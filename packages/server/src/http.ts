import {
    AGENT_HEADER,
    AGENT_NAME_HEADER,
    AGENT_PROJECTS_HEADER,
    cleanAgentName,
    decodeAgentProjects,
} from "./agents.ts";
import {
    type Authenticator,
    LOCAL_PRINCIPAL,
    type Principal,
    UnknownProjectError,
} from "./auth.ts";
import { type LocalBackend, RequestError } from "./backend.ts";
import { mcpRefusal } from "./config.ts";
import { corsHeaders, hostAllowed, parseExtraOrigins, writeOriginRejected } from "./cors.ts";
import { accountRoutes } from "./routes/account.ts";
import { annotationRoutes } from "./routes/annotations.ts";
import { bundleRoutes } from "./routes/bundles.ts";
import {
    type AppContext,
    json,
    notFound,
    type RouteRequest,
    type Routes,
} from "./routes/common.ts";
import { EventStreams, eventRoutes } from "./routes/events.ts";
import { pageRoutes } from "./routes/pages.ts";
import { projectRoutes } from "./routes/projects.ts";
import { relayRoutes } from "./routes/relay.ts";
import { healthRoute, statusRoutes } from "./routes/status.ts";
import { settingsRoutes } from "./settings.ts";
import { type ShareLinks, sharedAsset } from "./share.ts";

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
        access: { write: boolean; projectId?: string }
    ) => Promise<Response | null>;
    /** Signed links to single screenshots, for webhook messages (see share.ts). */
    share?: ShareLinks;
    /**
     * Where agents on this machine reach `/mcp` (`notato dev`), which the board shows even when it is opened through
     * the tunnel. Unset on a shared server, where it is the board's own address.
     */
    mcpUrl?: string;
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
    for (const routes of PUBLIC_ROUTES) {
        const answered = await routes(request, app);
        if (answered) return answered;
    }
    const { principal } = request;
    if (!principal) throw new RequestError("authentication required", 401);
    for (const routes of ROUTES) {
        const answered = await routes({ ...request, principal }, app);
        if (answered) return answered;
    }
    return notFound();
}

/**
 * Builds the request handler. It owns the checks every request goes through (CORS, host, origin, credentials, the
 * `mcp` setting for agents) and then hands it to the routes in `routes/`.
 */
export function createApp(options: AppOptions): AppHandler {
    const { backend, auth } = options;
    const extraOrigins = options.corsOrigins ?? parseExtraOrigins(process.env.NOTATO_CORS_ORIGINS);
    const allowedHosts = options.allowedHosts ?? (options.mode === "dev" ? "loopback" : "any");
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
            if (!hostAllowed(req, allowedHosts))
                return withCors(json({ error: "host not allowed" }, 403));
            if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
            if (writeOriginRejected(req, extraOrigins))
                return withCors(json({ error: "origin not allowed" }, 403));

            const method = methodOf(req);
            // Without `auth`, every caller is the person at this machine.
            let principal: Principal | null = LOCAL_PRINCIPAL;
            if (auth) {
                principal = await auth.identify(req, url);
                if (!principal && !isPublic(method, path)) {
                    return withCors(
                        json({ error: "authentication required" }, 401, {
                            "WWW-Authenticate": "Bearer",
                        })
                    );
                }
            }
            if (options.authorize) {
                const projectId = /^\/projects\/([^/]+)/.exec(path)?.[1];
                const denied = await options.authorize(req, {
                    write: req.method !== "GET" && req.method !== "HEAD",
                    projectId: projectId === undefined ? undefined : decodePart(projectId),
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
            const match = (pattern: RegExp): string[] | null => {
                const found = pattern.exec(path);
                return found ? found.slice(1).map(decodePart) : null;
            };
            return withCors(await route({ req, url, path, method, principal, info, match }, app));
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
