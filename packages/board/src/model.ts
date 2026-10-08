import type { Annotation, Intent, Reply, Severity, Status } from "@notato/schema";
import type { ProjectSummary } from "./api.ts";

// Everything here is plain data in, plain data out, so the board's behaviour can be tested without a browser.

const STATUSES: Status[] = [
    "open",
    "acknowledged",
    "variant_chosen",
    "resolved",
    "revert_requested",
    "reverted",
    "dismissed",
];
export const SEVERITIES: Severity[] = ["blocker", "major", "minor", "nit"];
export const INTENTS: Intent[] = ["fix", "change", "question", "approve", "variants"];

/**
 * Not finished yet: what the inbox's To do, the sidebar's counts and the Overview call to do. A revert request and a
 * picked version are waiting for the agent, and an acknowledged note is being worked on but is not done, so they all
 * count, as they do in `notato_list_open`. (The server's `open` count leaves acknowledged out; the board counts from
 * `statuses` and falls back to `open` only for a server too old to send them.)
 */
export const TODO: Status[] = ["open", "acknowledged", "variant_chosen", "revert_requested"];
export const DONE: Status[] = ["resolved", "reverted"];

export type View = "todo" | "done" | "dismissed" | "all";
export const VIEWS: Array<{ id: View; label: string; statuses: Status[] }> = [
    { id: "todo", label: "To do", statuses: TODO },
    { id: "done", label: "Done", statuses: DONE },
    { id: "dismissed", label: "Dismissed", statuses: ["dismissed"] },
    { id: "all", label: "All", statuses: [] },
];

export interface Filters {
    status: Status[];
    route: string;
    severity: Severity | "";
    intent: Intent | "";
    /** One person's notes, by the name on them; `NO_NAME` for the ones with no name. */
    by: string;
    author: "" | "human" | "agent";
    bundle: string;
}

/**
 * `Filters.by` for notes with no name on them (with `author`, the unnamed agents or people). The server's `?by=` can
 * only match a name, so this one is applied in the board alone.
 */
export const NO_NAME = "\u0000no-name";

/** The filters beyond status, all cleared. */
export const NO_EXTRA_FILTERS: Omit<Filters, "status"> = {
    route: "",
    severity: "",
    intent: "",
    by: "",
    author: "",
    bundle: "",
};

/** What the inbox shows when a project opens: what is still to do. */
export const NO_FILTERS: Filters = { status: TODO, ...NO_EXTRA_FILTERS };

/** Which view a status list is, or null when it is some other mix. */
export function viewOf(statuses: Status[]): View | null {
    const key = [...statuses].sort().join(",");
    return VIEWS.find((v) => [...v.statuses].sort().join(",") === key)?.id ?? null;
}

/** The filters beyond status that are set, for a "clear" control. */
export const extraFilterCount = (f: Filters) =>
    [f.route, f.severity, f.intent, f.by, f.author, f.bundle].filter(Boolean).length;

export function matches(a: Annotation, f: Filters): boolean {
    return (
        (f.status.length === 0 || f.status.includes(a.status)) &&
        (!f.route || a.route === f.route) &&
        (!f.severity || a.severity === f.severity) &&
        (!f.intent || a.intent === f.intent) &&
        (!f.by || (f.by === NO_NAME ? !a.author.name : a.author.name === f.by)) &&
        (!f.author || a.author.kind === f.author) &&
        (!f.bundle || (f.bundle === "none" ? a.bundleId === null : a.bundleId === f.bundle))
    );
}

const time = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
};

/** When anything last happened to an annotation: it was made, or someone wrote in its thread. */
export function lastActivity(a: Annotation): string {
    let latest = a.createdAt;
    for (const r of a.thread) if (time(r.createdAt) > time(latest)) latest = r.createdAt;
    return latest;
}

/** Replies people and agents wrote, leaving out what Notato recorded on its own. */
export const replyCount = (a: Annotation) => a.thread.filter((r) => !r.automatic).length;

/** The text a search looks through: what was said, and where. */
function haystack(a: Annotation): string {
    const parts: Array<string | undefined> = [
        a.comment,
        a.route,
        a.url,
        a.author.name,
        a.status.replace("_", " "),
        a.severity,
        a.intent,
        a.appName,
        a.target.selectedText,
        a.environment.platform,
        a.id,
    ];
    for (const t of a.target.identity) {
        parts.push(
            t.selector,
            t.testId,
            t.name,
            t.text,
            t.component?.name,
            t.component?.source,
            t.source?.file
        );
    }
    for (const r of a.thread) parts.push(r.body, r.author.name);
    return parts.filter(Boolean).join("\n").toLowerCase();
}

/** Every word of the query appears somewhere in the annotation or its thread. */
export function matchesSearch(a: Annotation, query: string): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const text = haystack(a);
    return words.every((w) => text.includes(w));
}

export type Sort = "activity" | "newest" | "oldest" | "severity";
export const SORTS: Array<{ id: Sort; label: string }> = [
    { id: "activity", label: "Recently active" },
    { id: "newest", label: "Newest first" },
    { id: "oldest", label: "Oldest first" },
    { id: "severity", label: "Most severe first" },
];

const severityRank = (a: Annotation) =>
    a.severity ? SEVERITIES.indexOf(a.severity) : SEVERITIES.length;

export function sortAnnotations(list: Annotation[], sort: Sort): Annotation[] {
    const out = [...list];
    const newest = (x: Annotation, y: Annotation) => time(y.createdAt) - time(x.createdAt);
    switch (sort) {
        case "activity":
            return out.sort(
                (x, y) => time(lastActivity(y)) - time(lastActivity(x)) || newest(x, y)
            );
        case "newest":
            return out.sort(newest);
        case "oldest":
            return out.sort((x, y) => -newest(x, y));
        case "severity":
            return out.sort((x, y) => severityRank(x) - severityRank(y) || newest(x, y));
    }
}

export type Group = "none" | "route" | "status" | "person" | "severity";
export const GROUPS: Array<{ id: Group; label: string }> = [
    { id: "none", label: "No grouping" },
    { id: "route", label: "By page" },
    { id: "status", label: "By status" },
    { id: "person", label: "By person" },
    { id: "severity", label: "By severity" },
];

/** How the inbox is cut: kept per project for as long as the project is open, so moving between tabs keeps it. */
export interface InboxState {
    filters: Filters;
    search: string;
    sort: Sort;
    group: Group;
}

export interface AnnotationGroup {
    key: string;
    label: string;
    items: Annotation[];
}

/** Splits an already sorted list into groups, keeping the order within each. */
export function groupAnnotations(list: Annotation[], group: Group): AnnotationGroup[] {
    if (group === "none") return [{ key: "", label: "", items: list }];
    const keyOf = (a: Annotation): string => {
        switch (group) {
            case "route":
                return a.route;
            case "status":
                return a.status;
            case "person":
                return authorName(a.author);
            case "severity":
                return a.severity ?? "";
        }
    };
    const groups = new Map<string, Annotation[]>();
    for (const a of list) {
        const key = keyOf(a);
        const items = groups.get(key);
        if (items) items.push(a);
        else groups.set(key, [a]);
    }
    // Statuses in the order work moves and severities from the worst; anything else by name.
    const rank = (key: string) => {
        if (group === "status") return STATUSES.indexOf(key as Status);
        if (group === "severity")
            return key ? SEVERITIES.indexOf(key as Severity) : SEVERITIES.length;
        return 0;
    };
    const label = (key: string) => {
        if (group === "status") return statusLabel(key as Status);
        if (group === "severity" && !key) return "No severity";
        return key;
    };
    return [...groups.entries()]
        .sort(([x], [y]) => rank(x) - rank(y) || x.localeCompare(y))
        .map(([key, items]) => ({ key, label: label(key), items }));
}

/** How a status reads on screen. */
export const statusLabel = (status: Status): string =>
    ({
        open: "Open",
        acknowledged: "Acknowledged",
        variant_chosen: "Version picked",
        resolved: "Resolved",
        revert_requested: "Revert requested",
        reverted: "Reverted",
        dismissed: "Dismissed",
    })[status];

/** The name to show for whoever wrote something. */
export const authorName = (author: { kind: string; name?: string }) =>
    author.name ?? (author.kind === "agent" ? "Agent" : "Anonymous");

export interface ActivityItem {
    key: string;
    at: string;
    /** A new note, something said in a thread, or something Notato recorded (a version picked, say). */
    kind: "created" | "reply" | "automatic";
    annotation: Annotation;
    reply?: Reply;
}

/** Everything that happened in a project, newest first. */
export function activityOf(list: Annotation[]): ActivityItem[] {
    const out: ActivityItem[] = [];
    for (const a of list) {
        out.push({ key: a.id, at: a.createdAt, kind: "created", annotation: a });
        for (const r of a.thread) {
            out.push({
                key: `${a.id}:${r.id}`,
                at: r.createdAt,
                kind: r.automatic ? "automatic" : "reply",
                annotation: a,
                reply: r,
            });
        }
    }
    return out.sort((x, y) => time(y.at) - time(x.at));
}

const DAY = 86_400_000;

/**
 * Local midnight `back` days before the day of `now`. By the calendar, not by 24-hour steps: a day that changes the
 * clocks is 23 or 25 hours long.
 */
function startOfDay(now: number, back = 0): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    return d.getTime();
}

/** "just now", "5m", "3h", "Yesterday", "Mon 3", "3 Oct 2025": short enough for a list. */
export function relativeTime(iso: string, now = Date.now()): string {
    const t = time(iso);
    const diff = now - t;
    if (diff < 45_000) return "just now";
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m`;
    if (t >= startOfDay(now)) return `${Math.round(diff / 3_600_000)}h`;
    if (t >= startOfDay(now, 1)) return "Yesterday";
    const date = new Date(t);
    if (t >= startOfDay(now, 6)) return date.toLocaleDateString(undefined, { weekday: "short" });
    if (date.getFullYear() === new Date(now).getFullYear())
        return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** `relativeTime` inside a sentence: "5m ago", "yesterday", "on 3 Oct". */
export function ago(iso: string, now = Date.now()): string {
    const r = relativeTime(iso, now);
    if (/^\d+[mh]$/.test(r)) return `${r} ago`;
    if (r === "just now") return r;
    return r === "Yesterday" ? "yesterday" : `on ${r}`;
}

/** A heading for a day in a timeline. */
export function dayLabel(iso: string, now = Date.now()): string {
    const t = time(iso);
    if (t >= startOfDay(now)) return "Today";
    if (t >= startOfDay(now, 1)) return "Yesterday";
    return new Date(t).toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
        ...(new Date(t).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
    });
}

/** A time of day, the way this browser writes one: "15:23", or "03:23 PM". */
export const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** A duration as a person would say it: "4 min", "3 h", "2 days". */
export function duration(ms: number): string {
    if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
    if (ms < 59.5 * 60_000) return `${Math.round(ms / 60_000)} min`;
    if (ms < 47.5 * 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
    const days = Math.round(ms / DAY);
    return `${days} day${days === 1 ? "" : "s"}`;
}

export interface Count {
    key: string;
    total: number;
    todo: number;
}

/** Whoever wrote notes: a person or an agent, by the name on them (none for notes with no name). */
export interface Person extends Count {
    agent: boolean;
    name?: string;
}

export interface ProjectStats {
    total: number;
    todo: number;
    done: number;
    dismissed: number;
    statuses: Record<Status, number>;
    routes: Count[];
    people: Person[];
    /** Of what is still to do. */
    severities: Record<Severity | "none", number>;
    /** New notes on each of the last `days` days, oldest first, by local midnight. */
    perDay: Array<{ day: string; count: number }>;
    /** From a note to the first reply someone else wrote, over the notes that have one. */
    medianFirstReplyMs: number | null;
    replies: number;
}

const byTodoThenTotal = (x: Count, y: Count) =>
    y.todo - x.todo || y.total - x.total || x.key.localeCompare(y.key);

export function projectStats(list: Annotation[], now = Date.now(), days = 30): ProjectStats {
    const statuses = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    const severities: ProjectStats["severities"] = {
        blocker: 0,
        major: 0,
        minor: 0,
        nit: 0,
        none: 0,
    };
    const routes = new Map<string, Count>();
    const people = new Map<string, Person>();
    const firstReplies: number[] = [];
    let replies = 0;

    const perDay = Array.from({ length: days }, (_, i) => {
        const start = startOfDay(now, days - 1 - i);
        return { day: new Date(start).toISOString(), start, count: 0 };
    });
    const tomorrow = startOfDay(now, -1);

    for (const a of list) {
        statuses[a.status] += 1;
        const todo = TODO.includes(a.status) ? 1 : 0;
        if (todo) severities[a.severity ?? "none"] += 1;

        const route = routes.get(a.route) ?? { key: a.route, total: 0, todo: 0 };
        route.total += 1;
        route.todo += todo;
        routes.set(a.route, route);

        // By kind and name: an agent with no name is not every agent, and a person called "Agent" is not one.
        const agent = a.author.kind === "agent";
        const key = `${agent ? "agent" : "human"}:${a.author.name ?? ""}`;
        const person = people.get(key) ?? {
            key,
            total: 0,
            todo: 0,
            agent,
            ...(a.author.name ? { name: a.author.name } : {}),
        };
        person.total += 1;
        person.todo += todo;
        people.set(key, person);

        // The slots ascend, so the last one starting at or before the note is its day; nothing after today counts.
        const created = time(a.createdAt);
        const slot = created < tomorrow ? perDay.findLast((s) => created >= s.start) : undefined;
        if (slot) slot.count += 1;

        const said = a.thread.filter((r) => !r.automatic);
        replies += said.length;
        const first = said.find(
            (r) => r.author.kind !== a.author.kind || r.author.name !== a.author.name
        );
        if (first) firstReplies.push(Math.max(0, time(first.createdAt) - created));
    }

    firstReplies.sort((x, y) => x - y);
    const mid = firstReplies.length >> 1;
    const median =
        firstReplies.length === 0
            ? null
            : firstReplies.length % 2
              ? (firstReplies[mid] ?? 0)
              : ((firstReplies[mid - 1] ?? 0) + (firstReplies[mid] ?? 0)) / 2;

    return {
        total: list.length,
        todo: TODO.reduce((n, s) => n + statuses[s], 0),
        done: DONE.reduce((n, s) => n + statuses[s], 0),
        dismissed: statuses.dismissed,
        statuses,
        routes: [...routes.values()].sort(byTodoThenTotal),
        people: [...people.values()].sort(byTodoThenTotal),
        severities,
        perDay: perDay.map(({ day, count }) => ({ day, count })),
        medianFirstReplyMs: median,
        replies,
    };
}

/** "1 note", "3 notes", "2 replies". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "fix" is "Fix": a word from the wire format as a label. */
export const capitalise = (s: string) => `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;

/** The end of a route, which is what tells pages apart in a list: "/InitPage/HomePage" is "HomePage". */
export const lastSegment = (route: string) => route.split("/").filter(Boolean).at(-1) ?? route;

/** The letter on an avatar or a name card: the first of the name, so "ada" and "Ada Lovelace" are both A. */
export function initial(name: string | undefined): string {
    const first = [...(name ?? "").trim()][0];
    return first ? first.toUpperCase() : "?";
}

/** The later of two times (ISO 8601), either of which may be missing. */
export function later(x: string | null | undefined, y: string | null | undefined): string | null {
    if (!x) return y ?? null;
    if (!y) return x;
    return time(y) > time(x) ? y : x;
}

/** The newest thing that happened in a list of notes, by the times the server holds for them. */
export function newestActivity(list: Annotation[]): string | null {
    let newest: string | null = null;
    for (const a of list) newest = later(newest, lastActivity(a));
    return newest;
}

// ---- changes from the event stream ---------------------------------------------------------------------------

/** One change from the server's event stream, as far as a list of notes is concerned. */
export interface NoteChange {
    type: "created" | "updated" | "replied" | "deleted";
    id: string;
    annotation?: Annotation;
}

/** The list with one change applied. */
export function applyChange(list: Annotation[], change: NoteChange): Annotation[] {
    if (change.type === "deleted") return list.filter((x) => x.id !== change.id);
    const a = change.annotation;
    if (!a) return list;
    return list.some((x) => x.id === a.id)
        ? list.map((x) => (x.id === a.id ? a : x))
        : [...list, a];
}

/**
 * A full load with the changes that arrived while it was on its way laid over it. The server may have read the list
 * before those changes happened, so where the two differ the change is the newer. `changes` holds the last change for
 * each note: the note as it is now, or null once it was deleted.
 */
export function mergeSnapshot(
    snapshot: Annotation[],
    changes: ReadonlyMap<string, Annotation | null>
): Annotation[] {
    const out: Annotation[] = [];
    for (const a of snapshot) {
        const changed = changes.get(a.id);
        if (changed === undefined) out.push(a);
        else if (changed) out.push(changed);
    }
    const loaded = new Set(snapshot.map((a) => a.id));
    for (const [id, changed] of changes) if (changed && !loaded.has(id)) out.push(changed);
    return out;
}

/**
 * Whether a change can move a project's counts (how many notes, what is to do), which only a fresh count from the server
 * settles. `before` is the note's status before the change, when it is known. A reply never changes a status.
 */
export function countsMayChange(change: NoteChange, before: Status | undefined): boolean {
    switch (change.type) {
        case "created":
        case "deleted":
            return true;
        case "replied":
            return false;
        case "updated":
            return before === undefined || before !== change.annotation?.status;
    }
}

/**
 * The project list with `at` as the project's latest activity when it is later than what the list has: what a change
 * that leaves the counts alone does to it. Null when the list does not have the project, which takes a reload.
 */
export function withActivity<P extends { id: string; lastActivityAt?: string }>(
    projects: P[],
    projectId: string,
    at: string
): P[] | null {
    const found = projects.find((p) => p.id === projectId);
    if (!found) return null;
    const next = later(found.lastActivityAt, at);
    if (!next || next === found.lastActivityAt) return projects;
    return projects.map((p) => (p === found ? { ...p, lastActivityAt: next } : p));
}

// ---- the reply box -------------------------------------------------------------------------------------------

/** The reply box after a send from it failed: what did not go comes back, above anything written since. */
export function restoreDraft(current: string, unsent: string): string {
    return current.trim() ? `${unsent.trimEnd()}\n${current}` : unsent;
}

/** Runs tasks one at a time, in the order they were handed over; one that fails does not hold up the next. */
export function serial(): <T>(task: () => Promise<T>) => Promise<T> {
    let last: Promise<unknown> = Promise.resolve();
    return (task) => {
        const run = last.then(task);
        last = run.catch(() => undefined);
        return run;
    };
}

// ---- projects ------------------------------------------------------------------------------------------------

/** What a project is called on screen: its name, or its id until it has one. */
export const projectName = (p: ProjectSummary | undefined, id: string) => p?.name?.trim() || id;

/** What is not finished yet, the same set as the inbox's "To do"; older servers only report `open`. */
export const todoOf = (p: ProjectSummary) =>
    p.statuses ? TODO.reduce((n, s) => n + (p.statuses?.[s] ?? 0), 0) : p.open;

/** Newest activity first; projects from a server that does not report it go by id after those that do. */
export const byActivity = (x: ProjectSummary, y: ProjectSummary) =>
    (y.lastActivityAt ? Date.parse(y.lastActivityAt) : 0) -
        (x.lastActivityAt ? Date.parse(x.lastActivityAt) : 0) || x.id.localeCompare(y.id);

/** What the server takes as a project id: letters, digits and `_ . @ -`, at most 128, and never only dots. */
const PROJECT_ID = /^(?!\.+$)[\w.@-]{1,128}$/;

/** Why `id` cannot be a project id, said to the person typing it, or null when it can be one. */
export function projectIdProblem(id: string): string | null {
    if (!id) return "Give the project an id.";
    if (id.length > 128) return "An id is at most 128 characters.";
    if (/^\.+$/.test(id)) return "An id cannot be only dots.";
    if (!PROJECT_ID.test(id)) return "Use only letters, digits and _ . @ - (no spaces).";
    return null;
}

/** The id to suggest for a project's name: "Checkout Web (iOS)" is `checkout-web-ios`. Empty when nothing fits. */
export function suggestProjectId(name: string): string {
    const slug = name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9_.@-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "")
        .slice(0, 128)
        .replace(/[-.]+$/, "");
    return PROJECT_ID.test(slug) ? slug : "";
}
