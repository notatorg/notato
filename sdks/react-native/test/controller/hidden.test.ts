import { sampleAnnotation } from "@notato/schema";
import { describe, expect, it, vi } from "vitest";
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
