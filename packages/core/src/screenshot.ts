import type { Annotation } from "@notato/schema";

/** A crop in physical pixels of the stored full screenshot, never page coordinates. */
export interface ScreenshotCrop {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Invalid or old metadata never becomes a filesystem path or an unchecked image allocation. */
export function screenshotCrop(a: Annotation): ScreenshotCrop | undefined {
    const raw = (a.context.screenshot as { cropRect?: unknown } | undefined)?.cropRect;
    const full = a.screenshots?.full;
    if (!full || !raw || typeof raw !== "object") return undefined;
    const { x, y, w, h } = raw as ScreenshotCrop;
    if (
        ![x, y, w, h].every(Number.isSafeInteger) ||
        x < 0 ||
        y < 0 ||
        w < 1 ||
        h < 1 ||
        x + w > full.w ||
        y + h > full.h
    )
        return undefined;
    return { x, y, w, h };
}

/** SDKs and list views need the pin metadata, rather than a copy of all console/network/style diagnostics. */
export function annotationSummary(a: Annotation): Annotation {
    const { steps: _steps, context, ...rest } = a;
    return { ...rest, context: context.screenshot ? { screenshot: context.screenshot } : {} };
}
