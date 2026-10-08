import { Annotation, Bundle } from "@notato/schema";
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { Connection, StoredAnnotation, StreamState } from "../src/client.ts";
import { NotatoError } from "../src/client.ts";
import { type Host, NotatoController, type Transport } from "../src/controller.ts";
import type { ServerEvent } from "../src/events.ts";
import type { Picked } from "../src/inspect.ts";
import { memoryStorage, type Storage, type StorageProvider } from "../src/storage.ts";

const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
    0, 0, 0, 2,
]);

/** A fake Notato server: what it has, what it was asked, and a stream the test drives. */
function fakeServer() {
    const stored = new Map<string, Annotation>();
    let seq = 0;
    const calls: string[] = [];
    let onEvent: ((e: ServerEvent) => void) | undefined;
    let onState: ((s: StreamState, d?: string) => void) | undefined;
    let fail: NotatoError | undefined;
    const store = (a: Annotation): StoredAnnotation => {
        stored.set(a.id, a);
        return { seq: ++seq, annotation: a };
    };
    const transport: Transport = {
        send: vi.fn(async (_c: Connection, a: Annotation, files) => {
            calls.push(`send ${a.id} ${files.length}`);
            if (fail) throw fail;
            return store(a);
        }),
        list: vi.fn(async () =>
            [...stored.values()].map((annotation, i) => ({ seq: i + 1, annotation }))
        ),
        reply: vi.fn(async (_c, id, body, author, aside) => {
            const a = stored.get(id) as Annotation;
            return store({
                ...a,
                thread: [
                    ...a.thread,
                    {
                        id: `r${seq}`,
                        author,
                        body,
                        createdAt: new Date().toISOString(),
                        ...(aside ? { aside } : {}),
                    },
                ],
            });
        }),
        setStatus: vi.fn(async (_c, id, status) =>
            store({ ...(stored.get(id) as Annotation), status })
        ),
        setPeopleOnly: vi.fn(async (_c, id, on) =>
            store({ ...(stored.get(id) as Annotation), peopleOnly: on })
        ),
        remove: vi.fn(async (_c, id) => {
            calls.push(`delete ${id}`);
            stored.delete(id);
        }),
        relayResult: vi.fn(async () => undefined),
        uploadBundle: vi.fn(async () => ({ bundleId: "b1", imported: 1 })),
        config: vi.fn(async () => ({ screenshots: true })),
        follow: vi.fn((_c, _agent, e, s) => {
            onEvent = e;
            onState = s;
            return { stop: vi.fn(), retry: vi.fn() };
        }),
    };
    return {
        transport,
        stored,
        calls,
        hello: async () => {
            onEvent?.({
                event: "hello",
                data: { projectId: "shop", agent: { connected: true, names: ["Claude"] } },
            });
            await settle();
        },
        event: async (event: string, data: unknown) => {
            onEvent?.({ event, data });
            await settle();
        },
        /** An event, with no wait for it to be applied. */
        send: (event: string, data: unknown) => onEvent?.({ event, data }),
        drop: () => onState?.("offline", "cannot reach it"),
        failWith: (e?: NotatoError) => {
            fail = e;
        },
    };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

function picked(over: Partial<Picked> = {}): Picked {
    return {
        names: ["App", "ProductCard", "Text", "RCTText"],
        props: { children: "£1.45" },
        frame: { left: 10, top: 100, width: 60, height: 20 },
        componentStack: "",
        element: {
            fiber: {} as never,
            tag: "Text",
            text: "£1.45",
            path: ["App", "ProductCard"],
            private: false,
            input: false,
            shown: false,
        },
        view: {},
        ...over,
    };
}

function fakeHost(route = "/shop"): Host & { toasts: string[] } {
    const toasts: string[] = [];
    return {
        toasts,
        resolve: async (target) => {
            if (target === "#missing")
                throw new NotatoError('Nothing on this screen matches "#missing".');
            return picked();
        },
        capture: async (_p, _pin, id) => ({
            full: { bytes: PNG, ref: { id: `${id}-full`, mime: "image/png", w: 4, h: 2 } },
        }),
        select: () => undefined,
        route: () => route,
        device: () => ({ os: "ios", osVersion: "26.5", viewport: { w: 402, h: 874 }, dpr: 3 }),
        toast: (m) => toasts.push(m),
    };
}

function start(
    config: Parameters<NotatoController["configure"]>[0],
    server = fakeServer(),
    storage?: Storage
) {
    const notato = new NotatoController(server.transport);
    notato.attachHost(fakeHost());
    const provider: StorageProvider | undefined = storage
        ? { open: () => storage, share: async () => true }
        : undefined;
    notato.configure({
        enabled: true,
        captureLogs: false,
        ...config,
        ...(provider ? { storage: provider } : {}),
    });
    return { notato, server };
}

describe("dev mode", () => {
    it("sends a note with its screenshot, and takes the server's copy", async () => {
        const { notato, server } = start({ project: "shop" });
        await server.hello();
        expect(notato.getState()).toMatchObject({ connection: "connected", agents: ["Claude"] });
        const a = await notato.annotate("Text", "Make the price bigger", { intent: "change" });
        expect(Annotation.safeParse(a).success).toBe(true);
        expect(server.calls).toEqual([`send ${a.id} 1`]);
        expect(notato.getState().notes).toHaveLength(1);
        expect(notato.getState().notes[0]).toMatchObject({ pending: false, mine: true });
        expect(a).toMatchObject({
            route: "/shop",
            intent: "change",
            mode: "dev",
            author: { kind: "human" },
        });
    });

    it("keeps a note made offline and sends it when the server says hello", async () => {
        const { notato, server } = start({ project: "shop" });
        server.drop();
        server.failWith(new NotatoError("cannot reach the Notato server"));
        await notato.annotate("Text", "Offline note");
        expect(notato.getState()).toMatchObject({ connection: "offline", pendingCount: 1 });
        server.failWith(undefined);
        await server.hello();
        expect(notato.getState().pendingCount).toBe(0);
        expect(server.stored.size).toBe(1);
    });

    it("marks a note the server refuses for good as failed, and still sends the ones after it", async () => {
        const { notato, server } = start({ project: "shop" });
        server.failWith(new NotatoError("too large", 413));
        const first = await notato.annotate("Text", "Too big");
        server.failWith(undefined);
        const second = await notato.annotate("Text", "Fine");
        expect(notato.getState().notes.find((n) => n.annotation.id === first.id)).toMatchObject({
            pending: true,
            failed: "too large",
        });
        await server.hello();
        expect(server.stored.has(second.id)).toBe(true);
        expect(server.stored.has(first.id)).toBe(false);
    });

    it("holds the queue on a server that answers but will not take notes yet (an unknown project)", async () => {
        const { notato, server } = start({ project: "shop" });
        server.failWith(new NotatoError("unknown project", 404));
        await notato.annotate("Text", "One");
        await notato.annotate("Text", "Two");
        expect(notato.getState().notes.map((n) => n.waiting)).toEqual([
            "unknown project",
            "unknown project",
        ]);
        const host = fakeHost();
        notato.attachHost(host);
        await server.hello();
        expect(host.toasts).toEqual(["Notes not sent: unknown project"]);
        // Stopped at the first: the second was not tried again.
        expect(server.calls.filter((c) => c.startsWith("send")).length).toBe(3);
    });

    it("follows the server's changes, and forgets a note deleted there", async () => {
        const { notato, server } = start({ project: "shop" });
        await server.hello();
        const a = await notato.annotate("Text", "Note");
        await server.event("updated", { annotation: { ...a, status: "acknowledged" } });
        expect(notato.getState().notes[0]?.annotation.status).toBe("acknowledged");
        await server.event("updated", {
            annotation: { ...a, id: "other", projectId: "elsewhere" },
        });
        expect(notato.getState().notes).toHaveLength(1);
        await server.event("deleted", { id: a.id });
        expect(notato.getState().notes).toHaveLength(0);
    });

    it("replies, asides, People only, revert and delete go through the server", async () => {
        const { notato, server } = start({ project: "shop", author: "Ada" });
        await server.hello();
        const a = await notato.annotate("Text", "Note");
        await notato.reply(a.id, "  More detail  ", true);
        expect(server.transport.reply).toHaveBeenCalledWith(
            expect.anything(),
            a.id,
            "More detail",
            { kind: "human", name: "Ada" },
            true
        );
        await notato.setPeopleOnly(a.id, true);
        expect(notato.getState().notes[0]?.annotation.peopleOnly).toBe(true);
        await notato.requestRevert(a.id, "");
        expect(server.transport.setStatus).toHaveBeenCalledWith(
            expect.anything(),
            a.id,
            "revert_requested",
            "Please undo this change.",
            expect.anything()
        );
        await notato.cancelRevert(a.id);
        await notato.delete(a.id);
        expect(server.stored.size).toBe(0);
        expect(notato.getState().notes).toHaveLength(0);
    });

    it("deletes on the server a note deleted here while it was on its way", async () => {
        const server = fakeServer();
        let release: () => void = () => undefined;
        const send = server.transport.send;
        server.transport.send = vi.fn(async (c, a, f) => {
            await new Promise<void>((r) => {
                release = r;
            });
            return send(c, a, f);
        });
        const { notato } = start({ project: "shop" }, server);
        const making = notato.annotate("Text", "Oops");
        await settle();
        const id = notato.getState().notes[0]?.annotation.id as string;
        await notato.delete(id);
        release();
        await making;
        expect(server.calls).toContain(`delete ${id}`);
        expect(server.stored.size).toBe(0);
    });

    it("rejects a target it cannot find, and a note with nothing to say", async () => {
        const { notato } = start({ project: "shop" });
        await expect(notato.annotate("#missing", "x")).rejects.toThrow(/Nothing on this screen/);
        await expect(notato.annotate("Text", "   ")).rejects.toThrow(/comment/);
    });
});

describe("the token", () => {
    it("goes only to the configured server, never to one typed into the settings", async () => {
        const server = fakeServer();
        const { notato } = start(
            { project: "shop", server: "http://localhost:4799", token: "pft_secret" },
            server
        );
        const follow = server.transport.follow as unknown as {
            mock: { calls: Array<[{ token?: string; server: string }]> };
        };
        expect(follow.mock.calls.at(-1)?.[0]).toMatchObject({
            server: "http://localhost:4799",
            token: "pft_secret",
        });
        notato.saveSettings({ name: "", screenshots: true, server: "http://evil.example.com" });
        expect(follow.mock.calls.at(-1)?.[0].server).toBe("http://evil.example.com");
        expect(follow.mock.calls.at(-1)?.[0].token).toBeUndefined();
    });

    it("keeps a newer copy the server's events brought while a note was on its way", async () => {
        const server = fakeServer();
        let release: () => void = () => undefined;
        const send = server.transport.send;
        server.transport.send = vi.fn(async (c, a, f) => {
            const stored = await send(c, a, f);
            await new Promise<void>((r) => {
                release = r;
            });
            return stored;
        });
        const { notato } = start({ project: "shop" }, server);
        await server.hello();
        const making = notato.annotate("Text", "Note");
        await settle();
        const sent = server.stored.values().next().value as Annotation;
        await server.event("updated", { annotation: { ...sent, status: "acknowledged" } });
        release();
        await making;
        expect(notato.getState().notes[0]?.annotation.status).toBe("acknowledged");
    });
});

describe("test mode", () => {
    it("keeps notes on the device, survives a restart, packages them as a bundle, and clears them", async () => {
        const storage = memoryStorage();
        const { notato, server } = start(
            { project: "shop", mode: "test", author: "Tess" },
            fakeServer(),
            storage
        );
        expect(notato.getState().connection).toBe("local");
        const a = await notato.annotate("Text", "Wrong price", { severity: "major" });
        expect(server.calls).toEqual([]);
        expect(notato.getState().pendingCount).toBe(1);

        // A new run reads them back.
        const again = start({ project: "shop", mode: "test" }, fakeServer(), storage).notato;
        expect(again.getState().notes.map((n) => n.annotation.id)).toEqual([a.id]);

        const { zip, name, uploaded } = await notato.packageNotes();
        expect(uploaded).toBe(false);
        expect(name).toMatch(/^notato-shop-.+\.zip$/);
        const files = unzipSync(zip);
        expect(Object.keys(files).sort()).toEqual([
            "annotations.json",
            "feedback.md",
            "shots/01-full.png",
        ]);
        const bundle = Bundle.parse(
            JSON.parse(new TextDecoder().decode(files["annotations.json"]))
        );
        expect(bundle).toMatchObject({ projectId: "shop", author: { name: "Tess" } });
        expect(bundle.annotations[0]).toMatchObject({
            mode: "test",
            severity: "major",
            screenshots: { full: { path: "shots/01-full.png" } },
        });
        expect(files["shots/01-full.png"]).toEqual(PNG);

        notato.clearLocal();
        expect(notato.getState().notes).toHaveLength(0);
        expect(storage.loadNotes()).toEqual([]);
    });

    it("uploads the package to a server when one is set", async () => {
        const { notato, server } = start({
            project: "shop",
            mode: "test",
            server: "http://localhost:4799",
        });
        await notato.annotate("Text", "x");
        expect((await notato.packageNotes()).uploaded).toBe(true);
        expect(server.transport.uploadBundle).toHaveBeenCalled();
        expect(server.transport.send).not.toHaveBeenCalled();
    });

    it("records People only on a note still on the device, in its thread", async () => {
        const { notato } = start({ project: "shop", mode: "test", author: "Tess" });
        const a = await notato.annotate("Text", "x");
        await notato.setPeopleOnly(a.id, true);
        const note = notato.getState().notes[0]?.annotation as Annotation;
        expect(note.peopleOnly).toBe(true);
        expect(note.thread).toMatchObject([
            {
                automatic: true,
                peopleOnly: true,
                author: { name: "Tess" },
                body: "Made this people only: the agent won't see it.",
            },
        ]);
        await notato.setPeopleOnly(a.id, false);
        expect(notato.getState().notes[0]?.annotation.peopleOnly).toBeUndefined();
        expect(Annotation.safeParse(notato.getState().notes[0]?.annotation).success).toBe(true);
    });

    it("says there is nothing to package before a note is made", async () => {
        const { notato } = start({ project: "shop", mode: "test" });
        await expect(notato.packageNotes()).rejects.toThrow(/Nothing to package/);
    });
});

describe("agent mode", () => {
    it("files an annotate request as the agent's note and reports it", async () => {
        const { notato, server } = start({ project: "shop", mode: "agent" });
        expect(server.transport.follow).toHaveBeenCalledWith(
            expect.anything(),
            true,
            expect.anything(),
            expect.anything()
        );
        await server.hello();
        await server.event("annotate-request", {
            requestId: "q1",
            args: { target: "Text", comment: "Checked", author: "Claude" },
        });
        await settle();
        const note = notato.getState().notes[0]?.annotation as Annotation;
        expect(note.author).toEqual({ kind: "agent", name: "Claude" });
        expect(server.transport.relayResult).toHaveBeenCalledWith(expect.anything(), "q1", {
            ok: true,
            annotationId: note.id,
        });
    });

    it("reports a target it cannot find", async () => {
        const { server } = start({ project: "shop", mode: "agent" });
        await server.hello();
        await server.event("annotate-request", {
            requestId: "q2",
            args: { target: "#missing", comment: "x" },
        });
        await settle();
        expect(server.transport.relayResult).toHaveBeenCalledWith(expect.anything(), "q2", {
            ok: false,
            error: 'Nothing on this screen matches "#missing".',
        });
    });
});

describe("runtime", () => {
    it("remembers on, off, the toolbar and a name across launches, until reset", () => {
        const storage = memoryStorage();
        const first = start({ project: "shop" }, fakeServer(), storage).notato;
        first.disable();
        first.hideToolbar();
        expect(
            first.saveSettings({ name: "Dom", screenshots: false, server: "ftp://nope" })
        ).toMatch(/not an http/);
        const second = start({ project: "shop" }, fakeServer(), storage).notato;
        expect(second.getState()).toMatchObject({
            enabled: false,
            toolbarVisible: false,
            author: "Dom",
            screenshots: false,
        });
        second.resetRuntimeState();
        expect(second.getState()).toMatchObject({
            enabled: true,
            toolbarVisible: true,
            screenshots: true,
        });
        expect(second.getState().author).toBeUndefined();
    });

    it("stays off with a project id the server would refuse", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { notato } = start({ project: "../etc" });
        expect(notato.getState()).toMatchObject({ enabled: false });
        expect(notato.getState().problem).toMatch(/may only use letters/);
        warn.mockRestore();
    });

    it("numbers pins per screen and keeps up with ten thousand notes", async () => {
        const { notato, server } = start({ project: "shop" });
        const base = await notato.annotate("Text", "first");
        for (let i = 0; i < 10_000; i++) {
            const route = `/screen-${i % 50}`;
            server.stored.set(`n${i}`, {
                ...base,
                id: `n${String(i).padStart(5, "0")}`,
                route,
                createdAt: new Date(1_700_000_000_000 + i).toISOString(),
            });
        }
        const t0 = performance.now();
        await server.hello();
        const loaded = performance.now() - t0;
        expect(notato.getState().notes.length).toBe(10_001);
        const t1 = performance.now();
        const here = notato.notesOn("/screen-7");
        const grouped = performance.now() - t1;
        expect(here).toHaveLength(200);
        expect(here.map((n) => n.number)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
        expect(notato.nextPin("/screen-7")).toBe(201);
        // A burst of live updates is applied together, in one change of the state, and only its screen is worked out
        // again: another screen's notes stay the very same list.
        const other = notato.notesOn("/screen-8");
        let changes = 0;
        notato.subscribe(() => changes++);
        const t2 = performance.now();
        for (let i = 0; i < 100; i++)
            server.send("updated", {
                annotation: { ...base, id: "n00007", route: "/screen-7", status: "acknowledged" },
            });
        await settle();
        const updates = performance.now() - t2;
        expect(changes).toBe(1);
        expect(notato.getState().notes.find((n) => n.annotation.id === "n00007")).toMatchObject({
            annotation: { status: "acknowledged" },
        });
        expect(notato.notesOn("/screen-8")).toBe(other);
        expect(notato.notesOn("/screen-7")).not.toBe(here);
        expect(loaded).toBeLessThan(1500);
        expect(grouped).toBeLessThan(200);
        expect(updates).toBeLessThan(500);
    });
});

describe("mounting", () => {
    const config = { project: "shop", enabled: true, captureLogs: false };

    it("starts again when <Notato> mounts again with the same options, as React's StrictMode does", () => {
        const notato = new NotatoController(fakeServer().transport);
        const first = notato.attach();
        notato.configure(config);
        expect(notato.getState().enabled).toBe(true);
        // StrictMode: the effects' clean-up, then the effects again.
        notato.detach(first);
        expect(notato.getState()).toMatchObject({ enabled: false, connection: "disabled" });
        const second = notato.attach();
        notato.configure(config);
        expect(notato.getState()).toMatchObject({ enabled: true, connection: "connecting" });
        // The first one going again changes nothing; the one mounted now does.
        notato.detach(first);
        expect(notato.getState().enabled).toBe(true);
        notato.detach(second);
        expect(notato.getState().enabled).toBe(false);
    });

    it("leaves Notato to a <Notato> mounted before the old one went, and keeps the notes it had", async () => {
        const server = fakeServer();
        server.failWith(new NotatoError("cannot reach the Notato server"));
        const notato = new NotatoController(server.transport);
        notato.attachHost(fakeHost());
        const old = notato.attach();
        notato.configure(config);
        await notato.annotate("Text", "Kept");
        const replacement = notato.attach();
        notato.configure(config);
        notato.detach(old);
        expect(notato.getState()).toMatchObject({ enabled: true, pendingCount: 1 });
        // Unmounted, then mounted again: the note not sent yet is still there, in memory storage too.
        notato.detach(replacement);
        notato.attach();
        notato.configure(config);
        expect(notato.getState()).toMatchObject({ enabled: true, pendingCount: 1 });
    });

    it("forgets an overlay only when it is still the one attached", async () => {
        const notato = new NotatoController(fakeServer().transport);
        const old = fakeHost();
        notato.attachHost(old);
        notato.attachHost(fakeHost());
        notato.detachHost(old);
        notato.configure(config);
        await expect(notato.annotate("Text", "Still here")).resolves.toMatchObject({
            comment: "Still here",
        });
    });
});

describe("the server, in order", () => {
    it("sends the notes kept on the device before it reads the server's list", async () => {
        const { notato, server } = start({ project: "shop" });
        server.failWith(new NotatoError("cannot reach the Notato server"));
        await notato.annotate("Text", "Offline");
        server.failWith(undefined);
        const order: string[] = [];
        const { send, list } = server.transport;
        server.transport.send = vi.fn(async (c, a, f) => {
            order.push("send");
            return send(c, a, f);
        });
        server.transport.list = vi.fn(async (c) => {
            order.push("list");
            return list(c);
        });
        await server.hello();
        expect(order).toEqual(["send", "list"]);
        expect(notato.getState()).toMatchObject({ pendingCount: 0 });
        expect(notato.getState().notes).toHaveLength(1);
    });

    it("applies the changes that came while the list was read over it: the list may be older", async () => {
        const { notato, server } = start({ project: "shop" });
        await server.hello();
        const a = await notato.annotate("Text", "Note");
        const list = server.transport.list;
        let answer: () => void = () => undefined;
        server.transport.list = vi.fn(async (c) => {
            const items = await list(c);
            await new Promise<void>((r) => {
                answer = r;
            });
            return items;
        });
        await server.hello();
        await server.event("updated", { annotation: { ...a, status: "acknowledged" } });
        answer();
        await settle();
        expect(notato.getState().notes[0]?.annotation.status).toBe("acknowledged");
    });

    it("forgets nothing when the server's list cannot be read to its end", async () => {
        const { notato, server } = start({ project: "shop" });
        await server.hello();
        await notato.annotate("Text", "Kept");
        server.transport.list = vi.fn(async () => {
            throw new NotatoError(
                "the server's list of notes did not move on from one page to the next"
            );
        });
        await server.hello();
        expect(notato.getState().notes).toHaveLength(1);
    });

    it("deletes on the server a note deleted here while it was on its way, even when Notato restarted meanwhile", async () => {
        const server = fakeServer();
        let release: () => void = () => undefined;
        const send = server.transport.send;
        server.transport.send = vi.fn(async (c, a, f) => {
            await new Promise<void>((r) => {
                release = r;
            });
            return send(c, a, f);
        });
        const { notato } = start({ project: "shop" }, server);
        const making = notato.annotate("Text", "Oops");
        await settle();
        const id = notato.getState().notes[0]?.annotation.id as string;
        await notato.delete(id);
        notato.saveSettings({ name: "", screenshots: true, server: "http://localhost:4798" });
        release();
        await making;
        expect(server.calls).toContain(`delete ${id}`);
        expect(server.stored.size).toBe(0);
    });

    it("pins only the notes made in a React Native app; the others stay in the list", async () => {
        const { notato, server } = start({ project: "shop" });
        await server.hello();
        const mine = await notato.annotate("Text", "Here");
        await server.event("created", {
            annotation: {
                ...mine,
                id: "web1",
                createdAt: new Date(Date.now() + 1000).toISOString(),
                environment: { ...mine.environment, platform: "web" },
            },
        });
        expect(notato.notesOn("/shop").map((n) => n.record.annotation.id)).toEqual([
            mine.id,
            "web1",
        ]);
        expect(notato.pinsOn("/shop").map((n) => [n.number, n.record.annotation.id])).toEqual([
            [1, mine.id],
        ]);
        expect(notato.nextPin("/shop")).toBe(3);
    });
});

describe("the agent's requests", () => {
    const ask = (requestId: string) => ({
        requestId,
        args: { target: "Text", comment: `Request ${requestId}`, author: "Claude" },
    });

    it("are answered one at a time, so one screenshot never shows another's outline", async () => {
        const { notato, server } = start({ project: "shop", mode: "agent" });
        const host = fakeHost();
        const log: string[] = [];
        const capture = host.capture;
        host.capture = async (p, pin, id) => {
            log.push(`start ${pin}`);
            await new Promise((r) => setTimeout(r, 20));
            log.push(`end ${pin}`);
            return capture(p, pin, id);
        };
        notato.attachHost(host);
        await server.hello();
        server.send("annotate-request", ask("q1"));
        server.send("annotate-request", ask("q2"));
        for (let i = 0; i < 20 && server.stored.size < 2; i++) await settle();
        expect(log).toEqual(["start 1", "end 1", "start 2", "end 2"]);
        expect(server.transport.relayResult).toHaveBeenCalledTimes(2);
    });

    it("hear that a note was not filed while it is still on the device, and why", async () => {
        const { server } = start({ project: "shop", mode: "agent" });
        await server.hello();
        server.failWith(new NotatoError("cannot reach the Notato server"));
        await server.event("annotate-request", ask("q3"));
        await settle();
        expect(server.transport.relayResult).toHaveBeenCalledWith(expect.anything(), "q3", {
            ok: false,
            error: "The note was made on the device but not sent: the server could not be reached. It is sent again on the next connection.",
        });
        server.failWith(new NotatoError("unknown project", 404));
        await server.event("annotate-request", ask("q4"));
        await settle();
        expect(server.transport.relayResult).toHaveBeenLastCalledWith(expect.anything(), "q4", {
            ok: false,
            error: "The note was made on the device but the server did not take it: unknown project. It is sent again on the next connection.",
        });
    });
});
