import {
    assertBoard,
    isSecure,
    json,
    noContent,
    notFound,
    RequestError,
    readJson,
} from "@notato/server";
import { z } from "zod";
import type { CloudRoutes } from "../context.ts";

/** Personal and company data controls never accept client-selected account or workspace IDs. */
export const lifecycleRoutes: CloudRoutes = async (
    { req, path, method, principal },
    { auth, backend, options }
) => {
    if (!auth || !["/workspace/policy", "/workspace", "/auth/account"].includes(path)) return null;
    if (path === "/workspace" && method !== "DELETE") return null;
    if (path === "/auth/account" && method !== "DELETE") return null;
    if (principal.kind !== "member") throw new RequestError("workspace sign-in required", 403);
    if (method !== "GET") assertBoard(req, "data controls");
    if (path === "/workspace/policy") {
        if (method === "GET")
            return json(await backend.store.getWorkspacePolicy(principal.workspaceId));
        if (method === "PUT") {
            const body = await readJson(
                req,
                z.object({ retentionDays: z.number().int().min(1).max(3650).nullable() }).strict()
            );
            return json(
                await backend.store.setWorkspacePolicy(
                    principal.workspaceId,
                    principal.username,
                    body.retentionDays
                )
            );
        }
    }
    if (path === "/workspace") {
        const { confirm, password, accessToken } = await readJson(
            req,
            z
                .object({
                    confirm: z.string().min(1).max(200),
                    password: z.string().max(1000).optional(),
                    accessToken: z.string().max(20_000).optional(),
                })
                .strict()
        );
        const workspace = await auth.store.getWorkspace(principal.workspaceId);
        if (!workspace) return notFound();
        if (workspace.name !== confirm)
            throw new RequestError("type the workspace name to confirm deletion");
        if (!(await auth.reauthenticate(principal, password, accessToken)))
            throw new RequestError(
                "verify your current password or sign in again before deleting this workspace",
                403
            );
        return (await backend.deleteWorkspace(workspace.id, principal.username))
            ? noContent()
            : notFound();
    }
    const account = await auth.store.getUser(principal.username);
    if (
        account?.identitySubject &&
        (await auth.managed?.isProtectedUser?.(account.identitySubject))
    )
        throw new RequestError("The instance administrator cannot be deleted", 403);
    const body = await readJson(
        req,
        z
            .object({
                confirm: z.string(),
                password: z.string().max(1000).optional(),
                accessToken: z.string().max(20_000).optional(),
                deletePrivateWorkspaces: z.boolean().default(false),
            })
            .strict()
    );
    if (body.confirm !== principal.username)
        throw new RequestError("confirm the current account to delete it");
    if (auth.managed && !auth.managed.deleteUser)
        throw new RequestError(
            "account deletion is not available yet; contact the service administrator",
            503
        );
    if (!(await auth.reauthenticate(principal, body.password, body.accessToken)))
        throw new RequestError(
            "verify your current password or sign in again before deleting your account",
            403
        );
    if (
        !(await backend.deleteAccount(
            principal.username,
            new Date().toISOString(),
            body.deletePrivateWorkspaces
        ))
    )
        return notFound();
    return json({ deleted: true, identityCleanupPending: Boolean(auth.managed) }, 202, {
        "Set-Cookie": await auth.logout(req, isSecure(req, options.trustProxy), false),
    });
};
