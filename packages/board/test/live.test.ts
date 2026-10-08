import { beforeEach, describe, expect, it } from "bun:test";
import {
    createLive,
    hasUnseen,
    type LiveOptions,
    lastSeen,
    markSeen,
    retryDelay,
    type StreamLike,
} from "../src/live.ts";

/** An EventSource as far as the hub uses one, driven by the test. */
class FakeStream implements StreamLike {
    readyState = 0;
    onerror: ((ev: Event) => void) | null = null;
    closed = false;
    private handlers = new Map<string, Array<(ev: Event) => void>>();
    addEventListener(type: string, fn: (ev: Event) => void) {
        this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
    }
    close() {
        this.closed = true;
        this.readyState = 2;
    }
    emit(type: string, data: unknown = {}) {
        for (const fn of this.handlers.get(type) ?? [])
            fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
    /** The browser gave up: a 401 or a 502 instead of a stream. */
    refuse() {
        this.readyState = 2;
        this.onerror?.(new Event("error"));
    }
    /** The connection dropped; the browser retries it by itself. */
    drop() {
        this.readyState = 0;
        this.onerror?.(new Event("error"));
    }
}

function setup(signedIn: () => Promise<boolean> = async () => true) {
    const streams: FakeStream[] = [];
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    let signedOut = 0;
    const options: LiveOptions = {
        open: () => {
            const s = new FakeStream();
            streams.push(s);
            return s;
        },
        signedIn,
        onSignedOut: () => {
            signedOut += 1;
        },
        setTimeout: (fn, ms) => {
            const t = { fn, ms, cleared: false };
            timers.push(t);
            return t;
        },
        clearTimeout: (t) => {
            (t as { cleared: boolean }).cleared = true;
        },
    };
    const live = createLive(options);
    const fire = () => {
        const pending = timers.filter((t) => !t.cleared);
        timers.length = 0;
        for (const t of pending) t.fn();
        return pending.map((t) => t.ms);
    };
    return { live, streams, timers, fire, signedOut: () => signedOut };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the live stream", () => {
    it("opens one stream while anything listens, and closes it when nothing does", () => {
        const { live, streams } = setup();
        const off1 = live.subscribe(() => {});
        const off2 = live.watch(() => {});
        expect(streams).toHaveLength(1);
        off1();
        expect(streams[0]?.closed).toBe(false);
        off2();
        expect(streams[0]?.closed).toBe(true);
    });

    it("hands every change to the listeners", () => {
        const { live, streams } = setup();
        const heard: string[] = [];
        live.subscribe((e) => heard.push(`${e.type}:${e.id}`));
        streams[0]?.emit("updated", { id: "01A", projectId: "p" });
        streams[0]?.emit("deleted", { id: "01B", projectId: "p" });
        expect(heard).toEqual(["updated:01A", "deleted:01B"]);
    });

    it("reopens a stream the browser gave up on, with backoff, and reloads once it is back", async () => {
        const { live, streams, fire } = setup();
        let resyncs = 0;
        live.subscribe(
            () => {},
            () => {
                resyncs += 1;
            }
        );
        streams[0]?.emit("hello");
        expect(live.state()).toBe("live");

        streams[0]?.refuse();
        expect(live.state()).toBe("offline");
        await settle();
        expect(fire()).toEqual([1000]);
        expect(streams).toHaveLength(2);

        // Still failing: it waits longer each time.
        streams[1]?.refuse();
        await settle();
        expect(fire()).toEqual([2000]);
        streams[2]?.refuse();
        await settle();
        expect(fire()).toEqual([4000]);

        streams[3]?.emit("hello");
        expect(live.state()).toBe("live");
        expect(resyncs).toBe(1);
        // Back to a short wait after a success.
        streams[3]?.refuse();
        await settle();
        expect(fire()).toEqual([1000]);
    });

    it("leaves a dropped connection to the browser's own retry", async () => {
        const { live, streams, timers } = setup();
        live.subscribe(() => {});
        streams[0]?.emit("hello");
        streams[0]?.drop();
        await settle();
        expect(live.state()).toBe("offline");
        expect(timers).toHaveLength(0);
        expect(streams[0]?.closed).toBe(false);
    });

    it("sends the person to sign in when the session is over, instead of retrying", async () => {
        const { live, streams, timers, signedOut } = setup(async () => false);
        live.subscribe(() => {});
        streams[0]?.emit("hello");
        streams[0]?.refuse();
        await settle();
        expect(signedOut()).toBe(1);
        expect(timers).toHaveLength(0);
        expect(streams).toHaveLength(1);
    });

    it("keeps trying when the server cannot even say who is signed in", async () => {
        const { live, streams, fire } = setup(async () => {
            throw new Error("502");
        });
        live.subscribe(() => {});
        streams[0]?.refuse();
        await settle();
        expect(fire()).toEqual([1000]);
        expect(streams).toHaveLength(2);
    });

    it("stops retrying once nothing listens", async () => {
        const { live, streams, timers } = setup();
        const off = live.subscribe(() => {});
        streams[0]?.refuse();
        await settle();
        expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
        off();
        expect(timers.filter((t) => !t.cleared)).toHaveLength(0);
    });

    it("waits at most 30 s between tries", () => {
        expect([0, 1, 2, 3, 4, 5, 6, 10].map(retryDelay)).toEqual([
            1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
        ]);
    });
});

describe("what this browser has seen", () => {
    beforeEach(() => {
        const store = new Map<string, string>();
        globalThis.localStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
            key: () => null,
            length: 0,
        } as Storage;
    });

    it("keeps the server's time, and only moves it forwards", () => {
        markSeen("p", "2026-10-06T10:00:00.000Z");
        markSeen("p", "2026-10-06T09:00:00.000Z");
        expect(lastSeen("p")).toBe("2026-10-06T10:00:00.000Z");
        markSeen("p", null);
        expect(lastSeen("p")).toBe("2026-10-06T10:00:00.000Z");
    });

    it("marks a project new only for activity later than what was seen", () => {
        expect(hasUnseen("p", "2026-10-06T10:00:00.000Z")).toBe(false); // never opened here
        markSeen("p", "2026-10-06T10:00:00.000Z");
        expect(hasUnseen("p", "2026-10-06T10:00:00.000Z")).toBe(false);
        expect(hasUnseen("p", "2026-10-06T10:00:01.000Z")).toBe(true);
    });
});
