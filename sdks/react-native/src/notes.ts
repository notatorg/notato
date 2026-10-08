import type { Annotation } from "@notato/schema";
import { PLATFORM, routeName } from "./annotation.ts";

/** A note Notato knows of: from the server, or made here and not sent yet. */
export interface NoteRecord {
    readonly annotation: Annotation;
    /** Made here and not yet taken by the server (or, in test mode, not yet packaged). */
    readonly pending: boolean;
    /** Why the server refused it for good: it stays on the device, marked failed, and is not sent again. */
    readonly failed?: string;
    /** Why it has not been sent yet, when the server said (a project it does not know, a token it does not take). */
    readonly waiting?: string;
    /** Made on this device. */
    readonly mine: boolean;
}

/** A note on a screen, with the number its pin shows. */
export interface NumberedNote {
    number: number;
    record: NoteRecord;
}

/** What a change of the notes can do to them (`NoteStore.edit`). */
export interface NoteEdit {
    get(id: string): NoteRecord | undefined;
    /** Replaces the note with its id, or adds it at the end. */
    put(record: NoteRecord): void;
    remove(id: string): void;
}

/** No notes on a screen: always the same empty list, so what depends on it does not run again for nothing. */
const NONE: readonly NumberedNote[] = Object.freeze([]);

/** A screen's notes in the order they were made: oldest first, then by id. */
const madeOrder = (a: NoteRecord, b: NoteRecord) => {
    const x = a.annotation;
    const y = b.annotation;
    if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? -1 : 1;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
};

/**
 * Every note Notato knows, kept so that a project with thousands of them stays quick: found by id at once, the pending
 * ones counted as they change, and each screen's numbered list worked out only when one of its notes changed. The list
 * is replaced whole on each change, never changed in place, so React sees every change and nothing else.
 */
export class NoteStore {
    private records: NoteRecord[] = [];
    /** Where each note is in `records`, by id. */
    private at = new Map<string, number>();
    private pending = 0;
    /** Each screen's notes, numbered as their pins are: worked out when asked, and again only when one changed. */
    private screens = new Map<string, readonly NumberedNote[]>();
    /** Each screen's pinned notes, kept with the list of the screen's notes they were picked from. */
    private pinned = new WeakMap<readonly NumberedNote[], readonly NumberedNote[]>();

    /** Every note, in the order Notato came to know them. */
    get all(): readonly NoteRecord[] {
        return this.records;
    }

    /** How many notes have not reached the server yet. */
    get pendingCount(): number {
        return this.pending;
    }

    get(id: string): NoteRecord | undefined {
        const i = this.at.get(id);
        return i === undefined ? undefined : this.records[i];
    }

    /** Replaces every note at once (a load, another server): the index, the count and the screens start again. */
    replace(next: NoteRecord[]): void {
        this.records = next;
        this.at = new Map(next.map((r, i) => [r.annotation.id, i]));
        this.pending = next.reduce((n, r) => n + (r.pending ? 1 : 0), 0);
        this.screens.clear();
    }

    /**
     * Changes some notes in one go: one copy of the list however many change, the pending count kept as they do, and
     * only the screens they are on worked out again. Returns whether anything changed.
     */
    edit(apply: (notes: NoteEdit) => void): boolean {
        let next: Array<NoteRecord | undefined> | undefined;
        let removed = false;
        const touched = new Set<string>();
        const write = () => {
            next ??= this.records.slice();
            return next;
        };
        apply({
            get: (id) => {
                const i = this.at.get(id);
                return i === undefined ? undefined : (next ?? this.records)[i];
            },
            put: (record) => {
                const list = write();
                const id = record.annotation.id;
                const i = this.at.get(id);
                const old = i === undefined ? undefined : list[i];
                if (i !== undefined && old) {
                    touched.add(routeName(old.annotation.route));
                    if (old.pending) this.pending--;
                    list[i] = record;
                } else {
                    this.at.set(id, list.length);
                    list.push(record);
                }
                touched.add(routeName(record.annotation.route));
                if (record.pending) this.pending++;
            },
            remove: (id) => {
                const i = this.at.get(id);
                if (i === undefined) return;
                const list = write();
                const old = list[i];
                if (!old) return;
                list[i] = undefined;
                this.at.delete(id);
                removed = true;
                touched.add(routeName(old.annotation.route));
                if (old.pending) this.pending--;
            },
        });
        if (!next) return false;
        if (removed) {
            this.records = next.filter((r): r is NoteRecord => r !== undefined);
            this.at = new Map(this.records.map((r, i) => [r.annotation.id, i]));
        } else {
            this.records = next as NoteRecord[];
        }
        for (const route of touched) this.screens.delete(route);
        return true;
    }

    /** Changes one note (or removes it, when `change` gives nothing back). Returns whether it was there. */
    update(id: string, change: (record: NoteRecord) => NoteRecord | undefined): boolean {
        let found = false;
        this.edit((notes) => {
            const record = notes.get(id);
            if (!record) return;
            found = true;
            const updated = change(record);
            if (!updated) notes.remove(id);
            else if (updated !== record) notes.put(updated);
        });
        return found;
    }

    /**
     * The notes on a screen, oldest first, numbered as their pins are. Worked out the first time a screen is asked for,
     * and again only after one of its notes changed.
     */
    notesOn(route: string): readonly NumberedNote[] {
        const key = routeName(route);
        let list = this.screens.get(key);
        if (!list) {
            const here = this.records.filter((r) => routeName(r.annotation.route) === key);
            list = here.length
                ? here.sort(madeOrder).map((record, i) => ({ number: i + 1, record }))
                : NONE;
            this.screens.set(key, list);
        }
        return list;
    }

    /**
     * The notes on a screen that get a pin here: those made in a React Native app. A note from another platform (the
     * web's, iOS's) is in the Notes list with its number, without a pin: its selector names something else.
     */
    pinsOn(route: string): readonly NumberedNote[] {
        const here = this.notesOn(route);
        let pins = this.pinned.get(here);
        if (!pins) {
            const own = here.filter((n) => n.record.annotation.environment?.platform === PLATFORM);
            pins = own.length === here.length ? here : own.length ? own : NONE;
            this.pinned.set(here, pins);
        }
        return pins;
    }
}
