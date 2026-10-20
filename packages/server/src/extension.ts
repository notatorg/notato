import type { AuthProvider } from "./auth.ts";
import type { BackendHooks, LocalBackend, LocalBackendOptions } from "./backend.ts";
import type { ConfigSource } from "./config.ts";
import type { AppOptions, ExtraRoutes } from "./http.ts";
import type { McpHttpOptions } from "./mcp-http.ts";
import type { AuthStore, BlobStore, Store } from "./storage.ts";

/**
 * What a deployment brings to `runServe` beyond the defaults (SQLite and files in the data folder, an admin login
 * and project tokens): where notes and screenshots are kept, who is signed in, extra routes, and the moments a
 * limit or a policy check belongs. A deployment with accounts and storage of its own is built from these; a plain
 * server uses none of them.
 *
 * An extension never edits the server: it hands it parts and the server calls them. Everything it replaces
 * behaves as the built-in does for the code that calls it, so annotations, MCP, relay, webhooks and the event
 * streams work the same on any store. Each part is made when the server needs it, from what exists by then, so a
 * later part can use an earlier one.
 *
 * `S`, `B` and `A` are the store, backend and accounts the extension makes (`store`, `backend`, `auth`), which every
 * later part is then handed as they are. An extension that makes none of them leaves them as the server's own.
 */
export interface ServerExtension<
    S extends Store & AuthStore = Store & AuthStore,
    B extends LocalBackend = LocalBackend,
    A extends AuthProvider = AuthProvider,
> {
    name: string;
    /** Keeps notes, projects and accounts somewhere other than the data folder's SQLite file. */
    store?(context: ExtensionContext): (S & Closeable) | Promise<S & Closeable>;
    /** Keeps screenshots somewhere other than the data folder. */
    blobs?(context: ExtensionContext): BlobStore | Promise<BlobStore>;
    /** Changes what the settings file says (and does not): the server reads settings through what this returns. */
    config?(base: ConfigSource, context: ExtensionContext): ConfigSource;
    /** Limits and checks, run before the backend changes anything. */
    hooks?(context: ExtensionContext & Parts<S>): BackendHooks;
    /**
     * Makes the backend, for a deployment whose notes, projects and accounts do more than the server's own (a
     * subclass of `LocalBackend`). Without it the server makes a `LocalBackend` with the options it is given.
     */
    backend?(context: ExtensionContext & Parts<S> & { options: LocalBackendOptions }): B;
    /**
     * Who is signed in, instead of the built-in admin login and project tokens. When this is set the built-in admin
     * account is not created: the extension owns its accounts.
     */
    auth?(context: ExtensionContext & Parts<S> & { backend: B }): A | Promise<A>;
    /** `false` turns the signed screenshot links in webhook messages off (a deployment that keeps screenshots private). */
    share?: false;
    /** Routes, request middleware, allowed origins, headers and size limits for the HTTP API. */
    http?(context: ExtensionContext & Parts<S> & Built<B, A>): ExtensionHttp;
    /** Limits, a guard and auditing for MCP over HTTP. */
    mcp?(context: ExtensionContext & Parts<S> & Built<B, A>): ExtensionMcp;
    /**
     * Wraps every request the server answers, `/mcp` included, before anything else: for a rate limit or a
     * connection budget. Call `next()` to answer, or return a response to refuse.
     */
    fetch?(
        context: ExtensionContext & Parts<S> & Built<B, A>
    ): (
        req: Request,
        info: { ip?: string; path: string },
        next: () => Promise<Response>
    ) => Promise<Response>;
    /**
     * Runs once the server is up (background work, a listener for another service's callbacks, anything with a
     * lifetime) and returns how to stop it. Called as the server stops, before the store closes.
     */
    start?(
        runtime: ExtensionRuntime<S, B, A>
    ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

/** What `http` adds: see `AppOptions` for each. */
export interface ExtensionHttp
    extends Pick<
        AppOptions,
        | "around"
        | "originsFor"
        | "responseHeaders"
        | "maxUploadBytes"
        | "maxBundleBytes"
        | "authorize"
        | "strictOrigins"
        | "boardCsp"
        | "projectRules"
        | "projectMemberLabels"
        | "collaborationCanManage"
        | "resolveProjectMember"
        | "tokenRules"
        | "teamCanManage"
        | "teamTokenOptions"
        | "aboutCaller"
    > {
    routes?: ExtraRoutes;
    /** The largest body the server reads at all, in bytes. */
    maxRequestBodySize?: number;
}

/** What `mcp` adds: see `McpHttpOptions` for each. */
export type ExtensionMcp = Pick<
    McpHttpOptions,
    | "guard"
    | "maxSessions"
    | "maxSessionsPerCredential"
    | "requireToken"
    | "auditTool"
    | "lockedRefusal"
>;

export interface Closeable {
    close(): void | Promise<void>;
}

export interface ExtensionContext {
    /** The data folder, which the built-in parts use and an extension may too. */
    dir: string;
    version: string;
    log: (message: string) => void;
}

/** The parts the server has made by the time a later part is asked for. */
export interface Parts<S extends Store & AuthStore = Store & AuthStore> {
    store: S;
    blobs: BlobStore;
    config: ConfigSource;
}

/** What exists once the backend and accounts do. */
export interface Built<
    B extends LocalBackend = LocalBackend,
    A extends AuthProvider = AuthProvider,
> {
    backend: B;
    auth: A;
}

export interface ExtensionRuntime<
    S extends Store & AuthStore = Store & AuthStore,
    B extends LocalBackend = LocalBackend,
    A extends AuthProvider = AuthProvider,
> extends ExtensionContext,
        Parts<S>,
        Built<B, A> {
    host: string;
    port: number;
}
