import { runServe, type ServeOptions, type ServeRuntime } from "@notato/server";
import type { Authenticator } from "./auth.ts";
import type { CloudBackend } from "./backend.ts";
import { type CloudServeOptions, cloudSetup } from "./extension.ts";
import type { AuthStore, Store } from "./storage.ts";

export * from "./audit.ts";
export * from "./auth.ts";
export * from "./backend.ts";
export * from "./beta.ts";
export * from "./better-auth.ts";
export * from "./billing.ts";
export * from "./context.ts";
export * from "./extension.ts";
export * from "./mail.ts";
export * from "./managed-auth.ts";
export * from "./postgres-store.ts";
export * from "./resource-limits.ts";
export * from "./s3-blobs.ts";
export * from "./storage.ts";

/** The running service, with its backend, accounts and store as the cloud's own. */
export type CloudRuntime = ServeRuntime<Store & AuthStore, CloudBackend, Authenticator>;

/** Notato Cloud's server: the open server with Postgres, Better Auth, S3 storage and workspaces put under it. */
export async function runCloud(options: ServeOptions & CloudServeOptions): Promise<CloudRuntime> {
    const { extension, cleanup } = cloudSetup(options);
    try {
        return await runServe({ ...options, extension });
    } catch (error) {
        await cleanup().catch(() => {});
        throw error;
    }
}
