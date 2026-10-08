import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { View } from "react-native";
import type { NotatoController } from "../controller.ts";
import { appElements, commitCount } from "../inspect.ts";
import type { NoteRecord, NumberedNote } from "../notes.ts";
import { indexOf, query, selectorToFind } from "../selectors.ts";
import { measure, type TreeElement } from "../tree.ts";
import { onScreen, type Point, type Rect, toRect } from "./geometry.ts";

/** The most pins drawn on one screen: the newest. The Notes list has every one. */
const MAX_PINS = 150;

/** How often pins are placed again: their views move without saying so (a scroll, an animation). */
const PLACE_EVERY_MS = 600;

/** Of the views a pin's selector finds (a list's rows, say), how many are measured to find the nearest. */
const MAX_CANDIDATES = 12;

/** A pin on screen: its note and number, and where its element is now, or where it was when it cannot be found. */
export interface PlacedPin {
    record: NoteRecord;
    number: number;
    rect: Rect;
    /** Its element cannot be found: the pin stays where the note was made, dimmed. */
    detached: boolean;
}

const samePins = (a: PlacedPin[], b: PlacedPin[]) =>
    a.length === b.length &&
    a.every((x, i) => {
        const y = b[i] as PlacedPin;
        return (
            x.record === y.record &&
            x.number === y.number &&
            x.detached === y.detached &&
            x.rect.x === y.rect.x &&
            x.rect.y === y.rect.y &&
            x.rect.w === y.rect.w &&
            x.rect.h === y.rect.h
        );
    });

/**
 * Keeps a screen's pins on their elements while `wanted`: each found again by its note's selector and measured,
 * every 0.6 seconds. The app's tree is read again only after React has committed something or the notes
 * changed; in between, only where the same views are now is asked (a scroll moves them without a commit).
 */
export function usePlacedPins(options: {
    notato: NotatoController;
    app: RefObject<View | null>;
    /** The screen's notes that get a pin. */
    pinnable: readonly NumberedNote[];
    wanted: boolean;
    /** Where the overlay is on the page. */
    origin(): Promise<Point>;
    size: { width: number; height: number };
}): PlacedPin[] {
    const { notato, app, pinnable, wanted, origin, size } = options;
    const [pins, setPins] = useState<PlacedPin[]>([]);
    const shown = useMemo(() => pinnable.slice(-MAX_PINS), [pinnable]);
    // Read as the pins are placed, so the server's changes do not start the placing over.
    const shownRef = useRef(shown);
    shownRef.current = shown;
    const active = wanted && shown.length > 0;

    useEffect(() => {
        if (!active) {
            setPins((current) => (current.length ? [] : current));
            return;
        }
        let live = true;
        // The views each pin's selector found the last time the app's tree was read, and when that was.
        const found: {
            commits?: number;
            of?: readonly NumberedNote[];
            views: Map<string, TreeElement[]>;
        } = { views: new Map() };
        const place = async () => {
            const notes = shownRef.current;
            const commits = commitCount();
            if (commits === undefined || commits !== found.commits || found.of !== notes) {
                const elements = appElements(app.current, notato.maskInputs);
                const index = indexOf(elements);
                found.views = new Map();
                for (const { record } of notes) {
                    const identity = record.annotation.target.identity[0];
                    let views: TreeElement[] = [];
                    if (identity) {
                        try {
                            views = query(elements, selectorToFind(identity), index).slice(
                                0,
                                MAX_CANDIDATES
                            );
                        } catch {
                            // a selector this SDK cannot read: the pin stays where the note was made
                        }
                    }
                    found.views.set(record.annotation.id, views);
                }
                found.commits = commits;
                found.of = notes;
            }
            const at = await origin();
            const placed = await Promise.all(
                notes.map(async ({ record, number }) => {
                    const stored = record.annotation.target.rect;
                    // Of several alike (a list's rows), the one nearest where the note was made.
                    let best: { rect: Rect; distance: number } | undefined;
                    for (const element of found.views.get(record.annotation.id) ?? []) {
                        const frame = await measure(element.fiber);
                        if (!frame) continue;
                        const r = toRect(frame, at);
                        const distance =
                            Math.hypot(r.x - stored.x, r.y - stored.y) +
                            Math.abs(r.w - stored.w) +
                            Math.abs(r.h - stored.h);
                        if (!best || distance < best.distance) best = { rect: r, distance };
                    }
                    const rect = best?.rect;
                    return { record, number, rect: rect ?? stored, detached: !rect };
                })
            );
            // An element scrolled out of sight takes its pin with it. The same pins again are not set again: that
            // would draw the overlay for nothing.
            const next = placed.filter((p) => p.detached || onScreen(p.rect, size));
            if (live) setPins((current) => (samePins(current, next) ? current : next));
        };
        void place();
        const timer = setInterval(() => void place(), PLACE_EVERY_MS);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [active, origin, app, notato, size]);

    return pins;
}
