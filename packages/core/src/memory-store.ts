import type { Annotation, Status } from "@notato/schema";
import type { AnnotationRecord } from "./types.ts";

export interface MemoryStore {
    add(record: AnnotationRecord): void;
    get(id: string): AnnotationRecord | undefined;
    list(filter?: { status?: Status; route?: string }): AnnotationRecord[];
    /**
     * Inserts or replaces by id, as when the server reports a new or changed annotation. Screenshot bytes
     * and live elements already held for that id are kept.
     */
    upsert(annotation: Annotation): void;
    /**
     * Applies a whole read from the server at once: inserts or replaces these annotations (as `upsert` does) and removes
     * the ids in `remove`, then tells listeners once, so a page of a hundred notes is one update, not a hundred.
     */
    upsertMany(annotations: readonly Annotation[], remove?: readonly string[]): void;
    /** Replaces the stored annotation; returns false when the id is unknown. */
    update(id: string, patch: (a: Annotation) => Annotation): boolean;
    remove(id: string): void;
    clear(): void;
    subscribe(listener: () => void): () => void;
}

/**
 * The same record with another annotation. Everything else is carried over as it is held: a record's `elements` can
 * be a getter over weak references (see the pipeline), which copying the value out would turn into strong ones.
 */
function withAnnotation(record: AnnotationRecord, annotation: Annotation): AnnotationRecord {
    const next = Object.defineProperties(
        {},
        Object.getOwnPropertyDescriptors(record)
    ) as AnnotationRecord;
    next.annotation = annotation;
    return next;
}

/** The page-local store. Dev and serve modes mirror the server here; test mode is the only copy. */
export function createMemoryStore(): MemoryStore {
    const records = new Map<string, AnnotationRecord>();
    const listeners = new Set<() => void>();
    const emit = () => {
        for (const listener of [...listeners]) listener();
    };
    /** Screenshot bytes and live elements already held for the id are kept. */
    const put = (annotation: Annotation) => {
        const current = records.get(annotation.id);
        records.set(
            annotation.id,
            current ? withAnnotation(current, annotation) : { annotation, assets: new Map() }
        );
    };

    return {
        add(record) {
            records.set(record.annotation.id, record);
            emit();
        },
        get: (id) => records.get(id),
        list(filter) {
            return [...records.values()].filter(
                ({ annotation: a }) =>
                    (!filter?.status || a.status === filter.status) &&
                    (!filter?.route || a.route === filter.route)
            );
        },
        upsert(annotation) {
            put(annotation);
            emit();
        },
        upsertMany(annotations, remove = []) {
            for (const annotation of annotations) put(annotation);
            let removed = false;
            for (const id of remove) removed = records.delete(id) || removed;
            if (annotations.length > 0 || removed) emit();
        },
        update(id, patch) {
            const current = records.get(id);
            if (!current) return false;
            records.set(id, withAnnotation(current, patch(current.annotation)));
            emit();
            return true;
        },
        remove(id) {
            if (records.delete(id)) emit();
        },
        clear() {
            if (records.size === 0) return;
            records.clear();
            emit();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
