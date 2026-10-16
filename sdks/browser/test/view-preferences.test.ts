// @vitest-environment happy-dom
import { sampleAnnotation } from "@notato/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHiddenNotes, privateScope } from "../src/view-preferences.ts";

beforeEach(() => localStorage.clear());
describe("private hidden annotations", () => {
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
