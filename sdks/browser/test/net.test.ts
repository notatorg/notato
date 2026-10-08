// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { net, STREAM_CLOSED, setTransport } from "../src/net.ts";

afterEach(() => {
    setTransport();
    vi.unstubAllGlobals();
});

describe("how the SDK reaches its server", () => {
    it("is the page's own fetch, looked up at the time of each call", async () => {
        const first = vi.fn(async () => new Response("one"));
        vi.stubGlobal("fetch", first);
        expect(await (await net.fetch("http://s/x")).text()).toBe("one");
        const second = vi.fn(async () => new Response("two"));
        vi.stubGlobal("fetch", second);
        expect(await (await net.fetch("http://s/y", { method: "POST" })).text()).toBe("two");
        expect(first).toHaveBeenCalledWith("http://s/x", undefined);
        expect(second).toHaveBeenCalledWith("http://s/y", { method: "POST" });
    });

    it("is the page's own EventSource for streams", () => {
        const made: string[] = [];
        vi.stubGlobal(
            "EventSource",
            class {
                readyState = 0;
                constructor(url: string) {
                    made.push(url);
                }
                addEventListener() {}
                close() {}
            }
        );
        net.events("http://s/events");
        expect(made).toEqual(["http://s/events"]);
    });

    it("a host's transport takes over for what it supplies, and the page's own stays for the rest", async () => {
        const fetched: string[] = [];
        setTransport({
            fetch: async (input) => {
                fetched.push(input);
                return new Response("from the host");
            },
        });
        expect(await (await net.fetch("http://s/a")).text()).toBe("from the host");
        expect(fetched).toEqual(["http://s/a"]);
        const made: string[] = [];
        vi.stubGlobal(
            "EventSource",
            class {
                readyState = 0;
                constructor(u: string) {
                    made.push(u);
                }
                addEventListener() {}
                close() {}
            }
        );
        net.events("http://s/e"); // not supplied: the page's own
        expect(made).toEqual(["http://s/e"]);
    });

    it("with nothing it goes back to the page's own", async () => {
        setTransport({ fetch: async () => new Response("host") });
        setTransport();
        vi.stubGlobal("fetch", async () => new Response("page"));
        expect(await (await net.fetch("http://s/a")).text()).toBe("page");
    });

    it("a closed stream is 2, as in EventSource", () => {
        expect(STREAM_CLOSED).toBe(2);
    });
});
