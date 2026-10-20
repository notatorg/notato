import {
    assertBoard,
    generateSecret,
    json,
    noContent,
    notFound,
    RequestError,
    readJson,
    sha256Hex,
} from "@notato/server";
import { ulid } from "ulid";
import { z } from "zod";
import type { Principal } from "../auth.ts";
import { assertProjectManager, type CloudRoutes } from "../context.ts";
import type { InvitationRecord } from "../storage.ts";

const Name = z.string().trim().min(1).max(200);
const Invite = z
    .object({
        email: z
            .email()
            .max(254)
            .transform((email) => email.toLowerCase()),
        role: z.enum(["owner", "admin", "member"]).default("member"),
    })
    .strict();
const shownInvite = ({ tokenHash: _hash, ...invite }: InvitationRecord) => invite;
const hash = (secret: string) => sha256Hex(new TextEncoder().encode(secret));

/** Workspace management uses the selected membership; no client-provided workspace or owner ids. */
export const teamRoutes: CloudRoutes<Principal | null> = async (
    { req, path, method, principal, match },
    { auth, options, backend }
) => {
    if (!auth) return null;
    const invited = match(/^\/invitations\/([^/]+)(?:\/accept)?$/);
    if (invited) {
        const secret = invited[0] ?? "";
        if (!/^ntinv_[\w-]{43}$/.test(secret)) return notFound();
        const tokenHash = await hash(secret);
        const invitation = await auth.store.getInvitation(tokenHash);
        if (
            !invitation ||
            invitation.acceptedAt ||
            invitation.revokedAt ||
            invitation.expiresAt <= new Date().toISOString()
        )
            return notFound();
        if (method === "GET" && !path.endsWith("/accept"))
            return json({
                workspace: await auth.store.getWorkspace(invitation.workspaceId),
                email: invitation.email,
                role: invitation.role,
                projectId: invitation.projectId,
                expiresAt: invitation.expiresAt,
            });
        if (method === "POST" && path.endsWith("/accept")) {
            assertBoard(req, "invitations");
            if (principal?.kind !== "member" || !principal.email)
                throw new RequestError("sign in with the invited email address", 403);
            const member = await auth.store.acceptInvitation(
                tokenHash,
                principal.username,
                new Date().toISOString()
            );
            if (!member)
                throw new RequestError(
                    "this invitation is unavailable or belongs to another email address",
                    403
                );
            await auth.selectWorkspace(req, member.workspaceId);
            return json({ workspaceId: member.workspaceId });
        }
        return null;
    }
    if (!/^\/(workspaces|workspace)(?:\/|$)/.test(path)) return null;
    if (principal?.kind !== "member") throw new RequestError("workspace sign-in required", 403);
    if (method !== "GET") assertBoard(req, "workspace management");
    if (path === "/workspaces" && method === "POST") {
        if (!auth.managed)
            throw new RequestError("self-service workspace creation is not configured", 403);
        const { name, plan, extraSeats } = await readJson(
            req,
            z
                .object({
                    name: Name,
                    plan: z.enum(["free", "plus", "pro", "team"]).optional(),
                    extraSeats: z.number().int().min(0).max(99).default(0),
                })
                .strict()
        );
        if (!options.testPlans && !options.workspacePlans && (plan || extraSeats))
            throw new RequestError("test plan selection is disabled", 403);
        if (options.workspacePlans && !options.billing && plan && plan !== "free")
            throw new RequestError(
                "Paid workspace creation is unavailable until billing is configured",
                409
            );
        const workspace = { id: `ws_${ulid()}`, name, createdAt: new Date().toISOString() };
        await auth.store.createWorkspace(
            workspace,
            principal.username,
            options.testPlans || options.workspacePlans
                ? { id: plan ?? "free", extraSeats }
                : undefined
        );
        await auth.selectWorkspace(req, workspace.id);
        return json(workspace, 201);
    }
    const workspaceId = principal.workspaceId;
    if (path === "/workspace/audit" && method === "GET") {
        assertProjectManager(principal);
        return json({ items: await auth.store.listAudit(workspaceId) });
    }
    if (path === "/workspace") {
        if (method === "GET") {
            const members = await Promise.all(
                (await auth.store.listWorkspaceMembers(workspaceId)).map(async (membership) => {
                    const user = await auth.store.getUser(membership.username);
                    return {
                        ...membership,
                        name: user?.displayName ?? membership.username,
                        email: user?.email,
                    };
                })
            );
            return json({
                workspace: await auth.store.getWorkspace(workspaceId),
                role: principal.role,
                members,
                private: Boolean(
                    (options.testPlans || options.workspacePlans) &&
                        ((await backend.store.getWorkspacePlan(workspaceId))?.id ?? "free") ===
                            "free"
                ),
            });
        }
        if (method === "PATCH") {
            assertProjectManager(principal);
            const { name } = await readJson(req, z.object({ name: Name }).strict());
            return json(await auth.store.renameWorkspace(workspaceId, name));
        }
    }
    const member = match(/^\/workspace\/members\/([^/]+)$/);
    if (member) {
        assertProjectManager(principal);
        const username = member[0] ?? "";
        const membership = await auth.store.getMembership(workspaceId, username);
        if (!membership) return notFound();
        if (principal.role !== "owner" && membership.role !== "member")
            throw new RequestError("only an owner can manage workspace admins and owners", 403);
        if (method === "PATCH") {
            const { role } = await readJson(
                req,
                z.object({ role: z.enum(["owner", "admin", "member"]) }).strict()
            );
            if (principal.role !== "owner" && role !== "member")
                throw new RequestError("only an owner can assign admin or owner roles", 403);
            await auth.store.setMembership({ ...membership, role });
            return json(await auth.store.getMembership(workspaceId, username));
        }
        if (method === "DELETE")
            return (await auth.store.removeMembership(workspaceId, username))
                ? noContent()
                : notFound();
    }
    if (path === "/workspace/invitations") {
        assertProjectManager(principal);
        if (method === "GET")
            return json({
                items: (await auth.store.listInvitations(workspaceId)).map(shownInvite),
            });
        if (method === "POST") {
            if (!auth.managed)
                throw new RequestError("verified email sign-in is required for invitations", 403);
            const { email, role } = await readJson(req, Invite);
            if (principal.role !== "owner" && role !== "member")
                throw new RequestError("only an owner can invite admins or owners", 403);
            const secret = generateSecret("ntinv_");
            const now = new Date();
            const invitation = {
                id: ulid(),
                workspaceId,
                email,
                role,
                tokenHash: await hash(secret),
                createdBy: principal.username,
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + 7 * 86400_000).toISOString(),
            };
            await auth.store.createInvitation(invitation);
            const publicUrl = process.env.NOTATO_PUBLIC_URL ?? new URL(req.url).origin;
            const url = new URL("/", publicUrl);
            url.searchParams.set("invite", secret);
            return json({ invitation: shownInvite(invitation), url: url.toString() }, 201);
        }
    }
    const revoke = match(/^\/workspace\/invitations\/([^/]+)$/);
    if (revoke && method === "DELETE") {
        assertProjectManager(principal);
        return (await auth.store.revokeInvitation(
            workspaceId,
            revoke[0] ?? "",
            new Date().toISOString()
        ))
            ? noContent()
            : notFound();
    }
    return null;
};
