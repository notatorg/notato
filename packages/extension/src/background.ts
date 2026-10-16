import {
    apiPath,
    type BackgroundReply,
    createSseParser,
    decodeInit,
    encodeResponse,
    forwardedUrl,
    type PageConfig,
    type SiteConfig,
    type StreamEvent,
    type StreamStart,
    serverMethod,
    type ToBackground,
} from "./protocol.ts";

/** The port a stream arrives on, as much of `chrome.runtime.Port` as is used. */
export interface WorkerPort {
    postMessage(message: StreamEvent): void;
    onMessage: { addListener(fn: (message: StreamStart) => void): void };
    onDisconnect: { addListener(fn: () => void): void };
    disconnect(): void;
}

export interface WorkerOptions {
    fetch(input: string, init?: RequestInit): Promise<Response>;
    /** The settings for a site, by its origin. */
    siteConfig(origin: string): Promise<SiteConfig | null>;
    timeoutMs?: number;
}

const REFUSED =
    "Notato's extension only reaches the server set for this site, and only for what its toolbar asks";

const REDIRECTED = "The server answered with a redirect, which Notato's extension does not follow";

/** The statuses a browser follows as a redirect. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * A redirect, not followed. In a browser it is an opaque response with status 0, which cannot be handed to the page as
 * a response at all; elsewhere it is the 3xx itself. Either way the page is told, rather than sent somewhere else.
 */
const isRedirect = (res: Response) =>
    res.type === "opaqueredirect" || res.status === 0 || REDIRECTS.has(res.status);

/** The headers of a page's request that are sent on: the ones the toolbar sends. */
const PAGE_HEADERS = ["accept", "content-type", "x-http-method-override"];

/**
 * A request's headers as the site's own: its token, if it has one, and of the page's only those the toolbar sends. The
 * page is never told the token, so it has none of its own to send, and the extension does not lend its trust to
 * whatever else a script on the page might bring: a credential of its own, or the `X-Notato-Agent` headers that have
 * the server count an agent there. Its address is `forwardedUrl`'s, which keeps to the toolbar's query in the same way.
 */
function asSite(site: SiteConfig, headers?: HeadersInit): Headers {
    const asked = new Headers(headers);
    const sent = new Headers();
    for (const name of PAGE_HEADERS) {
        const value = asked.get(name);
        if (value !== null) sent.set(name, value);
    }
    if (site.token) sent.set("authorization", `Bearer ${site.token}`);
    return sent;
}

/**
 * The parts of the server's status that the toolbar shows. The rest lists every project on the server, which is not
 * this site's business. Null when the answer is not a JSON object, so nothing unread is passed on.
 */
async function statusForPage(res: Response): Promise<Response | null> {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const config = body.config as { screenshots?: unknown } | null | undefined;
    const agents = body.agents as Record<string, unknown> | null | undefined;
    return Response.json(
        {
            version: body.version,
            mode: body.mode,
            pages: body.pages,
            config: { screenshots: config?.screenshots },
            agents: agents
                ? { connected: agents.connected, watching: agents.watching, names: agents.names }
                : undefined,
        },
        { status: res.status, statusText: res.statusText }
    );
}

/** The one stream a page may open: its project's events. */
const EVENTS = /^\/projects\/[^/]+\/events$/;

/**
 * What the extension's background worker does for a page: the requests it asks for, held to what the toolbar needs
 * from the server set for that site, and the event streams. The page's origin is whatever the browser says sent the
 * message, never what the message claims.
 */
export function createWorker(options: WorkerOptions) {
    /** The site's settings and the address to send, when it is on and may make this request; otherwise null. */
    const siteAllowing = async (origin: string, url: string, method: string) => {
        const site = await options.siteConfig(origin);
        const sent = site?.enabled ? forwardedUrl(site, origin, url, method) : null;
        return site && sent ? { site, url: sent } : null;
    };

    return {
        /** What a page of `origin` is told of its site's settings: all but the token, and nothing when it is not on. */
        async pageConfig(origin: string): Promise<PageConfig | null> {
            const site = await options.siteConfig(origin);
            if (!site?.enabled) return null;
            const { token: _token, ...config } = site;
            return config;
        },

        async handle(origin: string, message: ToBackground): Promise<BackgroundReply> {
            if (message.kind === "ping") {
                try {
                    const res = await options.fetch(`${message.server.replace(/\/$/, "")}/health`, {
                        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
                    });
                    const body = (await res.json().catch(() => null)) as {
                        service?: string;
                    } | null;
                    return {
                        ok: true,
                        response: await encodeResponse(
                            Response.json({ ok: body?.service === "notato" })
                        ),
                    };
                } catch (error) {
                    return {
                        ok: false,
                        message: error instanceof Error ? error.message : String(error),
                    };
                }
            }
            try {
                const init = decodeInit(message.init);
                const method = serverMethod(init.method, init.headers);
                const allowed = await siteAllowing(origin, message.url, method);
                if (!allowed) return { ok: false, message: REFUSED };
                const { site, url } = allowed;
                const res = await options.fetch(url, {
                    ...init,
                    // As checked: fetch does not put every method in capitals itself (PATCH, for one).
                    ...(init.method ? { method: init.method.toUpperCase() } : {}),
                    headers: asSite(site, init.headers),
                    credentials: "omit",
                    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
                    redirect: "manual",
                });
                if (isRedirect(res)) return { ok: false, message: REDIRECTED };
                if (apiPath(site.server, url) === "/status") {
                    const status = await statusForPage(res);
                    return status
                        ? { ok: true, response: await encodeResponse(status) }
                        : { ok: false, message: "The server's status was not JSON" };
                }
                return { ok: true, response: await encodeResponse(res) };
            } catch (error) {
                return {
                    ok: false,
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        },

        /** An event stream for a page. Ends with an error state when the connection does, and the page opens another. */
        stream(origin: string, port: WorkerPort) {
            const abort = new AbortController();
            port.onDisconnect.addListener(() => abort.abort());
            port.onMessage.addListener((start) => {
                void (async () => {
                    const allowed = await siteAllowing(origin, start.url, "GET").catch(() => null);
                    if (!allowed || !EVENTS.test(apiPath(allowed.site.server, allowed.url) ?? "")) {
                        port.postMessage({ kind: "state", state: "error" });
                        port.disconnect();
                        return;
                    }
                    try {
                        const res = await options.fetch(allowed.url, {
                            headers: asSite(allowed.site, { Accept: "text/event-stream" }),
                            credentials: "omit",
                            signal: abort.signal,
                            // A redirect is not ok, so it ends the stream like any other refusal.
                            redirect: "manual",
                        });
                        if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
                        port.postMessage({ kind: "state", state: "open" });
                        const parser = createSseParser();
                        const decoder = new TextDecoder();
                        const reader = res.body.getReader();
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            for (const frame of parser.push(
                                decoder.decode(value, { stream: true })
                            ))
                                port.postMessage({ kind: "event", frame });
                        }
                    } catch {
                        // ended or refused: told below
                    }
                    if (!abort.signal.aborted) {
                        port.postMessage({ kind: "state", state: "error" });
                        port.disconnect();
                    }
                })();
            });
        },
    };
}
