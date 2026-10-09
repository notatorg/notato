// Where pins go: each at its element's top right, and moved aside when another pin is there already (several notes on
// one element, or on elements next to each other). The Swift SDK's PinLayout.
import type { Point, Rect } from "./rect.ts";

/** A pin's size: its middle sits on its element's top right corner. */
const PIN = 24;
/** How far apart two pins' corners must be. */
const CLEARANCE = 20;
/** How far a pin moves aside at each try. */
const STEP = 22;
/** How close to the screen's sides a pin may go. */
const MARGIN = 2;
/** How many steps a pin tries to each side, and how many rows down. */
const SIDEWAYS = 8;
const ROWS = 4;

const OFFSETS = [
    0,
    ...Array.from({ length: SIDEWAYS }, (_, i) => -(i + 1) * STEP),
    ...Array.from({ length: SIDEWAYS }, (_, i) => (i + 1) * STEP),
];

/** The top left of each pin, in order: the first to claim a place keeps it. `top` keeps them below the status bar. */
export function placePins(rects: Rect[], width: number, top = 50): Point[] {
    const placed: Point[] = [];
    const maxX = Math.max(MARGIN, width - PIN - MARGIN);
    for (const r of rects) {
        const first = {
            x: Math.min(Math.max(MARGIN, r.x + r.w - PIN / 2), maxX),
            y: Math.max(top, r.y - PIN / 2),
        };
        placed.push(free(first, maxX, placed) ?? first);
    }
    return placed;
}

/** The first free place near `first`: leftward along its row, then rightward, then the same on the rows below. */
function free(first: Point, maxX: number, placed: Point[]): Point | undefined {
    for (let row = 0; row < ROWS; row++) {
        for (const offset of OFFSETS) {
            const spot = { x: first.x + offset, y: first.y + row * STEP };
            if (spot.x < MARGIN || spot.x > maxX) continue;
            if (
                !placed.some(
                    (p) => Math.abs(p.x - spot.x) < CLEARANCE && Math.abs(p.y - spot.y) < CLEARANCE
                )
            )
                return spot;
        }
    }
    return undefined;
}
