import type { CapturePlugin } from "@notato/core";
import { animationsOn } from "../ui/freeze.ts";

/**
 * Records what is animating on the annotated elements, and how far along each animation is, which is what "too slow"
 * or "it jumps" is about. Freezing the page first (Pause) makes the progress the moment the person was looking at.
 */
export function animationsPlugin(): CapturePlugin {
    return {
        id: "animations",
        async capture(draft) {
            const seen = draft.elements.flatMap((el) => animationsOn(el));
            return seen.length ? { context: { animations: seen } } : undefined;
        },
    };
}
