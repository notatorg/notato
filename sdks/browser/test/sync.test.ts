import { createMemoryStore } from "@notato/core";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EventStream, setTransport } from "../src/net.ts";
import { createServerSync, type ServerSyncOptions } from "../src/sync.ts";

const note = (n: number, over: Partial<Annotation> = {}): Annotation => ({
    ...sampleAnnotation,
    id: `01N${String(n).padStart(4, "0")}`,
    comment: `note ${n}`,
    thread: [],
    ...over,
});

/** An event stream the test drives by hand. */
function fakeStream() {
    const listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
    let readyState = 1;
    const stream: EventStream = {
        addEventListener: (type, listener) =>
            listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        onerror: null,
        close: () => {
            readyState = 2;
        },
        get readyState() {
            return readyState;
        },
    };
    return {
        stream,
        emit(type: string, data: unknown) {
            for (const listener of listeners.get(type) ?? [])
                listener(new MessageEvent(type, { data: JSON.stringify(data) }));
        },
        /** What an EventSource does on an error status: closes for good, then says so. */
        fail(closed: boolean) {
            if (closed) readyState = 2;
            stream.onerror?.(new Event("error"));
        },
    };
}

/** A server with these notes, oldest first, that hands out `per` at a time the way the real one does. */
function serverWith(items: Annotation[], per = 500) {
    const asked: string[] = [];
    let failOn: number | undefined;
    const fetch = vi.fn(async (url: string) => {
        asked.push(url);
        const query = new URL(url).searchParams;
        const after = Number(query.get("afterSeq") ?? 0);
        if (failOn !== undefined && after >= failOn) return new Response("down", { status: 502 });
        const page = items
            .map((annotation, i) => ({ seq: i + 1, annotation }))
            .filter((item) => item.seq > after)
            .slice(0, per);
        const full = page.length === per;
        return Response.json({ items: page, ...(full ? { next: page.at(-1)?.seq } : {}) });
    });
    return {
        fetch,
        asked,
        set items(next: Annotation[]) {
            items = next;
        },
        failFrom(seq: number | undefined) {
            failOn = seq;
        },
    };
}

function start(
    server: ReturnType<typeof serverWith>,
    over: Partial<ServerSyncOptions> = {},
    streams: Array<ReturnType<typeof fakeStream>> = []
) {
    const store = over.store ?? createMemoryStore();
    setTransport({
        fetch: server.fetch,
        events: () => {
            const s = fakeStream();
            streams.push(s);
            return s.stream;
        },
    });
    const states: string[] = [];
    const sync = createServerSync({
        baseUrl: "http://localhost:4801",
        project: "shop",
        store,
        onState: (state) => states.push(state),
        ...over,
    });
    return { sync, store, states, streams };
}

const ids = (store: ReturnType<typeof createMemoryStore>) =>
    store
        .list()
        .map((r) => r.annotation.id)
        .sort();

afterEach(() => {
    setTransport();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("reading the server's list", () => {
    it("reads every page, so the newest notes are there on a big project", async () => {
        const all = Array.from({ length: 1203 }, (_, i) => note(i + 1));
        const server = serverWith(all);
        const { sync, store } = start(server);
        await sync.refresh();
        expect(store.list()).toHaveLength(1203);
        expect(store.get(note(1203).id)).toBeDefined();
        const shown = "open,acknowledged,variant_chosen,resolved,revert_requested,reverted";
        expect(server.asked.map((u) => decodeURIComponent(new URL(u).search))).toEqual([
            `?limit=500&status=${shown}`,
            `?limit=500&afterSeq=500&status=${shown}`,
            `?limit=500&afterSeq=1000&status=${shown}`,
        ]);
    });

    it("leaves dismissed notes out: they have no pin, so they are not asked for, and one sent anyway is not kept", async () => {
        const server = serverWith([note(1), note(2, { status: "dismissed" }), note(3)]);
        const { sync, store } = start(server);
        await sync.refresh();
        expect(new URL(server.asked[0] as string).searchParams.get("status")).not.toContain(
            "dismissed"
        );
        expect(ids(store)).toEqual([note(1).id, note(3).id]);
    });

    it("reads a server too old to know one of the statuses whole, and goes on doing so", async () => {
        const server = serverWith([note(1), note(2, { status: "dismissed" })]);
        const plain = server.fetch.getMockImplementation();
        server.fetch.mockImplementation(async (url: string) =>
            new URL(url).searchParams.has("status")
                ? Response.json({ error: 'invalid status "variant_chosen"' }, { status: 400 })
                : (plain?.(url) as Promise<Response>)
        );
        const { sync, store } = start(server);
        await sync.refresh();
        expect(ids(store)).toEqual([note(1).id]);
        await sync.refresh();
        expect(server.fetch.mock.calls.map(([u]) => new URL(u).searchParams.has("status"))).toEqual(
            [true, false, false]
        );
    });

    it("drops what the server no longer has, once the whole list is in", async () => {
        const server = serverWith([note(1), note(2), note(3)], 2);
        const { sync, store } = start(server);
        await sync.refresh();
        server.items = [note(1), note(3)]; // note 2 was deleted while this page was away
        const applied: Array<{ updated: string[]; removed: string[] }> = [];
        const again = start(server, {
            store,
            onApplied: (c) =>
                applied.push({ updated: c.updated.map((a) => a.id), removed: c.removed }),
        });
        await again.sync.refresh();
        expect(ids(store)).toEqual([note(1).id, note(3).id]);
        expect(applied).toEqual([{ updated: [], removed: [note(2).id] }]);
    });

    it("drops nothing when a page fails, and keeps what it had", async () => {
        const server = serverWith([note(1), note(2), note(3)], 2);
        const { sync, store } = start(server);
        await sync.refresh();
        server.items = [note(1), note(3), note(4)]; // note 2 gone, but the page that would show it…
        server.failFrom(2); // …is followed by one that fails
        await expect(sync.refresh()).rejects.toThrow("502");
        expect(ids(store)).toEqual([note(1).id, note(2).id, note(3).id]);
    });

    it("never drops a note still on its way to the server, or one refused by it", async () => {
        const server = serverWith([]);
        const store = createMemoryStore();
        store.add({ annotation: note(7), assets: new Map() });
        store.add({ annotation: note(8), assets: new Map() });
        store.add({ annotation: note(9), assets: new Map() });
        const { sync } = start(server, { store, keep: () => [note(7).id, note(8).id] });
        await sync.refresh();
        expect(ids(store)).toEqual([note(7).id, note(8).id]);
    });

    it("never drops a note that was waiting to be sent as the read began, and was sent during it", async () => {
        let release: () => void = () => {};
        const server = serverWith([]);
        server.fetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(Response.json({ items: [] }));
                })
        );
        const store = createMemoryStore();
        store.add({ annotation: note(6), assets: new Map() });
        const waiting = new Set([note(6).id]);
        const { sync } = start(server, { store, keep: () => waiting });
        const reading = sync.refresh();
        waiting.delete(note(6).id); // sent, after the list was read without it
        release();
        await reading;
        expect(ids(store)).toEqual([note(6).id]);
    });

    it("never drops a note made while the list was being read", async () => {
        let release: () => void = () => {};
        const server = serverWith([]);
        server.fetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(Response.json({ items: [] }));
                })
        );
        const { sync, store } = start(server);
        const reading = sync.refresh();
        store.add({ annotation: note(5), assets: new Map() }); // made, and sent, after the list was asked for
        release();
        await reading;
        expect(ids(store)).toEqual([note(5).id]);
    });

    it("does not undo what live events said while the list was being read", async () => {
        let release: () => void = () => {};
        const server = serverWith([]);
        const { sync, store, streams } = start(server);
        sync.start();
        server.fetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () =>
                        resolve(
                            Response.json({
                                items: [{ seq: 1, annotation: note(1, { status: "open" }) }],
                            })
                        );
                })
        );
        const reading = sync.refresh();
        streams[0]?.emit("updated", { annotation: note(1, { status: "resolved" }) });
        release();
        await reading;
        expect(store.get(note(1).id)?.annotation.status).toBe("resolved");
        sync.stop();
    });

    it("tells nobody anything when nothing changed", async () => {
        const server = serverWith([note(1), note(2)]);
        const { sync, store } = start(server);
        await sync.refresh();
        const heard = vi.fn();
        store.subscribe(heard);
        await sync.refresh();
        expect(heard).not.toHaveBeenCalled();
    });

    it("stops at a server that keeps saying there is more without moving on", async () => {
        const fetch = vi.fn(async () =>
            Response.json({ items: [{ seq: 1, annotation: note(1) }], next: 1 })
        );
        const { sync, store } = start({ ...serverWith([]), fetch } as never);
        await sync.refresh();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(ids(store)).toEqual([note(1).id]);
    });
});

describe("a change this page made", () => {
    it("is taken from the server's answer, with no list read for it", async () => {
        const server = serverWith([note(1)]);
        const { sync, store } = start(server);
        await sync.refresh();
        server.fetch.mockClear();
        const since = sync.mark();
        const answered = note(1, { status: "resolved" });
        expect(sync.apply(answered, since)).toBe(true);
        expect(store.get(answered.id)?.annotation.status).toBe("resolved");
        expect(server.fetch).not.toHaveBeenCalled();
    });

    it("does not undo what the stream said about the note after the request went", () => {
        const store = createMemoryStore();
        const { sync, streams } = start(serverWith([]), { store });
        sync.start();
        const since = sync.mark();
        // The agent answered while the reply was on its way back: the stream has the newer note.
        streams[0]?.emit("updated", { annotation: note(1, { status: "acknowledged" }) });
        expect(sync.apply(note(1, { status: "open" }), since)).toBe(true);
        expect(store.get(note(1).id)?.annotation.status).toBe("acknowledged");
        sync.stop();
    });

    it("says so when the answer is not a note, so the list can be read instead", () => {
        const { sync } = start(serverWith([]));
        expect(sync.apply(undefined, sync.mark())).toBe(false);
        expect(sync.apply({ id: "not a note" }, sync.mark())).toBe(false);
    });
});

describe("the live stream", () => {
    it("stays connected when the list cannot be read as it opens, and reads it again until it can", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const server = serverWith([note(1)]);
        server.failFrom(0); // the stream is open, but the list read fails (a proxy timing out)
        const { sync, states, streams, store } = start(server, { retryMs: 1000 });
        sync.start();
        streams[0]?.emit("hello", {});
        await vi.advanceTimersByTimeAsync(0);
        expect(states.at(-1)).toBe("connected");
        expect(server.fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(server.fetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1999); // waits longer each time
        expect(server.fetch).toHaveBeenCalledTimes(2);
        server.failFrom(undefined);
        await vi.advanceTimersByTimeAsync(1);
        expect(ids(store)).toEqual([note(1).id]);
        expect(states).not.toContain("offline");
        await vi.advanceTimersByTimeAsync(60_000); // and stops once it has it
        expect(server.fetch).toHaveBeenCalledTimes(3);
        sync.stop();
    });

    it("stops reading the list again once the stream itself fails", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const server = serverWith([]);
        server.failFrom(0);
        const { sync, streams } = start(server, { retryMs: 1000 });
        sync.start();
        streams[0]?.emit("hello", {});
        await vi.advanceTimersByTimeAsync(0);
        sync.stop();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(server.fetch).toHaveBeenCalledTimes(1);
    });

    it("is opened again, waiting longer each time, after the server refuses it", async () => {
        vi.useFakeTimers();
        const server = serverWith([note(1)]);
        const { sync, states, streams } = start(server, { retryMs: 1000 });
        sync.start();
        streams[0]?.fail(true); // a 502 from a proxy: EventSource gives up
        expect(states.at(-1)).toBe("offline");
        await vi.advanceTimersByTimeAsync(999);
        expect(streams).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(streams).toHaveLength(2);
        streams[1]?.fail(true);
        await vi.advanceTimersByTimeAsync(1999);
        expect(streams).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(streams).toHaveLength(3);
        // connected again: the list is read, and the next failure starts from the first wait again
        streams[2]?.emit("hello", {});
        await vi.advanceTimersByTimeAsync(0);
        expect(states.at(-1)).toBe("connected");
        expect(server.fetch).toHaveBeenCalled();
        streams[2]?.fail(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(streams).toHaveLength(4);
        sync.stop();
    });

    it("leaves a stream the browser is already reopening to the browser", async () => {
        vi.useFakeTimers();
        const { sync, states, streams } = start(serverWith([]), { retryMs: 1000 });
        sync.start();
        streams[0]?.fail(false);
        expect(states.at(-1)).toBe("connecting");
        await vi.advanceTimersByTimeAsync(5000);
        expect(streams).toHaveLength(1);
        sync.stop();
    });

    it("is not opened again once stopped", async () => {
        vi.useFakeTimers();
        const { sync, streams } = start(serverWith([]), { retryMs: 1000 });
        sync.start();
        streams[0]?.fail(true);
        sync.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(streams).toHaveLength(1);
    });

    it("passes a delete on, so a copy kept in this browser can follow", () => {
        const store = createMemoryStore();
        store.add({ annotation: note(1), assets: new Map() });
        const applied: string[][] = [];
        const { sync, streams } = start(serverWith([]), {
            store,
            onApplied: (c) => applied.push(c.removed),
        });
        sync.start();
        streams[0]?.emit("deleted", { id: note(1).id });
        expect(store.list()).toEqual([]);
        expect(applied).toEqual([[note(1).id]]);
        sync.stop();
    });
});
