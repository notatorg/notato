import type { z } from "zod";
import { type Authenticator, canAccessProject, isAdmin, type Principal } from "../auth.ts";
import { type LocalBackend, RequestError } from "../backend.ts";
import { sameOrigin } from "../cors.ts";
import type { AppOptions, RequestInfo } from "../http.ts";
import { type AnnotationFilter, PROJECT_ID } from "../storage.ts";
import type { EventStreams } from "./events.ts";

// What the route modules share: the context `createApp` makes once, the request as a route sees it, the responses
// every route gives, and the checks on who may do what.

/** The server's parts and settings, made once by `createApp` and handed to every route. */
export interface AppContext {
    backend: LocalBackend;
    /** Accounts and tokens. Absent on a server without logins (`notato dev`). */
    auth?: Authenticator;
    options: AppOptions;
    /** The largest upload each kind of request may carry, in bytes. */
    limits: { upload: number; bundle: number };
    /** The event streams open now, which `/status` counts as pages. */
    streams: EventStreams;
    /** When the server started, in milliseconds since the epoch. */
    startedAt: number;
}

/** One request as the routes see it, once it has passed the host, origin and credential checks. */
export interface RouteRequest<P extends Principal | null = Principal> {
    req: Request;
    url: URL;
    /** The path without a trailing slash, or `/` for the root. */
    path: string;
    /** The request's method, taking a POST that says it means PATCH as a PATCH. */
    method: string;
    /** Who the request is from. Null only on the routes anyone may use. */
    principal: P;
    info: RequestInfo;
    /** The captures of `pattern` against the path, URL-decoded; null when it does not match. */
    match(pattern: RegExp): string[] | null;
}

/** A group of routes: answers the requests it knows, and null for the rest. */
export type Routes<P extends Principal | null = Principal> = (
    route: RouteRequest<P>,
    app: AppContext
) => Promise<Response | null>;

// ---- responses -------------------------------------------------------------------------------------------------

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...headers,
        },
    });
}

export const notFound = () => json({ error: "not found" }, 404);

export const noContent = () => new Response(null, { status: 204 });

/** Markdown as it is served: text, never cached, and never sniffed into something else. */
export function markdown(body: string): Response {
    return new Response(body, {
        headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
}

/** A zip to download, streamed as it is written. */
export function zip({
    filename,
    zip,
}: {
    filename: string;
    zip: ReadableStream<Uint8Array>;
}): Response {
    return new Response(zip as BodyInit, {
        headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.@-]/g, "_")}"`,
            "Cache-Control": "no-store",
        },
    });
}

/** The body as JSON, checked against `schema`. A body that is not JSON, or not that shape, is a 400 that says why. */
export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        throw new RequestError("body must be JSON");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new RequestError(`${issue?.path.join(".") || "body"}: ${issue?.message}`);
    }
    return parsed.data;
}

// ---- who may do what -------------------------------------------------------------------------------------------

/** A project id from the URL, refused unless it is one a project can have. */
export function projectIdFrom(raw: string | undefined): string {
    if (!raw || !PROJECT_ID.test(raw)) throw new RequestError("invalid project id");
    return raw;
}

/** Throws 403 unless the credential may use this project (`*`: every project). */
export function assertAccess(principal: Principal, projectId: string): void {
    if (!canAccessProject(principal, projectId))
        throw new RequestError(`this credential cannot access project "${projectId}"`, 403);
}

export function assertAdmin(principal: Principal | null): void {
    if (!principal || !isAdmin(principal)) throw new RequestError("admin login required", 403);
}

/** The one project a token is for; undefined for an admin or a `*` token, which may use them all. */
export function tokenProject(principal: Principal): string | undefined {
    return principal.kind === "token" && principal.projectId !== "*"
        ? principal.projectId
        : undefined;
}

/** A filter a project token cannot widen beyond its own project: naming another is refused. */
export function withinReach(principal: Principal, filter: AnnotationFilter): AnnotationFilter {
    const own = tokenProject(principal);
    if (own === undefined) return filter;
    for (const asked of [filter.projectId ?? []].flat()) assertAccess(principal, asked);
    return { ...filter, projectId: own };
}

/**
 * Refuses a request that is not from the board itself (or a tool with no Origin, like curl). An app's page may talk to
 * the server for its annotations, but must never be able to point a webhook somewhere, or create, delete or mint
 * tokens for projects.
 */
export function assertBoard(req: Request, what = "settings"): void {
    const origin = req.headers.get("origin");
    if (origin !== null && !sameOrigin(req, origin)) {
        throw new RequestError(
            `${what} can only be changed from the Notato board or the notato CLI`,
            403
        );
    }
}

/** Whether the client reached the server over HTTPS, directly or through a trusted proxy. */
export function isSecure(req: Request, trustProxy = false): boolean {
    return (
        new URL(req.url).protocol === "https:" ||
        (trustProxy && req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https")
    );
}
