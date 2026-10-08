import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type AgentPresence, parseProjects } from "./agents.ts";
import type { Authenticator, Principal } from "./auth.ts";
import type { Backend } from "./backend.ts";
import { createMcpServer } from "./mcp.ts";
import { ScopedBackend } from "./scoped-backend.ts";

export interface McpHttpOptions {
    backend: Backend;
    version: string;
    /** Who a request is from. `notato dev` has no logins: everything that passes `guard` is the local user. */
    auth: Pick<Authenticator, "identify">;
    /** Checks before anything else, such as `notato dev` refusing browsers and the dev tunnel. A Response stops the request. */
    guard?: (req: Request) => Response | null;
    /** Why agents may not connect now (MCP turned off), or null. Sessions end at their next request while it is off. */
    refuse?: () => string | null;
    /** Whether `notato_import_bundle` may read paths on this machine: only where every caller is on it (`notato dev`). */
    allowImportPaths?: boolean;
    /** Sessions idle this long are closed. */
    idleMs?: number;
    /** Longest a single `notato_watch` blocks, so it stays inside the server's connection idle timeout. */
    maxWaitSeconds?: number;
    /** Where an open session counts as an agent being there (what pages show), named once it says who it is. */
    presence?: AgentPresence;
}

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
}

/** How long a quiet session still counts as an agent being there (a client that went away without saying so). */
const PRESENT_MS = 5 * 60 * 1000;

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

const samePrincipal = (a: Principal, b: Principal) =>
    a.kind === b.kind &&
    (a.kind === "admin"
        ? a.username === (b as typeof a).username
        : a.tokenId === (b as typeof a).tokenId);

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
    const idleMs = options.idleMs ?? 30 * 60 * 1000;

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
    }, 60_000);
    sweep.unref?.();

    const backendFor = (principal: Principal): Backend =>
        principal.kind === "token" && principal.projectId !== "*"
            ? new ScopedBackend(options.backend, principal.projectId)
            : options.backend;

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
                // Back after being quiet: there again.
                session.release ??= options.presence?.hold(
                    `mcp:${sessionId}`,
                    session.name,
                    session.projects
                );
                return session.transport.handleRequest(req);
            }

            // Only an initialize request may open a session.
            if (req.method !== "POST")
                return jsonRpcError(400, -32000, "no session: send an initialize request first");
            const presenceId = () => `mcp:${transport.sessionId}`;
            // Several repositories can share a server: `/mcp?project=web` keeps an agent to its own (a project token
            // already is).
            const projects =
                principal.kind === "token" && principal.projectId !== "*"
                    ? [principal.projectId]
                    : parseProjects(new URL(req.url).searchParams.getAll("project"));
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: (id) => {
                    sessions.set(id, {
                        transport,
                        server,
                        principal,
                        lastUsed: Date.now(),
                        projects,
                        // An agent with the MCP open is there, watching or not, as one on `notato dev` is.
                        release: options.presence?.hold(presenceId(), undefined, projects),
                    });
                },
            });
            const server = createMcpServer({
                backend: backendFor(principal),
                version: options.version,
                allowImportPaths: options.allowImportPaths ?? false,
                maxWaitSeconds: options.maxWaitSeconds,
                refuse: options.refuse,
                projects,
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
