import type { AssetRef } from "@notato/schema";
import { PixelRatio, Platform } from "react-native";
import { captureRef } from "react-native-view-shot";
import { captureSize, fromBase64, pngSize } from "./png.ts";

/** A screenshot as it is sent and kept: its PNG bytes, and the reference the note carries. */
export interface Shot {
    bytes: Uint8Array;
    ref: AssetRef;
}

/** A PNG of a view (the whole app, or one view of it) at `size` points, or undefined when it cannot be taken. */
export async function shoot(
    view: unknown,
    id: string,
    size: { width: number; height: number },
    maxScale: number
): Promise<Shot | undefined> {
    if (!view || size.width < 1 || size.height < 1) return undefined;
    try {
        // A view's instance, or its native tag: view-shot takes either.
        const data = await captureRef(view as Parameters<typeof captureRef>[0], {
            format: "png",
            quality: 1,
            result: "base64",
            ...captureSize(size.width, size.height, maxScale, PixelRatio.get(), Platform.OS),
        });
        const bytes = fromBase64(data);
        const dims = pngSize(bytes);
        if (!dims) return undefined;
        return { bytes, ref: { id, mime: "image/png", w: dims.w, h: dims.h } };
    } catch {
        return undefined;
    }
}
