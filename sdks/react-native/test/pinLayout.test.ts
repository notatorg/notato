import { describe, expect, it } from "vitest";
import { placePins } from "../src/ui/pinLayout.ts";

describe("placePins", () => {
    it("puts each pin at its element's top right, and moves one aside when another is there", () => {
        const spots = placePins(
            [
                { x: 100, y: 200, w: 50, h: 20 },
                { x: 100, y: 200, w: 50, h: 20 },
                { x: 300, y: 10, w: 200, h: 20 },
            ],
            400
        );
        expect(spots[0]).toEqual({ x: 138, y: 188 });
        expect(spots[1]).toEqual({ x: 116, y: 188 });
        // Kept on screen and below the status bar.
        expect(spots[2]).toEqual({ x: 374, y: 50 });
    });

    it("places a thousand pins quickly", () => {
        const rects = Array.from({ length: 1000 }, (_, i) => ({
            x: (i * 37) % 380,
            y: (i * 53) % 800,
            w: 40,
            h: 20,
        }));
        const t = performance.now();
        expect(placePins(rects, 402)).toHaveLength(1000);
        expect(performance.now() - t).toBeLessThan(1000);
    });
});
