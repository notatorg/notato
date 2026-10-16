import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedEvents } from "../src/event-stream.ts";

afterEach(() => vi.unstubAllGlobals());
describe("authenticated SSE", () => {
    it("keeps tokens in headers and decodes event frames split across network chunks", async () => {
        const bytes = new TextEncoder();
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(
                        new ReadableStream({
                            start(c) {
                                c.enqueue(bytes.encode(": ping\r\nevent: hel"));
                                c.enqueue(bytes.encode('lo\r\ndata: {"ok":true}\r\n\r\n'));
                                c.close();
                            },
                        }),
                        { headers: { "content-type": "text/event-stream" } }
                    )
            )
        );
        const stream = authenticatedEvents("https://notato.example/projects/p/events", {
            Authorization: "Bearer private",
        });
        const received: string[] = [];
        stream.addEventListener("hello", (e) => received.push(e.data));
        await vi.waitFor(() => expect(received).toEqual(['{"ok":true}']));
        expect(fetch).toHaveBeenCalledWith(
            "https://notato.example/projects/p/events",
            expect.objectContaining({
                headers: { Authorization: "Bearer private" },
                credentials: "omit",
            })
        );
        expect(stream.readyState).toBe(2);
    });
    it("reports refused streams as closed so sync can retry, and aborts deliberate closes quietly", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("refused", { status: 401 }))
        );
        const stream = authenticatedEvents("https://notato.example/events", {});
        const error = vi.fn();
        stream.onerror = error;
        await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
        expect(stream.readyState).toBe(2);
        const closed = authenticatedEvents("https://notato.example/events", {});
        const quiet = vi.fn();
        closed.onerror = quiet;
        closed.close();
        await new Promise((r) => setTimeout(r, 0));
        expect(quiet).not.toHaveBeenCalled();
    });
});
