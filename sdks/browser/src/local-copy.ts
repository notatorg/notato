import type { AnnotationRecord } from "@notato/core";
import type { Annotation } from "@notato/schema";
import type { Persistence, Unsent } from "./persist.ts";

/**
 * The copy of this page's own notes kept in this browser (the `persist` option), and only those: the server's changes
 * to them are kept too, so a reload shows them as they are. Without persistence every method does nothing. Saving runs
 * in the background; a failure is reported with `warn` and costs only the copy.
 */
export interface LocalCopy {
    /** Keeps a note this page made, and whether the server has it yet (`unsent`), or refused it (`refused`). */
    keep(record: AnnotationRecord, state: { unsent?: boolean; refused?: string }): void;
    /** The server has a kept note now. */
    sent(id: string): void;
    /** The server refused a kept note for good, and said why. */
    refused(id: string, message: string): void;
    /** The server changed or removed notes: the kept ones among them follow. */
    applied(change: { updated: Annotation[]; removed: string[] }): void;
    /** Forgets a note. */
    forget(id: string): Promise<void>;
    /** Forgets every note. */
    forgetAll(): Promise<void>;
    /** What was kept before, oldest first, each with whether it had reached the server. The notes are kept from now on. */
    load(): Promise<Array<{ record: AnnotationRecord; unsent?: Unsent }>>;
}

export function createLocalCopy(
    persistence: Persistence | null,
    warn: (message: string, error: unknown) => void
): LocalCopy {
    /** The notes this page made that are kept in this browser. */
    const kept = new Set<string>();
    const failed = (error: unknown) => warn("could not update this browser's copy", error);

    return {
        keep(record, state) {
            if (!persistence) return;
            const id = record.annotation.id;
            kept.add(id);
            persistence
                .save(record, { unsent: state.unsent })
                .then(() =>
                    state.refused
                        ? persistence.setUnsent(id, { refused: state.refused })
                        : undefined
                )
                .catch((error) => warn("could not save the annotation in this browser", error));
        },
        sent(id) {
            if (kept.has(id)) persistence?.setUnsent(id, null).catch(failed);
        },
        refused(id, message) {
            if (kept.has(id)) persistence?.setUnsent(id, { refused: message }).catch(failed);
        },
        applied({ updated, removed }) {
            for (const a of updated) if (kept.has(a.id)) persistence?.update(a).catch(failed);
            for (const id of removed) if (kept.delete(id)) persistence?.remove(id).catch(failed);
        },
        async forget(id) {
            kept.delete(id);
            await persistence?.remove(id);
        },
        async forgetAll() {
            kept.clear();
            await persistence?.clear();
        },
        async load() {
            if (!persistence) return [];
            const [records, unsent] = await Promise.all([persistence.load(), persistence.unsent()]);
            for (const record of records) kept.add(record.annotation.id);
            return records.map((record) => ({ record, unsent: unsent.get(record.annotation.id) }));
        },
    };
}
