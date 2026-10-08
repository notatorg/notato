import type { Annotation } from "@notato/schema";
import { describe, expect, it, vi } from "vitest";
import { NotatoError } from "../../src/client.ts";
import { fakeServer, holdSends, settle, start } from "./harness.ts";

describe("the server's changes", () => {
    it("are followed, and a note deleted there is forgotten", async () => {
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

    it("keep a newer copy the events brought while a note was on its way", async () => {
        const server = fakeServer();
        const release = holdSends(server, "after");
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

    it("come after the notes kept on the device are sent, and before the list is read", async () => {
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

    it("that came while the list was read are applied over it: the list may be older", async () => {
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

    it("forget nothing when the server's list cannot be read to its end", async () => {
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
});

describe("pins", () => {
    it("go only to the notes made in a React Native app; the others stay in the list", async () => {
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

    it("are numbered per screen, and keep up with ten thousand notes", async () => {
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
