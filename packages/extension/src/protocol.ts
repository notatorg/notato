/**
 * What the extension's three parts say to each other. The page (running in the page's own world, where it can read the
 * app's React components) cannot call the server itself: the page is on some other origin, with its own security
 * policy, which would refuse. So it asks, by `window.postMessage`, a relay (a content script in the extension's world),
 * which asks the extension's background worker, which is allowed to reach the server. This file is the vocabulary,
 * and the conversions between a request and something that can be sent between them.
 */
export const CHANNEL = "notato-extension";

/** What a person has set for one site. */
export interface SiteConfig {
    enabled: boolean;
    /** Where the Notato server is, e.g. http://localhost:4747. */
    server: string;
    project: string;
    /** For a shared server that asks for one. */
    token?: string;
    author?: string;
}

/**
 * What the page is told of its site's settings. Not the token: anything in the page's world can be read by every
 * script on the page, so the token stays in the extension, and the background worker adds it to each request itself.
 */
export type PageConfig = Omit<SiteConfig, "token">;

export const DEFAULT_SERVER = "http://localhost:4747";

/** A project id from where a page is served, so each app is its own project. */
export const projectFor = (host: string) => host.replace(/[^\w.@-]+/g, "-").slice(0, 100) || "page";

/** The project a site's page works in: the one set for the site, or else one named after the page's host. */
export function projectOf(site: Pick<SiteConfig, "project">, origin: string): string {
    if (site.project) return site.project;
    try {
        return projectFor(new URL(origin).host);
    } catch {
        return projectFor("");
    }
}

// ---- a request, as something that can cross a boundary that only carries text ---------------------------------

export type WireBody =
    | { type: "text"; text: string }
    | { type: "bytes"; base64: string; mime?: string }
    | {
          type: "form";
          entries: Array<
              [string, { text: string } | { base64: string; mime: string; filename: string }]
          >;
      };

export interface WireInit {
    method?: string;
    headers?: Array<[string, string]>;
    body?: WireBody;
}

export interface WireResponse {
    status: number;
    statusText: string;
    headers: Array<[string, string]>;
    /** The body, base64; absent when there is none. */
    base64?: string;
}

export function toBase64(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
        out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(out);
}

export function fromBase64(text: string): Uint8Array {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** A request's options as plain data. Handles what the SDK sends: text, bytes, a zip, and a form with screenshots. */
export async function encodeInit(init: RequestInit | undefined): Promise<WireInit> {
    const wire: WireInit = {};
    if (!init) return wire;
    if (init.method) wire.method = init.method;
    if (init.headers) wire.headers = [...new Headers(init.headers).entries()];
    const body = init.body;
    if (body === undefined || body === null) return wire;
    if (typeof body === "string") wire.body = { type: "text", text: body };
    else if (body instanceof FormData) {
        const entries: Extract<WireBody, { type: "form" }>["entries"] = [];
        for (const [name, value] of body.entries() as Iterable<[string, string | File]>) {
            if (typeof value === "string") entries.push([name, { text: value }]);
            else
                entries.push([
                    name,
                    {
                        base64: toBase64(await bytesOf(value)),
                        mime: value.type || "application/octet-stream",
                        filename: value.name,
                    },
                ]);
        }
        wire.body = { type: "form", entries };
    } else if (body instanceof URLSearchParams) wire.body = { type: "text", text: body.toString() };
    else if (body instanceof Blob)
        wire.body = { type: "bytes", base64: toBase64(await bytesOf(body)), mime: body.type };
    else if (body instanceof ArrayBuffer)
        wire.body = { type: "bytes", base64: toBase64(new Uint8Array(body)) };
    else if (ArrayBuffer.isView(body))
        wire.body = {
            type: "bytes",
            base64: toBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
        };
    else throw new Error("this request body cannot be sent through the extension");
    return wire;
}

/** The request options again, on the other side. */
export function decodeInit(wire: WireInit): RequestInit {
    const init: RequestInit = {};
    if (wire.method) init.method = wire.method;
    if (wire.headers) init.headers = wire.headers;
    const body = wire.body;
    if (!body) return init;
    if (body.type === "text") init.body = body.text;
    else if (body.type === "bytes")
        init.body = new Blob(
            [fromBase64(body.base64) as BlobPart],
            body.mime ? { type: body.mime } : undefined
        );
    else {
        // The browser sets the multipart boundary itself, so a Content-Type written for the form is dropped.
        const form = new FormData();
        for (const [name, value] of body.entries) {
            if ("text" in value) form.append(name, value.text);
            else
                form.append(
                    name,
                    new Blob([fromBase64(value.base64) as BlobPart], { type: value.mime }),
                    value.filename
                );
        }
        init.body = form;
        if (init.headers)
            init.headers = (init.headers as Array<[string, string]>).filter(
                ([k]) => k.toLowerCase() !== "content-type"
            );
    }
    return init;
}

const NO_BODY = new Set([101, 204, 205, 304]);

export async function encodeResponse(res: Response): Promise<WireResponse> {
    const wire: WireResponse = {
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()],
    };
    if (!NO_BODY.has(res.status)) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length) wire.base64 = toBase64(bytes);
    }
    return wire;
}

/**
 * The response again, on the page's side. Throws for a status a response cannot have (a redirect the browser did not
 * follow is status 0), as a browser's own `Response` does, and here in every runtime.
 */
export function decodeResponse(wire: WireResponse): Response {
    if (!Number.isInteger(wire.status) || wire.status < 200 || wire.status > 599)
        throw new RangeError(`a response cannot have status ${wire.status}`);
    const body =
        wire.base64 && !NO_BODY.has(wire.status) ? (fromBase64(wire.base64) as BlobPart) : null;
    return new Response(body, {
        status: wire.status,
        statusText: wire.statusText,
        headers: wire.headers,
    });
}

// ---- what the extension will fetch for a page ----------------------------------------------------------------

/** An annotation's or a screenshot's id, as the toolbar puts it in a path. */
const ID = "[A-Za-z0-9_-]{1,128}";

/**
 * What the toolbar asks of the server, by method and by path under the server's own address: `{project}` is only ever
 * this site's project. Nothing else, not the settings, the webhooks, the tokens, the list of projects, another
 * project's notes or the relay (the extension runs the toolbar in dev mode, which never uses it).
 */
const ROUTES: Array<{ methods: string[]; path: RegExp }> = [
    { methods: ["GET"], path: /^\/(health|config|status|auth\/me)$/ },
    { methods: ["GET", "POST"], path: /^\/projects\/\{project\}\/annotations$/ },
    { methods: ["GET"], path: /^\/projects\/\{project\}\/(events|markdown|export)$/ },
    { methods: ["POST"], path: /^\/projects\/\{project\}\/bundles$/ },
    // `/annotations/wait` is the server's long poll across every project, not an annotation.
    { methods: ["GET", "PATCH", "DELETE"], path: new RegExp(`^/annotations/(?!wait$)${ID}$`) },
    { methods: ["POST"], path: new RegExp(`^/annotations/${ID}/(replies|variants/choose)$`) },
    { methods: ["GET", "PUT"], path: new RegExp(`^/annotations/${ID}/variants$`) },
    { methods: ["GET"], path: new RegExp(`^/annotations/${ID}/markdown$`) },
    { methods: ["GET"], path: new RegExp(`^/assets/${ID}$`) },
];

/** Where `url` is on `server`, as a path under the server's own address; null when it is not on that server. */
export function apiPath(server: string, url: string): string | null {
    try {
        const target = new URL(url);
        const base = new URL(server);
        if (target.origin !== base.origin) return null;
        const prefix = base.pathname.replace(/\/$/, "");
        // On the server's own path, not merely one that starts with the same letters.
        return target.pathname.startsWith(`${prefix}/`)
            ? target.pathname.slice(prefix.length)
            : null;
    } catch {
        return null;
    }
}

/**
 * The method the server acts on. Some HTTP stacks cannot send PATCH, so the server takes a POST that says it means
 * one as a PATCH, and the extension has to read it the same way.
 */
export function serverMethod(method: string | undefined, headers?: HeadersInit): string {
    const named = (method ?? "GET").toUpperCase();
    return named === "POST" &&
        new Headers(headers).get("x-http-method-override")?.toUpperCase() === "PATCH"
        ? "PATCH"
        : named;
}

/**
 * Whether the extension may make this request for a page of `origin`: only to the server set for that site, and only
 * what the toolbar asks for there, for the site's own project. The server trusts the extension, so without this any
 * script on the page could use it to read every project's notes, delete them, or reach anything else the extension
 * can, such as other services on the same machine. `method` is the one the server will act on (see `serverMethod`).
 */
export function allowedRequest(
    site: SiteConfig,
    origin: string,
    url: string,
    method: string
): boolean {
    const path = apiPath(site.server, url);
    if (path === null) return false;
    // The project is compared decoded, as the server reads it, so no encoding of another name can pass for it.
    const project = /^\/projects\/([^/]+)\//.exec(path)?.[1];
    if (project !== undefined && decoded(project) !== projectOf(site, origin)) return false;
    const shape =
        project === undefined
            ? path
            : `/projects/{project}${path.slice(`/projects/${project}`.length)}`;
    return ROUTES.some((route) => route.methods.includes(method) && route.path.test(shape));
}

const decoded = (segment: string): string | null => {
    try {
        return decodeURIComponent(segment);
    } catch {
        return null;
    }
};

// ---- server-sent events ----------------------------------------------------------------------------------------

export interface SseFrame {
    type: string;
    data: string;
    lastEventId?: string;
}

/**
 * Reads a server-sent events stream a chunk at a time. Frames end at a blank line; `event:` names the frame (message
 * if absent), `data:` lines are joined with newlines, and lines starting with `:` are comments (keep-alives).
 */
export function createSseParser() {
    let buffer = "";
    return {
        push(chunk: string): SseFrame[] {
            buffer += chunk.replace(/\r\n?/g, "\n");
            const frames: SseFrame[] = [];
            for (;;) {
                const end = buffer.indexOf("\n\n");
                if (end === -1) break;
                const raw = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                let type = "message";
                let id: string | undefined;
                const data: string[] = [];
                let any = false;
                for (const line of raw.split("\n")) {
                    if (!line || line.startsWith(":")) continue;
                    const colon = line.indexOf(":");
                    const field = colon === -1 ? line : line.slice(0, colon);
                    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
                    if (field === "event") type = value;
                    else if (field === "data") {
                        data.push(value);
                        any = true;
                    } else if (field === "id") id = value;
                }
                if (any)
                    frames.push({
                        type,
                        data: data.join("\n"),
                        ...(id !== undefined ? { lastEventId: id } : {}),
                    });
            }
            return frames;
        },
    };
}

// ---- the messages between the page and the relay -------------------------------------------------------------

/** From the page to the relay. */
export type ToRelay =
    | { channel: typeof CHANNEL; to: "relay"; kind: "hello" }
    | {
          channel: typeof CHANNEL;
          to: "relay";
          kind: "fetch";
          id: number;
          url: string;
          init: WireInit;
      }
    | { channel: typeof CHANNEL; to: "relay"; kind: "events"; id: number; url: string }
    | { channel: typeof CHANNEL; to: "relay"; kind: "events-close"; id: number };

/** From the relay to the page. */
export type ToPage =
    | { channel: typeof CHANNEL; to: "page"; kind: "config"; config: PageConfig | null }
    | { channel: typeof CHANNEL; to: "page"; kind: "fetched"; id: number; response: WireResponse }
    | { channel: typeof CHANNEL; to: "page"; kind: "failed"; id: number; message: string }
    | { channel: typeof CHANNEL; to: "page"; kind: "event"; id: number; frame: SseFrame }
    | {
          channel: typeof CHANNEL;
          to: "page";
          kind: "events-state";
          id: number;
          state: "open" | "error";
      };

/** From the relay to the background worker. */
export type ToBackground =
    | { kind: "fetch"; url: string; init: WireInit }
    | { kind: "ping"; server: string };

export type BackgroundReply = { ok: true; response: WireResponse } | { ok: false; message: string };

/** Over the long-lived connection for a stream: first the URL, then what the background says. */
export type StreamStart = { url: string };
export type StreamEvent =
    | { kind: "event"; frame: SseFrame }
    | { kind: "state"; state: "open" | "error" };
