import {
    assertAccess,
    assertAdmin,
    assertBoard,
    type IssuedToken,
    isSecure,
    json,
    noContent,
    notFound,
    shownToken as openShownToken,
    PROJECT_ID,
    RequestError,
    readJson,
    type TokenRules,
    tokenPurpose,
} from "@notato/server";
import { z } from "zod";
import { type Authenticator, canAccessProject, type Principal } from "../auth.ts";
import { betaAdmin, invitationCookie } from "../beta.ts";
import { assertProjectManager, type CloudOptions, type CloudRoutes } from "../context.ts";
import { clientAddress } from "../hosted-guard.ts";
import type { TokenRecord } from "../storage.ts";

const TokenBody = z
    .object({
        projectId: z.union([z.literal("*"), z.string().regex(PROJECT_ID)]),
        name: z.string().trim().min(1).max(100),
        workspaceId: z.string().regex(PROJECT_ID).optional(),
        permission: z.enum(["capture", "full"]).optional(),
        purpose: z.enum(["app", "agent"]).optional(),
        expiresInDays: z.number().int().min(1).max(365).optional(),
        ownership: z.enum(["user", "service", "project"]).optional(),
    })
    .strict();

const AccountBody = z
    .object({
        username: z.string().trim().min(1).max(200),
        password: z.string().min(12).max(256),
    })
    .strict();

/** A token record as it is shown: the open server's, without the identity provider it was issued under either. */
export const shownToken = ({ identityNamespace: _namespace, ...record }: TokenRecord) =>
    openShownToken(record);

/** Personal keys are private to their owner; project/service credentials are managed by workspace managers. */
function visibleToken(principal: Principal, token: TokenRecord): boolean {
    if (principal.kind === "admin") return true;
    if (principal.kind !== "member" || token.workspaceId !== principal.workspaceId) return false;
    const ownership =
        token.ownership ??
        (tokenPurpose(token) === "agent" ? "project" : token.createdBy ? "user" : "service");
    if (ownership === "user")
        return (token.ownerUsername ?? token.createdBy) === principal.username;
    return principal.role !== "member" && canAccessProject(principal, token.projectId);
}

function assertTokenAccount(principal: Principal | null) {
    if (
        !principal ||
        principal.kind === "token" ||
        (principal.kind === "member" && principal.locked)
    )
        throw new RequestError("account sign-in required", 403);
}

/**
 * `/tokens` on the hosted service: members hold tokens of their own and, as a workspace's owner or admin, its
 * projects' and services'; each sees and revokes only those. Every new token belongs to a person, a service or a
 * project in the caller's workspace.
 */
export function hostedTokenRules(accounts: Authenticator): TokenRules {
    return {
        assertManager: assertTokenAccount,
        visible: visibleToken,
        shown: shownToken,
        issue: async (principal: Principal, req: Request): Promise<IssuedToken> => {
            const body = await readJson(req, TokenBody);
            const purpose = body.purpose ?? (body.permission === "full" ? "agent" : "app");
            const ownership =
                body.ownership ??
                (purpose === "agent"
                    ? "project"
                    : principal.kind === "member"
                      ? "user"
                      : "service");
            if (ownership !== "user") assertProjectManager(principal);
            const compatibleOwnership =
                purpose === "agent"
                    ? ownership === "project" || ownership === "user"
                    : ownership === "user" || ownership === "service";
            if (!compatibleOwnership)
                throw new RequestError(
                    "agent tokens belong to a user or project; app tokens belong to a user or service",
                    400
                );
            if (body.projectId === "*" && (accounts.managed || ownership === "project"))
                throw new RequestError("select one project for this token", 400);
            if (ownership === "user" && principal.kind !== "member")
                throw new RequestError(
                    "sign in with your workspace account for a personal token",
                    403
                );
            if (
                accounts.managed &&
                principal.kind === "admin" &&
                (body.permission === "full" || body.purpose === "agent" || body.projectId === "*")
            )
                throw new RequestError(
                    "sign in as the workspace owner or admin to issue private integration credentials",
                    403
                );
            assertAccess(principal, body.projectId);
            if (
                principal.kind === "member" &&
                body.workspaceId &&
                body.workspaceId !== principal.workspaceId
            )
                throw new RequestError("cannot create tokens in another workspace", 403);
            const workspaceId =
                principal.kind === "member" ? principal.workspaceId : body.workspaceId;
            if (workspaceId && !(await accounts.store.getWorkspace(workspaceId)))
                throw new RequestError("not found", 404);
            if (
                workspaceId &&
                body.projectId !== "*" &&
                (await accounts.store.getProject(body.projectId))?.workspaceId !== workspaceId
            )
                throw new RequestError("token workspace does not match its project", 403);
            if (body.permission === "capture" && body.projectId === "*")
                throw new RequestError("capture tokens must name one project", 400);
            return accounts.issueToken(body.projectId, body.name, {
                ...body,
                purpose,
                ownership,
                ...(ownership === "user" && principal.kind === "member"
                    ? { ownerUsername: principal.username }
                    : {}),
                workspaceId,
                createdBy: principal.kind === "member" ? principal.username : undefined,
            });
        },
    };
}

/**
 * What `/auth/me` adds on the hosted service: how its sign-in works, and who the caller is there (their workspaces
 * and role, an operator's identity setup, a token's purpose).
 */
export function aboutCaller(
    accounts: Authenticator,
    options: Pick<CloudOptions, "beta" | "emailPreferences" | "billing">
) {
    return async (principal: Principal | null): Promise<Record<string, unknown>> => ({
        accountDeletionAvailable:
            principal?.kind === "member" &&
            (principal as Principal & { instanceAdmin?: boolean }).instanceAdmin
                ? false
                : !accounts.managed || Boolean(accounts.managed.deleteUser),
        instanceAdmin: principal?.kind === "member" && principal.instanceAdmin === true,
        ...(principal?.kind === "member" &&
        principal.instanceAdmin &&
        principal.email &&
        (await accounts.managed?.bootstrapPasswordInUse?.(principal.email))
            ? { bootstrapPasswordInUse: true }
            : {}),
        billingEnabled: Boolean(options.billing),
        ...(accounts.managed ? { identity: accounts.managed.config } : {}),
        ...(options.beta ? { betaEnabled: true } : {}),
        ...(options.emailPreferences ? { emailPreferencesEnabled: true } : {}),
        isAdmin: principal?.kind === "admin",
        ...(principal?.kind === "member"
            ? {
                  username: principal.username,
                  name: principal.name ?? principal.username,
                  email: principal.email,
                  betaAdmin: Boolean(
                      options.beta &&
                          (principal.instanceAdmin || betaAdmin(options.beta, principal.email))
                  ),
                  ownedFreeWorkspace: await accounts.store.ownedFreeWorkspace(principal.username),
                  workspace: {
                      ...(await accounts.store.getWorkspace(principal.workspaceId)),
                      role: principal.role,
                      recoveryRequired: principal.recoveryRequired ?? false,
                      // Who this workspace is for: a person on their own, a team, or a guest of one project.
                      memberCount: (
                          await accounts.store.listWorkspaceMembers(principal.workspaceId)
                      ).length,
                      projectOnly: Boolean(
                          (
                              await accounts.store.getMembership(
                                  principal.workspaceId,
                                  principal.username
                              )
                          )?.projectOnly
                      ),
                  },
                  workspaces: await Promise.all(
                      (await accounts.store.listMemberships(principal.username)).map(
                          async (membership) => ({
                              ...(await accounts.store.getWorkspace(membership.workspaceId)),
                              role: membership.role,
                          })
                      )
                  ),
              }
            : {}),
        ...(principal?.kind === "token"
            ? {
                  tokenPurpose: tokenPurpose(principal),
                  captureOnly: principal.permission === "capture",
              }
            : {}),
    });
}

/**
 * What the hosted service adds to signing in and out: sign-in through the identity provider, choosing a workspace,
 * the devices signed in, and accounts an operator provisions. Password sign-in, sign-out, `/auth/me` and `/tokens`
 * are the open server's, with the rules above.
 */
export const accountRoutes: CloudRoutes<Principal | null> = async (
    { req, path, method, principal, info, match },
    { auth, options }
) => {
    if (!auth) return null;

    if (path === "/auth/session" && method === "POST") {
        assertBoard(req, "sign-in");
        const { accessToken, revokeOtherSessions } = await readJson(
            req,
            z
                .object({
                    accessToken: z.string().min(1).max(16000),
                    revokeOtherSessions: z.boolean().default(false),
                })
                .strict()
        );
        const result = await auth.managedLogin(
            accessToken,
            req,
            clientAddress(info.ip ?? "unknown"),
            isSecure(req, options.trustProxy),
            revokeOtherSessions
        );
        if (!result.ok)
            return json(
                { error: result.error },
                result.status,
                result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {}
            );
        const response = json({ ok: true }, 200, { "Set-Cookie": result.cookie });
        if (options.beta)
            response.headers.append(
                "Set-Cookie",
                invitationCookie("", isSecure(req, options.trustProxy), 0)
            );
        return response;
    }

    if (path === "/auth/workspace" && method === "POST") {
        assertBoard(req, "workspace selection");
        const { workspaceId } = await readJson(
            req,
            z.object({ workspaceId: z.string().regex(PROJECT_ID) }).strict()
        );
        if (principal?.kind !== "member" || !(await auth.selectWorkspace(req, workspaceId)))
            return json({ error: "workspace access required" }, 403);
        return json({ ok: true });
    }
    if (path === "/auth/sessions" && method === "GET") {
        if (!principal || principal.kind === "token")
            return json({ error: "account sign-in required" }, 403);
        const current = await auth.sessionId(req);
        return json({
            items: (await auth.store.listSessionsFor(principal.username))
                .filter((s) => s.expiresAt > new Date().toISOString())
                .map((s) => ({
                    id: s.id,
                    createdAt: s.createdAt,
                    expiresAt: s.expiresAt,
                    current: s.id === current,
                })),
        });
    }
    if (path === "/auth/sessions/revoke-others" && method === "POST") {
        assertBoard(req, "sessions");
        if (!principal || principal.kind === "token")
            return json({ error: "account sign-in required" }, 403);
        const id = await auth.sessionId(req);
        const current = id ? await auth.store.getSession(id) : null;
        await auth.revokeSessions(principal.username, id, current?.identitySessionId);
        return json({ ok: true });
    }
    const sessionOne = match(/^\/auth\/sessions\/([0-9a-f]{64})$/);
    if (sessionOne && method === "DELETE") {
        assertBoard(req, "sessions");
        if (!principal || principal.kind === "token")
            return json({ error: "account sign-in required" }, 403);
        return (await auth.revokeSession(principal.username, sessionOne[0] ?? ""))
            ? noContent()
            : notFound();
    }

    if (path === "/admin/users" && method === "POST") {
        assertAdmin(principal);
        assertBoard(req, "accounts");
        const { username, password } = await readJson(req, AccountBody);
        if (!(await auth.createAccount(username, password)))
            return json({ error: "an account with this username already exists" }, 409);
        const user = await auth.store.getUser(username);
        return json({ username, createdAt: user?.createdAt, isAdmin: false }, 201);
    }
    return null;
};
