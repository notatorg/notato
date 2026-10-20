// @vitest-environment happy-dom
import { sampleAnnotation } from "@notato/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHiddenNotes, privateScope } from "../src/view-preferences.ts";

beforeEach(() => localStorage.clear());
describe("private hidden annotations", () => {
    it("hides a batch once, keeps unfinished notes visible, and restores the whole batch", async () => {
        const changed = vi.fn();
        const hidden = createHiddenNotes(Promise.resolve("scope"), changed);
        await hidden.ready;
        changed.mockClear();
        const save = vi.spyOn(Storage.prototype, "setItem");
        const statuses: Array<typeof sampleAnnotation.status> = [
            "resolved",
            "reverted",
            "dismissed",
            "open",
            "acknowledged",
            "awaiting_response",
            "revert_requested",
            "variant_chosen",
        ];
        const notes = statuses.map((status, i) => ({
            ...sampleAnnotation,
            id: `note-${i}`,
            status,
        }));
        const original = structuredClone(notes);
        try {
            await hidden.hideMany([...notes, ...notes]);
            expect(notes.map((a) => hidden.has(a))).toEqual([
                true,
                true,
                true,
                false,
                false,
                false,
                false,
                false,
            ]);
            expect(hidden.count()).toBe(3);
            expect(changed).toHaveBeenCalledTimes(1);
            expect(save).toHaveBeenCalledTimes(1);
            expect(notes).toEqual(original);

            const reload = createHiddenNotes(Promise.resolve("scope"), () => {});
            await reload.ready;
            expect(notes.map((a) => reload.has(a))).toEqual(notes.map((a) => hidden.has(a)));
            reload.clear();
            expect(notes.some((a) => reload.has(a))).toBe(false);

            await hidden.hideMany(notes);
            expect(changed).toHaveBeenCalledTimes(1);
        } finally {
            save.mockRestore();
        }
    });

    it("keeps every note in a large batch hidden after a reload", async () => {
        const hidden = createHiddenNotes(Promise.resolve("scope"), () => {});
        const notes = Array.from({ length: 2001 }, (_, i) => ({
            ...sampleAnnotation,
            id: `note-${i}`,
            status: "resolved" as const,
        }));
        await hidden.hideMany(notes);
        const reload = createHiddenNotes(Promise.resolve("scope"), () => {});
        await reload.ready;
        expect(reload.count()).toBe(notes.length);
        expect(notes.every((a) => reload.has(a))).toBe(true);
    });

    it("waits for saved preferences before adding a batch", async () => {
        localStorage.setItem("notato:hidden:scope", '["saved"]');
        let resolve!: (scope: string) => void;
        const hidden = createHiddenNotes(
            new Promise<string>((done) => {
                resolve = done;
            }),
            () => {}
        );
        const a = { ...sampleAnnotation, id: "new", status: "resolved" as const };
        const hiding = hidden.hideMany([a]);
        resolve("scope");
        await hiding;
        expect(hidden.count()).toBe(2);
        expect(hidden.has(a)).toBe(true);
        expect(JSON.parse(localStorage.getItem("notato:hidden:scope") ?? "[]")).toEqual([
            "saved",
            "new",
        ]);
    });

    it("retains data, survives reload, and reveals a reopened or questioning note", async () => {
        const changed = vi.fn();
        const hidden = createHiddenNotes(Promise.resolve("scope"), changed);
        const a = { ...sampleAnnotation, status: "resolved" as const };
        await hidden.hide(a);
        expect(hidden.has(a)).toBe(true);
        expect(a.thread).toEqual(sampleAnnotation.thread);
        expect(hidden.has({ ...a, status: "awaiting_response" })).toBe(false);
        expect(hidden.has({ ...a, status: "open" })).toBe(false);
        const reload = createHiddenNotes(Promise.resolve("scope"), changed);
        await reload.ready;
        expect(reload.has(a)).toBe(true);
        reload.clear();
        expect(reload.has(a)).toBe(false);
        const other = createHiddenNotes(Promise.resolve("other"), changed);
        await other.ready;
        expect(other.has(a)).toBe(false);
    });
    it("separates destinations, projects and credentials without writing the secret to a key", async () => {
        const a = await privateScope(["https://test.example", "p", "token1"]);
        expect(a).not.toContain("token1");
        expect(a).toBe(await privateScope(["https://test.example", "p", "token1"]));
        expect(a).not.toBe(await privateScope(["https://test.example", "p", "token2"]));
        expect(a).not.toBe(await privateScope(["https://other.example", "p", "token1"]));
    });
});

it("keeps private draft scopes stable on local HTTP without Web Crypto", async () => {
    const normal = await privateScope(["http://192.168.1.10", "p", "token"]);
    vi.stubGlobal("crypto", undefined);
    try {
        expect(await privateScope(["http://192.168.1.10", "p", "token"])).toBe(normal);
    } finally {
        vi.unstubAllGlobals();
    }
});
