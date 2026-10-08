import { describe, expect, it } from "vitest";
import { captureSize, fromBase64, pngSize } from "../src/png.ts";

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
