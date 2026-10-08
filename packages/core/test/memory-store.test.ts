import { type Annotation, sampleAnnotation } from "@notato/schema";
import { describe, expect, it, vi } from "vitest";
import { type AnnotationRecord, createMemoryStore } from "../src/index.ts";

const record = (over: Partial<Annotation> = {}): AnnotationRecord => ({
    annotation: { ...sampleAnnotation, ...over },
    assets: new Map([["a".repeat(64), new Blob([new Uint8Array([137, 80, 78, 71])])]]),
});

describe("memory store", () => {
    it("filters, updates and notifies", () => {
        const store = createMemoryStore();
        const seen = vi.fn();
        store.subscribe(seen);
        const { annotation, assets } = record();
        store.add({ annotation, assets });
        expect(store.list({ route: "/checkout" })).toHaveLength(1);
        expect(store.list({ route: "/elsewhere" })).toHaveLength(0);
        store.update(annotation.id, (a) => ({ ...a, status: "resolved" }));
        expect(store.list({ status: "resolved" })).toHaveLength(1);
        expect(seen).toHaveBeenCalledTimes(2);
    });

    it("upsert creates unknown records, and keeps assets and elements when replacing", () => {
        const store = createMemoryStore();
        const { annotation, assets } = record();
        const elements = [{ tagName: "BUTTON" } as unknown as Element];
        store.add({ annotation, assets, elements });
        store.upsert({ ...annotation, status: "resolved" });
        const kept = store.get(annotation.id);
        expect(kept?.annotation.status).toBe("resolved");
        expect(kept?.assets).toBe(assets);
        expect(kept?.elements).toBe(elements);

        store.upsert({ ...annotation, id: "from-server" });
        expect(store.get("from-server")?.assets.size).toBe(0);
        expect(store.list()).toHaveLength(2);
    });

    it("upsertMany applies a whole read and tells listeners once", () => {
        const store = createMemoryStore();
        const { annotation, assets } = record();
        store.add({ annotation, assets });
        store.add(record({ id: "gone" }));
        const seen = vi.fn();
        store.subscribe(seen);

        store.upsertMany(
            [
                { ...annotation, status: "resolved" },
                { ...annotation, id: "new-1" },
                { ...annotation, id: "new-2" },
            ],
            ["gone", "never-there"]
        );
        expect(seen).toHaveBeenCalledTimes(1);
        expect(store.get(annotation.id)?.annotation.status).toBe("resolved");
        expect(store.get(annotation.id)?.assets).toBe(assets);
        expect(store.get("gone")).toBeUndefined();
        expect(store.list().map((r) => r.annotation.id)).toEqual([annotation.id, "new-1", "new-2"]);

        // Nothing to do is no update at all.
        store.upsertMany([], ["never-there"]);
        expect(seen).toHaveBeenCalledTimes(1);
        store.upsertMany([], ["new-2"]);
        expect(seen).toHaveBeenCalledTimes(2);
    });
});
