import type { Annotation } from "@notato/schema";
import { agentView } from "./agent-view.ts";

/**
 * How much of an annotation to write out. `compact` is a line, for scanning. `standard` is what a person or an agent
 * needs to find and fix the thing. `detailed` adds what the element looks like and where it sits. `forensic` is
 * everything captured: the full console and network, the raw identity, the evidence.
 */
export const DETAILS = ["compact", "standard", "detailed", "forensic"] as const;
export type Detail = (typeof DETAILS)[number];

export function parseDetail(value: unknown): Detail | undefined {
    return typeof value === "string" && (DETAILS as readonly string[]).includes(value)
        ? (value as Detail)
        : undefined;
}

export interface RenderOptions {
    detail?: Detail;
    /** The screenshots are being delivered alongside, as images. */
    screenshotsAttached?: boolean;
    /** Lines to put after the annotation and before the note about screenshots, e.g. what an agent should do next. */
    notes?: string[];
    /** For the agent: asides, which are for the people on the thread, are left out. */
    forAgent?: boolean;
}

/** The number on the pin and in the screenshot, which the screenshot plugin records. */
export function pinNumber(a: Annotation): number | undefined {
    const shot = a.context.screenshot as { pin?: unknown } | undefined;
    return typeof shot?.pin === "number" ? shot.pin : undefined;
}

interface ConsoleEntry {
    level: string;
    message: string;
}
interface NetworkEntry {
    method: string;
    url: string;
    status?: number;
    ms?: number;
}
interface AnimationEntry {
    kind?: string;
    name?: string;
    property?: string;
    duration?: number;
    delay?: number;
    easing?: string;
    iterations?: number | string;
    progress?: number;
    state?: string;
}

type Identity = Annotation["target"]["identity"][number];

export const clip = (s: string, n: number) => {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/**
 * Text that goes on a line of its own making stays on that line: a line break in it would let what someone typed
 * start a heading or a code fence of the document's own.
 */
const inline = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, " ");

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Captured context is whatever a client sent: anything that is not what the first-party SDK writes is shown as text. */
const asText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};
const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
const fields = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

function consoleEntries(a: Annotation): ConsoleEntry[] {
    return listOf(a.context?.console).flatMap((e): ConsoleEntry[] => {
        if (typeof e === "string") return [{ level: "log", message: e }];
        const f = fields(e);
        return f ? [{ level: asText(f.level) || "log", message: asText(f.message) }] : [];
    });
}

function networkEntries(a: Annotation): NetworkEntry[] {
    return listOf(a.context?.network).flatMap((e): NetworkEntry[] => {
        const f = fields(e);
        if (!f) return [];
        return [
            {
                method: asText(f.method) || "?",
                url: asText(f.url),
                status: asNumber(f.status),
                ms: asNumber(f.ms),
            },
        ];
    });
}

function animationEntries(a: Annotation): AnimationEntry[] {
    return listOf(a.context?.animations).flatMap((e): AnimationEntry[] => {
        const f = fields(e);
        if (!f) return [];
        const text = (v: unknown) => (typeof v === "string" ? v : undefined);
        return [
            {
                kind: text(f.kind),
                name: text(f.name),
                property: text(f.property),
                duration: asNumber(f.duration),
                delay: asNumber(f.delay),
                easing: text(f.easing),
                iterations: asNumber(f.iterations) ?? text(f.iterations),
                progress: asNumber(f.progress),
                state: text(f.state),
            },
        ];
    });
}

/** A request that failed: no response (status 0) or an error status. Unknown when a client did not say. */
const failedRequest = (e: NetworkEntry) =>
    e.status !== undefined && (e.status === 0 || e.status >= 400);
const statusText = (e: NetworkEntry) =>
    e.status === undefined ? "?" : e.status === 0 ? "no response" : String(e.status);

function consoleSummary(a: Annotation): string | undefined {
    const entries = consoleEntries(a);
    if (entries.length === 0) return undefined;
    const problems = entries.filter((e) =>
        ["error", "uncaught", "unhandledrejection", "warn"].includes(e.level)
    );
    if (problems.length === 0) return `${entries.length} message(s), no warnings or errors`;
    const errors = problems.filter((e) => e.level !== "warn");
    const last = problems[problems.length - 1];
    return `${errors.length} error(s), ${problems.length - errors.length} warning(s) — last: ${last ? `${clip(last.level, 40)}: ${clip(last.message, 200)}` : ""}`;
}

function networkSummary(a: Annotation): string | undefined {
    const entries = networkEntries(a);
    if (entries.length === 0) return undefined;
    const failed = entries.filter(failedRequest);
    if (failed.length === 0) return `${entries.length} request(s), none failed`;
    return `${failed.length} failed of ${entries.length} — ${failed
        .slice(-3)
        .map((e) => `${clip(e.method, 20)} ${clip(e.url, 300)} → ${statusText(e)}`)
        .join("; ")}`;
}

/** `iframe #preview → shadow root of #widget`: how to get to an element that is not simply in the page. */
function route(within: NonNullable<Identity["within"]>): string {
    return within
        .map((h) =>
            h.kind === "frame"
                ? `iframe \`${inline(h.selector)}\``
                : `shadow root of \`${inline(h.selector)}\``
        )
        .join(" → ");
}

function identityLine(i: Identity, index: number): string {
    const label = i.role ?? i.tag;
    const name = i.name ?? i.text;
    const parts = [
        `${index + 1}. ${inline(label)}${name ? ` “${clip(name, 60)}”` : ""}`,
        `selector \`${inline(i.selector)}\``,
    ];
    if (i.within?.length) parts.push(`reached through ${route(i.within)}`);
    if (i.testId) parts.push(`test id \`${inline(i.testId)}\``);
    if (i.source)
        parts.push(
            `${i.source.nearest ? "inside the element written at" : "written at"} ${inline(i.source.file)}:${i.source.line}:${i.source.col}`
        );
    if (i.component) {
        const path = i.component.path?.length
            ? ` in ${i.component.path.map((n) => `<${inline(n)}>`).join(" ")}`
            : "";
        parts.push(
            `component ${inline(i.component.name)}${i.component.source ? ` (${inline(i.component.source)})` : ""}${path}`
        );
    }
    return `  ${parts.join(" — ")}`;
}

const animationLine = (e: AnimationEntry) => {
    const what = e.name ?? e.property ?? e.kind ?? "animation";
    const timing = [
        e.duration !== undefined ? `${Math.round(e.duration)}ms` : "",
        e.easing,
        e.delay ? `delay ${Math.round(e.delay)}ms` : "",
        e.iterations === "infinite"
            ? "repeating"
            : e.iterations !== undefined && e.iterations !== 1
              ? `${e.iterations} times`
              : "",
    ].filter(Boolean);
    const where =
        e.progress !== undefined
            ? `${e.state ? `${e.state} ` : ""}at ${Math.round(e.progress * 100)}%`
            : (e.state ?? "");
    return inline(
        `${e.kind ? `${e.kind} ` : ""}${what}${timing.length ? ` ${timing.join(" ")}` : ""}${where ? ` (${where})` : ""}`
    );
};

/** What was offered to choose between, and what was chosen. */
function variantsLine(v: NonNullable<Annotation["variants"]>): string {
    const options = v.options
        .map((o) => (o.summary ? `${o.name} (${clip(o.summary, 80)})` : o.name))
        .join(", ");
    return inline(
        `Variants: group \`${v.group}\` — ${options}${v.chosen ? ` · picked: ${v.chosen}` : " · not picked yet"}`
    );
}

/**
 * The comment as the person wrote it. One line goes after `Comment:`; several are quoted, so nothing in them (a
 * heading, an unclosed code fence) can run on into the rest of the document.
 */
function commentLines(comment: string): string[] {
    const lines = comment.split(/\r\n|[\r\n\u2028\u2029]/);
    if (lines.length === 1) return [`Comment: ${comment}`];
    return ["Comment:", ...lines.map((l) => (l.trim() ? `> ${l}` : ">"))];
}

/** The most replies a note is written out with: its latest. A thread of thousands would be most of an agent's context. */
export const THREAD_LINES = 20;

const threadLines = (a: Annotation) => {
    const shown = a.thread.slice(-THREAD_LINES);
    const earlier = a.thread.length - shown.length;
    return [
        ...(earlier
            ? [
                  `  - (${earlier} earlier ${earlier === 1 ? "reply" : "replies"} not shown here: they are on the board)`,
              ]
            : []),
        ...shown.map(
            (r) =>
                `  - ${inline(r.author.name ?? r.author.kind)}${r.aside ? " (aside)" : ""}: ${clip(r.body, 400)}`
        ),
    ];
};

/** One line: for scanning a lot of them. */
function compactLine(a: Annotation): string {
    const pin = pinNumber(a);
    const t = a.target.identity[0];
    const tags = [a.intent, a.severity, a.status === "open" ? undefined : a.status]
        .filter(Boolean)
        .join(", ");
    const where = t
        ? `${inline(t.role ?? t.tag)}${t.name || t.text ? ` “${clip(t.name ?? t.text ?? "", 40)}”` : ""} \`${inline(t.selector)}\`${t.source && !t.source.nearest ? ` (${inline(t.source.file)}:${t.source.line})` : ""}`
        : a.target.kind;
    return `- ${pin ? `#${pin} ` : ""}${tags ? `[${tags}] ` : ""}${inline(a.route)} — ${clip(a.comment, 160)} — ${where}`;
}

/**
 * Compact, with something to act on (a revert request, a reply, a note to the agent): the line, then what the
 * instructions refer to, indented under it. The id to answer with, the whole comment when the line cut it short, and
 * the thread, whose last message is often the point.
 */
function compactWithNotes(a: Annotation, notes: string[]): string {
    const lines = [`Id: ${a.id}`];
    if (clip(a.comment, 160) !== a.comment) lines.push(...commentLines(a.comment));
    if (a.thread.length) lines.push("Thread:", ...threadLines(a));
    lines.push(...notes);
    return [compactLine(a), ...lines.map((l) => `  ${l}`)].join("\n");
}

const KNOWN_CONTEXT = new Set(["console", "network", "screenshot", "route", "animations"]);

/** One annotation as Markdown. See `Detail` for what each level holds. */
export function renderAnnotation(note: Annotation, options: RenderOptions = {}): string {
    const a = options.forAgent ? agentView(note) : note;
    const detail = options.detail ?? "standard";
    if (detail === "compact") {
        // The blank lines that set the notes apart in the longer forms would break the list here.
        const notes = (options.notes ?? []).filter((n) => n.trim() !== "");
        return notes.length ? compactWithNotes(a, notes) : compactLine(a);
    }

    const pin = pinNumber(a);
    const author = a.author.name
        ? `${a.author.name} (${a.author.kind})`
        : a.author.kind === "agent"
          ? "an agent"
          : "someone";
    const comment = commentLines(a.comment);
    const lines = [
        `## Annotation${pin ? ` #${pin}` : ""} — ${a.id}`,
        inline(
            `Status: ${a.status}${a.intent ? ` · Intent: ${a.intent}` : ""}${a.severity ? ` · Severity: ${a.severity}` : ""}${a.peopleOnly ? " · People only" : ""} · Mode: ${a.mode} · From: ${author} · ${a.createdAt}`
        ),
        inline(
            `Route: ${a.route} · Page: ${a.url}${a.appName ? ` · App: ${a.appName}${a.appVersion ? ` ${a.appVersion}` : ""}` : ""}`
        ),
        ...comment,
        // A quote ends at a blank line; without one, the next line would be read as part of it.
        ...(comment.length > 1 ? [""] : []),
        ...(a.variants ? [variantsLine(a.variants)] : []),
        `Target (${a.target.kind}, ${a.target.identity.length} element${a.target.identity.length === 1 ? "" : "s"}):`,
    ];
    a.target.identity.forEach((i, n) => {
        lines.push(identityLine(i, n));
        if (detail === "detailed" || detail === "forensic") {
            const pad = "     ";
            if (i.ancestors?.length)
                lines.push(`${pad}sits in: ${inline(i.ancestors.join(" > "))}`);
            if (i.classes?.length) lines.push(`${pad}classes: ${inline(i.classes.join(" "))}`);
            if (i.text && i.text !== i.name) lines.push(`${pad}text: “${clip(i.text, 120)}”`);
            if (i.styles)
                lines.push(
                    `${pad}styles: ${inline(
                        Object.entries(i.styles)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join("; ")
                    )}`
                );
        }
    });
    if (a.target.selectedText) lines.push(`  Selected text: “${clip(a.target.selectedText, 300)}”`);
    lines.push(
        `Viewport: ${a.environment.viewport.w}×${a.environment.viewport.h} @${a.environment.dpr}x · Target at (${Math.round(a.target.rect.x)}, ${Math.round(a.target.rect.y)}) size ${Math.round(a.target.rect.w)}×${Math.round(a.target.rect.h)}`
    );

    if (detail === "detailed" || detail === "forensic") {
        lines.push(
            `Environment: ${clip(a.environment.userAgent, 140)} · ${inline(a.environment.platform)}`
        );
        const animations = animationEntries(a);
        if (animations.length)
            lines.push("Animations:", ...animations.map((e) => `  - ${animationLine(e)}`));
    }

    if (detail === "forensic") {
        const entries = consoleEntries(a);
        if (entries.length)
            lines.push(
                `Console (${entries.length}):`,
                ...entries.slice(-50).map((e) => `  [${clip(e.level, 40)}] ${clip(e.message, 300)}`)
            );
        const requests = networkEntries(a);
        if (requests.length)
            lines.push(
                `Network (${requests.length}):`,
                ...requests
                    .slice(-50)
                    .map(
                        (e) =>
                            `  ${clip(e.method, 20)} ${clip(e.url, 300)} → ${statusText(e)}${e.ms !== undefined ? ` (${Math.round(e.ms)}ms)` : ""}`
                    )
            );
    } else {
        const consoleLine = consoleSummary(a);
        if (consoleLine) lines.push(`Console: ${consoleLine}`);
        const networkLine = networkSummary(a);
        if (networkLine) lines.push(`Network: ${networkLine}`);
    }

    if (a.steps?.length) {
        lines.push(
            "Steps the agent took:",
            ...a.steps.map(
                (s, i) =>
                    `  ${i + 1}. ${inline(`${s.action}${s.target ? ` ${s.target}` : ""}`)}${s.value ? ` = ${clip(s.value, 80)}` : ""}`
            )
        );
    }
    if (a.thread.length) lines.push("Thread:", ...threadLines(a));

    if (detail === "forensic") {
        const other = Object.keys(a.context ?? {}).filter((k) => !KNOWN_CONTEXT.has(k));
        for (const key of other)
            lines.push(`Context ${clip(key, 80)}: ${clip(asText(a.context[key]), 400)}`);
        if (a.screenshots) {
            const refs = [a.screenshots.full, a.screenshots.crop].filter(Boolean) as Array<{
                id: string;
                w: number;
                h: number;
            }>;
            lines.push(
                `Screenshots: ${refs.map((r) => `${r.w}×${r.h} ${r.id.slice(0, 12)}`).join(", ")}`
            );
        }
        lines.push(
            "Identity (as captured):",
            "```json",
            JSON.stringify(a.target.identity, null, 2).slice(0, 4000),
            "```"
        );
    }

    if (options.notes?.length) lines.push(...options.notes);
    if (!a.screenshots) {
        lines.push(
            "No screenshot was taken for this annotation (they may be turned off); use the target above."
        );
    } else if (options.screenshotsAttached) {
        lines.push(
            "Screenshots follow: first the full viewport with the target outlined, then a crop of the target."
        );
    }
    return lines.join("\n");
}

/** Many annotations as one Markdown document, for pasting into an agent or an issue. */
export function renderAnnotations(
    list: Annotation[],
    options: RenderOptions & { title?: string } = {}
): string {
    const detail = options.detail ?? "standard";
    const heading = `# ${options.title ?? "Feedback"} — ${list.length} annotation${list.length === 1 ? "" : "s"}`;
    if (list.length === 0) return `${heading}\n\nNothing to report.`;
    const body = list.map((a) => renderAnnotation(a, { ...options, detail }));
    return detail === "compact"
        ? `${heading}\n\n${body.join("\n")}`
        : `${heading}\n\n${body.join("\n\n")}`;
}
