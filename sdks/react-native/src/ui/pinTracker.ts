// Keeps a screen's pins on their elements, and costs as little as that can. Reading the app's tree is the dear part, so
// it is done only when the app itself committed something (not Notato), or the notes changed, and only once the app has
// gone quiet. In between, each pin follows the one view it was found on, measured a few times a second: one that is
// moving (a scroll, an animation) has its pin hidden until it stops, and drawn again where it came to rest.
import type { NoteRecord, NumberedNote } from "../notes.ts";
import { type Rect, sameRect } from "./rect.ts";

/** How long the app goes without committing before its tree is read again: until then it is busy. */
export const IDLE_MS = 250;
/** How long a change waits for that at most: an app that never stops animating still gets its pins. */
export const FALLBACK_MS = 2000;
/** How often the views the pins are on are measured, to see whether they moved. */
export const FOLLOW_MS = 120;

/** A pin on screen: its note and number, and where its element is now, or where it was when it cannot be found. */
export interface PlacedPin {
    record: NoteRecord;
    number: number;
    rect: Rect;
    /** Its element cannot be found: the pin stays where the note was made, dimmed. */
    detached: boolean;
    /** Its element is moving: the pin is hidden, where it was, until it stops. */
    moving: boolean;
}

/** What the tracker needs from the app, kept apart so it can be tested without React Native. */
export interface TrackerIO<V> {
    /** Reads the app's tree: the views each note's selector finds, by note id, likeliest first. */
    find(notes: readonly NumberedNote[]): Map<string, V[]>;
    /** How to measure views on the overlay now (null when off screen), asked once for each round of measuring. */
    measurer(): Promise<(view: V) => Promise<Rect | null>>;
    /** Whether any of a rect is on the overlay. */
    onScreen(rect: Rect): boolean;
    /** The pins to draw: called only when they changed. */
    show(pins: PlacedPin[]): void;
}

const samePins = (a: PlacedPin[], b: PlacedPin[]) =>
    a.length === b.length &&
    a.every((x, i) => {
        const y = b[i] as PlacedPin;
        return (
            x.record === y.record &&
            x.number === y.number &&
            x.detached === y.detached &&
            x.moving === y.moving &&
            sameRect(x.rect, y.rect)
        );
    });

export class PinTracker<V> {
    private notes: readonly NumberedNote[] = [];
    /** Every pin, on screen or not: a view scrolled away may come back. */
    private all: PlacedPin[] = [];
    /** What is drawn: the pins on screen. */
    private drawn: PlacedPin[] = [];
    /** The view each pin follows, and where it was when last measured. */
    private views = new Map<string, V>();
    private last = new Map<string, Rect | null>();

    private running = false;
    /** The app's tree must be read again; `urgent` when that should not wait for the app to go quiet. */
    private dirty = true;
    private urgent = true;
    private dirtySince = 0;
    /** When the app last committed something. */
    private changedAt = Number.NEGATIVE_INFINITY;
    private walkTimer?: ReturnType<typeof setTimeout>;
    private followTimer?: ReturnType<typeof setTimeout>;
    /** A walk or a round of measuring is under way: they take turns. */
    private busy = false;

    /**
     * Whether the app's commits are known (React's DevTools hook is there). Without them, the app may have changed at
     * any time, and its tree is read every `FALLBACK_MS`.
     */
    commitsKnown = true;

    constructor(private readonly io: TrackerIO<V>) {}

    /** The notes that get a pin: read the tree again for them, at once. */
    setNotes(notes: readonly NumberedNote[]): void {
        if (notes === this.notes) return;
        this.notes = notes;
        this.invalidate();
    }

    /** Something changed that the views' places depend on (the overlay's size): read the tree again, at once. */
    invalidate(): void {
        if (!this.dirty) this.dirtySince = Date.now();
        this.dirty = true;
        this.urgent = true;
        this.schedule();
    }

    /** The app committed something. Called as React commits, so it only notes the time and sets a timer. */
    appChanged(): void {
        this.changedAt = Date.now();
        if (!this.dirty) {
            this.dirty = true;
            this.dirtySince = this.changedAt;
        }
        this.schedule();
    }

    /** Starts placing and following pins. */
    start(): void {
        if (this.running) return;
        this.running = true;
        this.schedule();
        this.followSoon();
    }

    /** Stops looking, and leaves the pins where they are (under a sheet, say). */
    pause(): void {
        this.running = false;
        clearTimeout(this.walkTimer);
        clearTimeout(this.followTimer);
        this.walkTimer = undefined;
        this.followTimer = undefined;
    }

    /** Stops looking and takes the pins away. */
    stop(): void {
        this.pause();
        this.all = [];
        this.views = new Map();
        this.last = new Map();
        this.dirty = true;
        this.urgent = true;
        this.publish();
    }

    /** How long until the tree should be read: once the app is quiet, or has been changing for too long. */
    private wait(): number {
        if (this.urgent) return 0;
        const idle = this.commitsKnown ? this.changedAt + IDLE_MS : Number.POSITIVE_INFINITY;
        return Math.max(0, Math.min(idle, this.dirtySince + FALLBACK_MS) - Date.now());
    }

    private schedule(): void {
        if (!this.running || !this.dirty || this.busy || this.walkTimer !== undefined) return;
        this.walkTimer = setTimeout(() => this.tick(), this.wait());
    }

    private tick(): void {
        this.walkTimer = undefined;
        if (!this.running || !this.dirty || this.busy) return;
        // The app committed again since the timer was set: wait on.
        const wait = this.wait();
        if (wait > 0) this.walkTimer = setTimeout(() => this.tick(), wait);
        else void this.walk();
    }

    private followSoon(): void {
        if (!this.running || this.followTimer !== undefined || this.views.size === 0) return;
        this.followTimer = setTimeout(() => {
            this.followTimer = undefined;
            void this.follow();
        }, FOLLOW_MS);
    }

    /** Reads the app's tree, finds each pin's view (of several alike, the nearest to where the note was made). */
    private async walk(): Promise<void> {
        this.busy = true;
        this.dirty = false;
        this.urgent = false;
        try {
            const notes = this.notes;
            let found: Map<string, V[]>;
            try {
                found = this.io.find(notes);
            } catch {
                // the app's tree could not be read: every pin stays where its note was made
                found = new Map();
            }
            const measure = await this.io.measurer();
            const views = new Map<string, V>();
            const last = new Map<string, Rect | null>();
            this.all = await Promise.all(
                notes.map(async ({ record, number }): Promise<PlacedPin> => {
                    const id = record.annotation.id;
                    const stored = record.annotation.target.rect;
                    const candidates = found.get(id) ?? [];
                    const rects = await Promise.all(candidates.map((view) => measure(view)));
                    let best: { view: V; rect: Rect; distance: number } | undefined;
                    rects.forEach((r, i) => {
                        if (!r) return;
                        const distance =
                            Math.hypot(r.x - stored.x, r.y - stored.y) +
                            Math.abs(r.w - stored.w) +
                            Math.abs(r.h - stored.h);
                        if (!best || distance < best.distance)
                            best = { view: candidates[i] as V, rect: r, distance };
                    });
                    const chosen = best as { view: V; rect: Rect } | undefined;
                    if (chosen) {
                        views.set(id, chosen.view);
                        last.set(id, chosen.rect);
                    }
                    return {
                        record,
                        number,
                        rect: chosen?.rect ?? stored,
                        detached: !chosen,
                        moving: false,
                    };
                })
            );
            this.views = views;
            this.last = last;
            if (!this.commitsKnown) {
                this.dirty = true;
                this.dirtySince = Date.now();
            }
            if (this.running) this.publish();
        } catch {
            // measuring failed: the pins stay as they are, and the next look tries again
        } finally {
            this.busy = false;
            this.schedule();
            this.followSoon();
        }
    }

    /** Measures the view each pin is on: a pin whose view moved is hidden, and shown again where it stops. */
    private async follow(): Promise<void> {
        if (!this.running || this.busy) return;
        this.busy = true;
        try {
            const measure = await this.io.measurer();
            this.all = await Promise.all(
                this.all.map(async (pin) => {
                    const id = pin.record.annotation.id;
                    const view = this.views.get(id);
                    if (view === undefined) return pin;
                    const now = await measure(view);
                    const before = this.last.get(id) ?? null;
                    this.last.set(id, now);
                    // Moved since the last look, or gone from the layout (the commit that took it brings a walk).
                    if (!now || !sameRect(now, before))
                        return pin.moving ? pin : { ...pin, moving: true };
                    // Still since the last look: drawn there.
                    if (pin.moving || !sameRect(pin.rect, now))
                        return { ...pin, rect: now, moving: false };
                    return pin;
                })
            );
            if (this.running) this.publish();
        } catch {
            // as above
        } finally {
            this.busy = false;
            this.schedule();
            this.followSoon();
        }
    }

    /** Shows the pins on screen, when they are not what is drawn already. */
    private publish(): void {
        const next = this.all.filter((p) => p.detached || this.io.onScreen(p.rect));
        if (samePins(this.drawn, next)) return;
        this.drawn = next;
        this.io.show(next);
    }
}
