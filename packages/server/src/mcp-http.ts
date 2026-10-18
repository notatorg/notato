import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type AgentPresence, parseProjects } from "./agents.ts";
import {
    type AuthProvider,
    accessibleProjects,
    canAccessProject,
    type Principal,
    samePrincipal,
} from "./auth.ts";
import { type Backend, RequestError } from "./backend.ts";
import { createMcpServer } from "./mcp.ts";
import { ScopedBackend } from "./scoped-backend.ts";
import type { Store } from "./storage.ts";
import { tokenPurpose } from "./storage.ts";
import { teamBackend } from "./team.ts";

export interface McpHttpOptions {
    /** See `McpOptions.auditTool`. The credential is the one the session was opened with. */
    auditTool?: (principal: Principal, name: string) => Promise<(failed: boolean) => Promise<void>>;
    backend: Backend;
    version: string;
    /** Who a request is from. `notato dev` has no logins: everything that passes `guard` is the local user. */
    auth: Pick<AuthProvider, "identify">;
    /** Checks before anything else, such as `notato dev` refusing browsers and the dev tunnel. A Response stops the request. */
    guard?: (req: Request) => Response | null;
    /** Only a token may open MCP: a signed-in person's cookie is for the board. */
    requireToken?: boolean;
    /** How many sessions may be open at once, and for one credential. Defaults: 1024 and 32. */
    maxSessions?: number;
    maxSessionsPerCredential?: number;
    /** Why agents may not connect now (MCP turned off), or null. Sessions end at their next request while it is off. */
    refuse?: () => string | null;
    /** Whether `notato_import_bundle` may read paths on this machine: only where every caller is on it (`notato dev`). */
    allowImportPaths?: boolean;
    /** Sessions idle this long are closed. */
    idleMs?: number;
    /** Longest a single `notato_watch` blocks. Default: just inside the server's connection idle timeout. */
    maxWaitSeconds?: number;
    /** Where an open session counts as an agent being there (what pages show), named once it says who it is. */
    presence?: AgentPresence;
    /**
     * How a credential that is valid but suspended (`locked`) is refused: the HTTP status, and what the agent is told
     * to do about it. Default: 403, saying that access is suspended.
     */
    lockedRefusal?: { status: number; message: string };
}

/** What a suspended credential is told when the deployment does not say more. */
const LOCKED_REFUSAL = { status: 403, message: "access is suspended for this account" };

interface Session {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
    principal: Principal;
    lastUsed: number;
    /** Ends this session's agent presence; unset while it does not count as there. */
    release?: () => void;
    /** What the client called itself, for when it comes back after being quiet. */
    name?: string;
    /** The projects its agent works on (`/mcp?project=`, or its token's); undefined for every project. */
    projects?: string[];
    /** What `/mcp?project=` asked for, before narrowing by what the credential reaches. */
    requestedProjects?: string[];
}

/** How long a quiet session still counts as an agent being there (a client that went away without saying so). */
const PRESENT_MS = 5 * 60 * 1000;
/** How long a session may go unused before it is closed. */
const IDLE_MS = 30 * 60 * 1000;
/** How often sessions are checked for being quiet or idle. */
const SWEEP_MS = 60_000;
/** A `notato_watch` over HTTP returns before the connection's idle timeout (`SERVE_LIMITS.idleTimeout`) ends it. */
const MAX_WAIT_SECONDS = 240;

export const jsonRpcError = (
    status: number,
    code: number,
    message: string,
    headers: Record<string, string> = {}
) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });

/**
 * `/mcp`: the streamable HTTP transport, one session per client. A token for one project gets tools that
 * only ever see that project; an admin session or a `*` token sees all of them. The `notato_watch`
 * cursor lives in the session, so a reconnecting client starts again from the backlog.
 */
export function createMcpHttp(options: McpHttpOptions): {
    handle(req: Request): Promise<Response>;
    close(): Promise<void>;
} {
    const sessions = new Map<string, Session>();
    const idleMs = options.idleMs ?? IDLE_MS;

    const sweep = setInterval(() => {
        const cutoff = Date.now() - idleMs;
        const quiet = Date.now() - PRESENT_MS;
        for (const session of sessions.values()) {
            if (session.lastUsed < cutoff) void session.transport.close();
            else if (session.lastUsed < quiet) {
                session.release?.();
                session.release = undefined;
            }
        }
    }, SWEEP_MS);
    sweep.unref?.();

    // A credential that reaches only some projects gets tools that see only those, asked again on every call so a
    // revoked token or a removed member stops working inside a session that is already open.
    const projectBackendFor = (principal: Principal, req: Request): Backend =>
        accessibleProjects(principal) !== undefined
            ? new ScopedBackend(options.backend, async () => {
                  const current = await options.auth.identify(req, new URL(req.url));
                  if (!current || !samePrincipal(principal, current))
                      throw new RequestError("credential access revoked", 403);
                  return accessibleProjects(current) ?? [];
              })
            : options.backend;

    const backendFor = (principal: Principal, req: Request): Backend => {
        const inner = projectBackendFor(principal, req);
        const store = (options.backend as Backend & { store?: Store }).store;
        return store
            ? teamBackend(
                  inner,
                  store,
                  principal.developmentContextId,
                  async () => {
                      const current = await options.auth.identify(req, new URL(req.url));
                      if (
                          !current ||
                          !samePrincipal(principal, current) ||
                          current.developmentContextId !== principal.developmentContextId
                      )
                          throw new RequestError("Credential access revoked.", 403);
                  },
                  principal.kind === "token" ? principal.tokenId : undefined
              )
            : inner;
    };
    return {
        async handle(req) {
            const stopped = options.guard?.(req);
            if (stopped) return stopped;
            // Turned off: a call already running is answered with the reason by the tools themselves (see mcp.ts), and
            // anything after it is refused here, which also ends that session, so the agent reconnects once it is back on.
            const off = options.refuse?.();
            if (off) {
                const refused = sessions.get(req.headers.get("mcp-session-id") ?? "");
                if (refused) await refused.transport.close().catch(() => {});
                return jsonRpcError(403, -32001, off);
            }
            const principal = await options.auth.identify(req, new URL(req.url));
            // Valid, but suspended: say so, as the deployment words it, and end any session it has open.
            if (principal && principal.kind !== "admin" && principal.locked) {
                const open = sessions.get(req.headers.get("mcp-session-id") ?? "");
                if (open && samePrincipal(open.principal, principal))
                    await open.transport.close().catch(() => {});
                const { status, message } = options.lockedRefusal ?? LOCKED_REFUSAL;
                return jsonRpcError(status, -32001, message);
            }
            // The token an app carries is for notes; MCP is for an agent's, so a page's token cannot drive it.
            if (principal?.kind === "token" && tokenPurpose(principal) !== "agent")
                return jsonRpcError(
                    403,
                    -32001,
                    "an agent token is required for MCP; app tokens are for an SDK"
                );
            if (principal && options.requireToken && principal.kind !== "token")
                return jsonRpcError(
                    403,
                    -32001,
                    "an agent token is required for MCP; sign-in sessions are for the board"
                );
            if (!principal)
                return jsonRpcError(
                    401,
                    -32001,
                    "authentication required: send Authorization: Bearer <token>",
                    {
                        "WWW-Authenticate": "Bearer",
                    }
                );

            const sessionId = req.headers.get("mcp-session-id");
            if (sessionId) {
                const session = sessions.get(sessionId);
                if (!session)
                    return jsonRpcError(404, -32001, "session not found; initialise a new one");
                if (!samePrincipal(session.principal, principal))
                    return jsonRpcError(403, -32001, "this session belongs to another credential");
                session.lastUsed = Date.now();
                // What the credential reaches may have changed since the session began: follow it.
                const projects =
                    session.requestedProjects?.filter((id) => canAccessProject(principal, id)) ??
                    accessibleProjects(principal);
                if (projects?.join("\n") !== session.projects?.join("\n")) {
                    session.release?.();
                    session.release = undefined;
                    session.projects = projects;
                }
                // Back after being quiet: there again.
                session.release ??= options.presence?.hold(
                    `mcp:${sessionId}`,
                    session.name,
                    session.projects,
                    principal.developmentContextId
                );
                return session.transport.handleRequest(req);
            }

            if (
                sessions.size >= (options.maxSessions ?? 1024) ||
                [...sessions.values()].filter((s) => samePrincipal(s.principal, principal))
                    .length >= (options.maxSessionsPerCredential ?? 32)
            )
                return jsonRpcError(429, -32001, "MCP session limit reached", {
                    "Retry-After": "60",
                });

            // Only an initialize request may open a session.
            if (req.method !== "POST")
                return jsonRpcError(400, -32000, "no session: send an initialize request first");
            const presenceId = () => `mcp:${transport.sessionId}`;
            // Several repositories can share a server: `/mcp?project=web` keeps an agent to its own (a project token
            // already is).
            const asked = parseProjects(new URL(req.url).searchParams.getAll("project"));
            if (asked?.some((project) => !canAccessProject(principal, project)))
                return jsonRpcError(403, -32001, "project access denied");
            const projects = asked ?? accessibleProjects(principal);
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: (id) => {
                    sessions.set(id, {
                        transport,
                        server,
                        principal,
                        lastUsed: Date.now(),
                        projects,
                        requestedProjects: asked,
                        // An agent with the MCP open is there, watching or not, as one on `notato dev` is.
                        release: options.presence?.hold(
                            presenceId(),
                            undefined,
                            projects,
                            principal.developmentContextId
                        ),
                    });
                },
            });
            const audit = options.auditTool;
            const server = createMcpServer({
                ...(audit ? { auditTool: (name: string) => audit(principal, name) } : {}),
                backend: backendFor(principal, req),
                version: options.version,
                allowImportPaths: options.allowImportPaths ?? false,
                maxWaitSeconds: options.maxWaitSeconds ?? MAX_WAIT_SECONDS,
                refuse: options.refuse,
                // Only what the agent asked for, or the one project of a project token. What a wider credential
                // reaches is asked of the backend on every call, so a project added during the session is there.
                projects:
                    asked ??
                    (principal.kind === "token" &&
                    principal.projectId !== "*" &&
                    !principal.projectIds
                        ? [principal.projectId]
                        : undefined),
                onClient: (name) => {
                    const session = sessions.get(transport.sessionId ?? "");
                    if (session) session.name = name;
                    options.presence?.rename(presenceId(), name);
                },
            });
            transport.onclose = () => {
                const session = sessions.get(transport.sessionId ?? "");
                session?.release?.();
                if (transport.sessionId) sessions.delete(transport.sessionId);
            };
            await server.connect(transport);
            return transport.handleRequest(req);
        },

        async close() {
            clearInterval(sweep);
            for (const session of [...sessions.values()])
                await session.transport.close().catch(() => {});
            sessions.clear();
        },
    };
}
