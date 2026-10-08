import { Intent, Severity, Status } from "@notato/schema";
import type { z } from "zod";
import { RequestError } from "./backend.ts";
import type { AnnotationFilter } from "./storage.ts";

/**
 * The filter a query string asks for. Lists are paged (200 by default, at most 500 a page); an export (`whole`) has
 * every matching annotation unless the query sets a limit itself.
 */
export function filterFromQuery(
    q: URLSearchParams,
    projectId?: string,
    { whole = false }: { whole?: boolean } = {}
): AnnotationFilter {
    const filter: AnnotationFilter = {};
    // Repeated for several (`?project=web&project=admin`): an agent can work on more than one.
    const projects = projectId ? [projectId] : q.getAll("project").filter(Boolean).slice(0, 50);
    if (projects.length) filter.projectId = projects.length === 1 ? projects[0] : projects;

    const status = q.get("status");
    if (status) {
        const parsed = status.split(",").map((s) => Status.safeParse(s.trim()));
        if (parsed.some((p) => !p.success)) throw new RequestError(`invalid status "${status}"`);
        filter.status = parsed.map((p) => (p as { data: z.infer<typeof Status> }).data);
    }
    const route = q.get("route");
    if (route) filter.route = route;
    const severity = q.get("severity");
    if (severity) {
        const parsed = Severity.safeParse(severity);
        if (!parsed.success) throw new RequestError(`invalid severity "${severity}"`);
        filter.severity = parsed.data;
    }
    const intent = q.get("intent");
    if (intent) {
        const parsed = intent.split(",").map((s) => Intent.safeParse(s.trim()));
        if (parsed.some((p) => !p.success)) throw new RequestError(`invalid intent "${intent}"`);
        filter.intent = parsed.map((p) => (p as { data: z.infer<typeof Intent> }).data);
    }
    const bundle = q.get("bundle");
    if (bundle) filter.bundleId = bundle === "none" ? null : bundle;
    const author = q.get("author");
    if (author === "human" || author === "agent") filter.authorKind = author;
    const by = q.get("by");
    if (by) filter.authorName = by.slice(0, 120);
    // Notes with no name on them (an agent that did not say who it is, a person who never set one).
    if (q.get("unnamed") === "1") filter.authorName = null;
    const after = q.get("afterSeq");
    if (after !== null) {
        const n = Number(after);
        if (!Number.isInteger(n) || n < 0)
            throw new RequestError("afterSeq must be a non-negative integer");
        filter.afterSeq = n;
    }
    if (q.get("lastReply") === "human") filter.lastReplyBy = "human";
    if (q.get("diagnostic") === "0") filter.diagnostic = false;
    if (q.get("peopleOnly") === "0") filter.peopleOnly = false;
    if (q.get("unhanded") === "1") filter.unhanded = true;
    const exclude = q.get("exclude");
    if (exclude) filter.excludeIds = exclude.split(",").filter(Boolean).slice(0, 200);
    const asked = q.get("limit");
    if (whole) {
        const limit = Number(asked);
        if (asked !== null && Number.isFinite(limit)) filter.limit = Math.max(1, Math.floor(limit));
        return filter;
    }
    const limit = Number(asked ?? 200);
    filter.limit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 500) : 200;
    return filter;
}

/** The inverse of `filterFromQuery`, for clients that talk to the HTTP API. */
export function filterToQuery(filter: AnnotationFilter): URLSearchParams {
    const q = new URLSearchParams();
    if (filter.projectId !== undefined)
        for (const p of [filter.projectId].flat()) q.append("project", p);
    if (filter.status !== undefined)
        q.set("status", (Array.isArray(filter.status) ? filter.status : [filter.status]).join(","));
    if (filter.route !== undefined) q.set("route", filter.route);
    if (filter.severity !== undefined) q.set("severity", filter.severity);
    if (filter.intent !== undefined)
        q.set("intent", (Array.isArray(filter.intent) ? filter.intent : [filter.intent]).join(","));
    if (filter.bundleId !== undefined)
        q.set("bundle", filter.bundleId === null ? "none" : filter.bundleId);
    if (filter.authorKind !== undefined) q.set("author", filter.authorKind);
    if (filter.authorName === null) q.set("unnamed", "1");
    else if (filter.authorName !== undefined) q.set("by", filter.authorName);
    if (filter.afterSeq !== undefined) q.set("afterSeq", String(filter.afterSeq));
    if (filter.excludeIds?.length) q.set("exclude", filter.excludeIds.join(","));
    if (filter.lastReplyBy) q.set("lastReply", filter.lastReplyBy);
    if (filter.diagnostic === false) q.set("diagnostic", "0");
    if (filter.peopleOnly === false) q.set("peopleOnly", "0");
    if (filter.unhanded) q.set("unhanded", "1");
    if (filter.limit !== undefined) q.set("limit", String(filter.limit));
    return q;
}
