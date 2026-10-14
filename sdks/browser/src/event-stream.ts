import type { EventStream } from "./net.ts";

/** SSE over fetch keeps credentials in headers. The sync layer owns reconnects and full resynchronisation. */
export function authenticatedEvents(url: string, headers: HeadersInit): EventStream {
    const controller = new AbortController();
    const listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
    let state = 0;
    let closed = false;
    const stream: EventStream = {
        get readyState() {
            return state;
        },
        onerror: null,
        addEventListener(type, listener) {
            const set = listeners.get(type) ?? new Set();
            set.add(listener);
            listeners.set(type, set);
        },
        close() {
            closed = true;
            state = 2;
            controller.abort();
        },
    };
    const fail = () => {
        state = 2;
        if (!closed) stream.onerror?.(new Event("error"));
    };
    void (async () => {
        try {
            const response = await globalThis.fetch(url, {
                headers,
                signal: controller.signal,
                credentials: "omit",
                cache: "no-store",
            });
            if (
                !response.ok ||
                !response.headers.get("content-type")?.startsWith("text/event-stream") ||
                !response.body
            )
                throw new Error("stream refused");
            state = 1;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffered = "";
            let type = "message";
            let data: string[] = [];
            let size = 0;
            try {
                while (!closed) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    buffered += decoder.decode(chunk.value, { stream: true });
                    if (buffered.length + size > 4 * 1024 * 1024)
                        throw new Error("stream frame too large");
                    for (;;) {
                        const end = buffered.indexOf("\n");
                        if (end === -1) break;
                        const line = buffered.slice(0, end).replace(/\r$/, "");
                        buffered = buffered.slice(end + 1);
                        if (!line) {
                            if (data.length) {
                                const event = new MessageEvent(type, { data: data.join("\n") });
                                for (const listener of listeners.get(type) ?? []) listener(event);
                            }
                            type = "message";
                            data = [];
                            size = 0;
                        } else if (line.startsWith("event:")) type = line.slice(6).trimStart();
                        else if (line.startsWith("data:")) {
                            const value = line.slice(5).replace(/^ /, "");
                            data.push(value);
                            size += value.length;
                        }
                    }
                }
            } finally {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
            fail();
        } catch {
            fail();
        }
    })();
    return stream;
}
