import { Bundle } from "@notato/schema";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotatoError } from "../../src/client.ts";
import { memoryStorage } from "../../src/storage.ts";
import { fakeServer, settle, start } from "./harness.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

/** A server reached with a capture-only token: it takes new notes from the app, and nothing else. */
function captureOnlyServer() {
    const server = fakeServer();
    server.transport.config = vi.fn(async () => ({ screenshots: true, captureOnly: true }));
    return server;
}

describe("screenshots", () => {
    it("are not taken until the server has said it takes them", async () => {
        const server = fakeServer();
        server.transport.config = vi.fn(async () => {
            throw new NotatoError("cannot reach the Notato server");
        });
        const { notato } = start({ project: "shop" }, server);
        const a = await notato.annotate("Text", "No answer yet");
        expect(a.screenshots).toBeUndefined();
        expect(notato.getState().serverScreenshots).toBe(false);
    });

    it("are taken with no server at all: the notes stay on the device", async () => {
        const { notato, server } = start({ project: "shop", mode: "test" });
        const a = await notato.annotate("Text", "Offline tester");
        expect(a.screenshots).toBeDefined();
        expect(server.transport.config).not.toHaveBeenCalled();
    });

    it("follow test mode's server too, and a package leaves them out once it has them off", async () => {
        const server = fakeServer();
        const { notato } = start(
            { project: "shop", mode: "test", server: "http://localhost:4799" },
            server
        );
        const first = await notato.annotate("Text", "With a screenshot");
        expect(first.screenshots).toBeDefined();
        expect(server.transport.config).toHaveBeenCalled();

        // The operator turns them off. The package asks again, and shares what it says.
        server.transport.config = vi.fn(async () => ({ screenshots: false }));
        const { zip, screenshots } = await notato.packageNotes({ upload: false });
        expect(screenshots).toBe(false);
        const files = unzipSync(zip);
        expect(Object.keys(files).sort()).toEqual(["annotations.json", "feedback.md"]);
        const bundle = Bundle.parse(
            JSON.parse(new TextDecoder().decode(files["annotations.json"]))
        );
        expect(bundle.annotations[0]?.screenshots).toBeUndefined();

        // A screenshot asks again once the last answer is a few seconds old.
        const later = Date.now() + 10_000;
        vi.spyOn(Date, "now").mockReturnValue(later);
        server.transport.config = vi.fn(async () => ({ screenshots: false }));
        const second = await notato.annotate("Text", "Without");
        expect(server.transport.config).toHaveBeenCalled();
        expect(second.screenshots).toBeUndefined();
    });
});

describe("a capture-only token", () => {
    it("sends notes without following the events or reading the list, and changes none", async () => {
        const server = captureOnlyServer();
        const { notato } = start({ project: "shop" }, server);
        await settle();
        expect(server.transport.follow).not.toHaveBeenCalled();
        expect(notato.getState()).toMatchObject({ connection: "connected", captureOnly: true });

        const a = await notato.annotate("Text", "Sent, never read back");
        expect(server.stored.has(a.id)).toBe(true);
        expect(a.screenshots).toBeDefined();
        expect(server.transport.list).not.toHaveBeenCalled();
        expect(notato.getState().pendingCount).toBe(0);

        await expect(notato.reply(a.id, "More")).rejects.toThrow(/Notato board/);
        await expect(notato.requestRevert(a.id)).rejects.toThrow(/Notato board/);
        await expect(notato.setPeopleOnly(a.id, true)).rejects.toThrow(/Notato board/);
        await expect(notato.delete(a.id)).rejects.toThrow(/Notato board/);
        expect(server.transport.reply).not.toHaveBeenCalled();
        expect(server.transport.remove).not.toHaveBeenCalled();
        expect(notato.getState().notes).toHaveLength(1);
    });

    it("sends the notes kept on the device, and tries again when it could not", async () => {
        const storage = memoryStorage();
        const server = captureOnlyServer();
        server.failWith(new NotatoError("cannot reach the Notato server"));
        const { notato } = start({ project: "shop" }, server, storage);
        await settle();
        await notato.annotate("Text", "Kept");
        expect(notato.getState()).toMatchObject({ pendingCount: 1, connection: "offline" });

        // The next launch sends it straight away.
        server.failWith(undefined);
        const again = start({ project: "shop" }, server, storage).notato;
        await settle();
        expect(again.getState()).toMatchObject({ pendingCount: 0, connection: "connected" });
        expect(server.stored.size).toBe(1);
        expect(server.transport.follow).not.toHaveBeenCalled();
    });

    it("keeps a conflicting capture and marks it refused instead of assuming delivery", async () => {
        const server = captureOnlyServer();
        const { notato } = start({ project: "shop" }, server);
        await settle();
        server.failWith(new NotatoError("annotation id already exists", 409));
        await notato.annotate("Text", "Landed before");
        expect(notato.getState().pendingCount).toBe(1);
        expect(notato.getState().notes[0]?.failed).toContain("already exists");
    });

    it("is found out when the server could not be asked first and then refuses the stream", async () => {
        const server = fakeServer();
        let asked = 0;
        server.transport.config = vi.fn(async () => {
            if (asked++ === 0) throw new NotatoError("cannot reach the Notato server");
            return { screenshots: true, captureOnly: true };
        });
        const { notato } = start({ project: "shop" }, server);
        await server.refuse();
        expect(notato.getState()).toMatchObject({ connection: "connected", captureOnly: true });
        const stream = vi.mocked(server.transport.follow).mock.results[0]?.value as {
            stop(): void;
        };
        expect(stream.stop).toHaveBeenCalled();
    });

    it("uploads test-mode captures as a batch with a capture-only token", async () => {
        const server = captureOnlyServer();
        const { notato } = start(
            { project: "shop", mode: "test", server: "http://localhost:4799" },
            server
        );
        await notato.annotate("Text", "x");
        expect((await notato.packageNotes()).uploaded).toBe(true);
        expect(server.transport.uploadBundle).toHaveBeenCalledOnce();
    });
});

describe("recorded requests", () => {
    it("keep neither the query string nor a user name and password", async () => {
        const { notato, server } = start({ project: "shop" });
        await server.hello();
        notato.recordRequest({
            method: "get",
            url: "https://dom:hunter2@api.example.com/orders?key=abc#top",
            status: 200,
            durationMs: 12.4,
        });
        const a = await notato.annotate("Text", "Slow list");
        const network = (a.context as { network?: Array<{ url: string }> }).network;
        expect(network?.[0]?.url).toBe("https://api.example.com/orders");
    });
});
