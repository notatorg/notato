import type { Annotation } from "@notato/schema";
import { buildAnnotation } from "../src/annotation.ts";

/** A plain note, as the SDK makes one. */
export function annotation(over: Partial<Annotation> = {}): Annotation {
    return {
        ...buildAnnotation({
            project: "shop",
            appName: "Shop",
            route: "/shop",
            identity: { selector: "ProductCard > Text", tag: "Text", text: "£1.45" },
            rect: { x: 10, y: 100, w: 60, h: 20 },
            comment: "Bigger",
            pin: 1,
            device: { os: "ios", osVersion: "26.5", viewport: { w: 402, h: 874 }, dpr: 3 },
        }),
        ...over,
    };
}
