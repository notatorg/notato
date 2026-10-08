import { describe, expect, it } from "bun:test";
import { createWorker, type WorkerPort } from "../src/background.ts";
import type { SiteConfig, StreamEvent, StreamStart } from "../src/protocol.ts";

const SITE: SiteConfig = { enabled: true, server: "http://localhost:4747", project: "p" };

const worker = (
    fetcher: (input: string, init?: RequestInit) => Promise<Response>,
    site: SiteConfig | null = SITE
) =>
    createWorker({
        fetch: fetcher,
        siteConfig: async (origin) => (origin === "https://app.example" ? site : null),
    });

describe("the worker's requests", () => {
    it("fetches for a site that is on, with the options it was sent, and never follows a redirect", async () => {
        const seen: Array<{ url: string; init?: RequestInit }> = [];
        const w = worker(async (url, init) => {
            seen.push({ url, init });
            return Response.json({ ok: true });
        });
        const reply = await w.handle("https://app.example", {
            kind: "fetch",
            url: "http://localhost:4747/annotations/1",
            init: {
                method: "PATCH",
                headers: [["content-type", "application/json"]],
                body: { type: "text", text: "{}" },
            },
        });
        expect(reply.ok).toBe(true);
        expect(seen[0]?.url).toBe("http://localhost:4747/annotations/1");
        expect(seen[0]?.init?.method).toBe("PATCH");
        expect(seen[0]?.init?.redirect).toBe("manual");
        expect(seen[0]?.init?.credentials).toBe("omit");
        expect(seen[0]?.init?.signal).toBeDefined();
    });

    it("a redirect is a message saying so, not a response the page cannot be given", async () => {
        // A browser gives an opaque response with status 0 for a redirect it did not follow; Bun gives the 3xx itself.
        const opaque = {
            type: "opaqueredirect",
            status: 0,
            ok: false,
            statusText: "",
            headers: new Headers(),
            arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
        const moved = new Response(null, {
            status: 302,
            headers: { location: "http://elsewhere.example/" },
        });
        for (const answer of [opaque, moved]) {
            const reply = await worker(async () => answer).handle("https://app.example", {
                kind: "fetch",
                url: "http://localhost:4747/health",
                init: {},
            });
            expect(reply).toEqual({
                ok: false,
                message:
                    "The server answered with a redirect, which Notato's extension does not follow",
            });
        }
        // Not Modified is not a redirect.
        const unchanged = await worker(async () => new Response(null, { status: 304 })).handle(
            "https://app.example",
            { kind: "fetch", url: "http://localhost:4747/health", init: {} }
        );
        expect(unchanged.ok && unchanged.response.status).toBe(304);
    });

    it("is told the origin by the browser, so a page cannot borrow another site's settings", async () => {
        const calls: string[] = [];
        const w = worker(async (url) => {
            calls.push(url);
            return new Response("");
        });
        const reply = await w.handle("https://other.example", {
            kind: "fetch",
            url: "http://localhost:4747/config",
            init: {},
        });
        expect(reply).toEqual({
            ok: false,
            message:
                "Notato's extension only reaches the server set for this site, and only for what its toolbar asks",
        });
        expect(calls).toEqual([]);
    });

    it("does not fetch when the site is switched off, or for a path outside Notato's API", async () => {
        const calls: string[] = [];
        const record = async (url: string) => {
            calls.push(url);
            return new Response("");
        };
        expect(
            (
                await worker(record, { ...SITE, enabled: false }).handle("https://app.example", {
                    kind: "fetch",
                    url: "http://localhost:4747/config",
                    init: {},
                })
            ).ok
        ).toBe(false);
        expect(
            (
                await worker(record).handle("https://app.example", {
                    kind: "fetch",
                    url: "http://localhost:4747/admin/tokens",
                    init: {},
                })
            ).ok
        ).toBe(false);
        expect(calls).toEqual([]);
    });

    it("only what the toolbar asks, by method too, for the site's own project", async () => {
        const calls: string[] = [];
        const w = worker(async (url, init) => {
            calls.push(`${init?.method ?? "GET"} ${url}`);
            return Response.json({});
        });
        const ask = (url: string, method?: string, headers?: Array<[string, string]>) =>
            w.handle("https://app.example", {
                kind: "fetch",
                url: `http://localhost:4747${url}`,
                init: { ...(method ? { method } : {}), ...(headers ? { headers } : {}) },
            });
        expect((await ask("/projects/other/annotations")).ok).toBe(false);
        expect((await ask("/projects/p/annotations", "DELETE")).ok).toBe(false);
        expect((await ask("/webhooks/test", "POST")).ok).toBe(false);
        expect((await ask("/annotations/a1", "POST")).ok).toBe(false);
        expect(calls).toEqual([]);
        // The server's PATCH for stacks that cannot send one, and a method fetch leaves in lower case.
        expect(
            (await ask("/annotations/a1", "POST", [["x-http-method-override", "PATCH"]])).ok
        ).toBe(true);
        expect((await ask("/annotations/a1", "patch")).ok).toBe(true);
        expect(calls).toEqual([
            "POST http://localhost:4747/annotations/a1",
            "PATCH http://localhost:4747/annotations/a1",
        ]);
    });

    it("the site's token is added by the worker, and nothing the page sent stands in for it", async () => {
        const seen: Array<{ url: string; headers: Headers }> = [];
        const record = async (url: string, init?: RequestInit) => {
            seen.push({ url, headers: new Headers(init?.headers) });
            return Response.json({});
        };
        const pageSent = {
            kind: "fetch" as const,
            url: "http://localhost:4747/projects/p/annotations?limit=500&token=notato_page",
            init: {
                headers: [
                    ["authorization", "Bearer notato_page"],
                    ["x-notato-token", "notato_page"],
                    ["accept", "application/json"],
                ] as Array<[string, string]>,
            },
        };
        await worker(record, { ...SITE, token: "notato_site" }).handle(
            "https://app.example",
            pageSent
        );
        expect(seen[0]?.url).toBe("http://localhost:4747/projects/p/annotations?limit=500");
        expect(seen[0]?.headers.get("authorization")).toBe("Bearer notato_site");
        expect(seen[0]?.headers.get("x-notato-token")).toBeNull();
        expect(seen[0]?.headers.get("accept")).toBe("application/json");
        // A site without a token sends none, whatever the page put in.
        await worker(record).handle("https://app.example", pageSent);
        expect(seen[1]?.headers.get("authorization")).toBeNull();
        expect(seen[1]?.headers.get("x-notato-token")).toBeNull();
        expect(seen[1]?.url).toBe("http://localhost:4747/projects/p/annotations?limit=500");
    });

    it("the server's status reaches the page with only what the toolbar shows, not every project", async () => {
        const full = {
            ok: true,
            service: "notato",
            version: "1.2.3",
            mode: "dev",
            uptimeSec: 9,
            watchers: 2,
            pages: 1,
            agents: { connected: true, watching: false, names: ["Claude"], extra: 1 },
            mentions: [{ name: "agent" }],
            agentProjects: ["secret-project"],
            projects: [{ id: "secret-project", name: "Secret" }],
            config: { screenshots: "on", file: "/home/me/notato.config.json", webhooks: 2 },
        };
        const reply = await worker(async () => Response.json(full)).handle("https://app.example", {
            kind: "fetch",
            url: "http://localhost:4747/status",
            init: {},
        });
        expect(reply.ok && reply.response.status).toBe(200);
        const body = reply.ok
            ? await new Response(Buffer.from(reply.response.base64 ?? "", "base64")).json()
            : null;
        expect(body).toEqual({
            version: "1.2.3",
            mode: "dev",
            pages: 1,
            config: { screenshots: "on" },
            agents: { connected: true, watching: false, names: ["Claude"] },
        });
        // Not JSON: nothing unread is passed on.
        const odd = await worker(async () => new Response("<html>projects</html>")).handle(
            "https://app.example",
            { kind: "fetch", url: "http://localhost:4747/status", init: {} }
        );
        expect(odd).toEqual({ ok: false, message: "The server's status was not JSON" });
    });

    it("a network failure is a message, not a crash", async () => {
        const reply = await worker(async () => {
            throw new Error("connection refused");
        }).handle("https://app.example", {
            kind: "fetch",
            url: "http://localhost:4747/health",
            init: {},
        });
        expect(reply).toEqual({ ok: false, message: "connection refused" });
    });

    it("ping says whether a Notato server is there, and does not need a site", async () => {
        const found = await worker(async () =>
            Response.json({ ok: true, service: "notato" })
        ).handle("", {
            kind: "ping",
            server: "http://localhost:4747/",
        });
        expect(
            found.ok &&
                (await new Response(Buffer.from(found.response.base64 ?? "", "base64")).json())
        ).toEqual({ ok: true });
        const other = await worker(async () => Response.json({ service: "something-else" })).handle(
            "",
            {
                kind: "ping",
                server: "http://localhost:4747",
            }
        );
        expect(
            other.ok &&
                (await new Response(Buffer.from(other.response.base64 ?? "", "base64")).json())
        ).toEqual({ ok: false });
        const down = await worker(async () => {
            throw new Error("refused");
        }).handle("", { kind: "ping", server: "http://localhost:4747" });
        expect(down.ok).toBe(false);
    });
});

describe("the worker's streams", () => {
    function port() {
        const sent: StreamEvent[] = [];
        let start: ((m: StreamStart) => void) | undefined;
        let gone: (() => void) | undefined;
        let disconnected = false;
        const p: WorkerPort = {
            postMessage: (m) => sent.push(m),
            onMessage: { addListener: (f) => (start = f) },
            onDisconnect: { addListener: (f) => (gone = f) },
            disconnect: () => {
                disconnected = true;
            },
        };
        return {
            p,
            sent,
            begin: (url: string) => start?.({ url }),
            hangUp: () => gone?.(),
            isDisconnected: () => disconnected,
        };
    }
    const tick = () => new Promise((r) => setTimeout(r, 20));
    const until = async (check: () => boolean, ms = 3000) => {
        const end = Date.now() + ms;
        while (!check()) {
            if (Date.now() > end) throw new Error("timed out waiting");
            await tick();
        }
    };

    it("opens it, says so, and passes frames on as they arrive in pieces", async () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("event: hello\ndata: {}\n\nevent: cre"));
                controller.enqueue(encoder.encode('ated\ndata: {"a":1}\n\n'));
                // left open, as a live stream is
            },
        });
        const w = worker(
            async () => new Response(body, { headers: { "content-type": "text/event-stream" } })
        );
        const t = port();
        w.stream("https://app.example", t.p);
        t.begin("http://localhost:4747/projects/p/events");
        await tick();
        expect(t.sent).toEqual([
            { kind: "state", state: "open" },
            { kind: "event", frame: { type: "hello", data: "{}" } },
            { kind: "event", frame: { type: "created", data: '{"a":1}' } },
        ]);
    });

    it("hanging up ends the request, and says nothing more", async () => {
        let signal: AbortSignal | undefined;
        const w = worker(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
                headers: { "content-type": "text/event-stream" },
            });
        });
        const t = port();
        w.stream("https://app.example", t.p);
        t.begin("http://localhost:4747/projects/p/events");
        await tick();
        t.hangUp();
        expect(signal?.aborted).toBe(true);
        await tick();
        expect(t.sent.filter((m) => m.kind === "state" && m.state === "error")).toEqual([]);
    });

    it("a refused address is an error and a closed connection, with nothing fetched", async () => {
        const calls: string[] = [];
        const w = worker(async (url) => {
            calls.push(url);
            return new Response("");
        });
        const t = port();
        w.stream("https://app.example", t.p);
        t.begin("http://localhost:9999/projects/p/events");
        await tick();
        expect(t.sent).toEqual([{ kind: "state", state: "error" }]);
        expect(t.isDisconnected()).toBe(true);
        expect(calls).toEqual([]);
    });

    it("carries the site's token in a header, not the page's in the address", async () => {
        const seen: Array<{ url: string; headers: Headers }> = [];
        const w = worker(
            async (url, init) => {
                seen.push({ url, headers: new Headers(init?.headers) });
                return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
                    headers: { "content-type": "text/event-stream" },
                });
            },
            { ...SITE, token: "notato_site" }
        );
        const t = port();
        w.stream("https://app.example", t.p);
        t.begin("http://localhost:4747/projects/p/events?agent=1&token=notato_page");
        await tick();
        expect(seen[0]?.url).toBe("http://localhost:4747/projects/p/events?agent=1");
        expect(seen[0]?.headers.get("authorization")).toBe("Bearer notato_site");
        expect(seen[0]?.headers.get("accept")).toBe("text/event-stream");
        t.hangUp();
    });

    it("only the site's own project's events", async () => {
        const calls: string[] = [];
        const w = worker(async (url) => {
            calls.push(url);
            return Response.json({});
        });
        for (const url of [
            "http://localhost:4747/projects/other/events",
            "http://localhost:4747/status",
            "http://localhost:4747/projects/p/annotations",
        ]) {
            const t = port();
            w.stream("https://app.example", t.p);
            t.begin(url);
            await tick();
            expect(t.sent, url).toEqual([{ kind: "state", state: "error" }]);
        }
        expect(calls).toEqual([]);
    });

    it("a redirect is not followed: the stream ends with an error", async () => {
        const followed: string[] = [];
        const server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);
                if (url.pathname === "/projects/p/events")
                    return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
                followed.push(url.pathname);
                return new Response("event: hello\ndata: {}\n\n", {
                    headers: { "content-type": "text/event-stream" },
                });
            },
        });
        try {
            const base = `http://localhost:${server.port}`;
            const w = worker((input, init) => fetch(input, init), { ...SITE, server: base });
            const t = port();
            w.stream("https://app.example", t.p);
            t.begin(`${base}/projects/p/events`);
            await until(() => t.isDisconnected());
            expect(t.sent).toEqual([{ kind: "state", state: "error" }]);
            expect(followed).toEqual([]);
        } finally {
            server.stop(true);
        }
    });

    it("the server answering with an error ends it with an error, for the page to try again", async () => {
        const w = worker(async () => new Response("no", { status: 503 }));
        const t = port();
        w.stream("https://app.example", t.p);
        t.begin("http://localhost:4747/projects/p/events");
        await tick();
        expect(t.sent).toEqual([{ kind: "state", state: "error" }]);
        expect(t.isDisconnected()).toBe(true);
    });
});
