import {
    type BackgroundReply,
    CHANNEL,
    type PageConfig,
    type SiteConfig,
    type StreamEvent,
    type StreamStart,
    type ToBackground,
    type ToPage,
    type ToRelay,
} from "./protocol.ts";

/** A message without the envelope every one carries, for each kind of message on its own (a plain Omit would merge them). */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "channel" | "to"> : never;

/** What the page is told of its settings: all but the token, which only the background worker uses. */
const forPage = ({ token: _token, ...config }: SiteConfig): PageConfig => config;

/** A long-lived connection to the background worker, as much of `chrome.runtime.Port` as is used. */
export interface RelayPort {
    postMessage(message: StreamStart): void;
    onMessage: { addListener(fn: (message: StreamEvent) => void): void };
    onDisconnect: { addListener(fn: () => void): void };
    disconnect(): void;
}

export interface RelayOptions {
    /** Hears from the page. Returns how to stop. */
    fromPage(handler: (message: ToRelay) => void): () => void;
    toPage(message: ToPage): void;
    /** One request to the background worker. */
    ask(message: ToBackground): Promise<BackgroundReply | undefined>;
    /** Opens a stream through the background worker. */
    connect(): RelayPort;
    /** This site's settings, from the extension's storage. */
    loadConfig(): Promise<SiteConfig | null>;
}

/**
 * The content script that stands between the page and the background worker. It does nothing for a site that has
 * not been turned on, and says nothing the page did not ask for.
 */
export function createRelay(options: RelayOptions): { stop(): void } {
    const ports = new Map<number, RelayPort>();
    const say = (message: WithoutEnvelope<ToPage>) =>
        options.toPage({ channel: CHANNEL, to: "page", ...message } as ToPage);

    const stop = options.fromPage((message) => {
        if (message.kind === "hello") {
            void options.loadConfig().then(
                (config) =>
                    say({ kind: "config", config: config?.enabled ? forPage(config) : null }),
                () => say({ kind: "config", config: null })
            );
        } else if (message.kind === "fetch") {
            void options.ask({ kind: "fetch", url: message.url, init: message.init }).then(
                (reply) => {
                    if (reply?.ok)
                        say({ kind: "fetched", id: message.id, response: reply.response });
                    else
                        say({
                            kind: "failed",
                            id: message.id,
                            message: reply?.message ?? "the extension did not answer",
                        });
                },
                (error: unknown) =>
                    say({
                        kind: "failed",
                        id: message.id,
                        message: error instanceof Error ? error.message : String(error),
                    })
            );
        } else if (message.kind === "events") {
            const port = options.connect();
            ports.set(message.id, port);
            port.onMessage.addListener((event) => {
                if (event.kind === "event")
                    say({ kind: "event", id: message.id, frame: event.frame });
                else say({ kind: "events-state", id: message.id, state: event.state });
            });
            port.onDisconnect.addListener(() => {
                // The worker went away (it sleeps when idle): the page hears an error and opens another stream.
                if (ports.delete(message.id))
                    say({ kind: "events-state", id: message.id, state: "error" });
            });
            port.postMessage({ url: message.url });
        } else if (message.kind === "events-close") {
            const port = ports.get(message.id);
            ports.delete(message.id);
            port?.disconnect();
        }
    });

    return {
        stop() {
            stop();
            for (const port of ports.values()) port.disconnect();
            ports.clear();
        },
    };
}
