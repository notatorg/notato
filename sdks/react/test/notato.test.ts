import type { NotatoProps } from "@notato/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startKey, startToolbar } from "../src/Notato.ts";

const base: NotatoProps = { project: "shop", server: "http://localhost:4799" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.restoreAllMocks());

describe("what restarts the toolbar", () => {
    it("is any plain prop changing: the token, the author, keeping notes, and the rest", () => {
        const first = startKey(base);
        for (const change of [
            { token: "t2" },
            { author: "Ana" },
            { persist: true },
            { maskInputs: false },
            { screenshots: false },
            { styles: false },
            { nonce: "abc" },
            { testIdAttributes: ["data-qa"] },
        ] satisfies Partial<NotatoProps>[])
            expect(startKey({ ...base, ...change }), JSON.stringify(change)).not.toBe(first);
    });

    it("is not an array written inline again with the same things in it, or a new plugins array", () => {
        const a = startKey({ ...base, testIdAttributes: ["data-qa"], plugins: [] });
        const b = startKey({ ...base, testIdAttributes: ["data-qa"], plugins: [] });
        expect(b).toBe(a);
    });
});

describe("starting the toolbar", () => {
    it("starts it with the props as they are when it has loaded, and stops it", async () => {
        const destroy = vi.fn();
        const createController = vi.fn(() => ({ destroy }) as never);
        let props: NotatoProps = base;
        const stop = startToolbar(
            async () => ({ createController }),
            () => props
        );
        props = { ...base, author: "Ana" }; // rendered again while it was loading
        await settle();
        expect(createController).toHaveBeenCalledWith({ ...base, author: "Ana" });
        stop();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it("never starts it once stopped before it has loaded", async () => {
        const createController = vi.fn();
        const stop = startToolbar(
            async () => ({ createController }),
            () => base
        );
        stop();
        await settle();
        expect(createController).not.toHaveBeenCalled();
    });

    it("says why when it cannot load or start, instead of failing silently", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        startToolbar(
            () => Promise.reject(new Error("chunk failed to load")),
            () => base
        );
        await settle();
        expect(warn).toHaveBeenCalledWith(
            "[notato] the toolbar could not start",
            expect.objectContaining({ message: "chunk failed to load" })
        );
    });
});
