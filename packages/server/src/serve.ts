import { join, resolve } from "node:path";
import { Authenticator, type AuthProvider } from "./auth.ts";
import { LocalBackend } from "./backend.ts";
import { FileBlobStore } from "./blob-store.ts";
import { CONFIG_FILE, createConfigSource, mcpRefusal } from "./config.ts";
import { isLoopbackName } from "./cors.ts";
import { DEFAULT_PORT, databaseIn, ensureDataDir } from "./dev.ts";
import type { Built, ServerExtension } from "./extension.ts";
import { createApp, SERVE_LIMITS, type UiAssets } from "./http.ts";
import { createMcpHttp } from "./mcp-http.ts";
import { ShareLinks } from "./share.ts";
import { SqliteStore } from "./sqlite-store.ts";
import type { AuthStore, Store } from "./storage.ts";
import { startWebhooks } from "./webhooks.ts";

export interface ServeOptions<
    S extends Store & AuthStore = Store & AuthStore,
    B extends LocalBackend = LocalBackend,
    A extends AuthProvider = AuthProvider,
> {
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
    extension?: ServerExtension<S, B, A>;
}

/** The running server, with the store, backend and accounts an extension made as its own. */
export interface ServeRuntime<
    S extends Store & AuthStore = Store & AuthStore,
    B extends LocalBackend = LocalBackend,
    A extends AuthProvider = AuthProvider,
> {
    readonly host: string;
    readonly port: number;
    readonly backend: B;
    readonly auth: A;
    readonly store: S;
    /** Answers a request the way the listener does (extension middleware, MCP and all), without a socket. For tests. */
    handle(req: Request, info?: { ip?: string }): Promise<Response>;
    stop(): Promise<void>;
}

/** The shared server: login, per-project tokens, the HTTP API, streamable HTTP MCP at `/mcp`, and the board UI. */
export async function runServe<
    S extends Store & AuthStore = Store & AuthStore,
    B extends LocalBackend = LocalBackend,
    A extends AuthProvider = AuthProvider,
>(options: ServeOptions<S, B, A>): Promise<ServeRuntime<S, B, A>> {
    const host = options.host ?? process.env.NOTATO_HOST ?? "127.0.0.1";
    const port = options.port ?? Number(process.env.NOTATO_PORT ?? DEFAULT_PORT);
    const dir = resolve(options.dir ?? process.env.NOTATO_DIR ?? join(process.cwd(), ".notato"));
    const log = options.log ?? ((message: string) => console.error(`[notato] ${message}`));

    ensureDataDir(dir);
    const extension = options.extension;
    const context = { dir, version: options.version, log };
    // Without an extension's own part, each is the server's, and `S`, `B` and `A` are the defaults it satisfies.
    const ownStore = (): Store & AuthStore => new SqliteStore(databaseIn(dir));
    const store = (await extension?.store?.(context)) ?? (ownStore() as S);
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
        (new LocalBackend(store, blobs, backendOptions) as B);
    // A shared server is reached at its proxy's address, which only the person running it knows: NOTATO_PUBLIC_URL.
    // Without it, webhook messages carry no screenshot.
    const share =
        extension?.share === false
            ? undefined
            : new ShareLinks(dir, () => process.env.NOTATO_PUBLIC_URL);
    const hooks = startWebhooks({ bus: backend.bus, config, log, share });

    let auth: A;
    if (extension?.auth) auth = await extension.auth({ ...context, ...parts, backend });
    else {
        const builtIn = new Authenticator(store);
        const provider: AuthProvider = builtIn;
        auth = provider as A;
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

    const built: Built<B, A> = { backend, auth };
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
        boardCsp: http?.boardCsp,
        projectRules: http?.projectRules,
        tokenRules: http?.tokenRules,
        aboutCaller: http?.aboutCaller,
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

    const handle = (req: Request, info: { ip?: string } = {}): Promise<Response> => {
        const path = new URL(req.url).pathname;
        const answer = () => (path === "/mcp" ? mcp.handle(req) : app(req, info));
        return wrap ? wrap(req, { ip: info.ip, path }, answer) : answer();
    };

    const server = Bun.serve({
        hostname: host,
        port,
        ...SERVE_LIMITS,
        ...(http?.maxRequestBodySize ? { maxRequestBodySize: http.maxRequestBodySize } : {}),
        fetch: (req, srv) => {
            const ip = trustProxy
                ? (req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
                  srv.requestIP(req)?.address)
                : srv.requestIP(req)?.address;
            return handle(req, { ip });
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
        handle,
        async stop() {
            hooks.stop();
            await mcp.close();
            server.stop(true);
            await stopExtension?.();
            await store.close();
        },
    };
}
