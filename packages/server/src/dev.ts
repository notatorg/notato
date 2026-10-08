import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Author, Status } from "@notato/schema";
import { parseProjects } from "./agents.ts";
import { LOCAL_PRINCIPAL } from "./auth.ts";
import {
    type AssetBytes,
    type Backend,
    type ImportResult,
    LocalBackend,
    type VariantOffer,
} from "./backend.ts";
import { FileBlobStore } from "./blob-store.ts";
import {
    CONFIG_FILE,
    type ConfigSource,
    createConfigSource,
    defaultConfig,
    mcpRefusal,
    SETTINGS,
} from "./config.ts";
import { type AppHandler, type AppOptions, createApp, SERVE_LIMITS } from "./http.ts";
import { createMcpServer } from "./mcp.ts";
import { createMcpHttp, jsonRpcError } from "./mcp-http.ts";
import type { RelayArgs, RelayResult } from "./relay.ts";
import { isConnectionError, RemoteBackend } from "./remote-backend.ts";
import { ShareLinks } from "./share.ts";
import { SqliteStore } from "./sqlite-store.ts";
import type { AnnotationFilter, HandedEntry } from "./storage.ts";
import {
    createTunnelGate,
    fromOutside,
    loadDeviceAccess,
    saveDeviceAccess,
    startTunnel,
    type Tunnel,
    type TunnelOptions,
} from "./tunnel.ts";
import { bundledUi } from "./ui.ts";
import { startWebhooks } from "./webhooks.ts";

export const DEFAULT_PORT = 4747;

export interface PrimaryServer {
    backend: LocalBackend;
    port: number;
    stop(): void;
}

export interface PrimaryOptions {
    host: string;
    port: number;
    /** Directory holding `notato.db` and `assets/`. */
    dir: string;
    version: string;
    /** The settings in force (see `notato config`). Default: none set. */
    config?: ConfigSource;
    log?: (message: string) => void;
    /** Host names answered besides loopback ones (a dev tunnel's). The array may grow while the server runs. */
    allowedHosts?: string[];
    /** A check before every request (the dev tunnel's device token). */
    authorize?: AppOptions["authorize"];
    /** The address the outside world reaches this server at right now (its dev tunnel's), for screenshot links. */
    publicUrl?: () => string | undefined;
}

/** How programs on this machine reach a dev server on `port`: the address the board and `notato start` print. */
export const localUrl = (port: number) => `http://localhost:${port}`;

/**
 * `/mcp` in dev mode answers only programs on this machine. Never a web page: agents send no Origin, browsers always
 * do, and a page that could talk to the MCP could act as your agent. Never the dev tunnel or a proxy either: the device
 * token is built into every debug build of the app, so whoever has the build would have your agent's tools.
 */
export function localAgentsOnly(req: Request): Response | null {
    if (req.headers.has("origin"))
        return jsonRpcError(
            403,
            -32001,
            "web pages cannot connect to Notato's MCP; agents on this machine can (they send no Origin header)"
        );
    if (fromOutside(req))
        return jsonRpcError(
            403,
            -32001,
            "Notato's MCP is only served to this machine, not through a dev tunnel or a proxy"
        );
    return null;
}

function isAddressInUse(error: unknown): boolean {
    const e = error as { code?: string; message?: string };
    return e?.code === "EADDRINUSE" || /EADDRINUSE|in use/i.test(e?.message ?? "");
}

/** Binds the port first, then opens storage, so a second process never touches the database of the first. */
export function startPrimary(options: PrimaryOptions): PrimaryServer | null {
    let handler: AppHandler | undefined;
    let mcp: ReturnType<typeof createMcpHttp> | undefined;
    let server: ReturnType<typeof Bun.serve>;
    try {
        server = Bun.serve({
            hostname: options.host,
            port: options.port,
            ...SERVE_LIMITS,
            fetch: (req, srv) => {
                if (!handler) return new Response("starting", { status: 503 });
                if (mcp && new URL(req.url).pathname === "/mcp") return mcp.handle(req);
                return handler(req, { ip: srv.requestIP(req)?.address });
            },
        });
    } catch (error) {
        if (isAddressInUse(error)) return null;
        throw error;
    }
    mkdirSync(options.dir, { recursive: true });
    const store = new SqliteStore(join(options.dir, "notato.db"));
    const backend = new LocalBackend(store, new FileBlobStore(join(options.dir, "assets")), {
        config: options.config,
    });
    const share = new ShareLinks(
        options.dir,
        options.publicUrl ?? (() => process.env.NOTATO_PUBLIC_URL)
    );
    handler = createApp({
        backend,
        mode: "dev",
        version: options.version,
        ui: bundledUi(),
        allowedHosts: options.allowedHosts ?? "loopback",
        authorize: options.authorize,
        share,
        mcpUrl: `${localUrl(server.port ?? options.port)}/mcp`,
    });
    // MCP over HTTP, for an agent pointed at this server rather than starting its own `notato dev`.
    mcp = createMcpHttp({
        backend,
        version: options.version,
        // Everyone who reaches `/mcp` in dev mode is the person at this machine, as on the rest of the dev server.
        auth: { identify: async () => LOCAL_PRINCIPAL },
        guard: localAgentsOnly,
        refuse: () => mcpRefusal(backend.config()),
        allowImportPaths: true,
        presence: backend.agents,
    });
    // Annotation events go to the webhooks in the config, off to the side of the API.
    const hooks = startWebhooks({
        bus: backend.bus,
        config: options.config ?? defaultConfig,
        share,
        log: options.log ?? ((m) => console.error(`[notato] ${m}`)),
    });
    return {
        backend,
        port: server.port ?? options.port,
        stop() {
            hooks.stop();
            void mcp?.close();
            backend.agents.stop();
            server.stop(true);
            store.close();
        },
    };
}

/**
 * Delegates to whichever backend is current. When the process is attached to another server and that
 * server disappears, the first failing call (or the health monitor) promotes this process to primary.
 */
class SwitchableBackend implements Backend {
    current!: Backend;
    promote?: () => Promise<boolean>;

    private async call<T>(fn: (b: Backend) => Promise<T>): Promise<T> {
        try {
            return await fn(this.current);
        } catch (error) {
            if (
                this.current instanceof RemoteBackend &&
                isConnectionError(error) &&
                this.promote &&
                (await this.promote())
            ) {
                return fn(this.current);
            }
            throw error;
        }
    }

    list = (filter?: AnnotationFilter) => this.call((b) => b.list(filter));
    get = (id: string) => this.call((b) => b.get(id));
    markHanded = (entries: HandedEntry[]) => this.call((b) => b.markHanded(entries));
    asset = (id: string): Promise<AssetBytes | null> => this.call((b) => b.asset(id));
    setStatus = (id: string, status: Status, note?: string, author?: Author) =>
        this.call((b) => b.setStatus(id, status, note, author));
    reply = (id: string, body: string, author?: Author) =>
        this.call((b) => b.reply(id, body, author));
    offerVariants = (id: string, offer: VariantOffer, author?: Author) =>
        this.call((b) => b.offerVariants(id, offer, author));
    chooseVariant = (id: string, name: string | null, note?: string, author?: Author) =>
        this.call((b) => b.chooseVariant(id, name, note, author));
    waitForNew = (filter: AnnotationFilter, timeoutMs: number, signal?: AbortSignal) =>
        this.call((b) => b.waitForNew(filter, timeoutMs, signal));
    importBundle = (zip: Uint8Array): Promise<ImportResult> =>
        this.call((b) => b.importBundle(zip));
    requestAnnotation = (
        projectId: string | undefined,
        args: RelayArgs,
        timeoutMs: number
    ): Promise<RelayResult> => this.call((b) => b.requestAnnotation(projectId, args, timeoutMs));
}

export interface DevOptions {
    port?: number;
    host?: string;
    dir?: string;
    version: string;
    /** Speak MCP over stdin/stdout. Off in tests. */
    stdio?: boolean;
    log?: (message: string) => void;
    /** The config file. Default: `$NOTATO_CONFIG`, or `notato.config.json` in the current directory. */
    configFile?: string;
    /**
     * Put the server behind a Microsoft dev tunnel so phones can reach it, requiring a device token from anything that
     * comes through it (see tunnel.ts). Only the process that runs the server hosts it.
     */
    tunnel?: boolean;
    /** Replaces the devtunnel CLI in tests. */
    tunnelDriver?: Pick<TunnelOptions, "run" | "host" | "installed" | "retryMs">;
    /** `--no-mcp`: refuse agents whatever the config file says, for as long as this process runs. */
    mcp?: boolean;
    /**
     * `--project`: the projects this process's agent works on, when several repositories share one server. Its MCP
     * hands over only their notes, and only their pages say it is there. Default: `$NOTATO_PROJECT` (comma-separated),
     * else every project.
     */
    projects?: string[];
}

export interface DevRuntime {
    readonly role: "primary" | "client";
    readonly port: number;
    /** The data directory: the database, screenshots, and `device.json` with --tunnel. */
    readonly dir: string;
    readonly backend: Backend;
    /** Present when this process is the primary; `undefined` while attached to another. */
    readonly local: LocalBackend | undefined;
    /** The dev tunnel, when asked for and this process runs the server. */
    readonly tunnel: Tunnel | undefined;
    readonly mcp: McpServer;
    /** The projects this process's agent works on; undefined for every project. */
    readonly projects: string[] | undefined;
    close(): Promise<void>;
}

export async function runDev(options: DevOptions): Promise<DevRuntime> {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? Number(process.env.NOTATO_PORT ?? DEFAULT_PORT);
    const dir = resolve(options.dir ?? process.env.NOTATO_DIR ?? join(process.cwd(), ".notato"));
    const log = options.log ?? ((message: string) => console.error(`[notato] ${message}`));
    const projects = options.projects?.length
        ? options.projects
        : parseProjects(process.env.NOTATO_PROJECT);
    const config = createConfigSource({
        file: options.configFile ?? process.env.NOTATO_CONFIG ?? join(process.cwd(), CONFIG_FILE),
        flags: options.mcp === undefined ? undefined : { mcp: options.mcp },
    });
    // With --tunnel, requests from outside need the device token; the tunnel's host is added once it is known.
    const access = options.tunnel ? loadDeviceAccess(dir, port) : undefined;
    const gate = access ? createTunnelGate(access.token) : undefined;
    if (gate && access?.server) gate.hosts.push(new URL(access.server).hostname);
    const primaryOptions: PrimaryOptions = {
        host,
        port,
        dir,
        version: options.version,
        config,
        log,
        allowedHosts: gate?.hosts,
        authorize: gate?.authorize,
        publicUrl: () => process.env.NOTATO_PUBLIC_URL || access?.server,
    };
    const settings = config();
    if (settings.error) {
        log(`warning: ${settings.file}: ${settings.error}. Screenshots are off until it is fixed.`);
    } else if (!settings.screenshots) {
        log(
            `screenshots are off (${settings.source.screenshots === "env" ? SETTINGS.screenshots.env : settings.file})`
        );
    }
    const refusal = mcpRefusal(settings);
    if (refusal && !settings.error) log(refusal);

    const switchable = new SwitchableBackend();
    let primary: PrimaryServer | undefined;
    let role: "primary" | "client" = "primary";
    let actualPort = port;
    let monitor: ReturnType<typeof setInterval> | undefined;
    let promoting: Promise<boolean> | undefined;
    let closed = false;
    let tunnel: Tunnel | undefined;
    /** This process's own MCP, while it is open over stdio: an agent the server it runs counts as there. */
    let stdioOpen = false;
    let releaseAgent: (() => void) | undefined;
    const agentId = `agent_${crypto.randomUUID()}`;
    /** The agent on the other end of this process's MCP ("Codex"), once its client has introduced itself. */
    let agentLabel: string | undefined;

    const becomePrimary = (server: PrimaryServer) => {
        primary = server;
        actualPort = server.port;
        role = "primary";
        switchable.current = server.backend;
        if (monitor) clearInterval(monitor);
        monitor = undefined;
        if (stdioOpen) releaseAgent = server.backend.agents.hold(agentId, agentLabel, projects);
        if (access && gate && !tunnel) {
            access.local = localUrl(server.port);
            saveDeviceAccess(dir, access);
            tunnel = startTunnel({
                dir,
                port: server.port,
                access,
                log,
                onUrl: (url) => {
                    const name = new URL(url).hostname;
                    if (!gate.hosts.includes(name)) gate.hosts.push(name);
                },
                ...options.tunnelDriver,
            });
        }
    };

    switchable.promote = () => {
        promoting ??= (async () => {
            if (closed) return false;
            const server = startPrimary({ ...primaryOptions, port: actualPort });
            if (!server) return false;
            becomePrimary(server);
            log(
                `the server this process was attached to went away; now serving on http://${host}:${server.port} (data in ${dir})`
            );
            return true;
        })().finally(() => {
            promoting = undefined;
        });
        return promoting;
    };

    const first = startPrimary(primaryOptions);
    if (first) {
        becomePrimary(first);
        log(`dev server on http://${host}:${first.port} (data in ${dir})`);
    } else {
        const remote = new RemoteBackend(`http://${host}:${port}`);
        remote.agentName = agentLabel;
        remote.agentProjects = projects;
        if (!(await remote.health())) {
            throw new Error(
                `port ${port} is in use by something that is not notato; set NOTATO_PORT to use another port`
            );
        }
        role = "client";
        switchable.current = remote;
        log(
            `attached to the notato server already running on :${port}${projects ? ` (working on ${projects.join(", ")})` : ""}`
        );
        if (options.tunnel) {
            log(
                `no dev tunnel from this process: the server on :${port} belongs to another notato dev, which would have to be the one started with --tunnel. Give this project its own port (--port) to have one.`
            );
        }
        // Notice a vanished server within seconds, not at the next tool call, so the browser can reconnect.
        monitor = setInterval(async () => {
            if (!(await remote.health())) await switchable.promote?.();
        }, 3000);
        monitor.unref?.();
    }

    const mcp = createMcpServer({
        backend: switchable,
        version: options.version,
        projects,
        // Attached to another process, that server's setting applies: it refuses this process's requests when off.
        refuse: () => (primary ? mcpRefusal(primary.backend.config()) : null),
        onClient: (name) => {
            agentLabel = name;
            primary?.backend.agents.rename(agentId, name);
            if (switchable.current instanceof RemoteBackend) switchable.current.agentName = name;
        },
    });

    const close = async () => {
        if (closed) return;
        closed = true;
        if (monitor) clearInterval(monitor);
        releaseAgent?.();
        tunnel?.stop();
        await mcp.close().catch(() => {});
        primary?.stop();
    };

    if (options.stdio !== false) {
        await mcp.connect(new StdioServerTransport());
        stdioOpen = true;
        if (primary) releaseAgent = primary.backend.agents.hold(agentId, agentLabel, projects);
        // The session ending closes our stdin; the server must go with it.
        const shutdown = () => void close().finally(() => process.exit(0));
        process.stdin.on("end", shutdown);
        process.stdin.on("close", shutdown);
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }

    return {
        get role() {
            return role;
        },
        get port() {
            return actualPort;
        },
        dir,
        backend: switchable,
        get local() {
            return primary?.backend;
        },
        get tunnel() {
            return tunnel;
        },
        mcp,
        projects,
        close,
    };
}
