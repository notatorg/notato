import { DEFAULT_STYLE, detectStyle, type Style } from "./style.ts";

/** What a transform did. `reason` explains a no-op, so the CLI can tell the person what to do instead. */
export interface Edit {
    changed: boolean;
    source: string;
    reason?: string;
    /** Something worth saying about a change that was made, e.g. which of several matches was used. */
    note?: string;
}

export interface SetupOptions {
    project: string;
    server: string;
    /**
     * `dev` renders the toolbar under `vite dev` only. `env` also renders it in a build made with VITE_NOTATO=true,
     * for apps that are built and previewed during development (`vite build --watch` + `vite preview`), where
     * `import.meta.env.DEV` is false. Without the variable a build still ships nothing.
     */
    guard?: "dev" | "env";
}

const ALREADY = "already set up";

/** `my-app`, `@scope/my-app` -> a project id the server accepts. */
export function projectIdFromPackage(name: string | undefined): string {
    const bare = (name ?? "").replace(/^@[^/]+\//, "");
    const cleaned = bare.replace(/[^\w.@-]/g, "-").replace(/^-+|-+$/g, "");
    return cleaned.slice(0, 128) || "app";
}

/** Applies the file's quotes and semicolons to an import written as `import { X } from "y"`. */
function styledImport(line: string, style: Style): string {
    const quoted = style.quote === "'" ? line.replace(/"/g, "'") : line;
    return style.semi && !quoted.endsWith(";") ? `${quoted};` : quoted;
}

const isLineBreak = (c: string | undefined) => c === "\n" || c === "\r";

/**
 * Index just past the whitespace and comments at `i`. With `sameLine`, it stops at a line break, except one inside a
 * block comment.
 */
function skipTrivia(source: string, i: number, sameLine = false): number {
    for (;;) {
        const c = source[i];
        if (c === " " || c === "\t" || (!sameLine && isLineBreak(c))) i++;
        else if (c === "/" && source[i + 1] === "/") {
            while (i < source.length && !isLineBreak(source[i])) i++;
        } else if (c === "/" && source[i + 1] === "*") {
            const close = source.indexOf("*/", i + 2);
            if (close < 0) return source.length;
            i = close + 2;
        } else return i;
    }
}

/** Index just past the string literal whose quote is at `i`, or -1 when it does not close on its line. */
function stringEnd(source: string, i: number): number {
    const quote = source[i];
    for (let j = i + 1; j < source.length; j++) {
        if (source[j] === "\\") j++;
        else if (source[j] === quote) return j + 1;
        else if (isLineBreak(source[j])) return -1;
    }
    return -1;
}

/** Index just past the `{ … }` whose brace is at `i`, or -1. */
function bracesEnd(source: string, i: number): number {
    let depth = 0;
    for (let j = i; j < source.length; j = skipTrivia(source, j)) {
        const c = source[j];
        if (c === '"' || c === "'") {
            j = stringEnd(source, j);
            if (j < 0) return -1;
            continue;
        }
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) return j + 1;
        j++;
    }
    return -1;
}

/**
 * Index just past the import declaration whose clause starts at `i` (just after the `import` keyword): its module
 * specifier, any `with { … }` attributes and its semicolon. -1 when it is not one this can read.
 */
function importDeclarationEnd(source: string, i: number): number {
    let depth = 0;
    for (let j = skipTrivia(source, i); j < source.length; j = skipTrivia(source, j)) {
        const c = source[j];
        if (c === '"' || c === "'") {
            const end = stringEnd(source, j);
            if (end < 0) return -1;
            if (depth > 0) {
                j = end;
                continue;
            }
            // The module specifier: what may follow it on the same statement is attributes and a semicolon.
            let k = end;
            const next = skipTrivia(source, k, true);
            const attributes = /^(?:with|assert)\s*\{/.exec(source.slice(next));
            if (attributes) {
                k = bracesEnd(source, next + attributes[0].length - 1);
                if (k < 0) return -1;
            }
            const semicolon = skipTrivia(source, k, true);
            return source[semicolon] === ";" ? semicolon + 1 : k;
        }
        if (c === "{" || c === "(") depth++;
        else if (c === "}" || c === ")") depth--;
        else if (c === "=" && depth === 0) {
            // TypeScript's `import x = require("y")` or `import x = A.B`: it ends with its line.
            let k = j + 1;
            while (k < source.length && !(isLineBreak(source[k]) && depth === 0)) {
                if (source[k] === "(") depth++;
                else if (source[k] === ")") depth--;
                k++;
            }
            return k;
        } else if (c === ";" && depth === 0) return -1;
        j++;
    }
    return -1;
}

/**
 * Where the imports at the top of a file end: just past the last import declaration in the run of directives, comments
 * and imports a module starts with. -1 when there is none. It reads statement by statement and stops at the first
 * statement that is not an import, so nothing later in the file (a string at the end of a line in an object, a JSX
 * attribute, a ternary) can be taken for the end of an import.
 */
function importsEnd(source: string): number {
    let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
    if (source.startsWith("#!", i)) i = source.slice(i).search(/\r?\n|$/) + i;
    let last = -1;
    for (;;) {
        i = skipTrivia(source, i);
        const c = source[i];
        if (c === '"' || c === "'") {
            // A directive ("use client"), which may come before the imports.
            const end = stringEnd(source, i);
            if (end < 0) return last;
            const next = skipTrivia(source, end, true);
            if (source[next] === ";") i = next + 1;
            else if (next >= source.length || isLineBreak(source[next])) i = end;
            else return last;
            continue;
        }
        if (!/^import\b/.test(source.slice(i, i + 7))) return last;
        // `import(…)` and `import.meta` are expressions, not declarations.
        const after = skipTrivia(source, i + "import".length);
        if (source[after] === "(" || source[after] === ".") return last;
        const end = importDeclarationEnd(source, i + "import".length);
        if (end < 0) return last;
        last = end;
        i = end;
    }
}

/** Inserts after the last import statement (including multi-line ones), or after a directive, or at the top. */
export function addImport(
    source: string,
    rawLine: string,
    style: Style = detectStyle(source)
): string {
    const line = styledImport(rawLine, style);
    // Written in the file's own line endings, so a CRLF file does not come out with a stray LF.
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const end = importsEnd(source);
    if (end >= 0) {
        // After a comment that ends the import's line; before anything else written on that line.
        const rest = skipTrivia(source, end, true);
        if (rest >= source.length || isLineBreak(source[rest]))
            return `${source.slice(0, rest)}${eol}${line}${source.slice(rest)}`;
        const code = end + (/^[ \t]*/.exec(source.slice(end))?.[0].length ?? 0);
        return `${source.slice(0, end)}${eol}${line}${eol}${source.slice(code)}`;
    }
    const directive =
        /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*))*\s*["']use (?:client|server)["'];?[ \t]*\n/.exec(
            source
        );
    if (directive)
        return `${source.slice(0, directive[0].length)}${eol}${line}${eol}${source.slice(directive[0].length)}`;
    return `${line}${eol}${source}`;
}

const visualWidth = (text: string, style: Style) =>
    text.replace(/\t/g, style.indent.includes("\t") ? "    " : style.indent).length;

/** The Notato element on one line if it fits `printWidth`, otherwise one attribute per line as prettier writes it. */
function notatoElement(
    setup: SetupOptions,
    indent: string,
    style: Style,
    prefix = "",
    suffix = ""
): string {
    const attrs = [
        `mode="dev"`,
        // In a production build the component stays off unless told otherwise; the guard has already decided.
        ...(setup.guard === "env" ? ["enabled"] : []),
        `project=${JSON.stringify(setup.project)}`,
        `server=${JSON.stringify(setup.server)}`,
    ];
    const oneLine = `${indent}${prefix}<Notato ${attrs.join(" ")} />${suffix}`;
    if (visualWidth(oneLine, style) <= style.printWidth) return oneLine;
    const u = style.indent;
    return [
        `${indent}${prefix}<Notato`,
        ...attrs.map((a) => `${indent}${u}${a}`),
        `${indent}/>${suffix}`,
    ].join("\n");
}

/** `{import.meta.env.DEV && <Notato … />}`, wrapped like prettier does when it is too long. */
function devGuard(setup: SetupOptions, indent: string, style: Style): string {
    const condition =
        setup.guard === "env"
            ? `(import.meta.env.DEV || import.meta.env.VITE_NOTATO === "true")`
            : "import.meta.env.DEV";
    const oneLine = notatoElement(setup, indent, style, `{${condition} && `, "}");
    if (!oneLine.includes("\n")) return oneLine;
    const u = style.indent;
    return [
        `${indent}{${condition} && (`,
        notatoElement(setup, `${indent}${u}`, style),
        `${indent})}`,
    ].join("\n");
}

const APP_TAG = /<App(?:\s[^>]*?)?\s*\/>/g;

/**
 * Vite + React: wraps `<App />` in a fragment and adds the toolbar next to it behind
 * `import.meta.env.DEV`, which Vite replaces with `false` in production builds so nothing ships.
 *
 * With several `<App />` in the file, the one inside the `.render(` call is the root; otherwise the first.
 */
export function addToViteEntry(
    source: string,
    options: SetupOptions,
    style: Style = detectStyle(source)
): Edit {
    if (/@notato\/react/.test(source)) return { changed: false, source, reason: ALREADY };
    const candidates = [...source.matchAll(APP_TAG)];
    if (candidates.length === 0) {
        return {
            changed: false,
            source,
            reason: "could not find <App /> to put the toolbar next to",
        };
    }
    const renderAt = source.indexOf(".render(");
    const app =
        (renderAt >= 0 ? candidates.find((c) => (c.index ?? 0) > renderAt) : undefined) ??
        (candidates[0] as RegExpMatchArray);
    const at = app.index ?? 0;
    const lineStart = source.lastIndexOf("\n", at) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
    const u = style.indent;
    const wrapped = `<>\n${indent}${u}${app[0]}\n${devGuard(options, `${indent}${u}`, style)}\n${indent}</>`;
    const edited = source.slice(0, at) + wrapped + source.slice(at + app[0].length);
    return {
        changed: true,
        source: addImport(edited, 'import { Notato } from "@notato/react"', style),
        note:
            candidates.length > 1
                ? `found ${candidates.length} <App /> tags; used the one inside .render(...)`
                : undefined,
    };
}

/** The client component Next.js needs, since the toolbar uses browser APIs. Development only. */
export function nextClientComponent(options: SetupOptions, style: Style = DEFAULT_STYLE): string {
    const q = style.quote;
    const semi = style.semi ? ";" : "";
    const u = style.indent;
    const oneLine = notatoElement(options, u, style, "return ", semi);
    const ret = oneLine.includes("\n")
        ? [`${u}return (`, notatoElement(options, `${u}${u}`, style), `${u})${semi}`]
        : [oneLine];
    return [
        `${q}use client${q}${semi}`,
        "",
        styledImport('import { Notato } from "@notato/react"', style),
        "",
        "/** Mounts the Notato toolbar in development only; renders nothing in production builds. */",
        "export function NotatoDev() {",
        `${u}if (process.env.NODE_ENV !== ${q}development${q}) return null${semi}`,
        ...ret,
        "}",
        "",
    ].join("\n");
}

/** Next.js App Router: adds `<NotatoDev />` just before the closing `</body>` of the root layout. */
export function addToNextLayout(
    source: string,
    componentImport: string,
    style: Style = detectStyle(source)
): Edit {
    if (/NotatoDev/.test(source)) return { changed: false, source, reason: ALREADY };
    const closeAt = source.indexOf("</body>");
    if (closeAt < 0)
        return { changed: false, source, reason: "could not find </body> in the root layout" };
    const u = style.indent;
    const lineStart = source.lastIndexOf("\n", closeAt) + 1;
    const before = source.slice(lineStart, closeAt);
    const indent = /^[ \t]*/.exec(before)?.[0] ?? "";
    const after = source.slice(closeAt + "</body>".length);
    let edited: string;
    if (before.trim() === "") {
        // </body> on its own line: add a line above it, indented like its siblings.
        edited = `${source.slice(0, lineStart)}${indent}${u}<NotatoDev />\n${indent}</body>${after}`;
    } else {
        // `<body>{children}</body>` on one line: open it up so the toolbar gets a line of its own, as prettier would.
        const open = /<body\b[^>]*>/.exec(before);
        const inner = open ? before.slice(open.index + open[0].length).trim() : before.trim();
        const head = open ? before.slice(0, open.index + open[0].length) : "";
        edited = `${source.slice(0, lineStart)}${head}\n${inner ? `${indent}${u}${inner}\n` : ""}${indent}${u}<NotatoDev />\n${indent}</body>${after}`;
    }
    return {
        changed: true,
        source: addImport(edited, `import { NotatoDev } from "${componentImport}"`, style),
    };
}

/** Next.js Pages Router: wraps `<Component {...pageProps} />` in a fragment with the toolbar beside it. */
export function addToNextPagesApp(
    source: string,
    componentImport: string,
    style: Style = detectStyle(source)
): Edit {
    if (/NotatoDev/.test(source)) return { changed: false, source, reason: ALREADY };
    const page = /<Component\s+\{\.\.\.pageProps\}\s*\/>/.exec(source);
    if (!page)
        return {
            changed: false,
            source,
            reason: "could not find <Component {...pageProps} /> in _app",
        };
    const lineStart = source.lastIndexOf("\n", page.index) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
    const u = style.indent;
    const wrapped = `<>\n${indent}${u}${page[0]}\n${indent}${u}<NotatoDev />\n${indent}</>`;
    const edited =
        source.slice(0, page.index) + wrapped + source.slice(page.index + page[0].length);
    return {
        changed: true,
        source: addImport(edited, `import { NotatoDev } from "${componentImport}"`, style),
    };
}

/** Adds `.notato/` (screenshots and the local database) to a .gitignore, once. */
export function addToGitignore(source: string): Edit {
    if (/^\/?\.notato\/?\s*$/m.test(source)) return { changed: false, source, reason: ALREADY };
    const separator = source.length === 0 || source.endsWith("\n") ? "" : "\n";
    return {
        changed: true,
        source: `${source}${separator}\n# Notato: local feedback database and screenshots\n.notato/\n`,
    };
}

// ---- reverting ------------------------------------------------------------------------------------------
// Each of these undoes what the matching `addTo…` wrote, and only that. When the code has been changed by hand
// into something they do not recognise they change nothing and say why, rather than guess.

const NOT_SET_UP = "not set up";
const IMPORT_NOTATO =
    /^import\s*\{\s*Notato\s*\}\s*from\s*["']@notato\/react["'];?[ \t]*(?:\r?\n|$)/m;
const IMPORT_NOTATO_DEV =
    /^import\s*\{\s*NotatoDev\s*\}\s*from\s*["'][^"']+["'];?[ \t]*(?:\r?\n|$)/m;

/** Index just past the `/>` that closes the JSX element opening at `start`, skipping braces and strings. */
function elementEnd(source: string, start: number): number {
    let depth = 0;
    for (let i = start; i < source.length; i++) {
        const c = source[i];
        if (c === '"' || c === "'" || c === "`") {
            for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
        } else if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === "/" && source[i + 1] === ">" && depth === 0) return i + 2;
    }
    return -1;
}

/**
 * Takes the element `<tag … />` out, together with the `{condition && (…)}` it sits in. Whole lines go when the
 * element has them to itself. Returns null when it is somewhere this does not understand.
 */
function removeElement(source: string, tag: string): string | null {
    const start = source.search(new RegExp(`<${tag}\\b`));
    if (start < 0) return null;
    const end = elementEnd(source, start);
    if (end < 0) return null;

    let from = start;
    let to = end;
    const before = source.slice(0, start);
    const after = source.slice(end);
    const guarded = /\{[^{}]*?&&\s*\(?\s*$/.exec(before);
    const closing = /^\s*\)?\s*\}/.exec(after);
    if (guarded && closing) {
        from = guarded.index;
        to = end + closing[0].length;
    } else if (/&&\s*\(?\s*$|\?\s*\(?\s*$|:\s*\(?\s*$/.test(before)) {
        return null; // inside an expression of the person's own: removing just the element would break it
    }

    const lineStart = source.lastIndexOf("\n", from - 1) + 1;
    const lineEndAt = source.indexOf("\n", to);
    const lineEnd = lineEndAt < 0 ? source.length : lineEndAt + 1;
    const alone =
        source.slice(lineStart, from).trim() === "" && source.slice(to, lineEnd).trim() === "";
    if (!alone && !(guarded && closing)) return null;
    const cutFrom = alone ? lineStart : from;
    const cutTo = alone ? lineEnd : to;
    const removed = source.slice(cutFrom, cutTo);
    if ((removed.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length !== 1) return null;
    return source.slice(0, cutFrom) + source.slice(cutTo);
}

/** Undoes `addToViteEntry`: the element, the import, and the fragment that only held `<App />` and the toolbar. */
export function removeFromViteEntry(source: string): Edit {
    const hasImport = /@notato\/react/.test(source);
    if (!hasImport && !/<Notato\b/.test(source))
        return { changed: false, source, reason: NOT_SET_UP };

    let out = source;
    let note: string | undefined;
    if (/<Notato\b/.test(out)) {
        const without = removeElement(out, "Notato");
        if (without === null) {
            return {
                changed: false,
                source,
                reason: "the <Notato /> element has been changed by hand into something I could not safely remove",
            };
        }
        out = without;
    }
    out = out.replace(/<>\s*(<App(?:\s[^>]*?)?\s*\/>)\s*<\/>/, "$1");
    const withoutImport = out.replace(IMPORT_NOTATO, "");
    if (withoutImport === out && /@notato\/react/.test(out) && !/<Notato\b/.test(out)) {
        note = "left the @notato/react import, which has other names in it";
    }
    out = withoutImport;
    return { changed: out !== source, source: out, note };
}

/** Undoes `addToNextLayout`: the `<NotatoDev />` line and its import. */
export function removeFromNextLayout(source: string): Edit {
    if (!/NotatoDev/.test(source)) return { changed: false, source, reason: NOT_SET_UP };
    const without = removeElement(source, "NotatoDev");
    if (without === null) {
        return {
            changed: false,
            source,
            reason: "<NotatoDev /> has been changed by hand; remove it yourself",
        };
    }
    return { changed: true, source: without.replace(IMPORT_NOTATO_DEV, "") };
}

/** Undoes `addToNextPagesApp`: also unwraps the fragment that held `<Component />` and the toolbar. */
export function removeFromNextPagesApp(source: string): Edit {
    const edit = removeFromNextLayout(source);
    if (!edit.changed) return edit;
    return {
        ...edit,
        source: edit.source.replace(/<>\s*(<Component\s+\{\.\.\.pageProps\}\s*\/>)\s*<\/>/, "$1"),
    };
}

/** True for the component file `nextClientComponent` writes, so a file the person wrote is never deleted. */
export function isGeneratedNotatoComponent(source: string): boolean {
    return (
        /export function NotatoDev\(\)/.test(source) && /from\s*["']@notato\/react["']/.test(source)
    );
}

/** Undoes `addToGitignore`, when the block is the one init wrote (it has the comment). */
export function removeFromGitignore(source: string): Edit {
    const block =
        /\r?\n# Notato: local feedback database and screenshots\r?\n\.notato\/[ \t]*(?:\r?\n|$)/;
    if (block.test(source)) return { changed: true, source: source.replace(block, "") };
    if (/^\/?\.notato\/?\s*$/m.test(source)) {
        return {
            changed: false,
            source,
            reason: "has a .notato entry that init did not add; left as it is",
        };
    }
    return { changed: false, source, reason: NOT_SET_UP };
}

// ---- the Vite plugin ------------------------------------------------------------------------------------

const PLUGIN_IMPORT = 'import { notatoSource } from "@notato/vite"';
const PLUGIN_IMPORT_LINE =
    /^import\s*\{\s*notatoSource\s*\}\s*from\s*["']@notato\/vite["'];?[ \t]*(?:\r?\n|$)/m;
const PLUGIN_CALL = "notatoSource()";

/**
 * Adds `notatoSource()` as the first entry of the `plugins: [` array in a Vite config, with its import. It only
 * does anything when `VITE_NOTATO=true`, so the config stays valid everywhere. Where the config is not in a shape
 * this can edit safely (no literal `plugins: [`, or CommonJS), it changes nothing and says why.
 */
export function addToViteConfig(source: string, style: Style = detectStyle(source)): Edit {
    if (/@notato\/vite/.test(source)) return { changed: false, source, reason: ALREADY };
    if (!/^\s*import\s/m.test(source) && /\brequire\(/.test(source)) {
        return {
            changed: false,
            source,
            reason: "this is a CommonJS config; add notatoSource() to its plugins yourself",
        };
    }
    const array = /\bplugins\s*:\s*\[/.exec(source);
    if (!array) {
        return {
            changed: false,
            source,
            reason: "could not find a literal `plugins: [` array in the config",
        };
    }
    const open = array.index + array[0].length;
    const rest = source.slice(open);
    const inline = /^[ \t]*(?=\S)/.exec(rest);
    let edited: string;
    if (/^[ \t]*\r?\n/.test(rest)) {
        // One entry per line: a line of its own, indented like the entries that follow.
        const next = /\r?\n([ \t]*)(?=\S)/.exec(rest);
        const indent = next?.[1] ?? style.indent;
        const eol = /^[ \t]*(\r?\n)/.exec(rest)?.[1] ?? "\n";
        const lead = /^[ \t]*\r?\n/.exec(rest)?.[0] ?? "";
        edited = `${source.slice(0, open)}${lead}${indent}${PLUGIN_CALL},${eol}${rest.slice(lead.length)}`;
    } else {
        // All on one line: in front of the first entry, or alone in an empty array.
        const empty = /^[ \t]*\]/.test(rest);
        edited = `${source.slice(0, open)}${PLUGIN_CALL}${empty ? "" : ", "}${rest.slice(inline?.[0].length ?? 0)}`;
    }
    return {
        changed: true,
        source: addImport(edited, PLUGIN_IMPORT, style),
        note:
            (source.match(/\bplugins\s*:\s*\[/g)?.length ?? 0) > 1
                ? "used the first plugins array"
                : undefined,
    };
}

/** Undoes `addToViteConfig`: the entry, wherever in the array it now sits, and the import. */
export function removeFromViteConfig(source: string): Edit {
    if (!/notatoSource\(/.test(source) && !/@notato\/vite/.test(source)) {
        return { changed: false, source, reason: NOT_SET_UP };
    }
    let out = source;
    // Only the exact entry init writes, and only as an element of an array: anything else is the person's own.
    // On a line of its own: the whole line.
    out = out.replace(/^[ \t]*notatoSource\(\),?[ \t]*\r?\n/m, "");
    // Inline: with the comma that separated it from its neighbour.
    out = out
        .replace(/(?<=[[,]\s*)notatoSource\(\),\s*/, "")
        .replace(/,\s*notatoSource\(\)(?=\s*\])/, "")
        .replace(/(?<=\[\s*)notatoSource\(\)(?=\s*\])/, "");
    if (/notatoSource\(/.test(out)) {
        return {
            changed: false,
            source,
            reason: "notatoSource() is used in a way I could not safely remove",
        };
    }
    out = out.replace(PLUGIN_IMPORT_LINE, "");
    return { changed: out !== source, source: out };
}
