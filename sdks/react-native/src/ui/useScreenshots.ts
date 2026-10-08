import { type RefObject, useCallback, useState } from "react";
import type { View } from "react-native";
import { type Shot, shoot } from "../capture.ts";
import type { NotatoController } from "../controller.ts";
import { currentContainer, type Picked } from "../inspect.ts";
import { serial } from "../serial.ts";
import { maskedUnder, measure } from "../tree.ts";
import { overlaps, type Point, type Rect, toRect } from "./geometry.ts";

/** While a screenshot is taken: the element's outline and number, and the covers over what is private. */
export interface Capturing {
    rect: Rect;
    pin: number;
    covers: Rect[];
}

/** Waits for the next frame to be drawn: the outline and the covers must be on screen before the photograph. */
const nextFrames = () =>
    new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );

/**
 * Takes a note's screenshots: the screen with the element outlined and numbered and what is private covered, and a crop
 * of the element. `capturing` says what to draw meanwhile (and that Notato's own controls are to be hidden).
 */
export function useScreenshots(options: {
    notato: NotatoController;
    /** The view the overlay and the app share: the full screenshot is of it. */
    outer: RefObject<View | null>;
    /** The app's own view, whose private views are covered. */
    app: RefObject<View | null>;
    /** Where the overlay is on the page. */
    origin(): Promise<Point>;
    size: { width: number; height: number };
}): {
    capturing: Capturing | null;
    capture(picked: Picked, pin: number, id: string): Promise<{ full?: Shot; crop?: Shot }>;
} {
    const { notato, outer, app, origin, size } = options;
    const [capturing, setCapturing] = useState<Capturing | null>(null);

    /**
     * What screenshots cover: private views, password fields, and text fields when `maskInputs` is on. A private view
     * with no place of its own (a Text inside a Text) is painted by the view around it, which is covered instead; and
     * then the crop, which would show it, is left out.
     */
    const coversFor = useCallback(
        async (at: Point) => {
            const container = currentContainer(app.current);
            const masked = container ? maskedUnder(container, notato.maskInputs) : [];
            let around = false;
            const frames = await Promise.all(
                masked.map(async (view) => {
                    let frame = await measure(view.fiber);
                    for (let up = view.parent; !frame && up; up = up.parent) {
                        frame = await measure(up.fiber);
                        if (frame) around = true;
                    }
                    return frame;
                })
            );
            const covers = new Map<string, Rect>();
            for (const frame of frames) {
                if (!frame) continue;
                const rect = toRect(frame, at);
                covers.set(`${rect.x},${rect.y},${rect.w},${rect.h}`, rect);
            }
            return { covers: [...covers.values()], around };
        },
        [notato, app]
    );

    /**
     * Screenshots are taken one at a time (two notes at once: a relayed request and a tap), and the covers come off
     * only after the last: one finishing first must not uncover what the other is photographing.
     */
    const [oneAtATime] = useState(() => serial(() => setCapturing(null)));

    const photograph = useCallback(
        async (picked: Picked, pin: number, id: string): Promise<{ full?: Shot; crop?: Shot }> => {
            if (!notato.screenshotsOn) return {};
            const at = await origin();
            const rect = toRect(picked.frame, at);
            const { covers, around } = await coversFor(at);
            setCapturing({ rect, pin, covers });
            await nextFrames();
            const max = notato.configuration?.maxScreenshotScale ?? 2;
            const full = await shoot(
                outer.current,
                `${id}-full`,
                { width: size.width, height: size.height },
                max
            );
            // The crop is the view on its own, without the covers: left out when something private is in it.
            const coveredHere =
                around || picked.element.private || covers.some((c) => overlaps(c, rect));
            const crop =
                full && !coveredHere
                    ? await shoot(picked.view, `${id}-crop`, picked.frame, max)
                    : undefined;
            return { ...(full ? { full } : {}), ...(crop ? { crop } : {}) };
        },
        [notato, origin, coversFor, outer, size]
    );

    const capture = useCallback(
        (picked: Picked, pin: number, id: string) => oneAtATime(() => photograph(picked, pin, id)),
        [oneAtATime, photograph]
    );

    return { capturing, capture };
}
