import { DETAILS, parseDetail, renderAnnotation, renderAnnotations } from "@notato/core";
import { Author, SafeId, Severity, Status, Variants } from "@notato/schema";
import { z } from "zod";
import { canAccessProject, type Principal } from "../auth.ts";
import { type LocalBackend, RequestError, TEXT_MAX } from "../backend.ts";
import { filterFromQuery } from "../query.ts";
import type { AnnotationFilter, StoredAnnotation } from "../storage.ts";
import {
    type AppContext,
    assertAccess,
    json,
    markdown,
    noContent,
    notFound,
    projectIdFrom,
    type Routes,
    readJson,
    withinReach,
} from "./common.ts";

const Text = z.string().min(1).max(TEXT_MAX);

const PatchBody = z
    .object({
        status: Status.optional(),
        severity: Severity.nullable().optional(),
        comment: Text.optional(),
        /** Recorded as a thread reply alongside a status change. */
        note: Text.optional(),
        /** People only on or off: only a person can change it, and the change is recorded in the thread. */
        peopleOnly: z.boolean().optional(),
        author: Author.optional(),
    })
    .strict();

const ReplyBody = z.object({
    body: Text,
    author: Author.optional(),
    /** A remark for the people on the thread, kept from the agent. */
    aside: z.boolean().optional(),
});

const OfferBody = z
    .object({
        group: Variants.shape.group,
        options: Variants.shape.options,
        /** Shown in the thread. */
        note: Text.optional(),
        author: Author.optional(),
    })
    .strict();

const ChooseBody = z
    .object({
        /** One of the options offered, or null to take a pick back. */
        name: z.string().min(1).max(40).nullable(),
        note: Text.optional(),
        author: Author.optional(),
    })
    .strict();

const HandedBody = z.object({
    items: z.array(z.object({ id: SafeId, replyId: z.string().min(1).max(128) })).max(500),
});

/** How long `/annotations/wait` holds a request when it is not told, and the most it ever will. */
const WAIT_DEFAULT_MS = 25_000;
const WAIT_MAX_MS = 60_000;

/**
 * A note without what an app's own list never shows (`?fields=summary`): its context (the console, the network, the
 * styles) and an agent's steps, which are most of a note's size. The thread, the target, the status and the pin number
 * the screenshot was drawn with (`context.screenshot`) stay. Still a valid annotation, so any SDK's decoder takes it.
 */
function summary(item: StoredAnnotation): StoredAnnotation {
    const { steps: _steps, context, ...rest } = item.annotation;
    const screenshot = (context as { screenshot?: unknown } | undefined)?.screenshot;
    return { seq: item.seq, annotation: { ...rest, context: screenshot ? { screenshot } : {} } };
}

/**
 * One page of a list, oldest first. `next` is there when the page is full: ask again with `afterSeq=<next>` for the
 * rest, until a response has no `next`.
 */
async function page(
    backend: LocalBackend,
    filter: AnnotationFilter,
    query: URLSearchParams
): Promise<{ items: StoredAnnotation[]; next?: number }> {
    const listed = await backend.list(filter);
    const last = listed.at(-1);
    const items = query.get("fields") === "summary" ? listed.map(summary) : listed;
    return filter.limit !== undefined && listed.length >= filter.limit && last
        ? { items, next: last.seq }
        : { items };
}

/** The Markdown detail level a query asks for (`?detail=`), standard when it asks for none. */
function detailFrom(query: URLSearchParams) {
    const detail = parseDetail(query.get("detail") ?? "standard");
    if (!detail) throw new RequestError(`detail must be one of ${DETAILS.join(", ")}`);
    return detail;
}

/**
 * `POST /projects/:id/annotations`: a note as an SDK sends it, multipart with the annotation as JSON in `annotation`
 * and each screenshot's bytes as a file named `asset:<id>`.
 */
async function ingest(req: Request, projectId: string, app: AppContext): Promise<Response> {
    const max = app.limits.upload;
    if (!(req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
        throw new RequestError(
            "expected multipart/form-data with an `annotation` field and `asset:<id>` files",
            415
        );
    }
    if (Number(req.headers.get("content-length") ?? 0) > max)
        throw new RequestError(`upload exceeds ${max} bytes`, 413);

    const form = await req.formData();
    const raw = form.get("annotation");
    if (typeof raw !== "string") throw new RequestError('missing "annotation" field');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new RequestError('"annotation" is not valid JSON');
    }
    const files = new Map<string, Uint8Array>();
    let total = raw.length;
    for (const [key, value] of form.entries()) {
        const entry = value as unknown as string | File;
        if (key.startsWith("asset:") && typeof entry !== "string") {
            // Chunked uploads carry no Content-Length, so the limit is enforced on what was actually received too.
            total += entry.size;
            if (total > max) throw new RequestError(`upload exceeds ${max} bytes`, 413);
            files.set(key.slice("asset:".length), new Uint8Array(await entry.arrayBuffer()));
        }
    }
    const { stored, created } = await app.backend.ingest(parsed, files, { projectId });
    return json(stored, created ? 201 : 200);
}

/**
 * The notes: sending, listing and long-polling for them, each one with its thread, status and variants, as JSON or as
 * Markdown, and the screenshots they show.
 */
export const annotationRoutes: Routes = async (route, app) => {
    const { req, url, path, method, principal, match } = route;
    const { backend } = app;
    const query = url.searchParams;

    /** The note with this id, once the credential is known to reach its project; null when there is none. */
    const annotation = async (id: string | undefined) => {
        const existing = await backend.get(id ?? "");
        if (existing) assertAccess(principal, existing.annotation.projectId);
        return existing;
    };

    const inProject = match(/^\/projects\/([^/]+)\/annotations$/);
    if (inProject) {
        const projectId = projectIdFrom(inProject[0]);
        assertAccess(principal, projectId);
        if (method === "POST") return ingest(req, projectId, app);
        if (method === "GET")
            return json(await page(backend, filterFromQuery(query, projectId), query));
    }

    // ---- the same notes as Markdown, for pasting into any agent or issue ---------------------------------------
    const projectMarkdown = match(/^\/projects\/([^/]+)\/markdown$/);
    if (projectMarkdown && method === "GET") {
        const projectId = projectIdFrom(projectMarkdown[0]);
        assertAccess(principal, projectId);
        const detail = detailFrom(query);
        const items = await backend.list(filterFromQuery(query, projectId, { whole: true }));
        return markdown(
            renderAnnotations(
                items.map((i) => i.annotation),
                { detail, title: `Feedback for ${projectId}` }
            )
        );
    }
    const oneMarkdown = match(/^\/annotations\/([^/]+)\/markdown$/);
    if (oneMarkdown && method === "GET") {
        const found = await annotation(oneMarkdown[0]);
        if (!found) return notFound();
        return markdown(renderAnnotation(found.annotation, { detail: detailFrom(query) }));
    }

    if (path === "/annotations" && method === "GET")
        return json(await page(backend, withinReach(principal, filterFromQuery(query)), query));

    // What an attached agent was handed, so another session (or a restart) is not handed it again.
    if (path === "/annotations/handed" && method === "POST") {
        const { items } = await readJson(req, HandedBody);
        const reachable = [];
        for (const item of items) {
            const stored = await backend.get(item.id);
            if (stored && canAccessProject(principal, stored.annotation.projectId))
                reachable.push(item);
        }
        await backend.markHanded(reachable);
        return noContent();
    }

    if (path === "/annotations/wait" && method === "GET") {
        const filter = withinReach(principal, filterFromQuery(query));
        const asked = Number(query.get("timeoutMs") ?? WAIT_DEFAULT_MS);
        const timeout = Number.isFinite(asked)
            ? Math.min(Math.max(0, asked), WAIT_MAX_MS)
            : WAIT_DEFAULT_MS;
        return json({ ready: await backend.waitForNew(filter, timeout, req.signal) });
    }

    const one = match(/^\/annotations\/([^/]+)$/);
    if (one) {
        const id = one[0] ?? "";
        const existing = await annotation(id);
        if (method === "GET") return existing ? json(existing) : notFound();
        if (method === "PATCH") {
            const change = await readJson(req, PatchBody);
            if (!existing) return notFound();
            // One update: a refused status change must not leave the severity or comment changed behind it.
            const updated = await backend.update(
                id,
                {
                    status: change.status,
                    severity: change.severity,
                    comment: change.comment,
                    note: change.status ? change.note : undefined,
                    peopleOnly: change.peopleOnly,
                },
                change.author
            );
            return updated ? json(updated) : notFound();
        }
        if (method === "DELETE")
            return existing && (await backend.remove(id)) ? noContent() : notFound();
    }

    const replies = match(/^\/annotations\/([^/]+)\/replies$/);
    if (replies && method === "POST") {
        const id = replies[0] ?? "";
        const existing = await annotation(id);
        const body = await readJson(req, ReplyBody);
        const updated = existing
            ? await backend.reply(id, body.body, body.author, { aside: body.aside })
            : null;
        return updated ? json(updated, 201) : notFound();
    }

    // ---- variants: the agent offers versions, the person picks one ---------------------------------------------
    const variants = match(/^\/annotations\/([^/]+)\/variants$/);
    if (variants && method === "PUT") {
        const id = variants[0] ?? "";
        const existing = await annotation(id);
        const { author, ...offer } = await readJson(req, OfferBody);
        const updated = existing ? await backend.offerVariants(id, offer, author) : null;
        return updated ? json(updated) : notFound();
    }
    const choose = match(/^\/annotations\/([^/]+)\/variants\/choose$/);
    if (choose && method === "POST") {
        const id = choose[0] ?? "";
        const existing = await annotation(id);
        const body = await readJson(req, ChooseBody);
        const updated = existing
            ? await backend.chooseVariant(id, body.name, body.note, body.author)
            : null;
        return updated ? json(updated) : notFound();
    }

    const asset = match(/^\/assets\/([^/]+)$/);
    if (asset && method === "GET") return screenshot(asset[0] ?? "", principal, app);

    return null;
};

/** `GET /assets/:id`: a screenshot, for whoever may read a note that shows it, and for nobody once no note does. */
async function screenshot(id: string, principal: Principal, app: AppContext): Promise<Response> {
    const owners = await app.backend.projectsWithAsset(id);
    if (!owners.some((p) => canAccessProject(principal, p))) return notFound();
    const asset = await app.backend.asset(id);
    if (!asset) return notFound();
    return new Response(asset.bytes as BodyInit, {
        headers: {
            "Content-Type": asset.mime,
            // Private behind a login: the ids are unguessable hashes, but the image is still someone's.
            "Cache-Control": `${app.auth ? "private" : "public"}, max-age=31536000, immutable`,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    });
}
