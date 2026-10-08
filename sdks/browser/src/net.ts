/** A server-sent events stream, as much of `EventSource` as the SDK uses. */
export interface EventStream {
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
    onerror: ((event: Event) => void) | null;
    close(): void;
    /** 0 connecting, 1 open, 2 closed: the same numbers `EventSource` uses. */
    readonly readyState: number;
}

/** `readyState` of a stream that will not reconnect. */
export const STREAM_CLOSED = 2;

/**
 * How the SDK reaches its server. Normally the page's own `fetch` and `EventSource`. A host that cannot let the page
 * talk to the server directly (the browser extension, whose pages are on other origins with their own security
 * policies) supplies its own.
 */
export interface Transport {
    fetch(input: string, init?: RequestInit): Promise<Response>;
    events(url: string): EventStream;
}

const browser = (): Transport => ({
    // Looked up at the time of each call, so a page that replaces `fetch` later is still obeyed.
    fetch: (input, init) => globalThis.fetch(input, init),
    events: (url) => new EventSource(url) as unknown as EventStream,
});

let current: Transport = browser();

/** Uses a host's transport for what it supplies, and the page's own for the rest. With nothing, back to the page's own. */
export function setTransport(transport?: Partial<Transport>): void {
    current = { ...browser(), ...transport };
}

/** What the SDK's own requests go through. */
export const net: Transport = {
    fetch: (input, init) => current.fetch(input, init),
    events: (url) => current.events(url),
};

/** The Notato servers the SDK on this page talks to, by base URL. */
const servers = new Set<string>();

/** Notes a server the SDK talks to, until the returned function is called. */
export function addServer(base: string): () => void {
    const clean = base.replace(/\/$/, "");
    servers.add(clean);
    return () => servers.delete(clean);
}

/** Whether a URL is one of the SDK's own servers: what the network plugin leaves out of the page's requests. */
export function isServerUrl(url: string): boolean {
    for (const base of servers) if (url === base || url.startsWith(`${base}/`)) return true;
    return false;
}
