import {
    assertAdmin,
    assertBoard,
    json,
    noContent,
    notFound,
    PROJECT_ID,
    readJson,
} from "@notato/server";
import { z } from "zod";
import type { CloudRoutes } from "../context.ts";

const WorkspaceBody = z
    .object({
        id: z.string().regex(PROJECT_ID),
        name: z.string().trim().min(1).max(200),
        owner: z.string().trim().min(1).max(200),
    })
    .strict();

const NameBody = z.object({ name: z.string().trim().min(1).max(200) }).strict();
const MemberBody = z.object({ role: z.enum(["owner", "admin", "member"]) }).strict();

/** Operator provisioning. Workspace members cannot use these server-wide administration routes. */
export const workspaceRoutes: CloudRoutes = async (
    { req, path, method, principal, match },
    { auth, backend }
) => {
    if (!auth || !/^\/admin\/workspaces(?:\/|$)/.test(path)) return null;
    assertAdmin(principal);
    if (method !== "GET") assertBoard(req, "workspaces");
    const store = auth.store;

    if (path === "/admin/workspaces") {
        if (method === "GET") return json({ items: await store.listWorkspaces() });
        if (method === "POST") {
            const { id, name, owner } = await readJson(req, WorkspaceBody);
            if (!(await store.getUser(owner)))
                return json({ error: "owner account not found" }, 404);
            const workspace = { id, name, createdAt: new Date().toISOString() };
            if (!(await store.createWorkspace(workspace, owner)))
                return json({ error: "a workspace with this id already exists" }, 409);
            return json(workspace, 201);
        }
    }

    const one = match(/^\/admin\/workspaces\/([^/]+)$/);
    if (one) {
        const id = one[0] ?? "";
        const workspace = await store.getWorkspace(id);
        if (!workspace) return notFound();
        if (method === "GET")
            return json({
                workspace,
                members: await store.listWorkspaceMembers(id),
                projects: await backend.store.listProjects(id),
            });
        if (method === "PATCH") {
            const { name } = await readJson(req, NameBody);
            return json(await store.renameWorkspace(id, name));
        }
    }

    const member = match(/^\/admin\/workspaces\/([^/]+)\/members\/([^/]+)$/);
    if (member) {
        const workspaceId = member[0] ?? "";
        const username = member[1] ?? "";
        if (!(await store.getWorkspace(workspaceId))) return notFound();
        if (method === "PUT") {
            const { role } = await readJson(req, MemberBody);
            if (!(await store.getUser(username)))
                return json({ error: "member account not found" }, 404);
            await store.setMembership({
                workspaceId,
                username,
                role,
                createdAt: new Date().toISOString(),
            });
            return json(await store.getMembership(workspaceId, username));
        }
        if (method === "DELETE")
            return (await store.removeMembership(workspaceId, username)) ? noContent() : notFound();
    }
    return null;
};
