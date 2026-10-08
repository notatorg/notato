import { describe, expect, it } from "vitest";
import { NoteStore } from "../src/notes.ts";
import { annotation } from "./fixtures.ts";

const note = (id: string, route: string, pending = false) => ({
    annotation: annotation({ id, route, createdAt: `2026-10-0${id.length}T10:00:00.000Z` }),
    pending,
    mine: pending,
});

describe("NoteStore", () => {
    it("counts the pending notes as they are put, replaced and removed", () => {
        const store = new NoteStore();
        store.replace([note("a", "/shop", true), note("bb", "/shop")]);
        expect(store.pendingCount).toBe(1);
        store.edit((notes) => {
            notes.put({ ...note("a", "/shop"), mine: true });
            notes.put(note("ccc", "/basket", true));
            notes.remove("bb");
        });
        expect(store.pendingCount).toBe(1);
        expect(store.all.map((r) => r.annotation.id)).toEqual(["a", "ccc"]);
        expect(store.get("ccc")?.pending).toBe(true);
        expect(store.get("bb")).toBeUndefined();
    });

    it("works a screen's numbered notes out again only when one of them changed", () => {
        const store = new NoteStore();
        store.replace([note("bb", "/shop"), note("a", "/shop"), note("ccc", "/basket")]);
        const shop = store.notesOn("shop");
        expect(shop.map((n) => [n.number, n.record.annotation.id])).toEqual([
            [1, "a"],
            [2, "bb"],
        ]);
        const basket = store.notesOn("/basket");
        expect(store.update("ccc", (r) => ({ ...r, pending: true }))).toBe(true);
        expect(store.notesOn("/shop")).toBe(shop);
        expect(store.notesOn("/basket")).not.toBe(basket);
        expect(store.notesOn("/nowhere")).toBe(store.notesOn("/elsewhere"));
        expect(store.edit(() => undefined)).toBe(false);
    });
});
