import { NativeModules, PixelRatio, Platform } from "react-native";
import { captureRef } from "react-native-view-shot";
import { captureSize, compressScreenshot, type RawShot } from "./png.ts";

export type { RawShot, Shot } from "./png.ts";

/**
 * Whether Android has the app's window marked never to be captured (`FLAG_SECURE`: a one-time code, a card's number),
 * which view-shot would capture anyway. Only an app built with Notato's native module can tell; Expo Go cannot, and
 * says no.
 */
export async function windowIsSecure(): Promise<boolean> {
    if (Platform.OS !== "android") return false;
    const codec = NativeModules.NotatoImageCodec as
        | { isWindowSecure?(): Promise<boolean> }
        | undefined;
    try {
        return (await codec?.isWindowSecure?.()) === true;
    } catch {
        return false;
    }
}

/**
 * A compressed capture of a view at `size` points (base64, not read yet), or
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
        const codec = NativeModules.NotatoImageCodec as
            | { encodeWebP(png: string): Promise<string | null> }
            | undefined;
        return {
            id,
            data: await compressScreenshot(
                data,
                codec ? (png) => codec.encodeWebP(png) : undefined
            ),
        };
    } catch {
        return undefined;
    }
}
