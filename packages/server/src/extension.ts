import type { AuthProvider } from "./auth.ts";
import type { BackendHooks, LocalBackend } from "./backend.ts";
import type { ExtraRoutes } from "./http.ts";
import type { AuthStore, BlobStore, Store } from "./storage.ts";

/**
 * What a deployment brings to `runServe` beyond the defaults (SQLite and files in the data folder, an admin login
 * and project tokens): where notes and screenshots are kept, who is signed in, extra routes, and the moments a
 * limit or a billing check belongs. Notato Cloud is built from these; a plain server uses none of them.
 *
 * An extension never edits the server: it hands it parts and the server calls them. Everything it replaces
 * behaves as the built-in does for the code that calls it, so annotations, MCP, relay, webhooks and the event
 * streams work the same on any store.
 */
export interface ServerExtension {
    name: string;
    /** Keeps notes, projects and accounts somewhere other than the data folder's SQLite file. */
    store?: (
        context: ExtensionContext
    ) => (Store & AuthStore & Closeable) | Promise<Store & AuthStore & Closeable>;
    /** Keeps screenshots somewhere other than the data folder. */
    blobs?: (context: ExtensionContext) => BlobStore | Promise<BlobStore>;
    /**
     * Who is signed in, instead of the built-in admin login and project tokens. When this is set the built-in admin
     * account is not created: the extension owns its accounts.
     */
    auth?: (
        context: ExtensionContext & { store: Store & AuthStore }
    ) => AuthProvider | Promise<AuthProvider>;
    /** Routes to add, tried before the server's own so one may replace a built-in. */
    routes?: (
        context: ExtensionContext & { backend: LocalBackend; auth: AuthProvider }
    ) => ExtraRoutes;
    /** Limits and checks, run before the backend changes anything. */
    hooks?: BackendHooks;
    /**
     * Runs once the server is up (background work, a billing webhook's listener, anything with a lifetime) and returns
     * how to stop it. Called as the server stops, before the store closes.
     */
    start?: (
        runtime: ExtensionRuntime
    ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface Closeable {
    close(): void | Promise<void>;
}

export interface ExtensionContext {
    /** The data folder, which the built-in parts use and an extension may too. */
    dir: string;
    version: string;
    log: (message: string) => void;
}

export interface ExtensionRuntime extends ExtensionContext {
    backend: LocalBackend;
    auth: AuthProvider;
    store: Store & AuthStore;
    host: string;
    port: number;
}
