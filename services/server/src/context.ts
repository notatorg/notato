import { type AppContext, type AppOptions, RequestError, type RouteRequest } from "@notato/server";
import { type Authenticator, canManageProjects, type Principal } from "./auth.ts";
import type { CloudBackend } from "./backend.ts";
import type { BetaPolicy } from "./beta.ts";
import type { StripeBilling } from "./billing.ts";
import type { EmailPreferenceOptions } from "./email-preferences.ts";
import type { Metrics } from "./metrics.ts";
import type { RemoteWaitlist } from "./remote-waitlist.ts";
import type { HostedLimits } from "./storage.ts";

/** What Notato Cloud's deployment settings add to the server's own options. */
export interface CloudOptions {
    plugins?: import("./plugins/service.ts").PluginOptions;
    billing?: StripeBilling;
    beta?: BetaPolicy;
    remoteWaitlist?: RemoteWaitlist;
    testPlans?: boolean;
    /** Set once an operator has configured the marketing-email key: without it the choice is not offered. */
    emailPreferences?: EmailPreferenceOptions;
    /** The GitHub App's webhook secret. Without it `/github/webhook` is off and PR status stays manual. */
    githubWebhookSecret?: string;
    workspacePlans?: boolean;
    monitoringToken?: string;
    metrics?: Metrics;
    workspaceLimits?: HostedLimits;
    /** The service's public HTTPS origin, for cookies, redirects and browser request checks. */
    publicOrigin?: string;
}

/** What a cloud route is handed: the server's context, with its backend, accounts and options as the cloud's own. */
export interface CloudApp extends Omit<AppContext, "backend" | "auth" | "options"> {
    backend: CloudBackend;
    auth: Authenticator;
    options: AppOptions & CloudOptions;
    metrics?: Metrics;
}

export type CloudRoutes<P extends Principal | null = Principal> = (
    route: RouteRequest<P>,
    app: CloudApp
) => Promise<Response | null>;

/** Throws 403 unless the credential may manage a workspace's projects: an owner or admin, or the operator. */
export function assertProjectManager(principal: Principal | null): void {
    if (!principal || !canManageProjects(principal))
        throw new RequestError("workspace owner or admin required", 403);
}
