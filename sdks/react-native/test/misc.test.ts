import { describe, expect, it } from "vitest";
import { multipart, NotatoError } from "../src/client.ts";
import { captureSize, fromBase64, pngSize } from "../src/png.ts";
import { placePins } from "../src/ui/pinLayout.ts";
import { annotation } from "./fixtures.ts";

describe("png", () => {
    it("decodes base64 as react-native-view-shot gives it", () => {
        const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 7) % 256));
        const text = btoa(String.fromCharCode(...bytes));
        expect(fromBase64(text)).toEqual(bytes);
        expect(fromBase64(`${text.slice(0, 40)}\n${text.slice(40)}`)).toEqual(bytes);
        expect(fromBase64(btoa(String.fromCharCode(1, 2)))).toEqual(new Uint8Array([1, 2]));
    });

    it("reads a PNG's size from its header", () => {
        const header = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 56, 0, 0,
            9, 96,
        ]);
        expect(pngSize(header)).toEqual({ w: 1080, h: 2400 });
        expect(pngSize(new Uint8Array(4))).toBeUndefined();
    });

    it("asks for at most maxScale pixels per point: points on iOS, pixels on Android", () => {
        expect(captureSize(402, 874, 2, 3, "ios")).toEqual({ width: 268, height: 583 });
        expect(captureSize(411, 914, 2, 2.625, "android")).toEqual({ width: 822, height: 1828 });
        expect(captureSize(411, 914, 2, 2, "android")).toBeUndefined();
    });
});

describe("client", () => {
    it("sends a note as the multipart body every SDK sends", () => {
        const a = annotation();
        const body = new TextDecoder().decode(
            multipart(a, [{ id: "s1", bytes: new Uint8Array([1, 2, 3]) }], "B")
        );
        expect(body).toContain(
            '--B\r\nContent-Disposition: form-data; name="annotation"\r\nContent-Type: application/json\r\n\r\n{'
        );
        expect(body).toContain(
            'name="asset:s1"; filename="s1.png"\r\nContent-Type: image/png\r\n\r\n\u0001\u0002\u0003\r\n--B--\r\n'
        );
    });

    it("tells a note the server will never take from a server that will not take it now", () => {
        expect(new NotatoError("x", 422).refusesNote).toBe(true);
        expect(new NotatoError("x", 409).refusesNote).toBe(true);
        expect(new NotatoError("x", 404).refusesNote).toBe(false);
        expect(new NotatoError("x", 401).permanent).toBe(true);
        expect(new NotatoError("x", 429).permanent).toBe(false);
        expect(new NotatoError("x").permanent).toBe(false);
    });
});

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
