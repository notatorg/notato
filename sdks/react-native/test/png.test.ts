import { describe, expect, it } from "vitest";
import {
    captureSize,
    compressScreenshot,
    fromBase64,
    pngSize,
    readShot,
    webpSize,
} from "../src/png.ts";

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

function header(w: number, h: number) {
    const bytes = new Uint8Array(40);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("RIFF"));
    view.setUint32(4, 32, true);
    bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
    view.setUint32(16, 10, true);
    view.setUint32(24, w - 1, true);
    bytes[27] = (h - 1) & 255;
    bytes[28] = ((h - 1) >>> 8) & 255;
    bytes[29] = ((h - 1) >>> 16) & 255;
    return bytes;
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

it("reads WebP dimensions and media types while rejecting truncated headers", () => {
    const bytes = header(1080, 2400);
    expect(webpSize(bytes)).toEqual({ w: 1080, h: 2400 });
    expect(readShot({ id: "image", data: base64(bytes) })?.ref).toEqual({
        id: "image",
        mime: "image/webp",
        w: 1080,
        h: 2400,
    });
    expect(webpSize(bytes.subarray(0, 24))).toBeUndefined();
    bytes[16] = 255;
    expect(webpSize(bytes)).toBeUndefined();
});

it("accepts smaller native encodings only at the original dimensions and safely falls back", async () => {
    const png = new Uint8Array(100);
    png.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const view = new DataView(png.buffer);
    view.setUint32(16, 320);
    view.setUint32(20, 480);
    const original = base64(png);
    const webp = base64(header(320, 480));
    expect(await compressScreenshot(original, async () => webp)).toBe(webp);
    expect(await compressScreenshot(original)).toBe(original);
    expect(await compressScreenshot(original, async () => null)).toBe(original);
    expect(await compressScreenshot(original, async () => base64(header(160, 240)))).toBe(original);
    expect(
        await compressScreenshot(original, async () => {
            throw new Error("old binary");
        })
    ).toBe(original);
    expect(await compressScreenshot(original, async () => original + original)).toBe(original);
});
