import { z } from "zod";
import { RequestError } from "../backend.ts";
import {
    accessId,
    canReadSession,
    initializeProject,
    ownsProject,
    type ProjectAccess,
    projectAccess,
    ReviewSessions,
    reviewSessionView,
} from "../collaboration.ts";
import {
    assertAccess,
    assertAdmin,
    assertBoard,
    feedbackActorId,
    forReader,
    isAgentToken,
    json,
    noContent,
    notFound,
    type Routes,
    readJson,
} from "./common.ts";

const Id = z.string().regex(/^[\w.@:-]{1,200}$/);
const SessionBody = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(4000).optional(),
    visibility: z.enum(["personal", "shared"]).optional(),
    branch: z.string().trim().max(200).optional(),
    environment: z.string().trim().max(200).optional(),
});

export const collaborationRoutes: Routes = async ({ req, method, principal, match }, app) => {
    const records = app.backend.store.coordination;
    if (!records) return null;
    const actor = feedbackActorId(principal);
    const members = match(/^\/projects\/([^/]+)\/members(?:\/([^/]+))?$/);
    if (members) {
        const project = members[0]!;
        assertAccess(principal, project);
        if (!(await app.backend.store.getProject(project))) return notFound();
        const manager =
            principal.kind === "admin" ||
            Boolean(await app.options.collaborationCanManage?.(principal, project)) ||
            (await ownsProject(records, project, actor));
        if (method === "GET" && !members[1]) {
            const access = await projectAccess(records, project);
            const labels =
                (await app.options.projectMemberLabels?.(
                    principal,
                    project,
                    Object.keys(access?.members ?? {})
                )) ?? {};
            return json({ access, canManage: manager, labels });
        }
        if (!manager || principal.kind === "token")
            throw new RequestError("Project owner access required.", 403);
        assertBoard(req, "project members");
        await initializeProject(records, project, actor);
        if (method === "POST" && !members[1]) {
            const body = await readJson(
                req,
                z.object({
                    username: z.string().trim().min(1).max(200),
                    role: z.enum(["member", "admin"]).default("member"),
                })
            );
            const username = app.options.resolveProjectMember
                ? await app.options.resolveProjectMember(principal, project, body.username)
                : (await app.auth?.store.getUser(body.username))?.username;
            if (!username) throw new RequestError("Choose an existing collaborator account.", 400);
            const access = await records.change<ProjectAccess>(
                accessId(project),
                project,
                "project",
                (current) => {
                    if (!current) throw new RequestError("Project not found.", 404);
                    if (current.members[username] === "owner")
                        throw new RequestError("Transfer ownership to change the owner.", 409);
                    return {
                        ...current,
                        members: { ...current.members, [username]: body.role },
                        updatedAt: new Date().toISOString(),
                    };
                }
            );
            return json({ access });
        }
        if (method === "DELETE" && members[1]) {
            await records.change<ProjectAccess>(
                accessId(project),
                project,
                "project",
                (current) => {
                    if (!current) throw new RequestError("Project not found.", 404);
                    const username = members[1]!;
                    if (current.members[username] === "owner")
                        throw new RequestError(
                            "Transfer ownership before removing its owner.",
                            409
                        );
                    const next = { ...current.members };
                    delete next[username];
                    return { ...current, members: next, updatedAt: new Date().toISOString() };
                }
            );
            return noContent();
        }
    }

    const owner = match(/^\/projects\/([^/]+)\/owner$/);
    if (owner && method === "PATCH") {
        const project = owner[0]!;
        assertAccess(principal, project);
        assertBoard(req, "project ownership");
        if (
            principal.kind === "token" ||
            !(
                principal.kind === "admin" ||
                (await app.options.collaborationCanManage?.(principal, project)) ||
                (await ownsProject(records, project, actor))
            )
        )
            throw new RequestError("Project owner access required.", 403);
        const { username } = await readJson(
            req,
            z.object({ username: z.string().trim().min(1).max(200) })
        );
        const access = await records.change<ProjectAccess>(
            accessId(project),
            project,
            "project",
            (current) => {
                if (!current || !Object.hasOwn(current.members, username))
                    throw new RequestError("Add the new owner as a project member first.", 400);
                const members = { ...current.members };
                for (const name of Object.keys(members))
                    if (members[name] === "owner") members[name] = "admin";
                members[username] = "owner";
                return {
                    ...current,
                    owner: { kind: "user", id: username },
                    members,
                    updatedAt: new Date().toISOString(),
                };
            }
        );
        return json({ access });
    }
    const sessions = new ReviewSessions(records);
    const projectSessions = match(/^\/projects\/([^/]+)\/review-sessions$/);
    if (projectSessions) {
        const project = projectSessions[0]!;
        assertAccess(principal, project);
        if (!(await app.backend.store.getProject(project))) return notFound();
        if (method === "GET")
            return json({ items: (await sessions.list(project, actor)).map(reviewSessionView) });
        if (method === "POST") {
            if (isAgentToken(principal))
                throw new RequestError("Only people can start review sessions.", 403);
            const body = await readJson(req, SessionBody);
            return json({ session: await sessions.create(project, actor, body) }, 201);
        }
    }
    const one = match(/^\/review-sessions\/([^/]+)(?:\/(annotations|replies))?$/);
    if (one) {
        const session = await sessions.get(one[0]!);
        if (!session || !canReadSession(session, actor)) return notFound();
        assertAccess(principal, session.projectId);
        if (method === "GET") {
            const items = await app.backend.list(
                forReader(principal, {
                    projectId: session.projectId,
                    sessionId: session.id,
                    feedbackScope: "all",
                })
            );
            return json({ session: reviewSessionView(session), items });
        }
        if (method === "PATCH" && !one[1]) {
            if (isAgentToken(principal))
                throw new RequestError("Only the session creator can change its settings.", 403);
            const change = await readJson(
                req,
                SessionBody.partial().extend({ closed: z.boolean().optional() }).strict()
            );
            return json({
                session: reviewSessionView(await sessions.change(session.id, actor, change)),
            });
        }
        if (method === "POST" && one[1] === "replies") {
            const { body } = await readJson(
                req,
                z.object({ body: z.string().trim().min(1).max(8000) })
            );
            return json({
                session: reviewSessionView(
                    await sessions.reply(session.id, actor, body, {
                        kind: isAgentToken(principal) ? "agent" : "human",
                        name:
                            principal.kind === "token"
                                ? (principal.authorName ??
                                  (isAgentToken(principal) ? "Agent" : "Person"))
                                : principal.kind === "member"
                                  ? (principal.name ?? principal.username)
                                  : principal.username,
                    })
                ),
            });
        }
        if (method === "POST" && one[1] === "annotations") {
            if (session.createdBy !== actor || isAgentToken(principal))
                throw new RequestError("Only the session creator can group feedback.", 403);
            const { ids } = await readJson(req, z.object({ ids: z.array(Id).min(1).max(200) }));
            const items = await app.backend.list(
                forReader(principal, { projectId: session.projectId })
            );
            const selected = items.filter((item) => ids.includes(item.annotation.id));
            if (selected.length !== new Set(ids).size) return notFound();
            await sessions.group(
                session.id,
                actor,
                selected.map((item) => item.annotation.id)
            );
            return json({ session: reviewSessionView(session), added: selected.length });
        }
    }
    if (match(/^\/admin\/users$/)) {
        assertAdmin(principal);
        if (!app.auth?.store.listUsers) return notFound();
        if (method === "GET") return json({ items: await app.auth.store.listUsers() });
        if (method === "POST") {
            assertBoard(req, "local user accounts");
            const body = await readJson(
                req,
                z.object({
                    username: z
                        .string()
                        .trim()
                        .regex(/^[\w.@-]{1,100}$/),
                    password: z.string().min(12).max(200),
                })
            );
            if (await app.auth.store.getUser(body.username))
                throw new RequestError("This account already exists.", 409);
            await app.auth.store.upsertUser({
                username: body.username,
                passwordHash: await Bun.password.hash(body.password),
                createdAt: new Date().toISOString(),
                isAdmin: false,
            });
            return json({ username: body.username }, 201);
        }
    }
    return null;
};
