import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "@notato/core";
import { sampleAnnotation } from "@notato/schema";
import { type DevRuntime, runDev } from "@notato/server";
import { net, setTransport } from "../../../sdks/browser/src/net.ts";
import { createServerSync } from "../../../sdks/browser/src/sync.ts";
import { createWorker, type WorkerPort } from "../src/background.ts";
import { createPageTransport, type PageBus, requestConfig } from "../src/page.ts";
import {
    CHANNEL,
    type SiteConfig,
    type StreamEvent,
    type StreamStart,
    type ToPage,
    type ToRelay,
} from "../src/protocol.ts";
import { createRelay, type RelayPort } from "../src/relay.ts";

const PNG = Uint8Array.from(
    atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ),
    (c) => c.charCodeAt(0)
);

const dirs: string[] = [];
const devs: DevRuntime[] = [];
afterEach(async () => {
    setTransport(); // the page's own again
    for (const d of devs.splice(0)) await d.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function realServer() {
    const dir = mkdtempSync(join(tmpdir(), "notato-ext-"));
    dirs.push(dir);
    const rt = await runDev({ port: 0, dir, version: "t", stdio: false, log: () => {} });
    devs.push(rt);
    return `http://127.0.0.1:${rt.port}`;
}

/** The two ends of one stream connection, as the relay and the worker each see theirs. */
function portPair(): { relaySide: RelayPort; workerSide: WorkerPort } {
    const toWorker: Array<(m: StreamStart) => void> = [];
    const toRelay: Array<(m: StreamEvent) => void> = [];
    const relayGone: Array<() => void> = [];
    const workerGone: Array<() => void> = [];
    let closed = false;
    const close = (who: Array<() => void>) => {
        if (closed) return;
        closed = true;
        for (const fn of who) fn();
    };
    return {
        relaySide: {
            postMessage: (m) =>
                queueMicrotask(() => {
                    for (const f of toWorker) f(m);
                }),
            onMessage: { addListener: (f) => toRelay.push(f) },
            onDisconnect: { addListener: (f) => relayGone.push(f) },
            disconnect: () => close(workerGone),
        },
        workerSide: {
            postMessage: (m) =>
                queueMicrotask(() => {
                    if (!closed) for (const f of toRelay) f(m);
                }),
            onMessage: { addListener: (f) => toWorker.push(f) },
            onDisconnect: { addListener: (f) => workerGone.push(f) },
            disconnect: () => close(relayGone),
        },
    };
}

/** A page, a relay and a worker wired together in memory, for a site with these settings. */
/** How long a stream waits before opening again, here: short, so a test of it need not wait a second. */
const RETRY_MS = 50;

function connect(
    origin: string,
    site: SiteConfig | null,
    fetcher: (input: string, init?: RequestInit) => Promise<Response> = (i, init) => fetch(i, init)
) {
    const pageHears = new Set<(m: ToPage) => void>();
    const relayHears = new Set<(m: ToRelay) => void>();
    const bus: PageBus = {
        post: (m) =>
            queueMicrotask(() => {
                for (const h of relayHears) h(m);
            }),
        listen: (h) => {
            pageHears.add(h);
            return () => pageHears.delete(h);
        },
    };
    const worker = createWorker({
        fetch: fetcher,
        siteConfig: async (o) => (o === origin ? site : null),
    });
    createRelay({
        fromPage(h) {
            relayHears.add(h);
            return () => relayHears.delete(h);
        },
        toPage: (m) =>
            queueMicrotask(() => {
                for (const h of pageHears) h(m);
            }),
        ask: (m) => worker.handle(origin, m),
        connect() {
            const { relaySide, workerSide } = portPair();
            worker.stream(origin, workerSide);
            return relaySide;
        },
        loadConfig: async () => site,
    });
    return { bus, transport: createPageTransport(bus, { retryMs: RETRY_MS }), worker };
}

const ORIGIN = "https://app.example.com";
const siteFor = (server: string, over: Partial<SiteConfig> = {}): SiteConfig => ({
    enabled: true,
    server,
    project: "shop",
    ...over,
});

const annotationForm = (id: string, comment: string) => {
    const form = new FormData();
    form.set(
        "annotation",
        JSON.stringify({
            ...sampleAnnotation,
            id,
            projectId: "shop",
            bundleId: null,
            comment,
            screenshots: { full: { id: "a".repeat(64), mime: "image/png", w: 1, h: 1 } },
        })
    );
    form.set(`asset:${"a".repeat(64)}`, new File([PNG], "s.png", { type: "image/png" }));
    return form;
};

const until = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("timed out waiting");
};

describe("a page's requests, carried by the extension to a real Notato server", () => {
    it("a plain request and its JSON answer", async () => {
        const server = await realServer();
        const { transport } = connect(ORIGIN, siteFor(server));
        const res = await transport.fetch(`${server}/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, service: "notato" });
    });

    it("an annotation with a screenshot goes up, and the screenshot comes back byte for byte", async () => {
        const server = await realServer();
        const { transport } = connect(ORIGIN, siteFor(server));
        const posted = await transport.fetch(`${server}/projects/shop/annotations`, {
            method: "POST",
            body: annotationForm("01EXT00000000000000000001", "from a page on another origin"),
        });
        expect(posted.status).toBe(201);
        const stored = (await posted.json()) as {
            annotation: { id: string; comment: string; screenshots: { full: { id: string } } };
        };
        expect(stored.annotation.comment).toBe("from a page on another origin");
        const image = await transport.fetch(
            `${server}/assets/${stored.annotation.screenshots.full.id}`
        );
        expect(image.headers.get("content-type")).toBe("image/png");
        expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    });

    it("a refusal from the server is a response with its status, not a failure", async () => {
        const server = await realServer();
        const { transport } = connect(ORIGIN, siteFor(server));
        const res = await transport.fetch(`${server}/annotations/01NOPE`);
        expect(res.status).toBe(404);
    });

    it("only the server set for the site: anything else is refused, and says why", async () => {
        const server = await realServer();
        const { transport } = connect(ORIGIN, siteFor(server));
        await expect(transport.fetch("http://127.0.0.1:1/config")).rejects.toThrow(
            "only reaches the server set for this site"
        );
        await expect(
            transport.fetch(`${server}/auth/login`, { method: "POST", body: "{}" })
        ).rejects.toThrow("only reaches");
    });

    it("a site that is not turned on gets nothing", async () => {
        const server = await realServer();
        const off = connect(ORIGIN, siteFor(server, { enabled: false }));
        expect(await requestConfig(off.bus, 200)).toBeNull();
        await expect(off.transport.fetch(`${server}/health`)).rejects.toThrow("only reaches");
        const unknown = connect(ORIGIN, null);
        expect(await requestConfig(unknown.bus, 200)).toBeNull();
    });

    it("the page is told its settings, when the site is on, but never the token", async () => {
        const server = await realServer();
        const { bus } = connect(ORIGIN, siteFor(server, { author: "Dom", token: "notato_x" }));
        const config = await requestConfig(bus);
        expect(config).toEqual({ enabled: true, server, project: "shop", author: "Dom" });
        expect(JSON.stringify(config)).not.toContain("notato_x");
    });

    it("the token goes on each request in the extension, and no script on the page sees it", async () => {
        const said: unknown[] = [];
        const seen: Array<{ url: string; authorization: string | null }> = [];
        const { bus, transport } = connect(
            ORIGIN,
            siteFor("http://localhost:4747", { token: "notato_site" }),
            async (url, init) => {
                seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
                return Response.json({ items: [] });
            }
        );
        bus.listen((m) => said.push(m));
        await requestConfig(bus);
        // What the SDK sends with no token of its own, and what a script on the page might try.
        await transport.fetch("http://localhost:4747/projects/shop/annotations?limit=500");
        await transport.fetch("http://localhost:4747/projects/shop/annotations", {
            headers: { Authorization: "Bearer notato_other" },
        });
        expect(seen).toEqual([
            {
                url: "http://localhost:4747/projects/shop/annotations?limit=500",
                authorization: "Bearer notato_site",
            },
            {
                url: "http://localhost:4747/projects/shop/annotations",
                authorization: "Bearer notato_site",
            },
        ]);
        expect(JSON.stringify(said)).not.toContain("notato_site");
    });

    it("a redirect fails the request with a message, rather than leaving it waiting", async () => {
        const { transport } = connect(
            ORIGIN,
            siteFor("http://localhost:4747"),
            async () =>
                new Response(null, { status: 307, headers: { location: "https://elsewhere/" } })
        );
        await expect(transport.fetch("http://localhost:4747/health")).rejects.toThrow(
            "redirect, which Notato's extension does not follow"
        );
    });

    it("only this site's project, and the server's status without the list of projects", async () => {
        const server = await realServer();
        const other = annotationForm("01EXT00000000000000000005", "someone else's");
        other.set(
            "annotation",
            JSON.stringify({ ...JSON.parse(other.get("annotation") as string), projectId: "other" })
        );
        expect(
            (await fetch(`${server}/projects/other/annotations`, { method: "POST", body: other }))
                .status
        ).toBe(201);
        const { transport } = connect(ORIGIN, siteFor(server));
        for (const path of [
            "/projects/other/annotations",
            "/projects/shop%2F..%2Fother/annotations",
            "/projects",
            "/annotations",
        ])
            await expect(transport.fetch(`${server}${path}`), path).rejects.toThrow("only reaches");
        await expect(
            transport.fetch(`${server}/annotations/01EXT00000000000000000005`, {
                method: "POST",
                body: "{}",
            })
        ).rejects.toThrow("only reaches");
        const own = await transport.fetch(`${server}/projects/shop/annotations`);
        expect(own.status).toBe(200);
        // The real server's status names every project; the page gets what the toolbar shows.
        expect(Object.keys((await (await fetch(`${server}/status`)).json()) as object)).toContain(
            "projects"
        );
        const status = (await (await transport.fetch(`${server}/status`)).json()) as Record<
            string,
            unknown
        >;
        expect(Object.keys(status).sort()).toEqual([
            "agents",
            "config",
            "mode",
            "pages",
            "version",
        ]);
        expect(status.version).toBe("t");
        expect(JSON.stringify(status)).not.toContain("other");
    });

    it("a request can be abandoned", async () => {
        const server = await realServer();
        const slow = (_input: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) =>
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
            );
        const { transport } = connect(ORIGIN, siteFor(server), slow);
        const controller = new AbortController();
        const pending = transport.fetch(`${server}/health`, { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toThrow();
    });
});

describe("the page's side", () => {
    it("an answer that is not a response (a redirect's status 0) fails the request, and does not hang it", async () => {
        let hear: ((m: ToPage) => void) | undefined;
        const bus: PageBus = {
            post: (m) =>
                queueMicrotask(() => {
                    if (m.kind === "fetch")
                        hear?.({
                            channel: CHANNEL,
                            to: "page",
                            kind: "fetched",
                            id: m.id,
                            response: { status: 0, statusText: "", headers: [] },
                        });
                }),
            listen: (h) => {
                hear = h;
                return () => {};
            },
        };
        const transport = createPageTransport(bus);
        const outcome = await Promise.race([
            transport.fetch("http://localhost:4747/health").then(
                () => "resolved",
                (error: Error) => error.message
            ),
            new Promise((r) => setTimeout(() => r("still waiting"), 500)),
        ]);
        expect(outcome).toBe("Notato's extension passed on status 0: no response");
    });
});

describe("live updates over the extension", () => {
    it("a stream opens, and what happens on the server reaches the page as events", async () => {
        const server = await realServer();
        const { transport } = connect(ORIGIN, siteFor(server));
        const stream = transport.events(`${server}/projects/shop/events`);
        const heard: Array<{ type: string; data: string }> = [];
        for (const type of ["hello", "created"])
            stream.addEventListener(type, (e) => heard.push({ type, data: e.data }));
        await until(() => heard.some((h) => h.type === "hello"));
        expect(stream.readyState).toBe(1);
        await fetch(`${server}/projects/shop/annotations`, {
            method: "POST",
            body: annotationForm("01EXT00000000000000000002", "live"),
        });
        await until(() => heard.some((h) => h.type === "created"));
        const created = JSON.parse(heard.find((h) => h.type === "created")?.data ?? "{}") as {
            annotation: { id: string };
        };
        expect(created.annotation.id).toBe("01EXT00000000000000000002");
        stream.close();
        expect(stream.readyState).toBe(2);
    });

    it("the SDK itself, set up the way the extension sets it up, mirrors the server's annotations into the page", async () => {
        const server = await realServer();
        const { transport } = connect(ORIGIN, siteFor(server));
        setTransport(transport);
        const store = createMemoryStore();
        const states: string[] = [];
        const sync = createServerSync({
            baseUrl: server,
            project: "shop",
            store,
            onState: (s) => states.push(s),
        });
        await fetch(`${server}/projects/shop/annotations`, {
            method: "POST",
            body: annotationForm("01EXT00000000000000000003", "before"),
        });
        sync.start();
        await until(() => states.includes("connected"));
        await until(() => store.list().length === 1); // the list it reads on connecting
        await fetch(`${server}/projects/shop/annotations`, {
            method: "POST",
            body: annotationForm("01EXT00000000000000000004", "after"),
        });
        await until(() => store.list().length === 2); // and the live event
        expect(
            store
                .list()
                .map((r) => r.annotation.comment)
                .sort()
        ).toEqual(["after", "before"]);
        // A change on the server arrives as an update.
        await fetch(`${server}/annotations/01EXT00000000000000000003`, {
            method: "PATCH",
            body: JSON.stringify({ status: "acknowledged" }),
        });
        await until(() => store.list().some((r) => r.annotation.status === "acknowledged"));
        sync.stop();
        expect(net.fetch).toBeDefined();
    });

    it("a stream the server ends is reported as an error and opened again", async () => {
        let opened = 0;
        const endsAtOnce = async () => {
            opened += 1;
            return new Response("event: hello\ndata: {}\n\n", {
                headers: { "content-type": "text/event-stream" },
            });
        };
        const { transport } = connect(ORIGIN, siteFor("http://localhost:4747"), endsAtOnce);
        const stream = transport.events("http://localhost:4747/projects/shop/events");
        let errors = 0;
        stream.onerror = () => {
            errors += 1;
        };
        await until(() => errors >= 1);
        await until(() => opened >= 2); // after the first wait, as an EventSource would
        expect(stream.readyState).not.toBe(2);
        stream.close();
        const after = opened;
        await new Promise((r) => setTimeout(r, RETRY_MS * 8)); // past any wait it could have had left
        expect(opened).toBe(after); // closed means closed: no more attempts
    });

    it("a stream for another server is refused and never fetched", async () => {
        const calls: string[] = [];
        const { transport } = connect(ORIGIN, siteFor("http://localhost:4747"), async (url) => {
            calls.push(url);
            return new Response("");
        });
        const stream = transport.events("http://127.0.0.1:9/projects/shop/events");
        let errored = false;
        stream.onerror = () => {
            errored = true;
        };
        await until(() => errored);
        stream.close();
        expect(calls).toEqual([]);
    });
});
