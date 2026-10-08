import type { AnnotationRecord } from "@notato/core";
import { Annotation } from "@notato/schema";

/** A note that had not reached the server when it was last seen here, and why the server refused it, if it did. */
export interface Unsent {
    refused?: string;
}

/**
 * Keeps annotations across reloads and crashes. In test mode the page holds the only copy of a tester's
 * work, so it must survive the tab closing. Screenshot bytes are kept as blobs beside the records.
 */
export interface Persistence {
    load(): Promise<AnnotationRecord[]>;
    /** Keeps a record and its screenshots. `unsent` also says whether it is still waiting to reach the server. */
    save(record: AnnotationRecord, options?: { unsent?: boolean }): Promise<void>;
    /** The server's newer version of a kept annotation (its status, its thread). Nothing happens if it is not kept. */
    update(annotation: Annotation): Promise<void>;
    /** Forgets an annotation, and its screenshots unless another kept annotation shows the same ones. */
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
    /** The kept notes that had not reached the server, by id. */
    unsent(): Promise<Map<string, Unsent>>;
    /** Marks a kept note as waiting to be sent (or refused, with why), or with `null` as on the server. */
    setUnsent(id: string, state: Unsent | null): Promise<void>;
}

const ANNOTATIONS = "annotations";
const ASSETS = "assets";
const OUTBOX = "outbox";

const request = <T>(r: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });

const finished = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    });

/** The screenshot ids a stored row points at. Read loosely: a row that no longer parses still holds on to its own. */
const assetIds = (row: unknown): string[] => {
    const shots = (row as { screenshots?: Record<"full" | "crop", { id?: unknown } | undefined> })
        ?.screenshots;
    return [shots?.full?.id, shots?.crop?.id].filter(
        (id): id is string => typeof id === "string" && id.length > 0
    );
};

/** Returns null where IndexedDB does not exist; callers then run without persistence. */
export function createIdbPersistence(
    project: string,
    factory: IDBFactory | undefined = globalThis.indexedDB
): Persistence | null {
    if (!factory) return null;
    const name = `notato:${project}`;
    let opened: Promise<IDBDatabase> | undefined;

    const db = () => {
        // Version 2 added the outbox. Each store is made only if missing, so a version 1 database keeps its notes.
        opened ??= new Promise<IDBDatabase>((resolve, reject) => {
            const open = factory.open(name, 2);
            open.onupgradeneeded = () => {
                const stores = open.result.objectStoreNames;
                if (!stores.contains(ANNOTATIONS))
                    open.result.createObjectStore(ANNOTATIONS, { keyPath: "id" });
                if (!stores.contains(ASSETS)) open.result.createObjectStore(ASSETS);
                if (!stores.contains(OUTBOX)) open.result.createObjectStore(OUTBOX);
            };
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
        });
        return opened;
    };

    return {
        async load() {
            const database = await db();
            const tx = database.transaction([ANNOTATIONS, ASSETS], "readonly");
            const rows = await request(tx.objectStore(ANNOTATIONS).getAll());
            const records: AnnotationRecord[] = [];
            for (const row of rows) {
                const parsed = Annotation.safeParse(row);
                if (!parsed.success) continue;
                const assets = new Map<string, Blob>();
                for (const id of assetIds(parsed.data)) {
                    const blob = (await request(tx.objectStore(ASSETS).get(id))) as
                        | Blob
                        | undefined;
                    if (blob) assets.set(id, blob);
                }
                records.push({ annotation: parsed.data, assets });
            }
            return records.sort((a, b) =>
                a.annotation.createdAt.localeCompare(b.annotation.createdAt)
            );
        },

        async save(record, options = {}) {
            const database = await db();
            const tx = database.transaction([ANNOTATIONS, ASSETS, OUTBOX], "readwrite");
            tx.objectStore(ANNOTATIONS).put(record.annotation);
            for (const [id, blob] of record.assets) tx.objectStore(ASSETS).put(blob, id);
            if (options.unsent === true) tx.objectStore(OUTBOX).put({}, record.annotation.id);
            else if (options.unsent === false) tx.objectStore(OUTBOX).delete(record.annotation.id);
            await finished(tx);
        },

        async update(annotation) {
            const database = await db();
            const tx = database.transaction(ANNOTATIONS, "readwrite");
            const store = tx.objectStore(ANNOTATIONS);
            // Only over a copy that is still here: a note removed meanwhile must not come back.
            if (await request(store.getKey(annotation.id))) store.put(annotation);
            await finished(tx);
        },

        async remove(id) {
            const database = await db();
            const tx = database.transaction([ANNOTATIONS, ASSETS, OUTBOX], "readwrite");
            const annotations = tx.objectStore(ANNOTATIONS);
            const gone = assetIds(await request(annotations.get(id)));
            annotations.delete(id);
            tx.objectStore(OUTBOX).delete(id);
            // Screenshot ids are content hashes, so two notes can share one: keep it while another still shows it.
            const others = (await request(annotations.getAll())) as unknown[];
            const inUse = new Set(others.flatMap(assetIds));
            for (const asset of gone) if (!inUse.has(asset)) tx.objectStore(ASSETS).delete(asset);
            await finished(tx);
        },

        async clear() {
            const database = await db();
            const tx = database.transaction([ANNOTATIONS, ASSETS, OUTBOX], "readwrite");
            tx.objectStore(ANNOTATIONS).clear();
            tx.objectStore(ASSETS).clear();
            tx.objectStore(OUTBOX).clear();
            await finished(tx);
        },

        async unsent() {
            const database = await db();
            const tx = database.transaction(OUTBOX, "readonly");
            const store = tx.objectStore(OUTBOX);
            const [keys, values] = await Promise.all([
                request(store.getAllKeys()),
                request(store.getAll()),
            ]);
            const out = new Map<string, Unsent>();
            keys.forEach((key, i) => {
                const value = values[i] as Unsent | undefined;
                out.set(
                    String(key),
                    typeof value?.refused === "string" ? { refused: value.refused } : {}
                );
            });
            return out;
        },

        async setUnsent(id, state) {
            const database = await db();
            const tx = database.transaction([ANNOTATIONS, OUTBOX], "readwrite");
            const outbox = tx.objectStore(OUTBOX);
            if (!state) outbox.delete(id);
            // Only for a note that is kept: an outbox entry without its note would point at nothing.
            else if (await request(tx.objectStore(ANNOTATIONS).getKey(id)))
                outbox.put(state.refused ? { refused: state.refused } : {}, id);
            await finished(tx);
        },
    };
}
