import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NumberedNote } from "../src/notes.ts";
import {
    FALLBACK_MS,
    FOLLOW_MS,
    IDLE_MS,
    PinTracker,
    type PlacedPin,
} from "../src/ui/pinTracker.ts";
import type { Rect } from "../src/ui/rect.ts";
import { annotation } from "./fixtures.ts";

/** A view the tracker follows: where it is now, which a test moves. */
interface FakeView {
    rect: Rect | null;
}

function setup(count = 2) {
    const notes: NumberedNote[] = Array.from({ length: count }, (_, i) => ({
        number: i + 1,
        record: {
            annotation: annotation({
                id: `n${i}`,
                target: { ...annotation().target, rect: { x: 10, y: 100 * i, w: 60, h: 20 } },
            }),
            pending: false,
            mine: true,
        },
    }));
    const views = new Map(
        notes.map((n, i) => [n.record.annotation.id, { rect: { x: 10, y: 100 * i, w: 60, h: 20 } }])
    );
    let walks = 0;
    const shown: PlacedPin[][] = [];
    const tracker = new PinTracker<FakeView>({
        find: (list) => {
            walks++;
            return new Map(
                list.map((n) => [
                    n.record.annotation.id,
                    [views.get(n.record.annotation.id) as FakeView],
                ])
            );
        },
        measurer: async () => async (view) => (view.rect ? { ...view.rect } : null),
        onScreen: (r) => r.y + r.h > 0 && r.y < 800,
        show: (pins) => shown.push(pins),
    });
    tracker.setNotes(notes);
    return { tracker, notes, views, shown, walks: () => walks };
}

describe("PinTracker", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("finds the pins at once, and then reads the tree only when the app commits", async () => {
        const t = setup();
        t.tracker.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(t.walks()).toBe(1);
        expect(t.shown.at(-1)?.map((p) => p.rect.y)).toEqual([0, 100]);
        // Nothing committed: however long it is left, the tree is not read again, and nothing is drawn again.
        await vi.advanceTimersByTimeAsync(5000);
        expect(t.walks()).toBe(1);
        expect(t.shown).toHaveLength(1);
        t.tracker.stop();
    });

    it("waits for the app to go quiet before reading its tree, and not longer than the fallback", async () => {
        const t = setup();
        t.tracker.start();
        await vi.advanceTimersByTimeAsync(0);
        // A burst of commits: read once, after the last of them.
        for (let i = 0; i < 5; i++) {
            t.tracker.appChanged();
            await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
        }
        expect(t.walks()).toBe(1);
        await vi.advanceTimersByTimeAsync(IDLE_MS);
        expect(t.walks()).toBe(2);
        // An app that never stops committing still gets its pins placed, every so often.
        const start = Date.now();
        while (Date.now() - start < FALLBACK_MS + IDLE_MS) {
            t.tracker.appChanged();
            await vi.advanceTimersByTimeAsync(50);
        }
        expect(t.walks()).toBe(3);
        t.tracker.stop();
    });

    it("hides a pin while its view moves, and shows it where the view stops", async () => {
        const t = setup();
        t.tracker.start();
        await vi.advanceTimersByTimeAsync(0);
        const view = t.views.get("n1") as FakeView;
        view.rect = { x: 10, y: 60, w: 60, h: 20 };
        await vi.advanceTimersByTimeAsync(FOLLOW_MS);
        expect(t.shown.at(-1)?.[1]).toMatchObject({ moving: true, rect: { y: 100 } });
        view.rect = { x: 10, y: 20, w: 60, h: 20 };
        await vi.advanceTimersByTimeAsync(FOLLOW_MS);
        expect(t.shown.at(-1)?.[1]).toMatchObject({ moving: true, rect: { y: 100 } });
        await vi.advanceTimersByTimeAsync(FOLLOW_MS);
        expect(t.shown.at(-1)?.[1]).toMatchObject({ moving: false, rect: { y: 20 } });
        // Following is not reading the tree.
        expect(t.walks()).toBe(1);
        t.tracker.stop();
    });

    it("drops a pin whose view went off screen, and brings it back when it returns", async () => {
        const t = setup();
        t.tracker.start();
        await vi.advanceTimersByTimeAsync(0);
        const view = t.views.get("n0") as FakeView;
        view.rect = { x: 10, y: -500, w: 60, h: 20 };
        await vi.advanceTimersByTimeAsync(FOLLOW_MS * 2);
        expect(t.shown.at(-1)?.map((p) => p.record.annotation.id)).toEqual(["n1"]);
        view.rect = { x: 10, y: 0, w: 60, h: 20 };
        await vi.advanceTimersByTimeAsync(FOLLOW_MS * 2);
        expect(t.shown.at(-1)?.map((p) => p.record.annotation.id)).toEqual(["n0", "n1"]);
        t.tracker.stop();
    });

    it("leaves no timers while paused, keeps the pins, and catches up when started again", async () => {
        const t = setup();
        t.tracker.start();
        await vi.advanceTimersByTimeAsync(0);
        t.tracker.pause();
        expect(vi.getTimerCount()).toBe(0);
        t.tracker.appChanged();
        expect(vi.getTimerCount()).toBe(0);
        expect(t.shown).toHaveLength(1);
        t.tracker.start();
        await vi.advanceTimersByTimeAsync(IDLE_MS);
        expect(t.walks()).toBe(2);
        t.tracker.stop();
        expect(vi.getTimerCount()).toBe(0);
        expect(t.shown.at(-1)).toEqual([]);
    });

    it("reads the tree every so often when it cannot know the app's commits", async () => {
        const t = setup();
        t.tracker.commitsKnown = false;
        t.tracker.start();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(FALLBACK_MS * 3);
        expect(t.walks()).toBe(4);
        t.tracker.stop();
    });
});
