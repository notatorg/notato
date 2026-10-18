import { Status } from "@notato/schema";
import {
    AGENT_HEADER,
    AGENT_NAME_HEADER,
    AGENT_PROJECTS_HEADER,
    cleanAgentName,
    decodeAgentProjects,
} from "./agents.ts";
import {
    Authenticator,
    type AuthProvider,
    accessibleProjects,
    canAccessProject,
    type IssuedToken,
    type IssueTokenOptions,
    LOCAL_PRINCIPAL,
    type Principal,
    UnknownProjectError,
} from "./auth.ts";
import { type LocalBackend, RequestError } from "./backend.ts";
import { mcpRefusal } from "./config.ts";
import {
    corsHeaders,
    hostAllowed,
    type OriginTrust,
    parseExtraOrigins,
    writeOriginRejected,
} from "./cors.ts";
import { accountRoutes } from "./routes/account.ts";
import { annotationRoutes } from "./routes/annotations.ts";
import { bundleRoutes } from "./routes/bundles.ts";
import { claimRoutes } from "./routes/claims.ts";
import {
    type AppContext,
    json,
    notFound,
    type RouteRequest,
    type Routes,
} from "./routes/common.ts";
import { contextRoutes } from "./routes/contexts.ts";
import { EventStreams, eventRoutes } from "./routes/events.ts";
import { notFoundPage, pageRoutes } from "./routes/pages.ts";
import { projectRoutes } from "./routes/projects.ts";
import { relayRoutes } from "./routes/relay.ts";
import { healthRoute, statusRoutes } from "./routes/status.ts";
import { settingsRoutes } from "./settings.ts";
import { type ShareLinks, sharedAsset } from "./share.ts";
import type { AuthStore, ProjectSummary, TokenRecord } from "./storage.ts";
import { type DevelopmentContext, TeamCoordinator, withWorkPermit } from "./team.ts";
import { outsideRefusal } from "./tunnel.ts";

/** Static files of the web UI. `path` is relative, e.g. `index.html` or `assets/app-3f2a.js`. */
export interface UiAssets {
    lookup(path: string): Promise<{ body: BodyInit; type: string } | null>;
}

export interface AppOptions {
    teamCanManage?: (principal: Principal) => boolean;
    teamTokenOptions?: (
        principal: Principal,
        context: DevelopmentContext
    ) => import("./auth.ts").IssueTokenOptions;
    backend: LocalBackend;
    mode: "dev" | "serve";
    version: string;
    /**
     * Accounts and tokens. Without it the server is open, which is only safe on loopback (dev mode). With it,
     * every route except `/health`, `/auth/*` and the UI shell needs a session or a token.
     */
    auth?: AuthProvider;
    /** The board UI, served at `/` and `/ui/*`. */
    ui?: UiAssets | null;
    /**
     * Extra allowed browser origins, on top of the server's own and the pages it trusts by default: this machine's
     * without `auth`, and any private network's with it (see `OriginTrust`).
     */
    corsOrigins?: string[];
    /** Which `Host` headers are answered. Dev mode defaults to loopback names only (DNS-rebinding guard). */
    allowedHosts?: "loopback" | "any" | string[];
    /** Behind a reverse proxy: believe `X-Forwarded-For` and `X-Forwarded-Proto`. */
    trustProxy?: boolean;
    /** Ceiling for one note with its screenshots. */
    maxUploadBytes?: number;
    /** Ceiling for a bundle zip upload. */
    maxBundleBytes?: number;
    /**
     * Called before every request that reaches a route. Return a Response to stop it (401/403), or null to
     * let it through. For policy beyond what `auth` provides, such as the dev tunnel's device token.
     */
    authorize?: (
        req: Request,
        access: { write: boolean; projectId?: string; principal: Principal | null }
    ) => Promise<Response | null>;
    /**
     * Wraps every request that has passed the host, origin and credential checks, with the credential known: run
     * `next()` to answer it, or return a response of your own to stop it. For policy a deployment adds (limits, a
     * locked account, an audit trail, metrics). Errors thrown inside are handled as the server's own are.
     */
    around?: (context: RequestContext, next: () => Promise<Response>) => Promise<Response>;
    /**
     * Only the origins listed (the server's own, `corsOrigins`, and `originsFor`) may call the API from a browser:
     * loopback and private networks are not trusted. For a service on the public internet.
     */
    strictOrigins?: boolean;
    /** Browser origins allowed for this one request, on top of the server's, such as the ones a project lists. */
    originsFor?: (req: Request, url: URL) => string[] | Promise<string[]>;
    /**
     * The Content-Security-Policy the board is served with, given the server's own: for a deployment whose board
     * talks to another origin (a sign-in provider) or loads a script from one.
     */
    boardCsp?: (base: string) => string;
    /** Headers added to every answer. */
    responseHeaders?: (req: Request, path: string) => Record<string, string>;
    /** Signed links to single screenshots, for webhook messages (see share.ts). */
    share?: ShareLinks;
    /**
     * Where agents on this machine reach `/mcp` (`notato dev`), which the board shows even when it is opened through
     * the tunnel. Unset on a shared server, where it is the board's own address.
     */
    mcpUrl?: string;
    /** Routes an extension adds to the server's own (see `ServerExtension`). */
    routes?: ExtraRoutes;
    /** Who manages projects, what `/projects` lists, and what a new project is made with, beyond an admin's own. */
    projectRules?: ProjectRules;
    /** Who uses `/tokens` beyond an admin, what each of them sees there, and how their tokens are issued. */
    tokenRules?: TokenRules;
    /**
     * What `GET /auth/me` says about whoever asks, beyond whether they are signed in and as whom: for accounts that
     * have more to them (a display name, a team) or a sign-in the board must be told about.
     */
    aboutCaller?(principal: Principal | null, req: Request): Promise<Record<string, unknown>>;
}

/**
 * How `/projects` works where more than an admin manages projects, or a project is more than an id and a name. Each
 * part left out keeps the server's own rule.
 */
export interface ProjectRules {
    /** Throws a `RequestError` unless the credential may create, rename and delete projects. The server's own: an admin. */
    assertManager?(principal: Principal): void;
    /**
     * The projects `GET /projects` lists for this credential, with their counts and whatever the store keeps about each
     * for whoever asks. The server shows only the ones the credential reaches whatever this returns. The server's
     * own: every project.
     */
    list?(principal: Principal): Promise<ProjectSummary[]>;
    /**
     * Decides a new project from who asks and what they sent: its id (one the server makes, say, where ids are shared
     * by many accounts and one chosen by a caller could collide with another's), what else its record holds, and how
     * its first tokens are issued. Throw a `RequestError` to refuse.
     */
    create?(principal: Principal, body: ProjectRequest): Promise<NewProject>;
}

/** `POST /projects` as `ProjectRules.create` reads it: `id`, `name` and `agent` checked, and any other field kept. */
export interface ProjectRequest {
    id?: string;
    name?: string;
    /** Also make a token for a coding agent, for this project only. */
    agent?: boolean;
    [field: string]: unknown;
}

/** What a new project is made with. */
export interface NewProject {
    id: string;
    /** Kept in the project's record beside its id, name and when it was made. */
    fields?: Record<string, unknown>;
    /** How its first app token is issued. */
    appToken?: IssueTokenOptions;
    /** How its agent token is issued, when one is asked for; it is always for an agent. */
    agentToken?: IssueTokenOptions;
}

/**
 * How `/tokens` works where people other than an admin hold tokens (their own, or their team's). Without these it is
 * an admin's alone, as `/admin/tokens` always is. Each part left out keeps the server's own rule.
 */
export interface TokenRules {
    /** Throws a `RequestError` unless the credential may list, issue and revoke tokens at `/tokens`. */
    assertManager?(principal: Principal | null): void;
    /** Whether the credential sees this token in the list and may revoke it. The server's own: only an admin does. */
    visible?(principal: Principal, token: TokenRecord): boolean;
    /** Issues the token `POST /tokens` asks for, reading the request's body itself. Throw a `RequestError` to refuse. */
    issue?(principal: Principal, req: Request): Promise<IssuedToken>;
    /** A token's record as any answer shows it. The server's own leaves out the token's hash (`shownToken`). */
    shown?(record: TokenRecord): object;
}

/** What an extension adds to the routes: tried before the server's own, so one can replace a built-in route. */
export interface ExtraRoutes {
    /** Routes anyone may reach, credentials or not. List the paths in `isPublic` too. */
    public?: Array<Routes<Principal | null>>;
    /** Routes for a credential the server has identified. */
    private?: Routes[];
    /** Whether a request may reach the routes without a credential (the server's own public paths always may). */
    isPublic?: (method: string, path: string) => boolean;
}

/** A request as `around` sees it. */
export interface RequestContext {
    req: Request;
    url: URL;
    path: string;
    method: string;
    /** Null only on the routes anyone may use. */
    principal: Principal | null;
    info: RequestInfo;
}

export interface RequestInfo {
    /** The client's address as the server saw it, for rate limiting. */
    ip?: string;
}

export type AppHandler = (req: Request, info?: RequestInfo) => Promise<Response>;

export const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024;
export const DEFAULT_MAX_BUNDLE = 100 * 1024 * 1024;

/**
 * What `Bun.serve` is given for this app. Connections may idle for the longest Bun allows: an event stream pings and a
 * long MCP call sends progress well inside it. A body has a hard ceiling; the routes enforce their own, smaller limits.
 */
export const SERVE_LIMITS = { idleTimeout: 255, maxRequestBodySize: 256 * 1024 * 1024 } as const;

/** The routes anyone may use, credentials or not. They must agree with `isPublic`. */
const PUBLIC_ROUTES: Array<Routes<Principal | null>> = [healthRoute, accountRoutes, pageRoutes];

/** Everything else, tried in order once the request is known to be from someone. */
const ROUTES: Routes[] = [
    settingsRoutes,
    statusRoutes,
    projectRoutes,
    annotationRoutes,
    eventRoutes,
    bundleRoutes,
    relayRoutes,
];

/** Whether a request may go on to the routes without a session or a token. */
const isPublic = (method: string, path: string) =>
    path === "/health" ||
    (path === "/auth/login" && method === "POST") ||
    (path === "/auth/me" && method === "GET") ||
    (method === "GET" &&
        (path === "/" ||
            path.startsWith("/ui/") ||
            path === "/inject.js" ||
            path === "/bookmarklet"));

/** `decodeURIComponent` that answers 400 for malformed percent-encoding instead of throwing a URIError. */
function decodePart(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        throw new RequestError("malformed percent-encoding in the URL");
    }
}

/** Some HTTP stacks (Android's HttpURLConnection) cannot send PATCH, so a POST may say it means one. */
const methodOf = (req: Request) =>
    req.method === "POST" && req.headers.get("x-http-method-override")?.toUpperCase() === "PATCH"
        ? "PATCH"
        : req.method;

/** Tries the public routes, then (once there is someone to answer to) the rest; 404 when none answers. */
async function route(request: RouteRequest<Principal | null>, app: AppContext): Promise<Response> {
    const extra = app.options.routes;
    for (const routes of [...(extra?.public ?? []), ...PUBLIC_ROUTES]) {
        const answered = await routes(request, app);
        if (answered) return answered;
    }
    const { principal } = request;
    if (!principal) throw new RequestError("authentication required", 401);
    for (const routes of [...(extra?.private ?? []), claimRoutes, contextRoutes, ...ROUTES]) {
        const answered = await routes({ ...request, principal }, app);
        if (answered) return answered;
    }
    return (await notFoundPage(request.req, app.options)) ?? notFound();
}

/**
 * Builds the request handler. It owns the checks every request goes through (CORS, host, origin, credentials, the
 * `mcp` setting for agents) and then hands it to the routes in `routes/`.
 */
export function createApp(options: AppOptions): AppHandler {
    const { backend, auth } = options;
    const localAuth =
        !auth && backend.store.coordination
            ? new Authenticator(backend.store as typeof backend.store & AuthStore)
            : undefined;
    const extraOrigins = options.corsOrigins ?? parseExtraOrigins(process.env.NOTATO_CORS_ORIGINS);
    const allowedHosts = options.allowedHosts ?? (options.mode === "dev" ? "loopback" : "any");
    // Without logins a page the server trusts can read and write every note, so it trusts only this machine's pages.
    const trust: OriginTrust = options.strictOrigins ? "listed" : auth ? "network" : "machine";
    const app: AppContext = {
        backend,
        auth,
        options,
        limits: {
            upload: options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD,
            bundle: options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE,
        },
        streams: new EventStreams(backend),
        startedAt: Date.now(),
    };

    return async (req, info = {}) => {
        const url = new URL(req.url);
        const path = url.pathname.replace(/\/+$/, "") || "/";
        let requestOrigins = extraOrigins;
        const withCors = (res: Response) => {
            for (const [key, value] of Object.entries(corsHeaders(req, requestOrigins, trust)))
                res.headers.set(key, value);
            for (const [key, value] of Object.entries(options.responseHeaders?.(req, path) ?? {}))
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
            if (shared) return withCors(shared);
            if (!hostAllowed(req, allowedHosts))
                return withCors(json({ error: "host not allowed" }, 403));
            if (options.originsFor)
                requestOrigins = [...extraOrigins, ...(await options.originsFor(req, url))];
            if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
            if (writeOriginRejected(req, requestOrigins, trust))
                return withCors(json({ error: "origin not allowed" }, 403));

            const method = methodOf(req);
            // Without `auth`, every caller is the person at this machine.
            let principal: Principal | null = LOCAL_PRINCIPAL;
            if (auth) {
                principal = await auth.identify(req, url);
                if (
                    !principal &&
                    !isPublic(method, path) &&
                    !options.routes?.isPublic?.(method, path)
                ) {
                    // A document request receives only the static 404, never private routes or account data.
                    const missing = await notFoundPage(req, options);
                    if (missing) return withCors(missing);
                    return withCors(
                        json({ error: "authentication required" }, 401, {
                            "WWW-Authenticate": "Bearer",
                        })
                    );
                }
            }
            if (
                !auth &&
                localAuth &&
                !(
                    (req.headers.get("authorization") ?? "").startsWith("Bearer notato_device_") ||
                    (url.searchParams.get("token") ?? "").startsWith("notato_device_")
                ) &&
                (req.headers.has("authorization") ||
                    req.headers.has("x-notato-token") ||
                    url.searchParams.has("token"))
            ) {
                principal = await localAuth.identify(req, url);
                if (!principal)
                    return withCors(json({ error: "Invalid checkout credential." }, 401));
            }
            if (principal?.developmentContextId) {
                const context = await new TeamCoordinator(backend.store).context(
                    principal.developmentContextId
                );
                if (!context || context.archived)
                    return withCors(json({ error: "Checkout connection revoked." }, 403));
            }
            if (options.authorize) {
                const projectId = /^\/projects\/([^/]+)/.exec(path)?.[1];
                const denied = await options.authorize(req, {
                    write: req.method !== "GET" && req.method !== "HEAD",
                    projectId: projectId === undefined ? undefined : decodePart(projectId),
                    principal,
                });
                if (denied) return withCors(denied);
            }
            // Without `auth`, a request from outside this machine (the dev tunnel, a proxy) is not the person at it: an
            // app on a phone at most, which reaches what an app uses and nothing of the board's or an agent's. After
            // `authorize`, so a request without the device token learns nothing.
            if (!auth) {
                const refused = outsideRefusal(req, method, path);
                if (refused) return withCors(refused);
            }
            // What the credential may do at all (capture-only and app tokens, MCP off, agent presence) happens inside
            // `around`, so a deployment's own refusal (a locked account, a limit) comes first.
            const run = async (): Promise<Response> => {
                if (principal?.kind === "token" && principal.permission === "capture") {
                    // A capture-only token is for a page that sends notes and nothing else: it reads nothing back, so a
                    // token in a page's source cannot be used to read the feedback of everyone who tested it.
                    if (path === "/config" && method === "GET") {
                        const project = url.searchParams.get("project");
                        if (project && !canAccessProject(principal, project))
                            return withCors(json({ error: "project access denied" }, 403));
                        return withCors(
                            json({
                                screenshots: backend.config().screenshots,
                                references: true,
                                reviews: true,
                                annotationStatuses: Status.options,
                                derivedScreenshots: backend.derivedScreenshots,
                                mentions: [],
                                agent: { connected: false, watching: false, sessions: 0 },
                                captureOnly: true,
                            })
                        );
                    }
                    if (
                        !(
                            method === "POST" &&
                            /^\/projects\/[^/]+\/(annotations|connection|bundles)$/.test(path)
                        ) &&
                        path !== "/health"
                    )
                        return withCors(
                            json(
                                {
                                    error: "capture tokens can only send new notes; sign in to the board to read them",
                                },
                                403
                            )
                        );
                    if (req.headers.has(AGENT_HEADER))
                        return withCors(
                            json({ error: "capture tokens cannot act as agents" }, 403)
                        );
                }
                if (
                    principal?.kind === "token" &&
                    principal.purpose === "app" &&
                    // The agent's side of the relay and of watching. A page in agent mode answering requests (its event
                    // stream with agent=1, and its results) is the app's side, and an app token may do that.
                    (req.headers.has(AGENT_HEADER) ||
                        path === "/relay/annotate" ||
                        path === "/annotations/handed")
                )
                    return withCors(
                        json({ error: "an agent token is required for agent operations" }, 403)
                    );
                // With MCP off, agents are refused here too: an attached notato dev (an agent's MCP on another process, which
                // names itself on every request) and, on a shared server, the agent tokens issued for every project. Its
                // health check still answers, so an attached process stays attached instead of trying to take over.
                const agentId = req.headers.get(AGENT_HEADER);
                if (agentId && principal && principal.kind !== "token")
                    principal = { ...principal, agentSession: true };
                const agentToken =
                    principal?.kind === "token" &&
                    (principal.purpose === "agent" || principal.projectId === "*");
                if ((agentId || agentToken) && path !== "/health") {
                    const off = mcpRefusal(backend.config());
                    if (off) return withCors(json({ error: off }, 403));
                }
                // The heartbeat counts only once the request has passed every check, so nobody can make a page believe an
                // agent is there.
                if (agentId && principal) {
                    const agentPrincipal = principal;
                    // The id is the agent's own, but only within its credential: two people's agents never share one, and
                    // an agent only ever claims projects its credential reaches.
                    const claimed = decodeAgentProjects(req.headers.get(AGENT_PROJECTS_HEADER));
                    backend.agents.touch(
                        `${principal.kind === "token" ? principal.tokenId : principal.username}:${agentId.slice(0, 64)}`,
                        cleanAgentName(req.headers.get(AGENT_NAME_HEADER)),
                        claimed?.filter((id) => canAccessProject(agentPrincipal, id)) ??
                            accessibleProjects(principal),
                        principal.developmentContextId
                    );
                }
                const match = (pattern: RegExp): string[] | null => {
                    const found = pattern.exec(path);
                    return found ? found.slice(1).map(decodePart) : null;
                };
                const dispatch = () =>
                    route({ req, url, path, method, principal, info, match }, app);
                if (principal?.developmentContextId && req.headers.has("x-notato-work-permit")) {
                    let permit: { session: string; version: number };
                    try {
                        permit = JSON.parse(req.headers.get("x-notato-work-permit")!);
                    } catch {
                        throw new RequestError("Invalid work permit.");
                    }
                    if (
                        typeof permit.session !== "string" ||
                        permit.session.length > 100 ||
                        !Number.isSafeInteger(permit.version)
                    )
                        throw new RequestError("Invalid work permit.");
                    return withWorkPermit(
                        {
                            ...permit,
                            contextId: principal.developmentContextId,
                            credentialId:
                                principal.kind === "token" ? principal.tokenId : undefined,
                        },
                        dispatch
                    );
                }
                return dispatch();
            };
            return withCors(
                options.around
                    ? await options.around({ req, url, path, method, principal, info }, run)
                    : await run()
            );
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
