// Rectangles on the overlay, with nothing of React Native's in them: what pins and selections are placed with, and
// what the tests can load on their own.
import type { Frame } from "../identity.ts";

/** A rectangle on the overlay, in points. */
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** A point on the overlay. */
export interface Point {
    x: number;
    y: number;
}

/** A frame on the page as a rect on the overlay, which starts at `origin`. */
export const toRect = (frame: Frame, origin: Point): Rect => ({
    x: frame.left - origin.x,
    y: frame.top - origin.y,
    w: frame.width,
    h: frame.height,
});

/** Whether any of a rect is on the overlay. */
export const onScreen = (r: Rect, size: { width: number; height: number }) =>
    r.x + r.w > 0 && r.y + r.h > 0 && r.x < size.width && r.y < size.height;

export const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Whether two rects (or two nothings) are the same. */
export const sameRect = (a: Rect | null | undefined, b: Rect | null | undefined) =>
    a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
