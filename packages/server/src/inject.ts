import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundledUi } from "./ui.ts";

let source: Promise<string | null> | undefined;

/**
 * The script that puts Notato on any page (`GET /inject.js`). A release has it built in; running from source it is
 * built once, on first use. Null when neither is possible.
 */
export function injectSource(): Promise<string | null> {
    source ??= load();
    return source;
}

async function load(): Promise<string | null> {
    const embedded = await bundledUi()?.lookup("inject.js");
    if (embedded) return await new Response(embedded.body).text();
    const entry = fileURLToPath(new URL("../../../sdks/browser/src/inject.ts", import.meta.url));
    if (!existsSync(entry)) return null;
    const built = await Bun.build({
        entrypoints: [entry],
        minify: true,
        target: "browser",
        define: { "process.env.NODE_ENV": '"production"' },
    });
    return built.success && built.outputs[0] ? await built.outputs[0].text() : null;
}

export interface InjectOptions {
    /** The project the notes go to. Each page's own host and port when left out. */
    project?: string;
    /** For a shared server that needs one. Visible to anyone who can read the page, like the SDK's. */
    token?: string;
    author?: string;
}

/** The address of the script, with what it was asked to do. */
export function scriptUrl(origin: string, options: InjectOptions = {}): string {
    const query = new URLSearchParams();
    if (options.project) query.set("project", options.project);
    if (options.token) query.set("token", options.token);
    if (options.author) query.set("author", options.author);
    const q = query.toString();
    return `${origin.replace(/\/$/, "")}/inject.js${q ? `?${q}` : ""}`;
}

/**
 * A bookmark's address: clicking it on a page loads the script into that page. A browser decodes percent-escapes in a
 * `javascript:` address before running it, so only what needs none is put in: the project and token are plain
 * characters, and the name (which can be anything) is left to the settings panel.
 */
export function bookmarklet(origin: string, options: InjectOptions = {}): string {
    if (!SAFE_ORIGIN.test(origin))
        throw new Error(`not an origin a bookmark can point at: ${origin}`);
    const { project, token } = plain(options);
    const url = scriptUrl(origin, { project, token });
    const where = `${origin.replace(/\/$/, "")}/inject.js`;
    // Single quotes only. The time makes a second click on the same page load it afresh.
    return (
        `javascript:(function(){var s=document.createElement('script');` +
        `s.src='${url}${url.includes("?") ? "&" : "?"}t='+Date.now();` +
        `s.onerror=function(){alert('Notato: could not load ${where}. Is it running, and does this page allow scripts from there?')};` +
        `document.documentElement.appendChild(s)})();`
    );
}

/** An origin as a bookmark can carry it: scheme, host and port only, nothing a script would read as code. */
const SAFE_ORIGIN = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?\/?$/;
const PLAIN_PROJECT = /^(?!\.+$)[\w.@-]{1,128}$/;
const PLAIN_TOKEN = /^[\w-]{1,200}$/;

/**
 * The project and token, kept only when they are the plain characters a `javascript:` address can carry as they are.
 * The page takes both from its own query string, and a quote in either (sent as %27, decoded before the bookmark
 * runs) would end the script's string and run whatever followed in the page it is clicked on.
 */
function plain(options: InjectOptions): { project?: string; token?: string } {
    return {
        project:
            options.project && PLAIN_PROJECT.test(options.project) ? options.project : undefined,
        token: options.token && PLAIN_TOKEN.test(options.token) ? options.token : undefined,
    };
}

/** The same thing to paste into the browser's console on a page. */
export function consoleSnippet(origin: string, options: InjectOptions = {}): string {
    return `(()=>{const s=document.createElement("script");s.src=${JSON.stringify(scriptUrl(origin, options))};document.documentElement.append(s)})()`;
}

const escapeHtml = (text: string) =>
    text.replace(
        /[&<>"']/g,
        (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
    );

/** The page at `/bookmarklet`: a link to drag to the bookmarks bar, and the other ways to load the script. */
export function bookmarkletPage(origin: string, asked: InjectOptions = {}): string {
    // What the query string asked for, kept only if it is plain: the page shows exactly what the bookmark will use.
    const options = { ...asked, ...plain(asked) };
    if (!SAFE_ORIGIN.test(origin)) origin = "http://localhost:4747";
    const label = options.project ? `Notato (${options.project})` : "Notato";
    const tag = `<script src="${scriptUrl(origin, options)}"></script>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notato on any page</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 20px; color: #111827; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .lead { color: #4b5563; margin-top: 0; }
  a.bm { display: inline-block; padding: 8px 16px; border-radius: 999px; background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; }
  pre { padding: 10px 12px; border-radius: 8px; background: #f3f4f6; overflow-x: auto; font-size: 13px; }
  .note { color: #6b7280; font-size: 13px; }
</style></head><body>
<h1>Notato on any page</h1>
<p class="lead">No install in the app, and nothing to rebuild. Click it on the page you want to annotate.</p>
<p><a class="bm" href="${escapeHtml(bookmarklet(origin, options))}">${escapeHtml(label)}</a></p>
<p>Drag the button to your bookmarks bar. Then open your app and click the bookmark: the Notato toolbar appears, and notes go to <code>${escapeHtml(origin)}</code>${options.project ? ` as project <code>${escapeHtml(options.project)}</code>` : ", each page's own host and port as its project"}.</p>
<h2>Or</h2>
<p>Paste this into the browser console on the page:</p>
<pre>${escapeHtml(consoleSnippet(origin, options))}</pre>
<p>Or add this to the page's HTML while you are working on it:</p>
<pre>${escapeHtml(tag)}</pre>
<p class="note">It reloads with the page, so click it again after a refresh. A page whose Content-Security-Policy does not allow scripts from this server will refuse it; the browser extension is for those. By default this server accepts notes from pages on this machine and local networks; for another site start it with <code>--cors-origin &lt;its origin&gt;</code>.</p>
</body></html>`;
}
