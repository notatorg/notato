import { DETAILS, parseDetail, renderAnnotation, renderAnnotations } from "@notato/core";
import { Author, SafeId, Severity, Status, sampleAnnotation, Variants } from "@notato/schema";
import { z } from "zod";
import {
    AGENT_HEADER,
    AGENT_NAME_HEADER,
    AGENT_PROJECTS_HEADER,
    cleanAgentName,
    decodeAgentProjects,
} from "./agents.ts";
import {
    type Authenticator,
    canAccessProject,
    isAdmin,
    type Principal,
    UnknownProjectError,
} from "./auth.ts";
import { type LocalBackend, RequestError } from "./backend.ts";
import { mcpRefusal } from "./config.ts";
import { corsHeaders, hostAllowed, parseExtraOrigins, writeOriginRejected } from "./cors.ts";
import type { NotatoEvent } from "./events.ts";
import { bookmarkletPage, injectSource } from "./inject.ts";
import { filterFromQuery } from "./query.ts";
import { RelayArgs, RelayError } from "./relay.ts";
import { assertBoard, settingsRoute } from "./settings.ts";
import { type ShareLinks, sharedAsset } from "./share.ts";
import type { AnnotationFilter, StoredAnnotation } from "./storage.ts";
import { buildDelivery, secretOf, sendDelivery } from "./webhooks.ts";

/** Static files of the web UI. `path` is relative, e.g. `index.html` or `assets/app-3f2a.js`. */
export interface UiAssets {
    lookup(path: string): Promise<{ body: BodyInit; type: string } | null>;
}

export interface AppOptions {
    backend: LocalBackend;
    mode: "dev" | "serve";
    version: string;
    /**
     * Accounts and tokens. Without it the server is open, which is only safe on loopback (dev mode). With it,
     * every route except `/health`, `/auth/*` and the UI shell needs a session or a token.
     */
    auth?: Authenticator;
    /** The board UI, served at `/` and `/ui/*`. */
    ui?: UiAssets | null;
    /** Extra allowed browser origins, on top of loopback, private networks and the server's own origin. */
    corsOrigins?: string[];
    /** Which `Host` headers are answered. Dev mode defaults to loopback names only (DNS-rebinding guard). */
    allowedHosts?: "loopback" | "any" | string[];
    /** Behind a reverse proxy: believe `X-Forwarded-For` and `X-Forwarded-Proto`. */
    trustProxy?: boolean;
    maxUploadBytes?: number;
    /** Ceiling for a bundle zip upload. */
    maxBundleBytes?: number;
    /**
     * Called before every request that reaches a route. Return a Response to stop it (401/403), or null to
     * let it through. For policy beyond what `auth` provides.
     */
    authorize?: (
        req: Request,
        access: { write: boolean; projectId?: string }
    ) => Promise<Response | null>;
    /** Extra routes tried after the built-in ones. */
    extend?: (req: Request, url: URL, app: AppContext) => Promise<Response | null>;
    /** Signed links to single screenshots, for webhook messages (see share.ts). */
    share?: ShareLinks;
    /**
     * Where agents on this machine reach `/mcp` (`notato dev`), which the board shows even when it is opened through
     * the tunnel. Unset on a shared server, where it is the board's own address.
     */
    mcpUrl?: string;
}

export interface AppContext {
    backend: LocalBackend;
    json: typeof json;
    options: AppOptions;
}

export interface RequestInfo {
    /** The client's address as the server saw it, for rate limiting. */
    ip?: string;
}

export type AppHandler = (req: Request, info?: RequestInfo) => Promise<Response>;

export const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024;
export const DEFAULT_MAX_BUNDLE = 100 * 1024 * 1024;
/** A project id: letters, digits and `_ . @ -`, but never only dots, so it can never name a parent folder. */
const ID = /^(?!\.+$)[\w.@-]{1,128}$/;

/** Running without `auth` means a trusted local caller, such as `notato dev` on loopback. */
const LOCAL: Principal = { kind: "admin", username: "local" };

/**
 * One page of a list, oldest first. `next` is there when the page is full: ask again with `afterSeq=<next>` for the
 * rest, until a response has no `next`.
 */
async function page(
    backend: LocalBackend,
    filter: AnnotationFilter,
    q?: URLSearchParams
): Promise<{ items: StoredAnnotation[]; next?: number }> {
    const listed = await backend.list(filter);
    const last = listed.at(-1);
    const items = q?.get("fields") === "summary" ? listed.map(summary) : listed;
    return filter.limit !== undefined && listed.length >= filter.limit && last
        ? { items, next: last.seq }
        : { items };
}

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

/** Markdown as it is served: text, never cached, and never sniffed into something else. */
function markdown(body: string): Response {
    return new Response(body, {
        headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
}

const sseEncoder = new TextEncoder();
const sseBytes = (event: string, data: unknown) =>
    sseEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const PING = sseEncoder.encode(": ping\n\n");
/** How far behind a client of the event stream may fall before it is let go. */
const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;

/**
 * A change as the event stream sends it, written once however many clients are listening: a reply on a long thread is
 * a large note, and it went out serialised once per listener.
 */
const busBytes = new WeakMap<object, Uint8Array>();
function busEventBytes(e: NotatoEvent): Uint8Array {
    let bytes = busBytes.get(e);
    if (!bytes) {
        bytes = sseBytes(e.type, {
            id: e.id,
            projectId: e.projectId,
            seq: e.seq,
            annotation: e.annotation,
            // What a change changed from, so a board can tell a status change without remembering.
            ...(e.previous ? { previous: e.previous } : {}),
        });
        busBytes.set(e, bytes);
    }
    return bytes;
}

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

const PatchBody = z
    .object({
        status: Status.optional(),
        severity: Severity.nullable().optional(),
        comment: z.string().min(1).max(10_000).optional(),
        /** Recorded as a thread reply alongside a status change. */
        note: z.string().min(1).max(10_000).optional(),
        /** People only on or off: only a person can change it, and the change is recorded in the thread. */
        peopleOnly: z.boolean().optional(),
        author: Author.optional(),
    })
    .strict();

const OfferBody = z
    .object({
        group: Variants.shape.group,
        options: Variants.shape.options,
        /** Shown in the thread. */
        note: z.string().min(1).max(10_000).optional(),
        author: Author.optional(),
    })
    .strict();

const ChooseBody = z
    .object({
        /** One of the options offered, or null to take a pick back. */
        name: z.string().min(1).max(40).nullable(),
        note: z.string().min(1).max(10_000).optional(),
        author: Author.optional(),
    })
    .strict();

const RelayBody = RelayArgs.extend({
    projectId: z.string().regex(ID).optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).default(60_000),
});

const RelayResultBody = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), annotationId: z.string().min(1).max(128) }),
    // A long error (a stack trace) is cut, not refused: refusing it would leave the agent waiting for a timeout instead.
    z.object({
        ok: z.literal(false),
        error: z
            .string()
            .max(100_000)
            .transform((e) => e.slice(0, 2000)),
    }),
]);

const ReplyBody = z.object({
    body: z.string().min(1).max(10_000),
    author: Author.optional(),
    /** A remark for the people on the thread, kept from the agent. */
    aside: z.boolean().optional(),
});
const LoginBody = z.object({
    username: z.string().min(1).max(200),
    password: z.string().min(1).max(1000),
});
const ProjectBody = z.object({
    id: z.string().regex(ID, "a project id is letters, digits and _ . @ - (not only dots)"),
    name: z.string().max(200).optional(),
});
const RenameBody = z.object({ name: z.string().min(1).max(200) });
const TokenBody = z.object({
    projectId: z.union([z.literal("*"), z.string().regex(ID)]),
    name: z.string().trim().min(1).max(100),
});

const HandedBody = z.object({
    items: z.array(z.object({ id: SafeId, replyId: z.string().min(1).max(128) })).max(500),
});

async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
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

/** Builds the request handler. It owns CORS, origin, host and credential checks, and the built-in routes. */
export function createApp(options: AppOptions): AppHandler {
    const { backend, auth } = options;
    const extraOrigins = options.corsOrigins ?? parseExtraOrigins(process.env.NOTATO_CORS_ORIGINS);
    const maxUpload = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD;
    const maxBundle = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE;
    const startedAt = Date.now();
    /** Open event streams: the pages (and board tabs) listening. Separate from `notato_watch` waiters. */
    let eventStreams = 0;
    const context: AppContext = { backend, json, options };

    const assertProject = (pid: string | undefined) => {
        if (!pid || !ID.test(pid)) throw new RequestError("invalid project id");
        return pid;
    };

    /** Throws 403 unless the credential may use this project. */
    const guard = (principal: Principal | null, projectId: string) => {
        if (!principal || !canAccessProject(principal, projectId)) {
            throw new RequestError(`this credential cannot access project "${projectId}"`, 403);
        }
    };

    /** A filter a project-scoped token cannot widen beyond its own project. */
    const scoped = (principal: Principal | null, filter: AnnotationFilter): AnnotationFilter => {
        if (!principal) throw new RequestError("authentication required", 401);
        if (principal.kind === "token" && principal.projectId !== "*") {
            for (const asked of [filter.projectId ?? []].flat())
                if (asked !== principal.projectId) guard(principal, asked);
            return { ...filter, projectId: principal.projectId };
        }
        return filter;
    };

    /** The project a bundle upload must be for: the URL's, or the token's own when it has one. */
    const uploadProject = (principal: Principal | null, pid?: string) => {
        if (pid) guard(principal, pid);
        if (principal?.kind === "token" && principal.projectId !== "*") return principal.projectId;
        return pid;
    };

    const summaryOf = async (projectId: string) =>
        (await backend.store.listProjects()).find((p) => p.id === projectId) ?? null;

    const requireAdmin = (principal: Principal | null) => {
        if (!principal || !isAdmin(principal)) throw new RequestError("admin login required", 403);
    };

    const isPublic = (req: Request, path: string) =>
        path === "/health" ||
        (path === "/auth/login" && req.method === "POST") ||
        (path === "/auth/me" && req.method === "GET") ||
        (req.method === "GET" &&
            (path === "/" ||
                path.startsWith("/ui/") ||
                path === "/inject.js" ||
                path === "/bookmarklet"));

    async function ui(path: string): Promise<Response | null> {
        if (!options.ui) return null;
        const file = path === "/" ? "index.html" : path.slice("/ui/".length);
        if (file.includes("..") || file.startsWith("/")) return null;
        const found = await options.ui.lookup(file);
        if (!found) return null;
        const shell = file === "index.html";
        return new Response(found.body, {
            headers: {
                "Content-Type": found.type,
                "Cache-Control": shell ? "no-cache" : "public, max-age=31536000, immutable",
                "X-Content-Type-Options": "nosniff",
                ...(shell
                    ? {
                          "Content-Security-Policy":
                              "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
                          "X-Frame-Options": "DENY",
                          "Referrer-Policy": "no-referrer",
                      }
                    : {}),
            },
        });
    }

    async function route(
        req: Request,
        url: URL,
        principal: Principal | null,
        info: RequestInfo
    ): Promise<Response> {
        const path = url.pathname.replace(/\/+$/, "") || "/";
        // Some HTTP stacks (Android's HttpURLConnection) cannot send PATCH, so a POST may say it means one.
        const method =
            req.method === "POST" &&
            req.headers.get("x-http-method-override")?.toUpperCase() === "PATCH"
                ? "PATCH"
                : req.method;
        /** Captures of `re` against the path, URL-decoded; null when it does not match. */
        const at = (re: RegExp): string[] | null => {
            const found = re.exec(path);
            if (!found) return null;
            try {
                return found.slice(1).map(decodeURIComponent);
            } catch {
                throw new RequestError("malformed percent-encoding in the URL");
            }
        };

        if (path === "/health" && method === "GET") return json({ ok: true, service: "notato" });

        // ---- who am I, and signing in ------------------------------------------------------------------
        if (path === "/auth/me" && method === "GET") {
            return json({
                mode: options.mode,
                authRequired: Boolean(auth),
                authenticated: Boolean(principal),
                ...(principal?.kind === "admin" ? { username: principal.username } : {}),
                ...(principal?.kind === "token" ? { projectId: principal.projectId } : {}),
            });
        }
        if (auth && path === "/auth/login" && method === "POST") {
            const { username, password } = await readJson(req, LoginBody);
            const result = await auth.login(username, password, info.ip ?? "unknown", secure(req));
            if (!result.ok) {
                return json(
                    { error: result.error },
                    result.status,
                    result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {}
                );
            }
            return json({ username }, 200, { "Set-Cookie": result.cookie });
        }
        if (auth && path === "/auth/logout" && method === "POST") {
            return json({ ok: true }, 200, { "Set-Cookie": await auth.logout(req, secure(req)) });
        }

        // ---- token administration ----------------------------------------------------------------------
        if (auth && path === "/admin/tokens") {
            requireAdmin(principal);
            if (method === "GET") {
                const items = (await auth.listTokens()).map(
                    ({ tokenHash: _hash, ...rest }) => rest
                );
                return json({ items });
            }
            if (method === "POST") {
                assertBoard(req, "tokens");
                const { projectId, name } = await readJson(req, TokenBody);
                const { token, record } = await auth.issueToken(projectId, name);
                const { tokenHash: _hash, ...safe } = record;
                return json({ token, record: safe }, 201);
            }
        }
        const tokenOne = auth ? at(/^\/admin\/tokens\/([^/]+)$/) : null;
        if (tokenOne && method === "DELETE") {
            requireAdmin(principal);
            assertBoard(req, "tokens");
            return (await auth?.revokeToken(tokenOne[0] ?? ""))
                ? new Response(null, { status: 204 })
                : json({ error: "not found" }, 404);
        }

        // ---- Notato on any page: a script to load, and a page with the bookmark to load it ----------------------
        if (method === "GET" && path === "/inject.js") {
            const script = await injectSource();
            if (!script) return json({ error: "this build does not include the page script" }, 404);
            return new Response(script, {
                headers: {
                    "Content-Type": "text/javascript; charset=utf-8",
                    // Fetched afresh each time, so a newer server never serves an older script from a cache.
                    "Cache-Control": "no-cache",
                    "X-Content-Type-Options": "nosniff",
                },
            });
        }
        if (method === "GET" && path === "/bookmarklet") {
            // The origin the person used to reach this server, so the bookmark points back at it.
            const origin = `${secure(req) ? "https" : "http"}://${req.headers.get("host") ?? url.host}`;
            return new Response(
                bookmarkletPage(origin, {
                    project: url.searchParams.get("project") ?? undefined,
                    token: url.searchParams.get("token") ?? undefined,
                }),
                {
                    headers: {
                        "Content-Type": "text/html; charset=utf-8",
                        "Cache-Control": "no-store",
                        "Content-Security-Policy":
                            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
                        "X-Content-Type-Options": "nosniff",
                    },
                }
            );
        }

        // ---- the web UI --------------------------------------------------------------------------------
        if (method === "GET" && (path === "/" || path.startsWith("/ui/"))) {
            const page = await ui(path);
            if (page) return page;
        }

        if (!principal) throw new RequestError("authentication required", 401);

        // ---- the board's settings page: notato.config.json, admin only, from the board only ----------------------
        const settings = await settingsRoute(req, path, principal, context);
        if (settings) return settings;

        if (path === "/config" && method === "GET") {
            // What a page needs to know before it captures anything (the server enforces it either way), and whether an
            // agent is connected, for the page to say so.
            return json({
                screenshots: backend.config().screenshots,
                agent: backend.agents.stateFor(url.searchParams.get("project") ?? undefined),
                mentions: backend.mentions.list(),
            });
        }

        if (path === "/status" && method === "GET") {
            const projects = await backend.store.listProjects();
            const config = backend.config();
            return json({
                ok: true,
                service: "notato",
                version: options.version,
                mode: options.mode,
                mcpUrl: options.mcpUrl,
                uptimeSec: Math.round((Date.now() - startedAt) / 1000),
                watchers: backend.bus.size,
                pages: eventStreams,
                agents: backend.agents.state,
                mentions: backend.mentions.list(),
                agentProjects: backend.relay
                    .projects()
                    .filter((p) => canAccessProject(principal, p)),
                projects: projects.filter((p) => canAccessProject(principal, p.id)),
                config: {
                    screenshots: config.screenshots ? "on" : "off",
                    source: config.source.screenshots,
                    mcp: config.mcp ? "on" : "off",
                    mcpSource: config.source.mcp,
                    file: config.file,
                    error: config.error,
                    webhooks: config.webhooks.length,
                },
            });
        }

        // ---- webhooks, for an admin: what and how, never where or with what secret --------------------------------
        if (path === "/webhooks" && method === "GET") {
            if (!isAdmin(principal))
                return json({ error: "only an admin can see the webhooks" }, 403);
            const config = backend.config();
            return json({
                items: config.webhooks.map((w, index) => ({
                    index,
                    name: w.name ?? new URL(w.url).host,
                    // The URL itself is a secret for many services (a Slack webhook is one), so only the host is shown.
                    host: new URL(w.url).host,
                    format: w.format,
                    events: w.events ?? null,
                    project: w.project ?? null,
                    signed: w.secret !== undefined,
                })),
                error: config.error ?? null,
            });
        }
        if (path === "/webhooks/test" && method === "POST") {
            if (!isAdmin(principal)) return json({ error: "only an admin can send a test" }, 403);
            const { index } = await readJson(
                req,
                z.object({ index: z.number().int().min(0) }).strict()
            );
            const hook = backend.config().webhooks[index];
            if (!hook) return json({ error: "no such webhook" }, 404);
            const secret = secretOf(hook);
            if (secret === null) {
                return json(
                    {
                        error: `${hook.secret} is not set where the server runs, so a signed test cannot be sent`,
                    },
                    409
                );
            }
            const log: string[] = [];
            const ok = await sendDelivery(
                hook,
                buildDelivery(
                    hook,
                    "annotation.created",
                    {
                        ...sampleAnnotation,
                        comment: "This is a test event from Notato. Nothing is wrong.",
                    },
                    secret
                ),
                { retryDelaysMs: [], log: (m) => log.push(m) }
            );
            return json({
                ok,
                detail: ok
                    ? "The other end answered with success."
                    : (log[0] ?? "It did not get through."),
            });
        }

        // ---- projects: an admin creates one (and, on a server with logins, its first token) ----------------
        if (path === "/projects" && method === "GET") {
            return json({
                items: (await backend.store.listProjects()).filter((p) =>
                    canAccessProject(principal, p.id)
                ),
            });
        }
        if (path === "/projects" && method === "POST") {
            requireAdmin(principal);
            assertBoard(req, "projects");
            const body = await readJson(req, ProjectBody);
            const created = await backend.createProject(body.id, body.name);
            if (!created)
                return json({ error: `a project with id "${body.id}" already exists` }, 409);
            const project = await summaryOf(created.id);
            // Apps on a server with logins need a token to send notes, so the first one comes with the project.
            if (!auth) return json({ project }, 201);
            const { token, record } = await auth.issueToken(created.id, `${created.name} app`);
            const { tokenHash: _hash, ...safe } = record;
            return json({ project, token: { token, record: safe } }, 201);
        }
        const projectOne = at(/^\/projects\/([^/]+)$/);
        if (projectOne) {
            const pid = assertProject(projectOne[0]);
            guard(principal, pid);
            if (method === "GET") {
                const project = await summaryOf(pid);
                return project ? json(project) : json({ error: "not found" }, 404);
            }
            if (method === "PATCH") {
                requireAdmin(principal);
                assertBoard(req, "projects");
                const { name } = await readJson(req, RenameBody);
                return (await backend.renameProject(pid, name))
                    ? json(await summaryOf(pid))
                    : json({ error: "not found" }, 404);
            }
            if (method === "DELETE") {
                requireAdmin(principal);
                assertBoard(req, "projects");
                if (!(await backend.deleteProject(pid))) return json({ error: "not found" }, 404);
                await auth?.store.revokeProjectTokens(pid, new Date().toISOString());
                return new Response(null, { status: 204 });
            }
        }

        const projectAnnotations = at(/^\/projects\/([^/]+)\/annotations$/);
        if (projectAnnotations) {
            const pid = assertProject(projectAnnotations[0]);
            guard(principal, pid);
            if (method === "POST") return ingest(req, pid);
            if (method === "GET")
                return json(
                    await page(backend, filterFromQuery(url.searchParams, pid), url.searchParams)
                );
        }

        const projectEvents = at(/^\/projects\/([^/]+)\/events$/);
        if (projectEvents && method === "GET") {
            const pid = projectEvents[0] ?? "";
            if (pid === "*") {
                if (principal.kind === "token" && principal.projectId !== "*")
                    guard(principal, "*");
            } else guard(principal, assertProject(pid));
            return events(req, pid === "*" ? "*" : pid, url.searchParams.get("agent") === "1");
        }

        if (path === "/annotations" && method === "GET") {
            return json(
                await page(
                    backend,
                    scoped(principal, filterFromQuery(url.searchParams)),
                    url.searchParams
                )
            );
        }

        // What an attached agent was handed, so another session (or a restart) is not handed it again.
        if (path === "/annotations/handed" && method === "POST") {
            const { items } = await readJson(req, HandedBody);
            const allowed = [];
            for (const item of items) {
                const stored = await backend.get(item.id);
                if (stored && principal && canAccessProject(principal, stored.annotation.projectId))
                    allowed.push(item);
            }
            await backend.markHanded(allowed);
            return new Response(null, { status: 204 });
        }

        if (path === "/annotations/wait" && method === "GET") {
            const filter = scoped(principal, filterFromQuery(url.searchParams));
            const timeout = Math.min(
                Math.max(0, Number(url.searchParams.get("timeoutMs") ?? 25_000)),
                60_000
            );
            return json({ ready: await backend.waitForNew(filter, timeout, req.signal) });
        }

        // ---- the same annotations as Markdown, for pasting into any agent or issue -------------------
        const markdownOf = at(/^\/annotations\/([^/]+)\/markdown$/);
        if (markdownOf && method === "GET") {
            const found = await backend.get(markdownOf[0] ?? "");
            if (!found) return json({ error: "not found" }, 404);
            guard(principal, found.annotation.projectId);
            const detail = parseDetail(url.searchParams.get("detail") ?? "standard");
            if (!detail) throw new RequestError(`detail must be one of ${DETAILS.join(", ")}`);
            return markdown(renderAnnotation(found.annotation, { detail }));
        }
        const projectMarkdown = at(/^\/projects\/([^/]+)\/markdown$/);
        if (projectMarkdown && method === "GET") {
            const projectId = projectMarkdown[0] ?? "";
            guard(principal, projectId);
            const detail = parseDetail(url.searchParams.get("detail") ?? "standard");
            if (!detail) throw new RequestError(`detail must be one of ${DETAILS.join(", ")}`);
            const items = await backend.list(
                filterFromQuery(url.searchParams, projectId, { whole: true })
            );
            return markdown(
                renderAnnotations(
                    items.map((i) => i.annotation),
                    { detail, title: `Feedback for ${projectId}` }
                )
            );
        }

        const one = at(/^\/annotations\/([^/]+)$/);
        if (one) {
            const id = one[0] ?? "";
            const existing = await backend.get(id);
            if (existing) guard(principal, existing.annotation.projectId);
            if (method === "GET")
                return existing ? json(existing) : json({ error: "not found" }, 404);
            if (method === "PATCH") {
                const change = await readJson(req, PatchBody);
                if (!existing) return json({ error: "not found" }, 404);
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
                return updated ? json(updated) : json({ error: "not found" }, 404);
            }
            if (method === "DELETE") {
                return existing && (await backend.remove(id))
                    ? new Response(null, { status: 204 })
                    : json({ error: "not found" }, 404);
            }
        }

        const replies = at(/^\/annotations\/([^/]+)\/replies$/);
        if (replies && method === "POST") {
            const id = replies[0] ?? "";
            const existing = await backend.get(id);
            if (existing) guard(principal, existing.annotation.projectId);
            const body = await readJson(req, ReplyBody);
            const updated = existing
                ? await backend.reply(id, body.body, body.author, { aside: body.aside })
                : null;
            return updated ? json(updated, 201) : json({ error: "not found" }, 404);
        }

        // ---- variants: the agent offers versions, the person picks one -------------------------------------
        const variantsOf = at(/^\/annotations\/([^/]+)\/variants$/);
        if (variantsOf && method === "PUT") {
            const id = variantsOf[0] ?? "";
            const existing = await backend.get(id);
            if (existing) guard(principal, existing.annotation.projectId);
            const body = await readJson(req, OfferBody);
            const updated = existing
                ? await backend.offerVariants(
                      id,
                      { group: body.group, options: body.options, note: body.note },
                      body.author
                  )
                : null;
            return updated ? json(updated) : json({ error: "not found" }, 404);
        }
        const variantsChoose = at(/^\/annotations\/([^/]+)\/variants\/choose$/);
        if (variantsChoose && method === "POST") {
            const id = variantsChoose[0] ?? "";
            const existing = await backend.get(id);
            if (existing) guard(principal, existing.annotation.projectId);
            const body = await readJson(req, ChooseBody);
            const updated = existing
                ? await backend.chooseVariant(id, body.name, body.note, body.author)
                : null;
            return updated ? json(updated) : json({ error: "not found" }, 404);
        }

        if (path === "/relay/annotate" && method === "POST") {
            const { projectId, timeoutMs, ...args } = await readJson(req, RelayBody);
            // A project token can only ever reach a page of its own project: naming another one is refused,
            // and leaving it out means its own.
            if (projectId) guard(principal, projectId);
            const target =
                principal.kind === "token" && principal.projectId !== "*"
                    ? principal.projectId
                    : projectId;
            try {
                return json(await backend.requestAnnotation(target, args, timeoutMs));
            } catch (error) {
                if (error instanceof RelayError)
                    throw new RequestError(error.message, error.status);
                throw error;
            }
        }

        const relayResult = at(/^\/relay\/([^/]+)\/result$/);
        if (relayResult && method === "POST") {
            const requestId = relayResult[0] ?? "";
            const owner = backend.relay.projectOf(requestId);
            if (owner) guard(principal, owner);
            const result = await readJson(req, RelayResultBody);
            return backend.relay.complete(requestId, result)
                ? json({ ok: true })
                : json({ error: "unknown or already settled request" }, 404);
        }

        const projectBundles = at(/^\/projects\/([^/]+)\/bundles$/);
        if (projectBundles) {
            const pid = assertProject(projectBundles[0]);
            guard(principal, pid);
            if (method === "POST") return importBundle(req, uploadProject(principal, pid));
            if (method === "GET") return json({ items: await backend.listBundles(pid) });
        }
        if (path === "/bundles" && method === "POST")
            return importBundle(req, uploadProject(principal));

        const bundleExport = at(/^\/bundles\/([^/]+)\/export$/);
        if (bundleExport && method === "GET") {
            const record = await backend.getBundle(bundleExport[0] ?? "");
            if (record) guard(principal, record.projectId);
            const exported = record ? await backend.exportBundle({ bundleId: record.id }) : null;
            return exported ? zipResponse(exported) : json({ error: "not found" }, 404);
        }

        const bundleOne = at(/^\/bundles\/([^/]+)$/);
        if (bundleOne && method === "GET") {
            const record = await backend.getBundle(bundleOne[0] ?? "");
            if (!record) return json({ error: "not found" }, 404);
            guard(principal, record.projectId);
            return json({
                bundle: record,
                annotations: await backend.list({ bundleId: record.id }),
            });
        }

        const projectExport = at(/^\/projects\/([^/]+)\/export$/);
        if (projectExport && method === "GET") {
            const pid = assertProject(projectExport[0]);
            guard(principal, pid);
            const exported = await backend.exportBundle({
                projectId: pid,
                filter: filterFromQuery(url.searchParams, pid, { whole: true }),
            });
            return exported ? zipResponse(exported) : json({ error: "not found" }, 404);
        }

        const assetPath = at(/^\/assets\/([^/]+)$/);
        if (assetPath && method === "GET") {
            const id = assetPath[0] ?? "";
            // A screenshot is readable by whoever may read a note that shows it, and by nobody once no note does.
            const owners = await backend.projectsWithAsset(id);
            if (!owners.some((p) => canAccessProject(principal, p)))
                return json({ error: "not found" }, 404);
            const asset = await backend.asset(id);
            if (!asset) return json({ error: "not found" }, 404);
            return new Response(asset.bytes as BodyInit, {
                headers: {
                    "Content-Type": asset.mime,
                    // Private: ids are unguessable hashes, but the image is still behind a login.
                    "Cache-Control": `${auth ? "private" : "public"}, max-age=31536000, immutable`,
                    "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": "default-src 'none'",
                },
            });
        }

        const extended = await options.extend?.(req, url, context);
        if (extended) return extended;
        return json({ error: "not found" }, 404);
    }

    /** Whether the client reached us over HTTPS, directly or through a trusted proxy. */
    const secure = (req: Request) =>
        new URL(req.url).protocol === "https:" ||
        (Boolean(options.trustProxy) &&
            req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https");

    const zipResponse = ({
        filename,
        zip,
    }: {
        filename: string;
        zip: ReadableStream<Uint8Array>;
    }) =>
        new Response(zip as BodyInit, {
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.@-]/g, "_")}"`,
                "Cache-Control": "no-store",
            },
        });

    async function importBundle(req: Request, projectId?: string): Promise<Response> {
        if (Number(req.headers.get("content-length") ?? 0) > maxBundle) {
            throw new RequestError(`bundle exceeds ${maxBundle} bytes`, 413);
        }
        let bytes: Uint8Array;
        if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
            const file = (await req.formData()).get("bundle") as unknown as string | File | null;
            if (!file || typeof file === "string") throw new RequestError('missing "bundle" file');
            bytes = new Uint8Array(await file.arrayBuffer());
        } else {
            bytes = new Uint8Array(await req.arrayBuffer());
        }
        if (bytes.byteLength > maxBundle)
            throw new RequestError(`bundle exceeds ${maxBundle} bytes`, 413);
        if (bytes.byteLength === 0) throw new RequestError("empty body: send the bundle zip");
        const result = await backend.importBundle(bytes, { projectId });
        return json(result, result.imported > 0 ? 201 : 200);
    }

    async function ingest(req: Request, pid: string): Promise<Response> {
        if (!(req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
            throw new RequestError(
                "expected multipart/form-data with an `annotation` field and `asset:<id>` files",
                415
            );
        }
        const length = Number(req.headers.get("content-length") ?? 0);
        if (length > maxUpload) throw new RequestError(`upload exceeds ${maxUpload} bytes`, 413);

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
                if (total > maxUpload)
                    throw new RequestError(`upload exceeds ${maxUpload} bytes`, 413);
                files.set(key.slice("asset:".length), new Uint8Array(await entry.arrayBuffer()));
            }
        }
        const { stored, created } = await backend.ingest(parsed, files, { projectId: pid });
        return json(stored, created ? 201 : 200);
    }

    function events(req: Request, projectId: string, agent: boolean): Response {
        let cleanup = () => {};
        const stream = new ReadableStream<Uint8Array>(
            {
                start(controller) {
                    const enqueue = (bytes: Uint8Array) => {
                        try {
                            controller.enqueue(bytes);
                            // A client that has stopped reading (asleep, on a dead connection) would have every event kept for
                            // it in memory: past a few megabytes behind, it is let go, and reconnects when it wakes.
                            if ((controller.desiredSize ?? 0) < -SLOW_CLIENT_BYTES) cleanup();
                        } catch {
                            cleanup();
                        }
                    };
                    const send = (event: string, data: unknown) => enqueue(sseBytes(event, data));
                    eventStreams += 1;
                    send("hello", {
                        projectId,
                        agent: backend.agents.stateFor(projectId),
                        mentions: backend.mentions.list(),
                    });
                    // Whether an agent is listening, and what @ can call (the mention plugins), as they change.
                    const unwatchAgents = backend.agents.subscribe(
                        (state) => send("agent", state),
                        projectId
                    );
                    const unwatchMentions = backend.mentions.subscribe((mentions) =>
                        send("mentions", mentions)
                    );
                    // A page in agent mode also takes annotate requests relayed from `notato_annotate`.
                    const unregister =
                        agent && projectId !== "*"
                            ? backend.relay.register(projectId, (request) =>
                                  send("annotate-request", request)
                              )
                            : () => {};
                    const unsubscribe = backend.bus.subscribe((e) => {
                        if (projectId === "*" || e.projectId === projectId)
                            enqueue(busEventBytes(e));
                    });
                    const ping = setInterval(() => enqueue(PING), 15_000);
                    cleanup = () => {
                        eventStreams -= 1;
                        clearInterval(ping);
                        unsubscribe();
                        unwatchAgents();
                        unwatchMentions();
                        unregister();
                        cleanup = () => {};
                        try {
                            controller.close();
                        } catch {
                            // already closed
                        }
                    };
                    req.signal.addEventListener("abort", () => cleanup());
                },
                cancel() {
                    cleanup();
                },
            },
            new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 })
        );
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            },
        });
    }

    return async (req, info = {}) => {
        const url = new URL(req.url);
        const path = url.pathname.replace(/\/+$/, "") || "/";
        const withCors = (res: Response) => {
            for (const [key, value] of Object.entries(corsHeaders(req, extraOrigins)))
                res.headers.set(key, value);
            return res;
        };
        if (options.trustProxy) {
            // The last address is the one the trusted proxy appended; anything before it is whatever the client claimed.
            const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
            if (forwarded) info = { ...info, ip: forwarded };
        }
        try {
            // One screenshot by a signed link, for a Teams card: the signature is the permission, so it needs no login,
            // passes the dev tunnel's gate, and answers on any host (NOTATO_PUBLIC_URL can be a proxy's own address).
            // Everything else goes on to the checks below.
            const shared = await sharedAsset(req, url, backend, options.share);
            if (shared) return shared;
            if (
                !hostAllowed(
                    req,
                    options.allowedHosts ?? (options.mode === "dev" ? "loopback" : "any")
                )
            ) {
                return withCors(json({ error: "host not allowed" }, 403));
            }
            if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
            if (writeOriginRejected(req, extraOrigins))
                return withCors(json({ error: "origin not allowed" }, 403));

            let principal: Principal | null = LOCAL;
            if (auth) {
                principal = await auth.identify(req, url);
                if (!principal && !isPublic(req, path)) {
                    return withCors(
                        json({ error: "authentication required" }, 401, {
                            "WWW-Authenticate": "Bearer",
                        })
                    );
                }
            }
            if (options.authorize) {
                const projectId = /^\/projects\/([^/]+)/.exec(url.pathname)?.[1];
                const denied = await options.authorize(req, {
                    write: req.method !== "GET" && req.method !== "HEAD",
                    projectId: projectId ? decodeURIComponent(projectId) : undefined,
                });
                if (denied) return withCors(denied);
            }
            // With MCP off, agents are refused here too: an attached notato dev (an agent's MCP on another process, which
            // names itself on every request) and, on a shared server, the agent tokens issued for every project. Its
            // health check still answers, so an attached process stays attached instead of trying to take over.
            const agentId = req.headers.get(AGENT_HEADER);
            const agentToken = principal?.kind === "token" && principal.projectId === "*";
            if ((agentId || agentToken) && path !== "/health") {
                const off = mcpRefusal(backend.config());
                if (off) return withCors(json({ error: off }, 403));
            }
            // The heartbeat counts only once the request has passed every check, so nobody can make a page believe an
            // agent is there.
            if (agentId && principal)
                backend.agents.touch(
                    agentId.slice(0, 64),
                    cleanAgentName(req.headers.get(AGENT_NAME_HEADER)),
                    decodeAgentProjects(req.headers.get(AGENT_PROJECTS_HEADER))
                );
            return withCors(await route(req, url, principal, info));
        } catch (error) {
            if (error instanceof RequestError)
                return withCors(json({ error: error.message }, error.status));
            if (error instanceof UnknownProjectError)
                return withCors(json({ error: error.message }, 404));
            console.error("[notato] unhandled error:", error);
            return withCors(json({ error: "internal error" }, 500));
        }
    };
}
