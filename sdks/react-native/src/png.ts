import type { AssetRef } from "@notato/schema";

/** A screenshot as it is sent and kept: its PNG bytes, and the reference the note carries. */
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
    if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: view.getUint32(16), h: view.getUint32(20) };
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

/** A screenshot's bytes and reference, read from what view-shot gave. Undefined when it is not a PNG. */
export function readShot(raw: RawShot | undefined): Shot | undefined {
    if (!raw) return undefined;
    const bytes = fromBase64(raw.data);
    const dims = pngSize(bytes);
    return dims
        ? { bytes, ref: { id: raw.id, mime: "image/png", w: dims.w, h: dims.h } }
        : undefined;
}
