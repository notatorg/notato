/**
 * Where pins go: each at its element's top right, and moved aside when another pin is there already (several notes on
 * one element, or on elements next to each other). The Swift SDK's PinLayout.
 */
const CLEARANCE = 20;
const STEP = 22;
const MARGIN = 2;
const SIDEWAYS = 8;
const ROWS = 4;

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

const OFFSETS = [
    0,
    ...Array.from({ length: SIDEWAYS }, (_, i) => -(i + 1) * STEP),
    ...Array.from({ length: SIDEWAYS }, (_, i) => (i + 1) * STEP),
];

/** The top left of each pin, in order: the first to claim a place keeps it. `top` keeps them below the status bar. */
export function placePins(rects: Rect[], width: number, top = 50): Array<{ x: number; y: number }> {
    const placed: Array<{ x: number; y: number }> = [];
    const maxX = Math.max(MARGIN, width - 26);
    for (const r of rects) {
        const first = {
            x: Math.min(Math.max(MARGIN, r.x + r.w - 12), maxX),
            y: Math.max(top, r.y - 12),
        };
        placed.push(free(first, maxX, placed) ?? first);
    }
    return placed;
}

/** The first free place near `first`: leftward along its row, then rightward, then the same on the rows below. */
function free(
    first: { x: number; y: number },
    maxX: number,
    placed: Array<{ x: number; y: number }>
) {
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
