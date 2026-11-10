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

/**
 * What went wrong drawing the page, as the toolbar recorded it: a screenshot that is only a stand-in, or frames on the
 * page that are missing from it. Without this a blank picture looks like a bug in the board.
 */
export function screenshotProblem(a: Annotation): string | null {
    const shot = a.context.screenshot as
        | { method?: unknown; error?: unknown; frameErrors?: unknown }
        | undefined;
    if (!shot || typeof shot !== "object") return null;
    if (shot.method === "fallback") {
        const why = typeof shot.error === "string" && shot.error ? `: ${shot.error}` : ".";
        return `The toolbar could not draw this page, so the screenshot is a stand-in${why}`;
    }
    const failed = typeof shot.frameErrors === "number" ? shot.frameErrors : 0;
    if (failed > 0)
        return `${failed === 1 ? "A frame" : `${failed} frames`} on this page could not be drawn, so ${failed === 1 ? "it shows" : "they show"} blank.`;
    return null;
}

/** SDKs and list views need the pin metadata, rather than a copy of all console/network/style diagnostics. */
export function annotationSummary(a: Annotation): Annotation {
    const { steps: _steps, context, ...rest } = a;
    return { ...rest, context: context.screenshot ? { screenshot: context.screenshot } : {} };
}
