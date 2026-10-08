import type { CapturePlugin } from "@notato/core";
import { redactFragment } from "../url.ts";

export interface RouteOptions {
    /** Include `location.hash` in the route, for apps with hash routing. */
    hash?: boolean;
}

/**
 * The route as recorded: `pathname`, plus the hash when enabled. A hash route can carry a secret as a URL can
 * (`#/reset?token=…`), and a note's route reaches the agent, webhooks and bundles, so it is blanked out the same way.
 */
export function routeString(loc: Pick<Location, "pathname" | "hash">, hash: boolean): string {
    return hash && loc.hash ? `${loc.pathname}#${redactFragment(loc.hash.slice(1))}` : loc.pathname;
}

/** Records the route as `pathname`, plus the hash when enabled. */
export function routePlugin(options: RouteOptions = {}): CapturePlugin {
    return {
        id: "route",
        async capture() {
            return { route: routeString(window.location, options.hash ?? false) };
        },
    };
}
