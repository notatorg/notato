import { type Annotation, sampleAnnotation } from "@notato/schema";
import { describe, expect, it, vi } from "vitest";
import { PLATFORM } from "../../src/annotation.ts";
import type { NotatoController } from "../../src/controller.ts";
import { HiddenAnnotations } from "../../src/hidden.ts";
import { memoryStorage } from "../../src/storage.ts";
import { fakeServer, start } from "./harness.ts";

describe("hiding annotations on this device", () => {
    it("works in Hermes without browser encoding or crypto globals", () => {
        vi.stubGlobal("TextEncoder", undefined);
        vi.stubGlobal("crypto", undefined);
        try {
            const hidden = new HiddenAnnotations();
            hidden.select(["https://stub.test", "shop", "dev", "credential", "Alice"]);
            hidden.hide([{ ...sampleAnnotation, status: "resolved" }]);
            expect(hidden.ids.size).toBe(1);
            expect(hidden.encoded).not.toContain("credential");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("hides across screens beyond the pin limit, keeps all feedback, survives restart and restores", async () => {
        const server = fakeServer();
        const storage = memoryStorage();
        const notes = Array.from({ length: 2001 }, (_, i) => ({
            ...sampleAnnotation,
            id: `done-${i}`,
            projectId: "shop",
            route: i % 2 ? "/shop" : "/other",
            status: "resolved" as const,
        }));
        for (const a of notes) server.stored.set(a.id, a);
        const active = {
            ...sampleAnnotation,
            projectId: "shop",
            id: "active",
            status: "awaiting_response" as const,
            route: "/shop",
        };
        server.stored.set(active.id, active);
        const config = {
            project: "shop",
            server: "http://stub.test",
            token: "test-credential",
            allowTokenInRelease: true,
            rememberRuntimeState: true,
        };
        let { notato } = start(config, server, storage);
        await server.hello();
        const nextPin = notato.nextPin("/shop");
        const numbers = new Map(
            notato.notesOn("/shop").map((n) => [n.record.annotation.id, n.number])
        );
        notato.hideAnnotation("active");
        expect(notato.hiddenCount).toBe(0);
        notato.hideAnnotation("done-0");
        expect(notato.hiddenCount).toBe(1);
        notato.hideCompleted();
        expect(notato.completedCount).toBe(0);
        expect(notato.hiddenCount).toBe(2001);
        expect(notato.notesOn("/other")).toEqual([]);
        expect(notato.notesOn("/shop").map((n) => n.record.annotation.id)).toEqual(["active"]);
        expect(notato.getState().notes).toHaveLength(2002);
        expect(notato.nextPin("/shop")).toBe(nextPin);
        expect(server.transport.remove).not.toHaveBeenCalled();
        expect(server.transport.setStatus).not.toHaveBeenCalled();
        expect(JSON.stringify(storage.loadSettings())).not.toContain("test-credential");
        notato.disable();
        ({ notato } = start(config, server, storage));
        notato.enable();
        await server.hello();
        expect(notato.hiddenCount).toBe(2001);
        expect(notato.visibleCount).toBe(1);
        await server.event("updated", { annotation: { ...notes[0], status: "open" } });
        expect(notato.visibleCount).toBe(2);
        await server.event("updated", { annotation: { ...notes[1], status: "awaiting_response" } });
        expect(
            notato.notesOn("/shop").find((n) => n.record.annotation.id === notes[1]?.id)?.number
        ).toBe(numbers.get("done-1"));
        expect(notato.visibleCount).toBe(3);
        notato.restoreHidden();
        expect(notato.visibleCount).toBe(2002);
        expect(notato.hiddenCount).toBe(0);
        notato.disable();
    });

    it("hides every done note, those finished later too, until it is switched off, and remembers it", async () => {
        const server = fakeServer();
        const storage = memoryStorage();
        const note = (id: string, status: Annotation["status"]) => ({
            ...sampleAnnotation,
            id,
            projectId: "shop",
            route: "/shop",
            status,
            environment: { ...sampleAnnotation.environment, platform: PLATFORM },
        });
        for (const a of [
            note("resolved", "resolved"),
            note("reverted", "reverted"),
            note("dismissed", "dismissed"),
            note("open", "open"),
            note("later", "awaiting_response"),
        ])
            server.stored.set(a.id, a);
        const config = {
            project: "shop",
            server: "http://stub.test",
            token: "test-credential",
            allowTokenInRelease: true,
            rememberRuntimeState: true,
        };
        const change = async (a: Annotation) => {
            server.stored.set(a.id, a);
            await server.event("updated", { annotation: a });
        };
        const shown = (n: NotatoController) =>
            n.notesOn("/shop").map((x) => x.record.annotation.id);
        let { notato } = start(config, server, storage);
        await server.hello();
        expect(notato.getState().hideDone).toBe(false);
        expect(shown(notato)).toHaveLength(5);

        notato.setHideDone(true);
        expect(notato.getState().hideDone).toBe(true);
        expect(shown(notato)).toEqual(["later", "open"]);
        expect(notato.pinsOn("/shop").map((x) => x.record.annotation.id)).toEqual([
            "later",
            "open",
        ]);
        expect(notato.visibleCount).toBe(2);
        expect(notato.completedCount).toBe(0);
        // The switch hides nothing one at a time, and changes nothing on the server.
        expect(notato.hiddenCount).toBe(0);
        expect(server.transport.setStatus).not.toHaveBeenCalled();

        // Finished after the switch went on: hidden too.
        await change(note("later", "resolved"));
        expect(shown(notato)).toEqual(["open"]);
        expect(notato.visibleCount).toBe(1);

        // Reopened: back by itself, with its pin number.
        await change(note("resolved", "open"));
        expect(notato.notesOn("/shop").map((x) => [x.record.annotation.id, x.number])).toEqual([
            ["open", 3],
            ["resolved", 4],
        ]);

        // Remembered across a restart.
        expect(storage.loadSettings()).toMatchObject({ hideDone: true });
        notato.disable();
        ({ notato } = start(config, server, storage));
        notato.enable();
        await server.hello();
        expect(notato.getState().hideDone).toBe(true);
        expect(shown(notato)).toEqual(["open", "resolved"]);

        // Off: every note shows again.
        notato.setHideDone(false);
        expect(notato.getState().hideDone).toBe(false);
        expect(shown(notato)).toHaveLength(5);
        expect(notato.visibleCount).toBe(5);
        expect(storage.loadSettings()).not.toHaveProperty("hideDone");
        notato.disable();
    });

    it("keeps notes hidden one at a time when the switch goes off", async () => {
        const server = fakeServer();
        for (const id of ["a", "b"])
            server.stored.set(id, {
                ...sampleAnnotation,
                id,
                projectId: "shop",
                route: "/shop",
                status: "resolved",
            });
        const { notato } = start({ project: "shop", server: "http://stub.test" }, server);
        await server.hello();
        notato.hideAnnotation("a");
        notato.setHideDone(true);
        expect(notato.notesOn("/shop")).toEqual([]);
        notato.setHideDone(false);
        expect(notato.notesOn("/shop").map((x) => x.record.annotation.id)).toEqual(["b"]);
        expect(notato.hiddenCount).toBe(1);
        notato.restoreHidden();
        expect(notato.notesOn("/shop")).toHaveLength(2);
        notato.disable();
    });

    it("separates destinations, projects, modes and credentials without storing the credential", () => {
        const hidden = new HiddenAnnotations();
        const parts = ["http://stub.test", "shop", "dev", "credential", "Alice"];
        hidden.select(parts);
        hidden.hide([{ ...sampleAnnotation, status: "resolved" }]);
        const saved = hidden.encoded;
        expect(saved).not.toContain("credential");
        for (let i = 0; i < parts.length; i++) {
            hidden.select(
                parts.map((part, j) => (i === j ? "other" : part)),
                saved
            );
            expect(hidden.ids.size).toBe(0);
        }
        hidden.select(parts, saved);
        expect(hidden.ids.size).toBe(1);
    });
});
