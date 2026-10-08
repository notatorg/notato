import type { IdentityPlugin } from "@notato/core";

/** The attribute the Notato Vite plugin writes: `path/from/repo/root.tsx:line:column`. */
export const SOURCE_ATTRIBUTE = "data-notato-src";

const POSITION = /^(.+):(\d+):(\d+)$/;

/** `path:line:col` into its parts, or undefined when it is not one. */
export function parseSource(value: string | null | undefined) {
    const match = value ? POSITION.exec(value) : null;
    if (!match) return undefined;
    const line = Number(match[2]);
    const col = Number(match[3]);
    return line > 0 && col > 0 ? { file: match[1] as string, line, col } : undefined;
}

/**
 * Reads where an element is written from the attribute the Vite plugin leaves on it, which is there even in a
 * production build. An element without it (one a library created) takes the nearest tagged element around it and
 * says so, since that is where to start looking rather than the exact line.
 */
export function sourceAttributeIdentityPlugin(): IdentityPlugin {
    return {
        id: "source-attribute",
        resolve(el) {
            const own = parseSource(el.getAttribute(SOURCE_ATTRIBUTE));
            if (own) return { source: own };
            const parent = el.parentElement?.closest(`[${SOURCE_ATTRIBUTE}]`);
            const near = parseSource(parent?.getAttribute(SOURCE_ATTRIBUTE));
            return near ? { source: { ...near, nearest: true } } : {};
        },
    };
}
