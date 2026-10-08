import type { CapturePlugin } from "@notato/core";
import { isServerUrl } from "../net.ts";
import { safeUrl } from "../url.ts";

export interface NetworkEntry {
    method: string;
    /** Origin and path only: query strings routinely carry tokens. */
    url: string;
    /** 0 when the request failed before a response. */
    status: number;
    durationMs: number;
    at: string;
}

export interface NetworkOptions {
    limit?: number;
    /** Requests to these URL prefixes are not recorded. The Notato server is always excluded. */
    ignore?: string[];
}

/** Keeps the last few fetch and XHR requests: method, path, status, duration. */
export function networkPlugin(options: NetworkOptions = {}): CapturePlugin {
    const limit = options.limit ?? 30;
    const ignore = options.ignore ?? [];
    const buffer: NetworkEntry[] = [];
    const record = (entry: NetworkEntry) => {
        if (isServerUrl(entry.url) || ignore.some((prefix) => entry.url.startsWith(prefix))) return;
        buffer.push(entry);
        if (buffer.length > limit) buffer.shift();
    };

    return {
        id: "network",
        setup() {
            const originalFetch = window.fetch;
            const patchedFetch = async (
                input: RequestInfo | URL,
                init?: RequestInit
            ): Promise<Response> => {
                const started = performance.now();
                const method = (
                    init?.method ?? (input instanceof Request ? input.method : "GET")
                ).toUpperCase();
                const url = safeUrl(input instanceof Request ? input.url : String(input));
                try {
                    const response = await originalFetch.call(window, input, init);
                    record({
                        method,
                        url,
                        status: response.status,
                        durationMs: Math.round(performance.now() - started),
                        at: new Date().toISOString(),
                    });
                    return response;
                } catch (error) {
                    record({
                        method,
                        url,
                        status: 0,
                        durationMs: Math.round(performance.now() - started),
                        at: new Date().toISOString(),
                    });
                    throw error;
                }
            };
            window.fetch = patchedFetch as typeof fetch;

            const proto = XMLHttpRequest.prototype;
            const originalOpen = proto.open;
            const originalSend = proto.send;
            // What each request was opened with, and when it was sent. A request object can be opened and sent again, so
            // it gets one listener, which reads what it is doing now.
            const meta = new WeakMap<
                XMLHttpRequest,
                { method: string; url: string; started?: number }
            >();
            const heard = new WeakSet<XMLHttpRequest>();
            proto.open = function patchedOpen(
                this: XMLHttpRequest,
                method: string,
                url: string | URL,
                ...rest: unknown[]
            ) {
                meta.set(this, { method: method.toUpperCase(), url: safeUrl(String(url)) });
                return (originalOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
            } as typeof proto.open;
            proto.send = function patchedSend(
                this: XMLHttpRequest,
                body?: Document | XMLHttpRequestBodyInit | null
            ) {
                const info = meta.get(this);
                if (info) {
                    info.started = performance.now();
                    if (!heard.has(this)) {
                        heard.add(this);
                        this.addEventListener("loadend", () => {
                            const now = meta.get(this);
                            if (now?.started === undefined) return;
                            record({
                                method: now.method,
                                url: now.url,
                                status: this.status,
                                durationMs: Math.round(performance.now() - now.started),
                                at: new Date().toISOString(),
                            });
                            now.started = undefined;
                        });
                    }
                }
                return originalSend.call(this, body);
            };

            return () => {
                window.fetch = originalFetch;
                proto.open = originalOpen;
                proto.send = originalSend;
            };
        },
        async capture() {
            return { context: { network: [...buffer] } };
        },
    };
}
