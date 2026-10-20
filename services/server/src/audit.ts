import { SETTINGS, sha256Hex } from "@notato/server";
import { type Authenticator, canAccessProject, type Principal } from "./auth.ts";
import type { AuditRecord } from "./storage.ts";

/** The words the routes are made of. Any other part of a path is an id, a name or a secret. */
const ROUTE_WORDS = new Set([
    ...Object.keys(SETTINGS),
    ...[
        "accept",
        "account",
        "admin",
        "annotate",
        "annotations",
        "assets",
        "audit",
        "auth",
        "beta",
        "billing",
        "bundles",
        "checkout",
        "choose",
        "cleanup",
        "complete",
        "config",
        "connection",
        "delete-workspace",
        "events",
        "export",
        "free",
        "handed",
        "invitation",
        "invitations",
        "invite",
        "links",
        "login",
        "logout",
        "markdown",
        "me",
        "members",
        "origins",
        "plan",
        "policy",
        "portal",
        "preview",
        "projects",
        "read",
        "recovery",
        "relay",
        "replies",
        "requests",
        "result",
        "revoke",
        "revoke-others",
        "screenshot",
        "session",
        "sessions",
        "settings",
        "setup",
        "subscription",
        "sync",
        "test",
        "tokens",
        "users",
        "variants",
        "verify",
        "wait",
        "waitlist",
        "webhook",
        "webhooks",
        "workspace",
        "workspaces",
    ],
]);

/**
 * A path as the route it reaches, `/projects/:id/origins`: never what the caller typed, so a record holds no ids,
 * names or secrets, and no text written to mislead whoever reads the log.
 */
export function auditRoute(path: string): string {
    const parts = path.split("/").slice(1);
    const shown = parts.slice(0, 6).map((part) => (!part || ROUTE_WORDS.has(part) ? part : ":id"));
    return `/${shown.join("/")}${parts.length > 6 ? "/…" : ""}`;
}

/** The project a path names, or undefined (malformed percent-encoding included: the route answers that with a 400). */
function projectIn(path: string): string | undefined {
    const part = /^\/projects\/([^/]+)/.exec(path)?.[1];
    if (part === undefined) return undefined;
    try {
        return decodeURIComponent(part);
    } catch {
        return undefined;
    }
}

/** Record management attempts before mutation. Never store request bodies, queries or credentials. */
export async function auditAttempt(
    auth: Authenticator | undefined,
    req: Request,
    principal: Principal | null,
    path: string,
    method: string
) {
    if (
        !auth?.managed ||
        ["GET", "HEAD", "OPTIONS"].includes(method) ||
        (principal?.kind === "token" && principal.permission === "capture")
    )
        return async (response: Response) => response;
    const action = `${method} ${auditRoute(path)}`;
    // An attempt is filed with the workspace it was aimed at only when the caller may act there. Anyone else's goes in
    // their own log, written before the route refuses it: nobody can fill (and so flush) another workspace's records.
    let targetWorkspace: string | undefined;
    const invite = /^\/invitations\/([^/]+)\/accept$/.exec(path)?.[1];
    if (invite && principal?.kind === "member") {
        const invitation = await auth.store.getInvitation(
            await sha256Hex(new TextEncoder().encode(invite))
        );
        if (
            invitation &&
            !invitation.acceptedAt &&
            !invitation.revokedAt &&
            invitation.expiresAt > new Date().toISOString() &&
            invitation.email === principal.email
        )
            targetWorkspace = invitation.workspaceId;
    }
    const project = projectIn(path);
    if (project && principal && canAccessProject(principal, project))
        targetWorkspace = (await auth.store.getProject(project))?.workspaceId;
    const recordFor = (who: Principal): AuditRecord => ({
        id: crypto.randomUUID(),
        workspaceId:
            targetWorkspace ??
            (who.kind === "admin" ? "__service" : (who.workspaceId ?? "__service")),
        actor: who.kind === "token" ? `token:${who.tokenId}` : `${who.kind}:${who.username}`,
        action,
        outcome: 0,
        createdAt: new Date().toISOString(),
    });
    let record = principal ? recordFor(principal) : undefined;
    if (record) await auth.store.appendAudit(record);
    return async (response: Response) => {
        if (!record && response.ok && response.headers.has("set-cookie")) {
            const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
            const who = await auth.identify(
                new Request(req.url, { headers: { cookie } }),
                new URL(req.url)
            );
            if (who) record = recordFor(who);
        }
        if (record) await auth.store.appendAudit({ ...record, outcome: response.status });
        return response;
    };
}
