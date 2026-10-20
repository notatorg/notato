import { join } from "node:path";
import {
    type AppContext,
    type BlobStore,
    type ConfigSource,
    type Principal as CorePrincipal,
    FileBlobStore,
    hostAllowed,
    isLoopbackName,
    isSecure,
    json,
    parseExtraOrigins,
    type RequestContext,
    RequestError,
    type RouteRequest,
    type ServerExtension,
    UnknownProjectError,
} from "@notato/server";
import { auditAttempt } from "./audit.ts";
import { Authenticator, type Principal } from "./auth.ts";
import { CloudBackend } from "./backend.ts";
import { type BetaPolicy, betaFromEnv } from "./beta.ts";
import { managedAuthFromEnv } from "./better-auth.ts";
import { billingFromEnv, type StripeBilling } from "./billing.ts";
import type { CloudApp, CloudOptions, CloudRoutes } from "./context.ts";
import {
    type EmailPreferenceOptions,
    emailPreferenceOptions,
    evidenceCutoff,
} from "./email-preferences.ts";
import { githubWebhookSecretFromEnv } from "./github-webhook.ts";
import {
    clientAddress,
    HostedGuard,
    INGRESS_LIMITS,
    type IngressLimits,
    type Lease,
    limitedResponse,
} from "./hosted-guard.ts";
import { startMaintenance } from "./maintenance.ts";
import type { ManagedAuth } from "./managed-auth.ts";
import { Metrics, sampleCapacity } from "./metrics.ts";
import { PostgresStore } from "./postgres-store.ts";
import { resourceLimitsFromEnv } from "./resource-limits.ts";
import { aboutCaller, accountRoutes, hostedTokenRules } from "./routes/account.ts";
import { createBetaRoutes } from "./routes/beta.ts";
import { billingRoutes, billingWebhook } from "./routes/billing.ts";
import { emailPreferenceRoutes } from "./routes/email-preferences.ts";
import { githubWebhookRoutes } from "./routes/github-webhook.ts";
import { instanceRoutes } from "./routes/instance.ts";
import { lifecycleRoutes } from "./routes/lifecycle.ts";
import { pluginRoutes, pluginsFor } from "./routes/plugins.ts";
import { hostedProjectRules, projectRoutes } from "./routes/projects.ts";
import { pullRequestRoutes } from "./routes/pull-requests.ts";
import { recoveryRoutes } from "./routes/recovery.ts";
import { monitoringRoutes } from "./routes/status.ts";
import { teamRoutes } from "./routes/team.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";
import { S3BlobStore, s3BlobsFromEnv } from "./s3-blobs.ts";
import {
    type AuthStore,
    DataControlError,
    HOSTED_LIMITS,
    QuotaError,
    type Store,
    WorkspaceOwnershipError,
} from "./storage.ts";

/** What Notato Cloud is set up with: the environment fills in what is not given, and tests give what they need. */
export interface CloudServeOptions {
    /** For example, "Platform administration" on a managed service. Permissions stay independent. */
    administration?: { title: string };
    resourceLimits?: import("./storage.ts").HostedLimits;
    plugins?: import("./plugins/service.ts").PluginOptions;
    /** Extra browser origins that may call the API, beyond each project's own list. */
    corsOrigins?: string[];
    /** Fail closed if hosted identity configuration is missing. */
    hosted?: boolean;
    billing?: StripeBilling | null;
    beta?: BetaPolicy | null;
    /** Explicit hosted testing only: self-service plan changes without any payment provider. */
    testPlans?: boolean;
    /** GitHub App webhook secret, for tests. Default: `NOTATO_GITHUB_WEBHOOK_SECRET`. */
    githubWebhookSecret?: string;
    /** Marketing-email choices and unsubscribe links. Default: `NOTATO_EMAIL_PREFERENCE_KEY`, else off. */
    emailPreferences?: EmailPreferenceOptions | null;
    /** Test injection / legacy custom deployments. Managed hosted accounts use canonical plans by default. */
    workspacePlans?: boolean;
    /** Optional managed identity provider. No configuration: native accounts remain in use. */
    managedAuth?: ManagedAuth | null;
    /** An already-open store, for tests. Otherwise `NOTATO_DATABASE_URL` is the Postgres database. */
    store?: Store & AuthStore & { close(): void | Promise<void> };
    blobs?: BlobStore;
    adminUser?: string;
    adminPassword?: string;
    allowedHosts?: string[];
    trustProxy?: boolean;
    /** The ingress limits, for tests. Otherwise the documented defaults. */
    ingress?: IngressLimits;
}

/** The open server's extension, as the cloud makes it: its store, backend and accounts are the cloud's own. */
export type CloudExtension = ServerExtension<Store & AuthStore, CloudBackend, Authenticator>;

/** What `/billing`, `/auth` and the rest of the cloud's routes are reached through, and how the service is run. */
export interface CloudSetup {
    extension: CloudExtension;
    options: CloudOptions;
    cleanup(): Promise<void>;
}

/** Validates the deployment's settings (the process fails closed on anything inconsistent) and builds the extension. */
export function cloudSetup(options: CloudServeOptions = {}): CloudSetup {
    const managed =
        options.managedAuth === null ? undefined : (options.managedAuth ?? managedAuthFromEnv());
    const beta = options.beta === null ? undefined : (options.beta ?? betaFromEnv());
    if (beta && !beta.admins.size) throw new Error("Set at least one beta administrator");
    if (beta && !managed) throw new Error("Closed beta requires managed identity");
    const betaRoutes = createBetaRoutes();
    const emailPreferences =
        options.emailPreferences === null
            ? undefined
            : (options.emailPreferences ?? emailPreferenceOptions(process.env));
    if (
        options.hosted === undefined &&
        process.env.NOTATO_HOSTED &&
        !["0", "1"].includes(process.env.NOTATO_HOSTED)
    )
        throw new Error("NOTATO_HOSTED must be 0 or 1");
    if ((options.hosted ?? process.env.NOTATO_HOSTED === "1") && !managed)
        throw new Error(
            "The full server requires Better Auth; refusing to fall back to native accounts"
        );
    let publicOrigin: string | undefined;
    if (process.env.NOTATO_PUBLIC_URL) {
        const publicUrl = new URL(process.env.NOTATO_PUBLIC_URL);
        if (
            publicUrl.username ||
            publicUrl.password ||
            publicUrl.search ||
            publicUrl.hash ||
            publicUrl.pathname !== "/" ||
            (publicUrl.protocol !== "https:" &&
                !(publicUrl.protocol === "http:" && isLoopbackName(publicUrl.hostname)))
        )
            throw new Error("NOTATO_PUBLIC_URL must be an HTTPS origin (HTTP only on loopback)");
        publicOrigin = publicUrl.origin;
    }
    if (managed?.config.requireMfa && !publicOrigin)
        throw new Error("set NOTATO_PUBLIC_URL to the hosted service's HTTPS origin");
    const billing =
        options.billing === null ? undefined : (options.billing ?? billingFromEnv(publicOrigin));
    if (
        options.testPlans === undefined &&
        process.env.NOTATO_TEST_PLANS &&
        !["0", "1"].includes(process.env.NOTATO_TEST_PLANS)
    )
        throw new Error("NOTATO_TEST_PLANS must be 0 or 1");
    const testPlans = options.testPlans ?? process.env.NOTATO_TEST_PLANS === "1";
    if (testPlans && (!managed || billing))
        throw new Error(
            "test plan selection requires hosted identity and payment billing to be disabled"
        );
    if (billing?.workspacePlans && !managed)
        throw new Error("workspace plan billing requires managed identity");
    if (
        billing &&
        options.workspacePlans !== undefined &&
        options.workspacePlans !== billing.workspacePlans
    )
        throw new Error("billing and workspace plan enforcement must use the same model");
    const workspacePlans = options.workspacePlans ?? Boolean(billing?.workspacePlans);
    if (workspacePlans && (!managed || testPlans))
        throw new Error(
            "payment-backed workspace plans require managed identity and no test selector"
        );
    const monitoringToken = process.env.NOTATO_MONITORING_TOKEN;
    if (monitoringToken && !/^[A-Za-z0-9_-]{32,512}$/.test(monitoringToken))
        throw new Error("monitoring token must have 32–512 random URL-safe characters");
    const chosenPassword = options.adminPassword ?? process.env.NOTATO_ADMIN_PASSWORD;
    if (managed?.config.operatorLogin && (!chosenPassword || chosenPassword.length < 20))
        throw new Error("operator password sign-in requires a password of at least 20 characters");

    const metrics = new Metrics();
    const guard = new HostedGuard(Date.now, options.ingress ?? INGRESS_LIMITS);
    const trustProxy = options.trustProxy ?? process.env.NOTATO_TRUST_PROXY === "1";
    const corsOrigins = options.corsOrigins ?? parseExtraOrigins(process.env.NOTATO_CORS_ORIGINS);
    const allowedHosts =
        options.allowedHosts ??
        (process.env.NOTATO_ALLOWED_HOSTS
            ? process.env.NOTATO_ALLOWED_HOSTS.split(",").map((h) => h.trim())
            : ("any" as const));
    const resourceLimits =
        options.resourceLimits ??
        resourceLimitsFromEnv() ??
        (billing || testPlans || workspacePlans ? HOSTED_LIMITS : undefined);
    const cloudOptions: CloudOptions = {
        administration: options.administration,
        plugins: options.plugins,
        beta,

        billing,
        testPlans,
        emailPreferences,
        githubWebhookSecret: options.githubWebhookSecret ?? githubWebhookSecretFromEnv(),
        workspacePlans,
        monitoringToken,
        metrics,
        workspaceLimits: resourceLimits,
        publicOrigin,
    };

    /**
     * The cloud's routes, as the server calls them: with its context seen as the cloud's own (its backend and accounts
     * are the cloud's), and the credential as the cloud's accounts made it.
     */
    const cloudRoutes = (backend: CloudBackend, accounts: Authenticator) => {
        const contexts = new WeakMap<AppContext, CloudApp>();
        const cloudApp = (app: AppContext): CloudApp => {
            let made = contexts.get(app);
            if (!made) {
                made = {
                    ...app,
                    backend,
                    auth: accounts,
                    options: { ...app.options, ...cloudOptions },
                    metrics,
                };
                contexts.set(app, made);
            }
            return made;
        };
        return <P extends Principal | null>(routes: CloudRoutes<P>) =>
            (route: RouteRequest<CorePrincipal | null>, app: AppContext) =>
                routes(route as RouteRequest<P>, cloudApp(app));
    };

    let openedStore: (Store & AuthStore & { close(): void | Promise<void> }) | undefined;
    const extension: CloudExtension = {
        name: "notato-server",

        store: async () => {
            const store =
                options.store ??
                (process.env.NOTATO_DATABASE_URL
                    ? await PostgresStore.connect(process.env.NOTATO_DATABASE_URL)
                    : undefined);
            if (!store)
                throw new Error(
                    "Notato Cloud keeps its records in Postgres: set NOTATO_DATABASE_URL"
                );
            if (resourceLimits) {
                if (
                    !store.setHostedLimits ||
                    !store.checkIngestBudget ||
                    !store.checkBundleBudget
                ) {
                    await store.close();
                    throw new Error("hosted storage must enforce workspace resource limits");
                }
                store.setHostedLimits(resourceLimits);
            }
            if (testPlans && !store.setTestPlans) {
                await store.close();
                throw new Error("hosted storage must enforce test plan limits");
            }
            store.setTestPlans?.(testPlans);
            if (workspacePlans && !store.setWorkspacePlans) {
                await store.close();
                throw new Error("hosted storage must enforce payment-backed workspace plans");
            }
            try {
                await store.setWorkspacePlans?.(workspacePlans);
            } catch (error) {
                await store.close();
                throw error;
            }
            openedStore = store;
            return store;
        },

        blobs: async ({ dir }) =>
            options.blobs ??
            (managed ? await s3BlobsFromEnv() : new FileBlobStore(join(dir, "assets"))),

        // An old server-wide hook must not start receiving every customer's feedback when registration is enabled.
        config: (base: ConfigSource, { log }) => {
            if (!managed) return base;
            if (base().webhooks.some((hook) => !hook.project))
                log(
                    "hosted registration: unscoped webhooks are disabled; give each webhook an explicit project"
                );
            return Object.assign(
                () => {
                    const settings = base();
                    return {
                        ...settings,
                        webhooks: settings.webhooks.filter((hook) => Boolean(hook.project)),
                    };
                },
                { file: base.file, invalidate: base.invalidate }
            );
        },

        hooks: ({ store }) => ({
            // The workspace's plan decides how many notes and bytes it may hold: refused before anything is written.
            beforeIngest: async (annotation, bytes) => {
                await store.checkIngestBudget?.(annotation, bytes);
            },
            // A bundle's record counts too: one with no room is refused before any of its notes is stored.
            beforeImportBundle: async (bundle) => {
                await store.checkBundleBudget?.(bundle);
            },
        }),

        backend: ({ store, blobs, options: backendOptions }) =>
            new CloudBackend(store, blobs, backendOptions),

        auth: async ({ store, log }) => {
            await managed?.initialize?.();
            const accounts = new Authenticator(store, {
                managed,
                beta,
                secureCookies: Boolean(managed && publicOrigin?.startsWith("https:")),
                ...(workspacePlans
                    ? {
                          workspaceRestricted: async (id: string) =>
                              (await store.getWorkspaceEntitlement(id)).locked,
                      }
                    : {}),
            });
            if (managed?.verifyRequest) return accounts;
            const adminUser = options.adminUser ?? process.env.NOTATO_ADMIN_USER ?? "admin";
            const admin = await accounts.ensureAdmin(adminUser, chosenPassword);
            if (admin.generatedPassword) {
                log(
                    `created the admin account "${adminUser}" with the password ${admin.generatedPassword}`
                );
                log("this is shown once; set NOTATO_ADMIN_PASSWORD to choose your own");
            }
            return accounts;
        },

        // Hosted screenshots stay private: no signed public links, unless an unmanaged deployment asks for them.
        share: !managed && process.env.NOTATO_PUBLIC_SCREENSHOTS === "on" ? undefined : false,

        http: ({ backend, auth: accounts }) => {
            const store = backend.store;
            const adapt = cloudRoutes(backend, accounts);
            return {
                strictOrigins: Boolean(managed),
                routes: {
                    public: [
                        async ({ req, path }) =>
                            path.startsWith("/api/auth/") && managed?.handler
                                ? managed.handler(req)
                                : null,
                        adapt(betaRoutes),
                        adapt(monitoringRoutes),
                        adapt(billingWebhook),
                        adapt(accountRoutes),
                        adapt(emailPreferenceRoutes),
                        adapt(githubWebhookRoutes),
                        adapt(teamRoutes),
                    ],
                    private: [
                        adapt(instanceRoutes),
                        adapt(lifecycleRoutes),
                        adapt(recoveryRoutes),
                        adapt(pluginRoutes),
                        adapt(pullRequestRoutes),
                        async (route) => {
                            if (
                                managed &&
                                route.principal.kind === "admin" &&
                                /^\/(contexts|projects\/[^/]+\/(contexts|work)|annotations\/[^/]+\/work)/.test(
                                    route.path
                                )
                            )
                                throw new RequestError(
                                    "Sign in with a workspace account to manage checkout connections.",
                                    403
                                );
                            return null;
                        },
                        adapt(billingRoutes),
                        adapt(workspaceRoutes),
                        adapt(projectRoutes),
                    ],
                    isPublic,
                },
                collaborationCanManage: (principal: CorePrincipal) =>
                    principal.kind === "admin" ||
                    (principal.kind === "member" &&
                        (principal as Principal & { role: string }).role !== "member"),
                projectMemberLabels: async (
                    _principal: CorePrincipal,
                    _project: string,
                    usernames: string[]
                ) => {
                    const labels: Record<string, { name: string }> = {};
                    for (const username of usernames) {
                        const user = await accounts.store.getUser(username);
                        if (user)
                            labels[username] = {
                                name: user.displayName?.trim() || user.email || username,
                            };
                    }
                    return labels;
                },
                resolveProjectMember: async (
                    principal: CorePrincipal,
                    _project: string,
                    identifier: string
                ) => {
                    if (principal.kind !== "member") return undefined;
                    const workspace = (principal as Principal & { workspaceId: string })
                        .workspaceId;
                    for (const member of await accounts.store.listWorkspaceMembers(workspace)) {
                        const user = await accounts.store.getUser(member.username);
                        if (
                            member.username === identifier ||
                            user?.email?.toLowerCase() === identifier.toLowerCase()
                        )
                            return member.username;
                    }
                    return undefined;
                },
                projectRules: hostedProjectRules(store, Boolean(managed)),
                tokenRules: hostedTokenRules(accounts),
                teamCanManage: (principal: CorePrincipal) =>
                    principal.kind === "admin" ||
                    (principal.kind === "member" &&
                        (principal as Principal & { role: string }).role !== "member"),
                teamTokenOptions: (
                    principal: CorePrincipal,
                    context: import("@notato/server").DevelopmentContext
                ) =>
                    ({
                        ownership: "user",
                        createdBy:
                            principal.kind === "member" || principal.kind === "admin"
                                ? principal.username
                                : undefined,
                        ownerUsername: context.owner,
                        workspaceId: (principal as Principal & { workspaceId: string }).workspaceId,
                        expiresInDays: 90,
                    }) as import("./auth.ts").HostedTokenOptions,
                aboutCaller: aboutCaller(accounts, cloudOptions),
                ...(managed
                    ? {
                          maxUploadBytes: 16 * 1024 * 1024,
                          maxBundleBytes: 32 * 1024 * 1024,
                          maxRequestBodySize: 32 * 1024 * 1024,
                      }
                    : {}),
                responseHeaders: (_req, path) => responseHeaders(path, Boolean(managed)),
                originsFor: managed
                    ? async (req, url) => projectOrigins(store, req, url)
                    : undefined,
                around: (context, next) =>
                    guardedRequest(context, next, {
                        managed,
                        publicOrigin,
                        trustProxy,
                        corsOrigins,
                        store,
                        accounts,
                        guard,
                    }),
            };
        },

        mcp: ({ store }) => {
            // A suspended workspace is told why, and where to put it right, as its other requests are (402).
            const lockedRefusal = {
                status: 402,
                message:
                    "access is suspended for this account: sign in to the board to put it right",
            };
            return managed
                ? {
                      lockedRefusal,
                      requireToken: true,
                      maxSessions: 128,
                      maxSessionsPerCredential: 8,
                      guard: (req: Request) => {
                          if (req.headers.has("origin"))
                              return json({ error: "browser access to MCP is disabled" }, 403);
                          if (!hostAllowed(req, allowedHosts))
                              return json({ error: "host not allowed" }, 403);
                          if (publicOrigin?.startsWith("https:") && !isSecure(req, trustProxy))
                              return json({ error: "HTTPS is required" }, 400);
                          return null;
                      },
                      auditTool: async (principal: CorePrincipal, name: string) => {
                          const who = principal as Principal;
                          const key = who.kind === "token" ? who.tokenId : who.username;
                          // A watch waits rather than works: it holds one of the credential's open streams.
                          const lease =
                              name === "notato_watch"
                                  ? guard.holdStream(credentialOf(who))
                                  : guard.acquire(`tool:${key}`, true);
                          if (lease instanceof Response)
                              throw new Error("MCP request limit reached; try again shortly");
                          const record = {
                              id: crypto.randomUUID(),
                              workspaceId:
                                  who.kind === "admin"
                                      ? "__service"
                                      : (who.workspaceId ?? "__service"),
                              actor: credentialOf(who),
                              action: `MCP ${name}`,
                              outcome: 0,
                              createdAt: new Date().toISOString(),
                          };
                          try {
                              await store.appendAudit(record);
                          } catch (reason) {
                              lease.release();
                              throw reason;
                          }
                          return async (failed: boolean) => {
                              try {
                                  await store.appendAudit({
                                      ...record,
                                      outcome: failed ? 403 : 200,
                                  });
                              } finally {
                                  lease.release();
                              }
                          };
                      },
                  }
                : { lockedRefusal };
        },

        fetch:
            ({ backend }) =>
            async (req, { ip, path }, next) => {
                if (
                    managed &&
                    publicOrigin?.startsWith("https:") &&
                    path !== "/health" &&
                    !isSecure(req, trustProxy)
                )
                    return json({ error: "HTTPS is required" }, 400);
                const origin = req.headers.get("origin");
                if (managed && origin && req.method !== "OPTIONS" && path !== "/mcp") {
                    const url = new URL(req.url);
                    const expected =
                        publicOrigin ??
                        `${trustProxy && req.headers.get("x-forwarded-proto") === "https" ? "https:" : url.protocol}//${req.headers.get("host") ?? url.host}`;
                    // Another origin may call with a project's token only if the project (or the deployment) lists
                    // it, and never with the board's cookie: answered before anyone is asked who they are.
                    if (
                        origin !== new URL(expected).origin &&
                        (req.headers.has("cookie") ||
                            ![
                                ...corsOrigins,
                                ...(await projectOrigins(backend.store, req, url)),
                            ].includes(origin))
                    )
                        return json({ error: "origin not allowed" }, 403);
                }
                const client = clientAddress(ip ?? "unknown");
                const lease = !(managed && path !== "/health")
                    ? undefined
                    : staysOpen(req.method, path)
                      ? guard.acquireStream(client)
                      : guard.acquire(
                            client,
                            path !== "/mcp" &&
                                ((req.method !== "GET" &&
                                    (path.includes("/annotations") || path.includes("/bundles"))) ||
                                    path.startsWith("/assets/") ||
                                    path.endsWith("/export") ||
                                    (path.includes("/annotations") && path !== "/annotations/wait"))
                        );
                if (lease instanceof Response) return lease;
                const began = performance.now();
                try {
                    const response = await next();
                    metrics.record(response.status, performance.now() - began);
                    if (managed && path === "/mcp") {
                        response.headers.set("Cache-Control", "no-store");
                        response.headers.set("Referrer-Policy", "no-referrer");
                        response.headers.set("X-Content-Type-Options", "nosniff");
                    }
                    return lease ? limitedResponse(response, lease.release) : response;
                } catch (error) {
                    // An error that escapes the server's own handling (MCP's) would otherwise reset the connection.
                    // Answer it as the server answers its other routes' errors, and count it in the error rate.
                    lease?.release();
                    console.error("[notato] unhandled error:", error);
                    metrics.record(500, performance.now() - began);
                    const failed = json({ error: "internal error" }, 500);
                    failed.headers.set("Cache-Control", "no-store");
                    return failed;
                }
            },

        start: ({ backend, store, log, dir, port }) => {
            metrics.measureCapacity(() => sampleCapacity(store, dir));
            const blobs = backend.blobs;
            if (blobs instanceof S3BlobStore) metrics.measureEgress(() => blobs.downloadedBytes);
            const plugins = pluginsFor(
                backend,
                publicOrigin ?? `http://127.0.0.1:${port}`,
                options.plugins
            );
            if (!plugins.key)
                log(
                    "plugins are off: set NOTATO_PLUGIN_KEY (64 hex characters, with a recovery copy kept elsewhere) to let workspaces connect tools"
                );
            const stopPlugins = plugins.start();
            const maintenance = startMaintenance(
                backend,
                store,
                managed,
                (result) => {
                    for (const task of result.tasks) metrics.recordMaintenance(task);
                    if (
                        result.notesRemoved ||
                        result.identitiesRemoved ||
                        result.assetsRemoved ||
                        result.failed
                    )
                        log(
                            `maintenance: ${result.notesRemoved} notes removed; ${result.assetsRemoved} orphan assets removed; ${result.identitiesRemoved} identities removed; ${result.failed ? "retry pending" : "complete"}`
                        );
                },
                emailPreferences ? () => evidenceCutoff(emailPreferences) : undefined
            );
            // Retry durable clean-up after a restart, once the listener and database are ready.
            void maintenance.run();
            return async () => {
                await stopPlugins();
                await maintenance.stop();
                await managed?.close?.();
            };
        },
    };

    return {
        extension,
        options: cloudOptions,
        async cleanup() {
            await managed?.close?.();
            await openedStore?.close();
        },
    };
}

/** Paths anyone may reach without signing in, beyond the open server's own. */
function isPublic(method: string, path: string): boolean {
    return (
        path.startsWith("/api/auth/") ||
        path === "/ready" ||
        (path === "/beta/status" && method === "GET") ||
        (["/beta/waitlist", "/beta/invitation"].includes(path) && method === "POST") ||
        (path === "/metrics" && method === "GET") ||
        (path === "/billing/webhook" && method === "POST") ||
        (path === "/auth/session" && method === "POST") ||
        (path === "/email/unsubscribe" && (method === "GET" || method === "POST")) ||
        (path === "/email/provider-events" && method === "POST") ||
        (path === "/github/webhook" && method === "POST") ||
        (method === "GET" && /^\/invitations\/[^/]+$/.test(path))
    );
}

function responseHeaders(path: string, managed: boolean): Record<string, string> {
    return {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...(managed && path === "/"
            ? {
                  "Cross-Origin-Opener-Policy": "same-origin",
                  "Permissions-Policy":
                      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
              }
            : {}),
        ...(managed && !path.startsWith("/ui/") ? { "Cache-Control": "no-store" } : {}),
    };
}

/** The sites a customer lists on a project may call that project's API from a browser, and nothing else may. */
async function projectOrigins(store: Store, req: Request, url: URL): Promise<string[]> {
    const origin = req.headers.get("origin");
    if (!origin) return [];
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ids: string[] = [];
    const decode = (part: string) => {
        try {
            return decodeURIComponent(part);
        } catch {
            return "";
        }
    };
    const project = /^\/projects\/([^/]+)/.exec(path)?.[1] ?? url.searchParams.get("project");
    if (project) ids.push(decode(project));
    const noteId = /^\/annotations\/([^/]+)/.exec(path)?.[1];
    if (noteId) {
        const note = await store.getAnnotation(decode(noteId));
        if (note) ids.push(note.annotation.projectId);
    }
    const assetId = /^\/assets\/([^/]+)/.exec(path)?.[1];
    if (assetId) ids.push(...(await store.projectsWithAsset(decode(assetId))));
    for (const id of new Set(ids))
        if ((await store.getProjectOrigins(id)).includes(origin)) return [origin];
    return [];
}

/** No normal notes, assets, exports, settings or token management while an unpaid workspace needs recovery. */
function recoveryAllowed(method: string, path: string): boolean {
    if (method === "GET" && /^\/billing\/recovery\/(projects|assets)\//.test(path)) return true;
    if (
        method === "GET" &&
        (path === "/" ||
            path.startsWith("/ui/") ||
            [
                "/health",
                "/ready",
                "/auth/me",
                "/auth/sessions",
                "/billing",
                "/billing/recovery",
            ].includes(path))
    )
        return true;
    if (
        method === "POST" &&
        [
            "/auth/login",
            "/auth/session",
            "/auth/logout",
            "/auth/workspace",
            "/auth/sessions/revoke-others",
            "/billing/checkout",
            "/billing/portal",
            "/billing/recovery/cleanup",
            "/billing/recovery/complete",
            "/billing/recovery/delete-workspace",
        ].includes(path)
    )
        return true;
    if (
        method === "DELETE" &&
        (path === "/workspace" ||
            path === "/auth/account" ||
            /^\/auth\/sessions\/[0-9a-f]{64}$/.test(path))
    )
        return true;
    return (
        (method === "GET" && /^\/invitations\/[^/]+$/.test(path)) ||
        (method === "POST" && /^\/invitations\/[^/]+\/accept$/.test(path))
    );
}

/** What the cloud adds around every request once its credential is known. */
async function guardedRequest(
    { req, url, path, method, principal }: RequestContext,
    next: () => Promise<Response>,
    deployment: {
        managed: ManagedAuth | undefined;
        publicOrigin: string | undefined;
        trustProxy: boolean;
        corsOrigins: string[];
        store: Store;
        accounts: Authenticator;
        guard: HostedGuard;
    }
): Promise<Response> {
    const { managed, publicOrigin, accounts, guard } = deployment;
    const who = principal as Principal | null;
    let held: Lease | undefined;
    try {
        const origin = req.headers.get("origin");
        if (
            managed &&
            req.headers.has("cookie") &&
            !["GET", "HEAD", "OPTIONS"].includes(method) &&
            req.headers.has("sec-fetch-site") &&
            req.headers.get("x-notato-board") !== "1"
        )
            return json({ error: "board request header required" }, 403);
        if (
            managed &&
            who?.kind === "token" &&
            who.purpose === "app" &&
            !who.developmentContextId &&
            /\/events$/.test(path) &&
            url.searchParams.get("agent") === "1"
        )
            return json({ error: "an agent token is required for agent operations" }, 403);
        // Waiting for new notes is how an agent watches, and pages show it as one: not for an app's token.
        if (who?.kind === "token" && who.purpose === "app" && path === "/annotations/wait")
            return json({ error: "an agent token is required for agent operations" }, 403);
        if (
            managed &&
            origin &&
            origin !== (publicOrigin ?? new URL(req.url).origin) &&
            who?.kind === "token" &&
            who.purpose === "agent"
        )
            return json(
                {
                    error: "agent tokens cannot be used by cross-origin browser apps; use an app token",
                },
                403
            );
        if (who && who.kind !== "admin" && who.recoveryRequired && !recoveryAllowed(method, path))
            return json(
                {
                    error: "This workspace needs recovery. Restore payment or use the downgrade wizard to activate Free.",
                    code: "workspace_recovery_required",
                    workspaceId: who.workspaceId,
                },
                402
            );
        // However many addresses a credential uses, it holds only so many of the service's open streams.
        if (managed && who && staysOpen(method, path)) {
            const lease = guard.holdStream(credentialOf(who));
            if (lease instanceof Response) return lease;
            held = lease;
        }
        const finishAudit = await auditAttempt(accounts, req, who, path, method);
        // A route's refusal is thrown; answered here, the attempt it refused is recorded with it, not left unfinished.
        let answer: Response;
        try {
            answer = await next();
        } catch (error) {
            const refused = refusal(error);
            if (!refused) throw error;
            answer = refused;
        }
        const response = await finishAudit(answer);
        return held ? limitedResponse(response, held.release) : response;
    } catch (error) {
        held?.release();
        const refused = refusal(error);
        if (refused) return refused;
        throw error;
    }
}

/** The answer to a refusal thrown on the way, as the server gives it; null for anything unexpected. */
function refusal(error: unknown): Response | null {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    if (error instanceof UnknownProjectError) return json({ error: error.message }, 404);
    if (error instanceof DataControlError) return json({ error: error.message }, error.status);
    if (error instanceof QuotaError) return json({ error: error.message }, 429);
    if (error instanceof WorkspaceOwnershipError) return json({ error: error.message }, 409);
    return null;
}

/** Answers that stay open: event streams, the long poll, an agent's relay request, and MCP's streams and calls. */
function staysOpen(method: string, path: string): boolean {
    // As the routes will see it: a trailing slash reaches the same stream.
    const route = path.replace(/\/+$/, "") || "/";
    return (
        path === "/mcp" ||
        (method === "GET" &&
            (route === "/annotations/wait" || /^\/projects\/[^/]+\/events$/.test(route))) ||
        (method === "POST" && route === "/relay/annotate")
    );
}

/** A credential as the activity log and the stream limits name it. */
function credentialOf(who: Principal): string {
    return who.kind === "token" ? `token:${who.tokenId}` : `${who.kind}:${who.username}`;
}
