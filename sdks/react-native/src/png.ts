import type { AssetRef } from "@notato/schema";

/** A screenshot as it is sent and kept, with its actual media type. */
export interface Shot {
    bytes: Uint8Array;
    ref: AssetRef;
}

/**
 * A screenshot as react-native-view-shot hands it over, as base64 and not read yet: turning it into bytes is work for
 * the JavaScript thread, left until the note is sent, so it is never done while the composer comes in.
 */
export interface RawShot {
    id: string;
    data: string;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;
LOOKUP["-".charCodeAt(0)] = 62;
LOOKUP["_".charCodeAt(0)] = 63;

/** Base64 to bytes, without relying on `atob` (which older Hermes builds lack). Whitespace and padding are skipped. */
export function fromBase64(text: string): Uint8Array {
    const clean = text.replace(/[^A-Za-z0-9+/_-]/g, "");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let at = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const a = LOOKUP[clean.charCodeAt(i)] as number;
        const b = LOOKUP[clean.charCodeAt(i + 1)] as number;
        const c = LOOKUP[clean.charCodeAt(i + 2)] as number;
        const d = LOOKUP[clean.charCodeAt(i + 3)] as number;
        out[at++] = (a << 2) | (b >> 4);
        if (i + 2 < clean.length) out[at++] = ((b & 15) << 4) | (c >> 2);
        if (i + 3 < clean.length) out[at++] = ((c & 3) << 6) | d;
    }
    return out.subarray(0, at);
}

/** A PNG's size, from its header. */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | undefined {
    if (
        bytes.length < 24 ||
        ![0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every(
            (value, i) => bytes[i] === value
        )
    )
        return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const w = view.getUint32(16);
    const h = view.getUint32(20);
    return w > 0 && h > 0 ? { w, h } : undefined;
}

/** WebP's three frame headers, without decoding pixels on the JavaScript thread. */
export function webpSize(bytes: Uint8Array): { w: number; h: number } | undefined {
    const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
    if (bytes.length < 25 || tag(0) !== "RIFF" || tag(8) !== "WEBP") return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 12; at + 8 <= bytes.length; ) {
        const size = view.getUint32(at + 4, true);
        if (at + 8 + size > bytes.length) return undefined;
        const kind = tag(at);
        if (kind === "VP8X" && size >= 10) {
            const u24 = (p: number) =>
                (bytes[p] ?? 0) | ((bytes[p + 1] ?? 0) << 8) | ((bytes[p + 2] ?? 0) << 16);
            return { w: u24(at + 12) + 1, h: u24(at + 15) + 1 };
        }
        if (kind === "VP8L" && size >= 5 && bytes[at + 8] === 0x2f) {
            const bits = view.getUint32(at + 9, true);
            return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (
            kind === "VP8 " &&
            size >= 10 &&
            bytes[at + 11] === 0x9d &&
            bytes[at + 12] === 1 &&
            bytes[at + 13] === 0x2a
        )
            return {
                w: view.getUint16(at + 14, true) & 0x3fff,
                h: view.getUint16(at + 16, true) & 0x3fff,
            };
        at += 8 + size + (size & 1);
    }
    return undefined;
}

/** A missing native module (an app binary made before this SDK) is a safe PNG fallback. */
export async function compressScreenshot(
    data: string,
    encoder?: (png: string) => Promise<string | null>
): Promise<string> {
    if (!encoder) return data;
    try {
        const result = await encoder(data);
        if (!result || result.length >= data.length) return data;
        const original = pngSize(fromBase64(data));
        const compressed = webpSize(fromBase64(result));
        if (original && compressed && original.w === compressed.w && original.h === compressed.h)
            return result;
    } catch {
        // Compression cannot make capturing a note fail.
    }
    return data;
}

/**
 * The size to ask react-native-view-shot for, so the image is at most `maxScale` pixels per point: iOS takes it in
 * points and draws at the screen's scale, Android in pixels.
 */
export function captureSize(
    width: number,
    height: number,
    maxScale: number,
    dpr: number,
    os: string
) {
    const scale = Math.min(dpr, maxScale);
    if (scale >= dpr) return undefined;
    const factor = os === "ios" ? scale / dpr : scale;
    return {
        width: Math.max(1, Math.round(width * factor)),
        height: Math.max(1, Math.round(height * factor)),
    };
}

/** A screenshot's bytes and reference, read from what view-shot gave. Supports old PNGs and compressed WebP. */
export function readShot(raw: RawShot | undefined): Shot | undefined {
    if (!raw) return undefined;
    const bytes = fromBase64(raw.data);
    const webp = webpSize(bytes);
    const dims = webp ?? pngSize(bytes);
    return dims && dims.w > 0 && dims.h > 0
        ? {
              bytes,
              ref: { id: raw.id, mime: webp ? "image/webp" : "image/png", w: dims.w, h: dims.h },
          }
        : undefined;
}
