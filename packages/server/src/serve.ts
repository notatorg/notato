import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Authenticator } from "./auth.ts";
import { LocalBackend } from "./backend.ts";
import { FileBlobStore } from "./blob-store.ts";
import { CONFIG_FILE, createConfigSource, mcpRefusal } from "./config.ts";
import { DEFAULT_PORT } from "./dev.ts";
import { createApp, type UiAssets } from "./http.ts";
import { createMcpHttp } from "./mcp-http.ts";
import { ShareLinks } from "./share.ts";
import { SqliteStore } from "./sqlite-store.ts";
import { startWebhooks } from "./webhooks.ts";

export interface ServeOptions {
    /** Interface to bind. Loopback unless told otherwise: expose it deliberately, behind TLS. */
    host?: string;
    port?: number;
    /** Holds `notato.db` and `assets/`. */
    dir?: string;
    version: string;
    adminUser?: string;
    /** Applied on every start, so changing it resets the password. Generated and shown once if omitted. */
    adminPassword?: string;
    corsOrigins?: string[];
    /** Host names the server answers to. Defaults to any, since it normally sits behind a proxy. */
    allowedHosts?: string[];
    /** Believe `X-Forwarded-For` and `X-Forwarded-Proto` from a reverse proxy in front of this server. */
    trustProxy?: boolean;
    ui?: UiAssets | null;
    log?: (message: string) => void;
    /** The config file. Default: `$NOTATO_CONFIG`, or `notato.config.json` in the current directory. */
    configFile?: string;
    /** `--no-mcp`: refuse agents whatever the config file says, for as long as this process runs. */
    mcp?: boolean;
}

export interface ServeRuntime {
    readonly host: string;
    readonly port: number;
    readonly backend: LocalBackend;
    readonly auth: Authenticator;
    readonly store: SqliteStore;
    stop(): Promise<void>;
}

const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);

/** The shared server: login, per-project tokens, the HTTP API, streamable HTTP MCP at `/mcp`, and the board UI. */
export async function runServe(options: ServeOptions): Promise<ServeRuntime> {
    const host = options.host ?? process.env.NOTATO_HOST ?? "127.0.0.1";
    const port = options.port ?? Number(process.env.NOTATO_PORT ?? DEFAULT_PORT);
    const dir = resolve(options.dir ?? process.env.NOTATO_DIR ?? join(process.cwd(), ".notato"));
    const log = options.log ?? ((message: string) => console.error(`[notato] ${message}`));

    mkdirSync(dir, { recursive: true });
    const store = new SqliteStore(join(dir, "notato.db"));
    const config = createConfigSource({
        file: options.configFile ?? process.env.NOTATO_CONFIG ?? join(process.cwd(), CONFIG_FILE),
        flags: options.mcp === undefined ? undefined : { mcp: options.mcp },
    });
    const settings = config();
    if (settings.error)
        log(
            `warning: ${settings.file}: ${settings.error}. Screenshots are off and agents are refused until it is fixed.`
        );
    else {
        if (!settings.screenshots) log("screenshots are off, so none are stored");
        if (!settings.mcp) log(mcpRefusal(settings) ?? "MCP is off");
    }
    // On a shared server an admin creates each project (and its tokens) before an app can send to it.
    const backend = new LocalBackend(
        store,
        new FileBlobStore(join(dir, "assets")),
        undefined,
        undefined,
        config,
        { autoCreateProjects: false }
    );
    // A shared server is reached at its proxy's address, which only the person running it knows: NOTATO_PUBLIC_URL.
    // Without it, webhook messages carry no screenshot.
    const share = new ShareLinks(dir, () => process.env.NOTATO_PUBLIC_URL);
    const hooks = startWebhooks({ bus: backend.bus, config, log, share });
    const auth = new Authenticator(store);

    const adminUser = options.adminUser ?? process.env.NOTATO_ADMIN_USER ?? "admin";
    const admin = await auth.ensureAdmin(
        adminUser,
        options.adminPassword ?? process.env.NOTATO_ADMIN_PASSWORD
    );
    if (admin.generatedPassword) {
        log(
            `created the admin account "${adminUser}" with the password ${admin.generatedPassword}`
        );
        log("this is shown once; set NOTATO_ADMIN_PASSWORD to choose your own");
    }

    const trustProxy = options.trustProxy ?? process.env.NOTATO_TRUST_PROXY === "1";
    const app = createApp({
        backend,
        mode: "serve",
        version: options.version,
        share,
        auth,
        ui: options.ui,
        trustProxy,
        corsOrigins: options.corsOrigins,
        allowedHosts:
            options.allowedHosts ??
            (process.env.NOTATO_ALLOWED_HOSTS
                ? process.env.NOTATO_ALLOWED_HOSTS.split(",").map((h) => h.trim())
                : "any"),
    });
    const mcp = createMcpHttp({
        backend,
        version: options.version,
        auth,
        refuse: () => mcpRefusal(backend.config()),
        maxWaitSeconds: 240,
        presence: backend.agents,
    });

    const server = Bun.serve({
        hostname: host,
        port,
        // Long-poll and MCP responses stay open; the busiest ones ping or send progress well inside this.
        idleTimeout: 255,
        maxRequestBodySize: 256 * 1024 * 1024,
        fetch: (req, srv) => {
            const path = new URL(req.url).pathname;
            if (path === "/mcp") return mcp.handle(req);
            return app(req, { ip: srv.requestIP(req)?.address });
        },
    });

    log(`serving on http://${host}:${server.port} (data in ${dir})`);
    if (!isLoopback(host) && !trustProxy) {
        log(
            "listening beyond loopback: put a TLS-terminating reverse proxy in front and set NOTATO_TRUST_PROXY=1"
        );
    }

    return {
        host,
        port: server.port ?? port,
        backend,
        auth,
        store,
        async stop() {
            hooks.stop();
            await mcp.close();
            server.stop(true);
            store.close();
        },
    };
}
