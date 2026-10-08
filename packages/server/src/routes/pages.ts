import type { Principal } from "../auth.ts";
import type { UiAssets } from "../http.ts";
import { bookmarkletPage, injectSource } from "../inject.ts";
import { isSecure, json, type Routes } from "./common.ts";

/** The board's own page may load only what the server itself serves, and may not be framed. */
const BOARD_CSP =
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * A file of the board: the page itself (`/`), revalidated every time, or one of its hashed scripts, styles and fonts
 * (`/ui/*`), cached for good. Null when there is no board or no such file.
 */
async function boardFile(ui: UiAssets, path: string): Promise<Response | null> {
    const file = path === "/" ? "index.html" : path.slice("/ui/".length);
    if (file.includes("..") || file.startsWith("/")) return null;
    const found = await ui.lookup(file);
    if (!found) return null;
    const shell = file === "index.html";
    return new Response(found.body, {
        headers: {
            "Content-Type": found.type,
            "Cache-Control": shell ? "no-cache" : "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            ...(shell
                ? {
                      "Content-Security-Policy": BOARD_CSP,
                      "X-Frame-Options": "DENY",
                      "Referrer-Policy": "no-referrer",
                  }
                : {}),
        },
    });
}

/** What anyone may load without signing in: the board, and the script (with its bookmarklet page) that puts Notato on any page. */
export const pageRoutes: Routes<Principal | null> = async (
    { req, url, path, method },
    { options }
) => {
    if (method !== "GET") return null;
    if (path === "/inject.js") {
        const script = await injectSource();
        if (!script) return json({ error: "this build does not include the page script" }, 404);
        return new Response(script, {
            headers: {
                "Content-Type": "text/javascript; charset=utf-8",
                // Fetched afresh each time, so a newer server never serves an older script from a cache.
                "Cache-Control": "no-cache",
                "X-Content-Type-Options": "nosniff",
            },
        });
    }
    if (path === "/bookmarklet") {
        // The origin the person used to reach this server, so the bookmark points back at it.
        const scheme = isSecure(req, options.trustProxy) ? "https" : "http";
        const origin = `${scheme}://${req.headers.get("host") ?? url.host}`;
        return new Response(
            bookmarkletPage(origin, {
                project: url.searchParams.get("project") ?? undefined,
                token: url.searchParams.get("token") ?? undefined,
            }),
            {
                headers: {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                    "Content-Security-Policy":
                        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
                    "X-Content-Type-Options": "nosniff",
                },
            }
        );
    }
    if (options.ui && (path === "/" || path.startsWith("/ui/"))) return boardFile(options.ui, path);
    return null;
};
