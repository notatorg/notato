import {
    accessibleProjectSummary,
    assertAccess,
    assertBoard,
    checkBody,
    generateSecret,
    json,
    type NewProject,
    notFound,
    ownsProject,
    PROJECT_ID,
    type ProjectRequest,
    type ProjectRules,
    projectIdFrom,
    RequestError,
    readJson,
    sha256Hex,
} from "@notato/server";
import { ulid } from "ulid";
import { z } from "zod";
import type { HostedTokenOptions, Principal } from "../auth.ts";
import { assertProjectManager, type CloudRoutes } from "../context.ts";
import { DEFAULT_WORKSPACE_ID, type Store } from "../storage.ts";

/** What `POST /projects` may say on the hosted service, beyond the open server's `id`, `name` and `agent`. */
const HostedProjectBody = z.object({
    workspaceId: z.string().regex(PROJECT_ID).optional(),
    tokenPermission: z.enum(["capture", "full"]).optional(),
});

const Origin = z
    .string()
    .max(300)
    .transform((value, ctx) => {
        try {
            const url = new URL(value.trim());
            if (url.username || url.password || url.search || url.hash) throw new Error();
            if (["http:", "https:"].includes(url.protocol) && url.pathname === "/")
                return url.origin;
            if (
                url.protocol === "chrome-extension:" &&
                /^[a-p]{32}$/.test(url.hostname) &&
                !url.port &&
                ["", "/"].includes(url.pathname)
            )
                return `chrome-extension://${url.hostname}`;
            throw new Error();
        } catch {
            ctx.addIssue({
                code: "custom",
                message:
                    "use an HTTP(S) origin or chrome-extension:// followed by a 32-character extension ID, without a path or wildcard",
            });
            return z.NEVER;
        }
    });

/** A project with its counts, as the list shows it; null when there is none with that id. */
const summaryOf = async (store: Store, projectId: string, username?: string) =>
    (await store.listProjects(undefined, username)).find((p) => p.id === projectId) ?? null;

/**
 * `/projects` on the hosted service: a workspace's owners and admins manage its projects; the list is the caller's
 * workspace, with what each signed-in person has read; and a new project belongs to the caller's workspace, with an
 * id the service makes for a customer and a first token that belongs to the project.
 */
export function hostedProjectRules(store: Store, managed: boolean): ProjectRules {
    return {
        assertManager: async (principal: Principal, projectId?: string) => {
            if (principal.kind === "admin") return;
            if (!projectId) return assertProjectManager(principal);
            if (
                principal.kind === "member" &&
                (principal.role !== "member" ||
                    (await ownsProject(store.coordination!, projectId, principal.username)))
            )
                return;
            throw new RequestError("Project owner access required.", 403);
        },
        list: (principal: Principal) =>
            store.listProjects(
                principal.kind === "member" ? principal.workspaceId : undefined,
                principal.kind === "admin" || principal.kind === "member"
                    ? principal.username
                    : undefined
            ),
        create: async (principal: Principal, body: ProjectRequest): Promise<NewProject> => {
            const asked = checkBody(body, HostedProjectBody);
            // Project ids are unique across the service, so on a hosted one a customer's are always the server's own:
            // an id they chose could be refused for being another workspace's (telling them it exists), or taken first.
            const id = principal.kind === "member" && managed ? `project_${ulid()}` : body.id;
            if (!id) throw new RequestError("project id is required");
            let workspaceId = asked.workspaceId;
            if (principal.kind === "member") {
                if (workspaceId && workspaceId !== principal.workspaceId)
                    throw new RequestError("cannot create projects in another workspace", 403);
                workspaceId = principal.workspaceId;
            }
            if (workspaceId && !(await store.getWorkspace(workspaceId)))
                throw new RequestError("not found", 404);
            const createdBy =
                principal.kind === "admin" || principal.kind === "member"
                    ? principal.username
                    : undefined;
            const appToken: HostedTokenOptions = {
                permission: asked.tokenPermission,
                ...(managed
                    ? {
                          purpose: "app" as const,
                          ownership:
                              principal.kind === "member"
                                  ? ("user" as const)
                                  : ("service" as const),
                          ...(principal.kind === "member"
                              ? { ownerUsername: principal.username }
                              : {}),
                      }
                    : {}),
                expiresInDays: asked.tokenPermission === "capture" ? 90 : undefined,
                ...(createdBy ? { createdBy } : {}),
            };
            return {
                id,
                fields: { workspaceId: workspaceId ?? DEFAULT_WORKSPACE_ID },
                appToken,
                agentToken: createdBy
                    ? {
                          createdBy,
                          ...(managed && principal.kind === "member"
                              ? { ownership: "user" as const, ownerUsername: principal.username }
                              : {}),
                      }
                    : {},
            };
        },
    };
}

/** What only a hosted project has: each person's read state, and the sites that may call its API from a browser. */
export const projectRoutes: CloudRoutes = async ({ req, method, principal, match }, app) => {
    const { backend, auth } = app;

    const invitation = match(/^\/projects\/([^/]+)\/invitations$/);
    if (invitation) {
        const project = invitation[0]!;
        assertAccess(principal, project);
        if (principal.kind !== "member") throw new RequestError("Workspace sign-in required.", 403);
        const allowed =
            principal.role !== "member" ||
            (await ownsProject(backend.store.coordination!, project, principal.username));
        if (!allowed) throw new RequestError("Project owner access required.", 403);
        if (method === "GET")
            return json({
                items: (await auth.store.listInvitations(principal.workspaceId))
                    .filter((item) => item.projectId === project)
                    .map(({ tokenHash: _hash, ...item }) => item),
            });
        if (method === "POST") {
            assertBoard(req, "project invitations");
            if (!auth.managed)
                throw new RequestError(
                    "Verified email sign-in is required for email invitations. Add an existing account in Project members.",
                    403
                );
            const { email } = await readJson(
                req,
                z
                    .object({
                        email: z
                            .email()
                            .max(254)
                            .transform((value) => value.toLowerCase()),
                    })
                    .strict()
            );
            const secret = generateSecret("ntinv_");
            const now = new Date();
            await auth.store.createInvitation({
                id: ulid(),
                workspaceId: principal.workspaceId,
                projectId: project,
                email,
                role: "member",
                tokenHash: await sha256Hex(new TextEncoder().encode(secret)),
                createdBy: principal.username,
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + 7 * 86400_000).toISOString(),
            });
            const url = new URL("/", process.env.NOTATO_PUBLIC_URL ?? new URL(req.url).origin);
            url.searchParams.set("invite", secret);
            return json({ url: url.toString() }, 201);
        }
    }
    const transfer = match(/^\/projects\/([^/]+)\/transfer$/);
    if (transfer && method === "POST") {
        const project = transfer[0]!;
        assertAccess(principal, project);
        assertBoard(req, "project transfer");
        if (principal.kind !== "member" || !backend.store.transferProject)
            throw new RequestError("Workspace account required.", 403);
        const { workspaceId } = await readJson(
            req,
            z.object({ workspaceId: z.string().regex(PROJECT_ID) }).strict()
        );
        if (await backend.store.betaWorkspaceBlocked(workspaceId))
            throw new RequestError("The destination workspace is unavailable.", 403);
        return json({
            project: await backend.store.transferProject(project, workspaceId, principal.username),
        });
    }
    const read = match(/^\/projects\/([^/]+)\/read$/);
    if (read && method === "PUT") {
        if (!auth || (principal.kind !== "admin" && principal.kind !== "member"))
            throw new RequestError("a signed-in account is required to save read state", 403);
        assertBoard(req, "read state");
        const id = projectIdFrom(read[0]);
        assertAccess(principal, id);
        const base = await summaryOf(backend.store, id, principal.username);
        const project = await accessibleProjectSummary(backend, principal, id, base ?? undefined);
        if (!project) return notFound();
        const body = await readJson(req, z.object({ at: z.string().datetime() }).strict());
        const at = new Date(body.at).toISOString();
        if (Date.parse(at) > Date.parse(project.lastActivityAt))
            throw new RequestError("read state must use an activity time reported by this project");
        await backend.store.markProjectRead(id, principal.username, at);
        return json(
            await accessibleProjectSummary(
                backend,
                principal,
                id,
                (await summaryOf(backend.store, id, principal.username)) ?? undefined
            )
        );
    }

    const origins = match(/^\/projects\/([^/]+)\/origins$/);
    if (origins) {
        const id = projectIdFrom(origins[0]);
        assertAccess(principal, id);
        assertProjectManager(principal);
        if (!(await backend.store.getProject(id))) return notFound();
        if (method === "GET") return json({ origins: await backend.store.getProjectOrigins(id) });
        if (method === "PUT") {
            assertBoard(req, "allowed browser origins");
            const { origins: allowed } = await readJson(
                req,
                z.object({ origins: z.array(Origin).max(50) }).strict()
            );
            await backend.store.setProjectOrigins(id, [...new Set(allowed)]);
            return json({ origins: await backend.store.getProjectOrigins(id) });
        }
    }
    return null;
};
