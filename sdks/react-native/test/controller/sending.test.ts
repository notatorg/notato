import { Annotation } from "@notato/schema";
import { describe, expect, it } from "vitest";
import { NotatoError } from "../../src/client.ts";
import { memoryStorage } from "../../src/storage.ts";
import { fakeHost, fakeServer, holdSends, settle, start } from "./harness.ts";

describe("sending a note", () => {
    it("sends it with its screenshot, and takes the server's copy", async () => {
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

    it("sends a note without a screenshot its storage cannot read, rather than hold the queue", async () => {
        const storage = memoryStorage();
        storage.loadAsset = () => {
            throw new Error("unreadable");
        };
        const { notato, server } = start({ project: "shop" }, fakeServer(), storage);
        server.failWith(new NotatoError("cannot reach the Notato server"));
        await notato.annotate("Text", "Kept");
        // A restart: the screenshot is only in storage now.
        const again = start({ project: "shop" }, server, storage).notato;
        server.failWith(undefined);
        await server.hello();
        expect(again.getState().pendingCount).toBe(0);
        expect(server.calls.at(-1)).toMatch(/ 0$/);
    });

    it("deletes on the server a note deleted here while it was on its way", async () => {
        const server = fakeServer();
        const release = holdSends(server);
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

    it("does so even when Notato restarted meanwhile", async () => {
        const server = fakeServer();
        const release = holdSends(server);
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

    it("rejects a target it cannot find, and a note with nothing to say", async () => {
        const { notato } = start({ project: "shop" });
        await expect(notato.annotate("#missing", "x")).rejects.toThrow(/Nothing on this screen/);
        await expect(notato.annotate("Text", "   ")).rejects.toThrow(/comment/);
    });
});
