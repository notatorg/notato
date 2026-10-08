// @vitest-environment node
import type { AnnotationRecord } from "@notato/core";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createIdbPersistence } from "../src/persist.ts";

const record = (n: number, over: Partial<Annotation> = {}): AnnotationRecord => {
    const annotation: Annotation = {
        ...sampleAnnotation,
        id: `01TEST${n}`,
        createdAt: `2026-10-05T10:00:0${n}.000Z`,
        screenshots: {
            full: { id: `full-${n}`, mime: "image/png", w: 1, h: 1 },
            crop: { id: `crop-${n}`, mime: "image/png", w: 1, h: 1 },
        },
        ...over,
    };
    return {
        annotation,
        assets: new Map([
            [`full-${n}`, new Blob([new Uint8Array([1, n])], { type: "image/png" })],
            [`crop-${n}`, new Blob([new Uint8Array([2, n])], { type: "image/png" })],
        ]),
    };
};

const bytes = async (blob: Blob | undefined) =>
    Array.from(new Uint8Array((await blob?.arrayBuffer()) ?? []));

describe("IndexedDB persistence", () => {
    it("returns null where IndexedDB does not exist", () => {
        expect(createIdbPersistence("p", undefined)).toBeNull();
    });

    it("restores annotations and their screenshot bytes after a reload, oldest first", async () => {
        const factory = new IDBFactory();
        const first = createIdbPersistence("checkout-web", factory);
        await first?.save(record(2));
        await first?.save(record(1));

        // A new instance over the same database: what a page reload sees.
        const reloaded = createIdbPersistence("checkout-web", factory);
        const loaded = (await reloaded?.load()) ?? [];
        expect(loaded.map((r) => r.annotation.id)).toEqual(["01TEST1", "01TEST2"]);
        expect(loaded[0]?.annotation).toEqual(record(1).annotation);
        expect(await bytes(loaded[0]?.assets.get("full-1"))).toEqual([1, 1]);
        expect(await bytes(loaded[1]?.assets.get("crop-2"))).toEqual([2, 2]);
    });

    it("keeps projects apart", async () => {
        const factory = new IDBFactory();
        await createIdbPersistence("a", factory)?.save(record(1));
        expect(await createIdbPersistence("b", factory)?.load()).toEqual([]);
    });

    it("overwrites on save, removes one, and clears all", async () => {
        const factory = new IDBFactory();
        const store = createIdbPersistence("p", factory);
        await store?.save(record(1));
        await store?.save(record(1, { status: "resolved" }));
        await store?.save(record(2));
        expect(
            (await store?.load())?.find((r) => r.annotation.id === "01TEST1")?.annotation.status
        ).toBe("resolved");
        await store?.remove("01TEST1");
        expect((await store?.load())?.map((r) => r.annotation.id)).toEqual(["01TEST2"]);
        await store?.clear();
        expect(await store?.load()).toEqual([]);
    });

    it("skips rows that no longer match the schema instead of failing the load", async () => {
        const factory = new IDBFactory();
        const store = createIdbPersistence("p", factory);
        await store?.save(record(1));
        await store?.save({
            ...record(2),
            annotation: { ...record(2).annotation, status: "bogus" as never },
        });
        expect((await store?.load())?.map((r) => r.annotation.id)).toEqual(["01TEST1"]);
    });

    it("removing a note removes its screenshots, but not ones another kept note shows too", async () => {
        const factory = new IDBFactory();
        const store = createIdbPersistence("p", factory);
        await store?.save(record(1));
        // The same screenshot in a second note: asset ids are content hashes, so they can be shared.
        await store?.save({
            annotation: {
                ...record(2).annotation,
                screenshots: {
                    full: { id: "full-1", mime: "image/png", w: 1, h: 1 },
                    crop: { id: "crop-2", mime: "image/png", w: 1, h: 1 },
                },
            },
            assets: new Map([
                ["full-1", record(1).assets.get("full-1") as Blob],
                ["crop-2", record(2).assets.get("crop-2") as Blob],
            ]),
        });
        expect(await assetKeys(factory, "p")).toEqual(["crop-1", "crop-2", "full-1"]);
        await store?.remove("01TEST2");
        expect(await assetKeys(factory, "p")).toEqual(["crop-1", "full-1"]);
        await store?.remove("01TEST1");
        expect(await assetKeys(factory, "p")).toEqual([]);
    });

    it("keeps the server's newer version of a kept note, and never brings a removed one back", async () => {
        const factory = new IDBFactory();
        const store = createIdbPersistence("p", factory);
        await store?.save(record(1));
        await store?.update({ ...record(1).annotation, status: "resolved" });
        expect((await store?.load())?.[0]?.annotation.status).toBe("resolved");
        await store?.remove("01TEST1");
        await store?.update({ ...record(1).annotation, status: "reverted" });
        expect(await store?.load()).toEqual([]);
    });

    it("remembers which notes had not reached the server, and why one was refused", async () => {
        const factory = new IDBFactory();
        const store = createIdbPersistence("p", factory);
        await store?.save(record(1), { unsent: true });
        await store?.save(record(2), { unsent: true });
        await store?.save(record(3), { unsent: false });
        await store?.setUnsent("01TEST2", { refused: "too large" });
        const reloaded = createIdbPersistence("p", factory);
        expect(Object.fromEntries((await reloaded?.unsent()) ?? [])).toEqual({
            "01TEST1": {},
            "01TEST2": { refused: "too large" },
        });
        await reloaded?.setUnsent("01TEST1", null); // it got there
        await reloaded?.remove("01TEST2");
        await reloaded?.setUnsent("01TEST9", {}); // not kept: nothing to mark
        expect(Object.fromEntries((await reloaded?.unsent()) ?? [])).toEqual({});
    });

    it("opens a database made before the outbox existed, with its notes", async () => {
        const factory = new IDBFactory();
        await new Promise<void>((resolve, reject) => {
            const open = factory.open("notato:old", 1);
            open.onupgradeneeded = () => {
                open.result.createObjectStore("annotations", { keyPath: "id" });
                open.result.createObjectStore("assets");
                open.transaction?.objectStore("annotations").put(record(1).annotation);
            };
            open.onsuccess = () => {
                open.result.close();
                resolve();
            };
            open.onerror = () => reject(open.error);
        });
        const store = createIdbPersistence("old", factory);
        expect((await store?.load())?.map((r) => r.annotation.id)).toEqual(["01TEST1"]);
        expect((await store?.unsent())?.size).toBe(0);
    });
});

/** The screenshot blobs a project's database holds, by id. */
async function assetKeys(factory: IDBFactory, project: string): Promise<string[]> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = factory.open(`notato:${project}`);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const r = db.transaction("assets").objectStore("assets").getAllKeys();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
    db.close();
    return keys.map(String).sort();
}
