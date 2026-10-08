import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_URL } from "../scripts/repo.ts";

// The docs pages, made from the READMEs so they never say something the READMEs do not: the main README is cut into
// pages by its headings, and each SDK's README is a page of its own. Links between them are pointed at the right page.

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A section of a README by its heading; `intro` keeps only what comes before its first subheading. */
type Section = string | { heading: string; intro: true };

interface Page {
    slug: string;
    group: string;
    title: string;
    /** One sentence for the docs home and under the page's title. */
    summary: string;
    file: string;
    /** Leave out to use the whole file (less its title and its Development section). */
    sections?: Section[];
}

export const GROUPS = ["Web apps", "Mobile apps", "Agents and teams", "Reference"] as const;

export const PAGES: Page[] = [
    {
        slug: "react",
        group: "Web apps",
        title: "React apps",
        summary:
            "Vite or Next.js: one command adds the toolbar behind a dev-only guard and sets up your coding agent.",
        file: "README.md",
        sections: [{ heading: "Quick start (dev mode)", intro: true }, "SDK props"],
    },
    {
        slug: "angular",
        group: "Web apps",
        title: "Angular apps",
        summary:
            "Angular 19 and later: provideNotato() in the app config, and nothing in production builds.",
        file: "sdks/angular/README.md",
    },
    {
        slug: "any-page",
        group: "Web apps",
        title: "Any page and the Chrome extension",
        summary:
            "Put the toolbar on any web page with a bookmark, a script tag or the browser extension.",
        file: "README.md",
        sections: ["Any page, with nothing to install", "Browser extension"],
    },
    {
        slug: "swiftui",
        group: "Mobile apps",
        title: "SwiftUI",
        summary: "iOS 17 and later, as a Swift package with no dependencies.",
        file: "sdks/swift/README.md",
    },
    {
        slug: "android",
        group: "Mobile apps",
        title: "Android",
        summary: "Jetpack Compose and Views on Android 7 and later, with nothing to mark.",
        file: "sdks/android/README.md",
    },
    {
        slug: "maui",
        group: "Mobile apps",
        title: ".NET MAUI",
        summary: "iOS, Android and Mac Catalyst on .NET 10 and later.",
        file: "sdks/dotnet/README.md",
    },
    {
        slug: "react-native",
        group: "Mobile apps",
        title: "React Native",
        summary:
            "Expo or bare, on the New Architecture: wrap the app, tap a view, and the note has its component and file.",
        file: "sdks/react-native/README.md",
    },
    {
        slug: "flutter",
        group: "Mobile apps",
        title: "Flutter",
        summary:
            "iOS, Android, macOS and the web: wrap the app, tap a widget, and the note has its file and line.",
        file: "sdks/flutter/README.md",
    },
    {
        slug: "phones",
        group: "Mobile apps",
        title: "Real phones",
        summary: "A dev tunnel, so a phone on any network reaches the server on your machine.",
        file: "README.md",
        sections: ["Phones: a dev tunnel"],
    },
    {
        slug: "agents",
        group: "Agents and teams",
        title: "Your coding agent",
        summary:
            "Run it with one command, then connect Claude Code, Codex, Cursor, Gemini CLI, Copilot or any MCP client: the tools, what the agent gets and critique.",
        file: "README.md",
        sections: [
            "Run it",
            "Works with your coding agent",
            "MCP tools",
            "@ mentions: plugins on the server",
            "Critique mode",
            "Agent mode",
        ],
    },
    {
        slug: "teams",
        group: "Agents and teams",
        title: "Testers, servers and webhooks",
        summary:
            "Testers send a zip or post to a shared server, and webhooks tell Slack, Discord or Teams.",
        file: "README.md",
        sections: [
            "Test mode: testers send you a zip",
            "Shared server",
            "Webhooks",
            "Settings, and working with other people",
        ],
    },
    {
        slug: "features",
        group: "Reference",
        title: "Everything it does",
        summary: "Intents, variants, the board, Markdown export and screenshots, in full.",
        file: "README.md",
        sections: [
            "What you can say, and what the agent gets",
            "Variants: compare versions in the page",
            "The board: every project in one place",
            "Copy as Markdown, and export",
            "Screenshots: on or off",
        ],
    },
    {
        slug: "limits",
        group: "Reference",
        title: "Known limits",
        summary: "What Notato does not do yet, and what has not been tried.",
        file: "README.md",
        sections: ["Known limits"],
    },
];

/** Each SDK's README is its own page, so a link to one goes there. */
const README_PAGES: Record<string, string> = {
    "sdks/swift/README.md": "swiftui",
    "sdks/android/README.md": "android",
    "sdks/dotnet/README.md": "maui",
};

/** Not docs for people using Notato: how to work on it. */
const LEFT_OUT = ["Development"];

// ---- Markdown, by heading --------------------------------------------------------------------------------------

interface Heading {
    level: number;
    text: string;
    line: number;
}

/** The headings in some Markdown, not counting lines inside fenced code (`#if DEBUG`, shell comments). */
function headingsOf(lines: string[]): Heading[] {
    const out: Heading[] = [];
    let fenced = false;
    lines.forEach((line, i) => {
        if (/^\s*```/.test(line)) fenced = !fenced;
        else if (!fenced) {
            const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
            if (m?.[1] && m[2] !== undefined) out.push({ level: m[1].length, text: m[2], line: i });
        }
    });
    return out;
}

/** Moves every heading in these lines up or down by `shift` levels, keeping them between h2 and h6. */
function shiftHeadings(lines: string[], shift: number): string[] {
    let fenced = false;
    return lines.map((line) => {
        if (/^\s*```/.test(line)) fenced = !fenced;
        if (fenced || shift === 0) return line;
        return line.replace(/^(#{1,6})(?=\s)/, (marks) =>
            "#".repeat(Math.min(6, Math.max(2, marks.length - shift)))
        );
    });
}

/** The line ranges `[start, end)` each section of a page takes, for the check that nothing was left out. */
const placed = new Map<string, Array<[number, number]>>();

function sectionOf(file: string, lines: string[], section: Section): string[] {
    const heading = typeof section === "string" ? section : section.heading;
    const intro = typeof section !== "string";
    const all = headingsOf(lines);
    const at = all.findIndex((h) => h.text === heading);
    const found = all[at];
    if (!found)
        throw new Error(
            `docs: ${file} has no heading "${heading}" (did it change? see site/docs.ts)`
        );
    const end =
        all.slice(at + 1).find((h) => intro || h.level <= found.level)?.line ?? lines.length;
    placed.set(file, [...(placed.get(file) ?? []), [found.line, end]]);
    return shiftHeadings(lines.slice(found.line, end), found.level - 2);
}

/** A whole README: without its title (the page has its own), the picture at the top, and how to develop it. */
function wholeFile(lines: string[]): string[] {
    const all = headingsOf(lines);
    const out = [...lines];
    for (const name of LEFT_OUT) {
        const at = all.findIndex((h) => h.level === 2 && h.text === name);
        const found = all[at];
        if (!found) continue;
        const end = all.slice(at + 1).find((h) => h.level <= 2)?.line ?? lines.length;
        out.fill("\u0000", found.line, end);
    }
    const title = all.find((h) => h.level === 1);
    if (title) out[title.line] = "\u0000";
    return out.filter((line) => line !== "\u0000" && !line.startsWith("<p align"));
}

/** What comes before a README's first `##`: its opening paragraphs. */
function introOf(lines: string[]): string[] {
    const first = headingsOf(lines).find((h) => h.level === 2)?.line ?? lines.length;
    return lines
        .slice(0, first)
        .filter((line) => !/^#\s/.test(line) && !line.startsWith("<p align"));
}

// ---- HTML ------------------------------------------------------------------------------------------------------

const decode = (html: string) =>
    html
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");

/** An anchor the way GitHub makes one from a heading, so the READMEs' own links keep working. */
export function slugify(text: string): string {
    return decode(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .trim()
        .replace(/\s/g, "-");
}

const esc = (text: string) =>
    text.replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string
    );

interface Rendered {
    page: Page;
    html: string;
    ids: Set<string>;
    toc: Array<{ level: number; id: string; html: string }>;
}

function render(page: Page, markdown: string): Rendered {
    const ids = new Set<string>();
    const toc: Rendered["toc"] = [];
    let html = Bun.markdown.html(markdown);
    html = html.replace(/<h([2-4])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
        const base = slugify(inner);
        let id = base;
        for (let n = 1; ids.has(id); n++) id = `${base}-${n}`;
        ids.add(id);
        if (Number(level) <= 3) toc.push({ level: Number(level), id, html: inner });
        return `<h${level} id="${id}">${inner}<a class="h-anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`;
    });
    html = html
        .replace(
            /<pre><code class="language-([\w+-]+)">/g,
            '<pre class="code"><code data-lang="$1">'
        )
        .replace(/<pre><code>/g, '<pre class="code"><code>')
        .replace(/<table>/g, '<div class="table-wrap"><table>')
        .replace(/<\/table>/g, "</table></div>");
    return { page, html, ids, toc };
}

/** Points a README's link at the docs page that now has it, or at the file in the repository. */
function relink(href: string, from: Rendered, pageOfId: Map<string, string>): string {
    if (/^[a-z][a-z+.-]*:/i.test(href) || href.startsWith("//")) return href;
    if (href.startsWith("#")) {
        const id = href.slice(1);
        if (from.ids.has(id)) return href;
        const other = pageOfId.get(id);
        return other ? `${other}.html#${id}` : href;
    }
    const [path = "", anchor] = href.split("#");
    const target = normalize(join(dirname(from.page.file), path))
        .split("\\")
        .join("/");
    if (target === "README.md") {
        const other = anchor ? pageOfId.get(anchor) : undefined;
        return other ? `${other}.html#${anchor}` : "index.html";
    }
    const readme = README_PAGES[target];
    if (readme) return `${readme}.html${anchor ? `#${anchor}` : ""}`;
    return `${REPO_URL}/blob/main/${target}${anchor ? `#${anchor}` : ""}`;
}

function sidebar(current: string): string {
    const link = (slug: string, title: string) =>
        `<a href="${slug}.html"${slug === current ? ' aria-current="page"' : ""}>${esc(title)}</a>`;
    const groups = GROUPS.map(
        (group) =>
            `<div class="dn-group"><p>${group}</p>${PAGES.filter((p) => p.group === group)
                .map((p) => link(p.slug, p.title))
                .join("")}</div>`
    ).join("");
    return `<nav class="docs-nav" aria-label="Docs">${link("index", "Overview")}${groups}</nav>`;
}

function layout(options: {
    slug: string;
    title: string;
    summary: string;
    group?: string;
    body: string;
    toc: Rendered["toc"];
}): string {
    const { slug, title, summary, group, body, toc } = options;
    const order = ["index", ...PAGES.map((p) => p.slug)];
    const at = order.indexOf(slug);
    const titleOf = (s: string) =>
        s === "index" ? "Overview" : (PAGES.find((p) => p.slug === s)?.title ?? s);
    const prev = order[at - 1];
    const next = order[at + 1];
    const pager = `<nav class="doc-pager" aria-label="Previous and next">${
        prev
            ? `<a class="prev" href="${prev}.html"><small>Previous</small>${esc(titleOf(prev))}</a>`
            : "<span></span>"
    }${next ? `<a class="next" href="${next}.html"><small>Next</small>${esc(titleOf(next))}</a>` : ""}</nav>`;
    const onThisPage = toc.length
        ? `<aside class="docs-toc" aria-label="On this page"><p>On this page</p>${toc
              .map((t) => `<a class="toc-${t.level}" href="#${t.id}">${t.html}</a>`)
              .join("")}</aside>`
        : `<aside class="docs-toc"></aside>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${slug === "index" ? "Notato docs" : `${esc(title)} · Notato docs`}</title>
<meta name="description" content="${esc(summary)}">
<link rel="icon" href="../notato.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800&family=Figtree:ital,wght@0,400..700;1,400&family=JetBrains+Mono:wght@400;500;700&display=swap">
<link rel="stylesheet" href="../site.css">
<link rel="stylesheet" href="../docs.css">
<script type="module" src="../docs.js"></script>
</head>
<body class="docs-body">
<a class="skip" href="#doc">Skip to content</a>
<header class="nav">
  <div class="wrap nav-in">
    <a class="brand" href="../index.html"><img src="../notato.png" alt="" width="34" height="34"><span>Notato</span></a>
    <span class="docs-badge">Docs</span>
    <nav class="nav-links" aria-label="Site">
      <a href="../index.html">Home</a>
      <a href="index.html"${slug === "index" ? ' aria-current="page"' : ""}>Docs</a>
      <a href="${REPO_URL}">GitHub</a>
    </nav>
    <a class="btn btn-sm btn-tab" href="../index.html#try">Try it</a>
  </div>
</header>
<div class="wrap docs">
  <details class="docs-menu"><summary>${esc(group ? `${group} · ${title}` : title)}</summary>${sidebar(slug)}</details>
  <div class="docs-side">${sidebar(slug)}</div>
  <main class="doc" id="doc">
    ${group ? `<p class="doc-crumb"><a href="index.html">Docs</a> › ${esc(group)}</p>` : ""}
    <h1>${esc(title)}</h1>
    <p class="doc-lede">${esc(summary)}</p>
    ${body}
    ${pager}
  </main>
  ${onThisPage}
</div>
<footer class="foot">
  <div class="wrap foot-in">
    <span class="brand"><img src="../notato.png" alt="" width="28" height="28"><span>Notato</span></span>
    <p>Made from the READMEs in the repository, so it says what the code does.</p>
    <p class="foot-links"><a href="${REPO_URL}">Source on GitHub</a><a href="../index.html">Home</a></p>
  </div>
</footer>
</body>
</html>
`;
}

/** Writes every docs page into `<dist>/docs`, and says on stderr if a README section is on no page. */
export function buildDocs(dist: string) {
    placed.clear();
    const read = (file: string) => readFileSync(join(repo, file), "utf8").split("\n");
    const rendered = PAGES.map((page) => {
        const lines = read(page.file);
        const parts = page.sections
            ? page.sections.flatMap((s) => [...sectionOf(page.file, lines, s), ""])
            : wholeFile(lines);
        return render(page, parts.join("\n"));
    });

    // Every heading of the main README is somewhere, apart from its title and how to develop it.
    const main = read("README.md");
    const left = headingsOf(main).filter(
        (h) =>
            h.level > 1 &&
            !LEFT_OUT.includes(h.text) &&
            !headingsOf(main).some(
                (d) => LEFT_OUT.includes(d.text) && d.level < h.level && d.line < h.line
            ) &&
            !(placed.get("README.md") ?? []).some(([start, end]) => h.line >= start && h.line < end)
    );
    for (const h of left)
        console.warn(`docs: README.md section "${h.text}" is on no docs page (see site/docs.ts)`);

    const pageOfId = new Map<string, string>();
    for (const r of rendered)
        for (const id of r.ids) if (!pageOfId.has(id)) pageOfId.set(id, r.page.slug);

    mkdirSync(join(dist, "docs"), { recursive: true });
    for (const r of rendered) {
        const body = r.html.replace(
            /href="([^"]*)"/g,
            (_m, href: string) => `href="${relink(href, r, pageOfId)}"`
        );
        writeFileSync(
            join(dist, "docs", `${r.page.slug}.html`),
            layout({ ...r.page, body, toc: r.toc })
        );
    }

    // The docs home: what Notato is, from the top of the README, then a card for each page.
    const intro = render(
        { slug: "index", group: "", title: "", summary: "", file: "README.md" },
        introOf(main).join("\n")
    );
    const introBody = intro.html.replace(
        /href="([^"]*)"/g,
        (_m, href: string) => `href="${relink(href, intro, pageOfId)}"`
    );
    const cards = GROUPS.map(
        (group) =>
            `<h2 id="${slugify(group)}">${group}</h2><div class="doc-cards">${PAGES.filter(
                (p) => p.group === group
            )
                .map(
                    (p) =>
                        `<a class="doc-card" href="${p.slug}.html"><b>${esc(p.title)}</b><span>${esc(p.summary)}</span></a>`
                )
                .join("")}</div>`
    ).join("");
    writeFileSync(
        join(dist, "docs", "index.html"),
        layout({
            slug: "index",
            title: "Notato docs",
            summary:
                "Set Notato up in your app and your coding agent, then see everything it can do.",
            body: `<div class="doc-intro">${introBody}</div>${cards}`,
            toc: GROUPS.map((g) => ({ level: 2, id: slugify(g), html: g })),
        })
    );
    return PAGES.length + 1;
}
