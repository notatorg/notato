import type { EventStream, Transport } from "@notato/browser";
import {
    CHANNEL,
    decodeResponse,
    encodeInit,
    type PageConfig,
    type ToPage,
    type ToRelay,
} from "./protocol.ts";

/** The page's side of the conversation with the relay: how to say something, and how to hear. */
export interface PageBus {
    post(message: ToRelay): void;
    listen(handler: (message: ToPage) => void): () => void;
}

/** Over `window.postMessage`, which is how the page's world and the extension's world talk. */
export function windowBus(win: Window = window): PageBus {
    return {
        post: (message) =>
            win.postMessage(message, win.location.origin === "null" ? "*" : win.location.origin),
        listen(handler) {
            const onMessage = (event: MessageEvent) => {
                // Only the relay in this very page: another frame or window cannot speak for it.
                if (event.source !== win) return;
                const data = event.data as Partial<ToPage> | null;
                if (data?.channel === CHANNEL && data.to === "page") handler(data as ToPage);
            };
            win.addEventListener("message", onMessage);
            return () => win.removeEventListener("message", onMessage);
        },
    };
}

/** Asks the relay for this site's settings. Null when the extension has none for it, or does not answer. */
export function requestConfig(bus: PageBus, timeoutMs = 3000): Promise<PageConfig | null> {
    return new Promise((resolve) => {
        const off = bus.listen((message) => {
            if (message.kind !== "config") return;
            clearTimeout(timer);
            off();
            resolve(message.config);
        });
        const timer = setTimeout(() => {
            off();
            resolve(null);
        }, timeoutMs);
        bus.post({ channel: CHANNEL, to: "relay", kind: "hello" });
    });
}

const RECONNECT_MAX_MS = 10_000;

/** The SDK's requests, carried by the extension. */
export function createPageTransport(
    bus: PageBus,
    options: {
        /** First wait before opening a stream again after it ended; doubles up to ten seconds. */
        retryMs?: number;
    } = {}
): Transport {
    const firstRetry = options.retryMs ?? 1000;
    let next = 0;
    const waiting = new Map<
        number,
        { resolve(response: Response): void; reject(error: Error): void }
    >();
    const streams = new Map<number, (message: ToPage) => void>();

    bus.listen((message) => {
        if (message.kind === "fetched") {
            const waiter = waiting.get(message.id);
            waiting.delete(message.id);
            // Something that is not a response (a redirect's status 0, say) fails the request, rather than throwing
            // here and leaving it waiting for ever.
            let response: Response;
            try {
                response = decodeResponse(message.response);
            } catch {
                const status = message.response.status;
                waiter?.reject(
                    new Error(`Notato's extension passed on status ${status}: no response`)
                );
                return;
            }
            waiter?.resolve(response);
        } else if (message.kind === "failed") {
            waiting.get(message.id)?.reject(new Error(message.message));
            waiting.delete(message.id);
        } else if (message.kind === "event" || message.kind === "events-state")
            streams.get(message.id)?.(message);
    });

    return {
        async fetch(input, init) {
            const wire = await encodeInit(init);
            const id = ++next;
            return await new Promise<Response>((resolve, reject) => {
                if (init?.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
                waiting.set(id, { resolve, reject });
                init?.signal?.addEventListener("abort", () => {
                    if (waiting.delete(id)) reject(new DOMException("aborted", "AbortError"));
                });
                bus.post({
                    channel: CHANNEL,
                    to: "relay",
                    kind: "fetch",
                    id,
                    url: input,
                    init: wire,
                });
            });
        },

        events(url): EventStream {
            const listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
            let readyState = 0;
            let id = 0;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let delay = firstRetry;
            const stream: EventStream = {
                onerror: null,
                get readyState() {
                    return readyState;
                },
                addEventListener(type, listener) {
                    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
                },
                close() {
                    readyState = 2;
                    if (timer) clearTimeout(timer);
                    if (id) {
                        streams.delete(id);
                        bus.post({ channel: CHANNEL, to: "relay", kind: "events-close", id });
                    }
                },
            };

            const connect = () => {
                id = ++next;
                const mine = id;
                streams.set(mine, (message) => {
                    if (readyState === 2) return;
                    if (message.kind === "events-state") {
                        if (message.state === "open") {
                            readyState = 1;
                            delay = firstRetry;
                            return;
                        }
                        // The connection ended: say so, then try again, as an EventSource does.
                        streams.delete(mine);
                        readyState = 0;
                        stream.onerror?.(new Event("error"));
                        timer = setTimeout(connect, delay);
                        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
                    } else if (message.kind === "event") {
                        const event = new MessageEvent(message.frame.type, {
                            data: message.frame.data,
                            lastEventId: message.frame.lastEventId ?? "",
                        });
                        for (const listener of listeners.get(message.frame.type) ?? [])
                            listener(event as MessageEvent<string>);
                    }
                });
                bus.post({ channel: CHANNEL, to: "relay", kind: "events", id: mine, url });
            };
            connect();
            return stream;
        },
    };
}
