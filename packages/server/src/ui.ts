import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiAssets } from "./http.ts";
import { webAssets } from "./web-assets.generated.ts";

const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".json": "application/json; charset=utf-8",
};

/**
 * Where `bun run build:board` writes the board. A server running from the source tree keeps the list of files it
 * loaded at start, but a rebuild gives the scripts and styles new hashed names, and the page, read afresh, asks for
 * those: so a name the list does not have is looked for here. In a compiled binary this folder does not exist, and only
 * the embedded files are served.
 */
const DIST = join(dirname(fileURLToPath(import.meta.url)), "../../board/dist");

/** The content type of a board file a folder may serve, or undefined for a path that is not one. */
function servable(path: string): string | undefined {
    if (path.includes("..") || path.startsWith("/") || path.includes("\\")) return undefined;
    return TYPES[path.slice(path.lastIndexOf("."))];
}

/** A built board's file from `dir`, when it is one the board has. */
async function fromFolder(dir: string, path: string) {
    const type = servable(path);
    if (!type) return null;
    const file = Bun.file(join(dir, path));
    return (await file.exists()) ? { body: file, type } : null;
}

/**
 * The board UI built into this binary, or null when the build did not include it (from source: the one in
 * packages/board/dist). `NOTATO_WEB_DIST` serves a board built somewhere else instead
 * (`bun packages/board/scripts/build.ts --outdir <dir>`), so a new board can be tried on a scratch server without
 * replacing the one a running server serves.
 */
export function bundledUi(): UiAssets | null {
    const override = process.env.NOTATO_WEB_DIST;
    if (override) return folderUi(override);
    const assets = webAssets;
    // The list is the empty stub the repository keeps: a server run from source serves the last `build:board`, if any.
    if (!assets) return existsSync(join(DIST, "index.html")) ? folderUi(DIST) : null;
    return {
        async lookup(path) {
            const found = assets[path];
            if (found) return { body: Bun.file(found.path), type: found.type };
            return fromFolder(DIST, path);
        },
    };
}

/** Every file of a built board, read from `dir` as it is asked for. */
function folderUi(dir: string): UiAssets {
    return { lookup: (path) => fromFolder(dir, path) };
}
