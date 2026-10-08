import type { Annotation, Author, Severity, Status } from "@notato/schema";
import { useEffect, useState } from "react";
import { type Filters, NO_NAME, TODO } from "./model.ts";

export interface Me {
    mode: "dev" | "serve";
    authRequired: boolean;
    authenticated: boolean;
    username?: string;
    projectId?: string;
}

export interface ProjectSummary {
    id: string;
    /** What people call it; the id until someone names it. Absent from servers older than project records. */
    name?: string;
    createdAt?: string;
    annotations: number;
    open: number;
    /** Absent from servers older than the multi-project board. */
    statuses?: Partial<Record<Status, number>>;
    lastActivityAt?: string;
}

export interface BundleRecord {
    id: string;
    projectId: string;
    createdAt: string;
    author: { name?: string };
    appName?: string;
    appVersion?: string;
    annotationCount: number;
    importedAt: string;
}

export interface TokenInfo {
    id: string;
    projectId: string;
    name: string;
    createdAt: string;
    lastUsedAt?: string;
    revokedAt?: string;
}

export interface ServerStatus {
    version: string;
    mode: "dev" | "serve";
    /** Where agents on the server's machine reach its MCP (dev mode); a shared server is reached at the board's own address. */
    mcpUrl?: string;
    uptimeSec?: number;
    /** Board tabs and app pages listening for changes. */
    pages?: number;
    /** Agent sessions (Claude Code, Codex, Cursor…) with Notato's MCP open, on servers that report them. */
    agents?: { connected: boolean; sessions: number; watching: boolean; names?: string[] };
    config: { screenshots: "on" | "off"; mcp?: "on" | "off"; webhooks: number };
}

// ---- settings: notato.config.json, as the server shows it (webhook URLs masked, secrets never) -----------------

export type OnOff = "on" | "off";

export interface WebhookView {
    index: number;
    /** Which version of the webhook this is; an edit or delete against an older one is refused. */
    fingerprint: string;
    name: string | null;
    /** Masked: enough to recognise, not enough to use. */
    url: string;
    host: string;
    format: "json" | "slack" | "discord" | "teams";
    events: string[] | null;
    project: string | null;
    screenshots: boolean;
    secret: { kind: "none" } | { kind: "env"; name: string; set: boolean } | { kind: "file" };
}

export interface SettingsView {
    file: string | null;
    exists: boolean;
    error: string | null;
    settings: Array<{
        name: string;
        value: OnOff;
        source: "default" | "file" | "env" | "flag";
        default: OnOff;
        about: string;
        env: string;
    }>;
    webhooks: WebhookView[];
    events: string[];
    formats: Array<WebhookView["format"]>;
    /** Where screenshot links in messages point, or null when the server cannot be reached from outside. */
    publicUrl?: string | null;
}

/** A webhook as the form sends it. Leaving out `url` or `secret` keeps what the saved one has; `secret: null` removes it. */
export interface WebhookDraft {
    name?: string | null;
    url?: string;
    format: WebhookView["format"];
    events?: string[] | null;
    project?: string | null;
    secret?: string | null;
    screenshots?: boolean;
}

/** Which event, about which note (the made-up one when `annotationId` is left out). */
export interface TestSubject {
    event?: string;
    annotationId?: string;
}

/** Exactly what a test would send. Screenshot links are mapped to where this page can show them. */
export interface Preview {
    format: WebhookView["format"];
    event: string;
    url: string;
    body: unknown;
    headers: Record<string, string>;
    images: Record<string, string>;
    notes: string[];
}

export interface TestResult {
    ok: boolean;
    status?: number;
    ms: number;
    detail: string;
    response?: string;
}

export const getSettings = () => request<SettingsView>("/settings");
/** The server refused because the webhook changed since the page loaded it. */
export const isStale = (e: unknown) =>
    e instanceof ApiError && e.status === 409 && /changed or removed/.test(e.message);
export const setSetting = (name: string, value: OnOff | null) =>
    request<SettingsView>(`/settings/${encodeURIComponent(name)}`, json("PUT", { value }));
export const addWebhook = (hook: WebhookDraft) =>
    request<SettingsView>("/settings/webhooks", json("POST", { hook }));
export const editWebhook = (w: WebhookView, hook: WebhookDraft) =>
    request<SettingsView>(
        `/settings/webhooks/${w.index}`,
        json("PUT", { fingerprint: w.fingerprint, hook })
    );
export const deleteWebhook = (w: WebhookView) =>
    request<SettingsView>(
        `/settings/webhooks/${w.index}?fingerprint=${encodeURIComponent(w.fingerprint)}`,
        {
            method: "DELETE",
        }
    );
const testBody = (hook: WebhookDraft, existing?: WebhookView, subject: TestSubject = {}) =>
    json("POST", {
        hook,
        ...(existing
            ? { existing: { index: existing.index, fingerprint: existing.fingerprint } }
            : {}),
        ...(subject.event ? { event: subject.event } : {}),
        ...(subject.annotationId ? { annotationId: subject.annotationId } : {}),
    });

/** Sends a test with the form as it is, saved or not. `existing` supplies the URL and secret it keeps. */
export const testWebhook = (hook: WebhookDraft, existing?: WebhookView, subject?: TestSubject) =>
    request<TestResult>("/settings/webhooks/test", testBody(hook, existing, subject));

/** What `testWebhook` would send, without sending it. */
export const previewWebhook = (hook: WebhookDraft, existing?: WebhookView, subject?: TestSubject) =>
    request<Preview>("/settings/webhooks/preview", testBody(hook, existing, subject));

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
    onUnauthorized = fn;
};
/** The session is over (it expired, or the person signed out elsewhere): back to signing in. */
export const signedOut = () => onUnauthorized();

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, { credentials: "same-origin", ...init });
    if (res.status === 401 && !path.startsWith("/auth/login")) onUnauthorized();
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) throw new ApiError(body?.error ?? `request failed (${res.status})`, res.status);
    return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
});

export const getMe = () => request<Me>("/auth/me");
export const getStatus = () => request<ServerStatus>("/status");
export const login = (username: string, password: string) =>
    request<{ username: string }>("/auth/login", json("POST", { username, password }));
export const logout = () => request<{ ok: true }>("/auth/logout", { method: "POST" });

export const listProjects = async () =>
    (await request<{ items: ProjectSummary[] }>("/projects")).items;

/** What a project is called on screen: its name, or its id until it has one. */
export const projectName = (p: ProjectSummary | undefined, id: string) => p?.name?.trim() || id;

export interface CreatedProject {
    project: ProjectSummary;
    /** Its first app token, on a server with logins. The plaintext exists only in this answer. */
    token?: { token: string; record: TokenInfo };
}

const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;

/** Admins only. A 409 means the id is taken. */
export const createProject = (id: string, name?: string) =>
    request<CreatedProject>("/projects", json("POST", { id, ...(name ? { name } : {}) }));
export const renameProject = (id: string, name: string) =>
    request<ProjectSummary>(projectPath(id), json("PATCH", { name }));
/** Deletes the project, every note in it with its screenshots and bundles, and revokes its tokens. */
export const deleteProject = (id: string) => request<void>(projectPath(id), { method: "DELETE" });

/**
 * Tokens just made, by project, so the page that explains how to connect an app can show one after a move. Only in
 * memory: the server shows a token once, and so does the board.
 */
const freshTokens = new Map<string, string>();
export const keepFreshToken = (projectId: string, token: string) =>
    freshTokens.set(projectId, token);
export const freshToken = (projectId: string) => freshTokens.get(projectId) ?? null;
export const forgetFreshToken = (projectId: string) => freshTokens.delete(projectId);
/** Projects made in this tab, so the page that follows can say so. */
const madeHere = new Set<string>();
export const markMadeHere = (projectId: string) => madeHere.add(projectId);
export const wasMadeHere = (projectId: string) => madeHere.has(projectId);
export const forgetMadeHere = (projectId: string) => madeHere.delete(projectId);

/** What is not finished yet, the same set as the inbox's "To do"; older servers only report `open`. */
export const todoOf = (p: ProjectSummary) =>
    p.statuses ? TODO.reduce((n, s) => n + (p.statuses?.[s] ?? 0), 0) : p.open;

/** Newest activity first; projects from a server that does not report it go by name after those that do. */
export const byActivity = (x: ProjectSummary, y: ProjectSummary) =>
    (y.lastActivityAt ? Date.parse(y.lastActivityAt) : 0) -
        (x.lastActivityAt ? Date.parse(x.lastActivityAt) : 0) || x.id.localeCompare(y.id);

export function filterQuery(filters: Filters): URLSearchParams {
    const q = new URLSearchParams();
    if (filters.status.length) q.set("status", filters.status.join(","));
    if (filters.route) q.set("route", filters.route);
    if (filters.severity) q.set("severity", filters.severity);
    if (filters.intent) q.set("intent", filters.intent);
    if (filters.author) q.set("author", filters.author);
    if (filters.by === NO_NAME) q.set("unnamed", "1");
    else if (filters.by) q.set("by", filters.by);
    if (filters.bundle) q.set("bundle", filters.bundle);
    return q;
}

const PAGE = 500;

/**
 * Every annotation in a project, oldest first. The server hands out at most 500 at a time and says where the next page
 * starts (`next`) while there is one, so this pages until a page has no `next`. Throws if any page fails: a part of the
 * list must never be taken for all of it.
 */
export async function listAnnotations(project: string): Promise<Annotation[]> {
    const out: Annotation[] = [];
    let after = 0;
    for (;;) {
        const page = await request<{
            items: Array<{ seq: number; annotation: Annotation }>;
            next?: number;
        }>(`${projectPath(project)}/annotations?limit=${PAGE}&afterSeq=${after}`);
        for (const item of page.items) out.push(item.annotation);
        // A server older than paging never sends `next`: its one page is the whole list.
        if (page.next === undefined || page.next <= after) return out;
        after = page.next;
    }
}

const NAME_KEY = "notato.board.name";

/** The name the board signs replies with. Stored in this browser only. */
export function boardName(): string {
    try {
        return localStorage.getItem(NAME_KEY)?.trim() ?? "";
    } catch {
        return "";
    }
}
const nameListeners = new Set<() => void>();

export function setBoardName(name: string) {
    try {
        if (name.trim()) localStorage.setItem(NAME_KEY, name.trim());
        else localStorage.removeItem(NAME_KEY);
    } catch {
        // kept for this visit only
    }
    for (const fn of nameListeners) fn();
}

/** The name on replies, kept in step wherever it is changed (the sidebar, Settings). */
export function useBoardName(): string {
    const [, bump] = useState(0);
    useEffect(() => {
        const update = () => bump((n) => n + 1);
        nameListeners.add(update);
        return () => {
            nameListeners.delete(update);
        };
    }, []);
    return boardName();
}
const me = (): Author => (boardName() ? { kind: "human", name: boardName() } : { kind: "human" });

export const setStatus = (id: string, status: Status, note?: string) =>
    request<{ annotation: Annotation }>(
        `/annotations/${encodeURIComponent(id)}`,
        json("PATCH", { status, note: note || undefined, author: me() })
    );

export const setSeverity = (id: string, severity: Severity | null) =>
    request<{ annotation: Annotation }>(
        `/annotations/${encodeURIComponent(id)}`,
        json("PATCH", { severity })
    );

/** Writes in the thread as this person; an aside is for the people on it, and the agent is not shown it. */
export const reply = (id: string, body: string, aside = false) =>
    request<{ annotation: Annotation }>(
        `/annotations/${encodeURIComponent(id)}/replies`,
        json("POST", { body, author: me(), ...(aside ? { aside } : {}) })
    );

/** People only on or off: the server records who changed it in the thread. */
export const setPeopleOnly = (id: string, on: boolean) =>
    request<{ annotation: Annotation }>(
        `/annotations/${encodeURIComponent(id)}`,
        json("PATCH", { peopleOnly: on, author: me() })
    );

/** Picks one of the versions an agent offered, or (with `null`) takes the pick back. */
export const chooseVariant = (id: string, name: string | null, note?: string) =>
    request<{ annotation: Annotation }>(
        `/annotations/${encodeURIComponent(id)}/variants/choose`,
        json("POST", { name, note: note || undefined, author: me() })
    );

export const remove = (id: string) =>
    request<void>(`/annotations/${encodeURIComponent(id)}`, { method: "DELETE" });

export const listBundles = async (project: string) =>
    (await request<{ items: BundleRecord[] }>(`/projects/${encodeURIComponent(project)}/bundles`))
        .items;

export const uploadBundle = (project: string, file: File) =>
    request<{ imported: number; skipped: number; bundleId: string }>(
        `/projects/${encodeURIComponent(project)}/bundles`,
        {
            method: "POST",
            headers: { "Content-Type": "application/zip" },
            body: file,
        }
    );

export const exportHref = (project: string, filters: Filters) =>
    `/projects/${encodeURIComponent(project)}/export?${filterQuery(filters)}`;

export const assetHref = (id: string) => `/assets/${encodeURIComponent(id)}`;

/** Puts text on the clipboard, with the old way as a fallback where the page may not use the new one. */
export async function copyText(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch {
        // not allowed here (an http page that is not localhost, say)
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("The browser would not let this page use the clipboard.");
}

export const listTokens = async () =>
    (await request<{ items: TokenInfo[] }>("/admin/tokens")).items;
export const createToken = (projectId: string, name: string) =>
    request<{ token: string; record: TokenInfo }>(
        "/admin/tokens",
        json("POST", { projectId, name })
    );
export const revokeToken = (id: string) =>
    request<void>(`/admin/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });

/**
 * Things the board remembers per browser; any of it can be missing, and none of it matters if it is.
 * `allowed` null takes any saved text.
 */
export function remembered<T extends string>(
    key: string,
    allowed: readonly T[] | null,
    fallback: T
): T {
    try {
        const saved = localStorage.getItem(key);
        if (!allowed) return (saved ?? fallback) as T;
        return (allowed as readonly string[]).includes(saved ?? "") ? (saved as T) : fallback;
    } catch {
        return fallback;
    }
}
export function remember(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // remembered for this visit only
    }
}
