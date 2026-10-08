import { createController } from "./controller.ts";

/**
 * Loaded by a `<script>` tag from a Notato server (`<server>/inject.js`), this puts Notato on any page, whatever
 * it is built with and whether or not it has the SDK. The server is wherever the script came from. Options are in the
 * script's query string, or in `window.__NOTATO_CONFIG__` set before it runs:
 *
 *   project   the project the notes go to (default: this page's host and port, so each app is its own)
 *   mode      `dev` (default) or `agent`
 *   token     a project token, for a shared server that asks for one
 *   author    a name for the notes
 *   hash      `1` when the app routes with the URL hash
 *   server    only when the script was not loaded from the server itself
 *
 * A page whose Content-Security-Policy let this script in by its nonce lets Notato's styles in by the same one, in a
 * browser too old for the constructed stylesheets that need none.
 */
interface InjectConfig {
    server?: string;
    project?: string;
    mode?: string;
    author?: string;
    token?: string;
    hash?: string | boolean;
}

declare global {
    interface Window {
        __NOTATO_CONFIG__?: InjectConfig;
    }
}

/** A project id from where the page is served: letters, digits, dots and dashes, so it is always a valid id. */
const projectFor = (host: string) => host.replace(/[^\w.@-]+/g, "-").slice(0, 100) || "page";

function start() {
    // Only while the script runs: read now, used once the page has a body.
    const script = document.currentScript as HTMLScriptElement | null;
    let from: URL | null = null;
    try {
        from = script?.src ? new URL(script.src) : null;
    } catch {
        // not a URL: the config has to say where the server is
    }
    const query = from?.searchParams;
    const config = window.__NOTATO_CONFIG__ ?? {};
    const pick = (key: keyof InjectConfig): string | undefined => {
        const fromConfig = config[key];
        if (typeof fromConfig === "string" && fromConfig) return fromConfig;
        if (typeof fromConfig === "boolean") return fromConfig ? "1" : "";
        return query?.get(key) || undefined;
    };

    const server = (pick("server") ?? from?.origin)?.replace(/\/$/, "");
    if (!server) {
        console.warn(
            "[notato] no server to send notes to: load this script from a Notato server, or set window.__NOTATO_CONFIG__.server"
        );
        return;
    }
    const props = {
        mode: pick("mode") === "agent" ? ("agent" as const) : ("dev" as const),
        server,
        project: pick("project") ?? projectFor(window.location.host),
        appName: window.location.host,
        author: pick("author"),
        token: pick("token"),
        hashRoutes: pick("hash") === "1",
        persist: false,
        nonce: script?.nonce || undefined,
    };
    // A script in the <head> runs before there is a body to put the toolbar in.
    if (document.body) createController(props);
    else
        document.addEventListener("DOMContentLoaded", () => createController(props), {
            once: true,
        });
}

start();
