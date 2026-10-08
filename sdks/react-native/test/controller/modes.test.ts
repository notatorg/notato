import { type Annotation, Bundle } from "@notato/schema";
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { NotatoError } from "../../src/client.ts";
import { memoryStorage } from "../../src/storage.ts";
import { fakeHost, fakeServer, PNG, start } from "./harness.ts";

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

    it("says there is nothing to package before a note is made", async () => {
        const { notato } = start({ project: "shop", mode: "test" });
        await expect(notato.packageNotes()).rejects.toThrow(/Nothing to package/);
    });
});

describe("agent mode", () => {
    const ask = (requestId: string, target = "Text") => ({
        requestId,
        args: { target, comment: `Request ${requestId}`, author: "Claude" },
    });

    it("follows the project's events with the agent's requests", () => {
        const { server } = start({ project: "shop", mode: "agent" });
        expect(server.transport.follow).toHaveBeenCalledWith(
            expect.anything(),
            true,
            expect.anything(),
            expect.anything()
        );
    });

    it("files an annotate request as the agent's note and reports it", async () => {
        const { notato, server } = start({ project: "shop", mode: "agent" });
        await server.hello();
        server.send("annotate-request", ask("q1"));
        await vi.waitFor(() => expect(server.transport.relayResult).toHaveBeenCalled());
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
        server.send("annotate-request", ask("q2", "#missing"));
        await vi.waitFor(() =>
            expect(server.transport.relayResult).toHaveBeenCalledWith(expect.anything(), "q2", {
                ok: false,
                error: 'Nothing on this screen matches "#missing".',
            })
        );
    });

    it("answers requests one at a time, so one screenshot never shows another's outline", async () => {
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
        await vi.waitFor(() => expect(server.transport.relayResult).toHaveBeenCalledTimes(2));
        expect(log).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    });

    it("tells the agent a note was not filed while it is still on the device, and why", async () => {
        const { server } = start({ project: "shop", mode: "agent" });
        await server.hello();
        server.failWith(new NotatoError("cannot reach the Notato server"));
        server.send("annotate-request", ask("q3"));
        await vi.waitFor(() =>
            expect(server.transport.relayResult).toHaveBeenCalledWith(expect.anything(), "q3", {
                ok: false,
                error: "The note was made on the device but not sent: the server could not be reached. It is sent again on the next connection.",
            })
        );
        server.failWith(new NotatoError("unknown project", 404));
        server.send("annotate-request", ask("q4"));
        await vi.waitFor(() =>
            expect(server.transport.relayResult).toHaveBeenLastCalledWith(expect.anything(), "q4", {
                ok: false,
                error: "The note was made on the device but the server did not take it: unknown project. It is sent again on the next connection.",
            })
        );
    });
});
