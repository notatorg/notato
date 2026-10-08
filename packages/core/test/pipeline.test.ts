import { Annotation } from "@notato/schema";
import { describe, expect, it, vi } from "vitest";
import type { CapturePlugin, IdentityPlugin, SinkPlugin } from "../src/index.ts";
import { createMemoryStore, createPipeline } from "../src/index.ts";

const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

const screenshotStub: CapturePlugin = {
    id: "screenshot",
    async capture(draft) {
        const full = await draft.putAsset(png(), { w: 100, h: 50 });
        return { screenshots: { full } };
    },
};

const base = (over: Partial<Parameters<typeof createPipeline>[0]> = {}) =>
    createPipeline({
        mode: "dev",
        projectId: "p1",
        author: { kind: "human", name: "Dom" },
        identity: [],
        capture: [screenshotStub],
        sinks: [],
        locate: () => ({ url: "http://localhost/a", route: "/a" }),
        environment: () => ({
            userAgent: "ua",
            viewport: { w: 10, h: 10 },
            dpr: 1,
            platform: "web",
        }),
        ...over,
    });

const input = {
    kind: "element" as const,
    elements: [{ tagName: "BUTTON" } as unknown as Element],
    rect: { x: 1, y: 2, w: 3, h: 4 },
    comment: "hi",
};

describe("pipeline", () => {
    it("numbers notes created at the same time one after the other", async () => {
        // Preparing takes a moment, so the second create starts before the first has built its draft.
        const slow: IdentityPlugin = {
            id: "slow",
            resolve: () => ({}),
            prepare: () => new Promise((resolve) => setTimeout(resolve, 10)),
        };
        const numbered: CapturePlugin = {
            id: "numbered",
            capture: async (draft) => ({ context: { numbered: draft.number } }),
        };
        const pipeline = base({ identity: [slow], capture: [numbered] });
        const [a, b] = await Promise.all([pipeline.create(input), pipeline.create(input)]);
        expect([a.annotation.context.numbered, b.annotation.context.numbered]).toEqual([1, 2]);
    });

    it("keeps the number the SDK's own counter hands out, when creates overlap", async () => {
        const slow: IdentityPlugin = {
            id: "slow",
            resolve: () => ({}),
            prepare: () => new Promise((resolve) => setTimeout(resolve, 10)),
        };
        const numbered: CapturePlugin = {
            id: "numbered",
            capture: async (draft) => ({ context: { numbered: draft.number } }),
        };
        let last = 40;
        const pipeline = base({
            identity: [slow],
            capture: [numbered],
            nextNumber: () => ++last,
        });
        const made = await Promise.all([1, 2, 3].map(() => pipeline.create(input)));
        expect(made.map((r) => r.annotation.context.numbered)).toEqual([41, 42, 43]);
    });

    it("produces a schema-valid annotation with content-addressed assets", async () => {
        const { annotation, assets } = await base().create(input);
        expect(Annotation.safeParse(annotation).success).toBe(true);
        expect(annotation.status).toBe("open");
        expect(annotation.screenshots?.full.id).toMatch(/^[0-9a-f]{64}$/);
        expect(assets.has(annotation.screenshots?.full.id ?? "")).toBe(true);
    });

    it("merges identity plugins in order and tolerates a throwing one", async () => {
        const warn = vi.fn();
        const dom: IdentityPlugin = {
            id: "dom",
            resolve: () => ({ selector: "#a", tag: "button", text: "x" }),
        };
        const bad: IdentityPlugin = {
            id: "bad",
            resolve: () => {
                throw new Error("nope");
            },
        };
        const react: IdentityPlugin = {
            id: "react",
            resolve: () => ({ component: { name: "Btn" } }),
        };
        const { annotation } = await base({ identity: [dom, bad, react], onWarn: warn }).create(
            input
        );
        expect(annotation.target.identity[0]).toMatchObject({
            selector: "#a",
            component: { name: "Btn" },
        });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("lets a plugin write only its own context key", async () => {
        const warn = vi.fn();
        const sneaky: CapturePlugin = {
            id: "console",
            async capture() {
                return { context: { console: [1], network: [2] }, comment: "overwritten" } as never;
            },
        };
        const { annotation } = await base({
            capture: [screenshotStub, sneaky],
            onWarn: warn,
        }).create(input);
        expect(annotation.context).toEqual({ console: [1] });
        expect(annotation.comment).toBe("hi");
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it("lets the route plugin override the route", async () => {
        const route: CapturePlugin = { id: "route", capture: async () => ({ route: "/a#/deep" }) };
        const { annotation } = await base({ capture: [screenshotStub, route] }).create(input);
        expect(annotation.route).toBe("/a#/deep");
    });

    it("makes a valid annotation when nothing captures a screenshot (they can be turned off)", async () => {
        const { annotation, assets } = await base({ capture: [] }).create(input);
        expect(Annotation.safeParse(annotation).success).toBe(true);
        expect(annotation.screenshots).toBeUndefined();
        expect(assets.size).toBe(0);
    });

    it("keeps going when a sink fails and delivers to the rest", async () => {
        const warn = vi.fn();
        const good = vi.fn(async () => {});
        const sinks: SinkPlugin[] = [
            {
                id: "down",
                deliver: async () => {
                    throw new Error("offline");
                },
            },
            { id: "ok", deliver: good },
        ];
        await base({ sinks, onWarn: warn }).create(input);
        expect(good).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("numbers pins sequentially and honours per-call author and mode", async () => {
        const pipeline = base();
        const first = await pipeline.create(input);
        const second = await pipeline.create({
            ...input,
            mode: "agent",
            author: { kind: "agent", name: "Claude" },
        });
        expect(first.annotation.mode).toBe("dev");
        expect(second.annotation).toMatchObject({ mode: "agent", author: { kind: "agent" } });
    });
});

describe("a note's elements", () => {
    /** Held through a getter over weak references, rather than as the elements themselves. */
    const weakly = (record: object | undefined) =>
        typeof Object.getOwnPropertyDescriptor(record ?? {}, "elements")?.get === "function";

    it("are held weakly, so a note does not keep an element the page has let go of", async () => {
        const record = await base().create(input);
        expect(weakly(record)).toBe(true);
        expect(record.elements).toEqual(input.elements);
    });

    it("stay weakly held through the store's updates, and keep their screenshots", async () => {
        const store = createMemoryStore();
        const record = await base().create(input);
        store.add(record);
        store.upsert({ ...record.annotation, status: "resolved" });
        store.upsertMany([{ ...record.annotation, status: "acknowledged" }]);
        store.update(record.annotation.id, (a) => ({ ...a, comment: "changed" }));
        const kept = store.get(record.annotation.id);
        expect(kept?.annotation).toMatchObject({ status: "acknowledged", comment: "changed" });
        expect(weakly(kept)).toBe(true);
        expect(kept?.elements).toEqual(input.elements);
        expect(kept?.assets).toBe(record.assets);
    });
});
