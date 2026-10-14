import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Authenticator, type AuthProvider } from "./auth.ts";
import { LocalBackend } from "./backend.ts";
import { FileBlobStore } from "./blob-store.ts";
import { CONFIG_FILE, createConfigSource, mcpRefusal } from "./config.ts";
import { isLoopbackName } from "./cors.ts";
import { DEFAULT_PORT } from "./dev.ts";
import type { Built, ServerExtension } from "./extension.ts";
import { createApp, SERVE_LIMITS, type UiAssets } from "./http.ts";
import { createMcpHttp } from "./mcp-http.ts";
import { ShareLinks } from "./share.ts";
import { SqliteStore } from "./sqlite-store.ts";
import type { AuthStore, Store } from "./storage.ts";
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
    /** What a deployment adds or replaces: its store, accounts, routes and limits. A plain server has none. */
    extension?: ServerExtension;
}

export interface ServeRuntime {
    readonly host: string;
    readonly port: number;
    readonly backend: LocalBackend;
    readonly auth: AuthProvider;
    readonly store: Store & AuthStore;
    stop(): Promise<void>;
}

/** The shared server: login, per-project tokens, the HTTP API, streamable HTTP MCP at `/mcp`, and the board UI. */
export async function runServe(options: ServeOptions): Promise<ServeRuntime> {
    const host = options.host ?? process.env.NOTATO_HOST ?? "127.0.0.1";
    const port = options.port ?? Number(process.env.NOTATO_PORT ?? DEFAULT_PORT);
    const dir = resolve(options.dir ?? process.env.NOTATO_DIR ?? join(process.cwd(), ".notato"));
    const log = options.log ?? ((message: string) => console.error(`[notato] ${message}`));

    mkdirSync(dir, { recursive: true });
    const extension = options.extension;
    const context = { dir, version: options.version, log };
    const store = (await extension?.store?.(context)) ?? new SqliteStore(join(dir, "notato.db"));
    const blobs = (await extension?.blobs?.(context)) ?? new FileBlobStore(join(dir, "assets"));
    const baseConfig = createConfigSource({
        file: options.configFile ?? process.env.NOTATO_CONFIG ?? join(process.cwd(), CONFIG_FILE),
        flags: options.mcp === undefined ? undefined : { mcp: options.mcp },
    });
    const config = extension?.config?.(baseConfig, context) ?? baseConfig;
    const settings = config();
    if (settings.error)
        log(
            `warning: ${settings.file}: ${settings.error}. Screenshots are off and agents are refused until it is fixed.`
        );
    else {
        if (!settings.screenshots) log("screenshots are off, so none are stored");
        if (!settings.mcp) log(mcpRefusal(settings) ?? "MCP is off");
    }
    const parts = { store, blobs, config };
    // On a shared server an admin creates each project (and its tokens) before an app can send to it.
    const backendOptions = {
        config,
        autoCreateProjects: false,
        hooks: extension?.hooks?.({ ...context, ...parts }),
    };
    const backend =
        extension?.backend?.({ ...context, ...parts, options: backendOptions }) ??
        new LocalBackend(store, blobs, backendOptions);
    // A shared server is reached at its proxy's address, which only the person running it knows: NOTATO_PUBLIC_URL.
    // Without it, webhook messages carry no screenshot.
    const share =
        extension?.share === false
            ? undefined
            : new ShareLinks(dir, () => process.env.NOTATO_PUBLIC_URL);
    const hooks = startWebhooks({ bus: backend.bus, config, log, share });

    let auth: AuthProvider;
    if (extension?.auth) auth = await extension.auth({ ...context, ...parts, backend });
    else {
        const builtIn = new Authenticator(store);
        auth = builtIn;
        const adminUser = options.adminUser ?? process.env.NOTATO_ADMIN_USER ?? "admin";
        const admin = await builtIn.ensureAdmin(
            adminUser,
            options.adminPassword ?? process.env.NOTATO_ADMIN_PASSWORD
        );
        if (admin.generatedPassword) {
            log(
                `created the admin account "${adminUser}" with the password ${admin.generatedPassword}`
            );
            log("this is shown once; set NOTATO_ADMIN_PASSWORD to choose your own");
        }
    }

    const built: Built = { backend, auth };
    const full = { ...context, ...parts, ...built };
    const trustProxy = options.trustProxy ?? process.env.NOTATO_TRUST_PROXY === "1";
    const http = extension?.http?.(full);
    const app = createApp({
        backend,
        mode: "serve",
        version: options.version,
        share,
        auth,
        routes: http?.routes,
        around: http?.around,
        authorize: http?.authorize,
        originsFor: http?.originsFor,
        strictOrigins: http?.strictOrigins,
        responseHeaders: http?.responseHeaders,
        maxUploadBytes: http?.maxUploadBytes,
        maxBundleBytes: http?.maxBundleBytes,
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
        presence: backend.agents,
        ...extension?.mcp?.(full),
    });
    const wrap = extension?.fetch?.(full);

    const server = Bun.serve({
        hostname: host,
        port,
        ...SERVE_LIMITS,
        ...(http?.maxRequestBodySize ? { maxRequestBodySize: http.maxRequestBodySize } : {}),
        fetch: (req, srv) => {
            const path = new URL(req.url).pathname;
            const ip = trustProxy
                ? (req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
                  srv.requestIP(req)?.address)
                : srv.requestIP(req)?.address;
            const answer = () => (path === "/mcp" ? mcp.handle(req) : app(req, { ip }));
            return wrap ? wrap(req, { ip, path }, answer) : answer();
        },
    });

    const stopExtension = await extension?.start?.({
        ...full,
        host,
        port: server.port ?? port,
    });

    log(`serving on http://${host}:${server.port} (data in ${dir})`);
    if (!isLoopbackName(host) && !trustProxy) {
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
            await stopExtension?.();
            await store.close();
        },
    };
}
