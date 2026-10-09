import { PixelRatio, Platform } from "react-native";
import { captureRef } from "react-native-view-shot";
import { captureSize, type RawShot } from "./png.ts";

export type { RawShot, Shot } from "./png.ts";

/**
 * A PNG of a view (the whole app, or one view of it) at `size` points, as view-shot gives it (base64, not read yet), or
 * undefined when it cannot be taken.
 */
export async function shootRaw(
    view: unknown,
    id: string,
    size: { width: number; height: number },
    maxScale: number
): Promise<RawShot | undefined> {
    if (!view || size.width < 1 || size.height < 1) return undefined;
    try {
        // A view's instance, or its native tag: view-shot takes either.
        const data = await captureRef(view as Parameters<typeof captureRef>[0], {
            format: "png",
            quality: 1,
            result: "base64",
            ...captureSize(size.width, size.height, maxScale, PixelRatio.get(), Platform.OS),
        });
        return { id, data };
    } catch {
        return undefined;
    }
}
