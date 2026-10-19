import type { Status } from "@notato/schema";
import { z } from "zod";
import { canAccessProject, type Principal, UnknownProjectError } from "../auth.ts";
import type { LocalBackend } from "../backend.ts";
import { RequestError } from "../backend.ts";
import { initializeProject, ownsProject } from "../collaboration.ts";
import type { NewProject, ProjectRequest, ProjectRules } from "../http.ts";
import { PROJECT_ID, type ProjectSummary, tokenPurpose } from "../storage.ts";
import {
    assertAccess,
    assertAdmin,
    assertBoard,
    feedbackActorId,
    forReader,
    json,
    noContent,
    notFound,
    projectIdFrom,
    type Routes,
    readJson,
    showToken,
} from "./common.ts";

const ProjectId = z
    .string()
    .regex(PROJECT_ID, "a project id is letters, digits and _ . @ - (not only dots)");

const ProjectBody = z.object({
    id: ProjectId,
    name: z.string().max(200).optional(),
    /** Also make a token for a coding agent, for this project only, so the agent can be connected at once. */
    agent: z.boolean().optional(),
});

/** The same, as `ProjectRules.create` reads it: the id may be the rules' to choose, and other fields theirs to read. */
const RuledProjectBody = z.looseObject({ ...ProjectBody.shape, id: ProjectId.optional() });

const RenameBody = z.object({ name: z.string().min(1).max(200) });

/** A probe carries nothing: a body, when there is one, is an empty JSON object, read within the usual limit. */
const EmptyBody = z.object({}).strict();

const WAITING = new Set<Status>([
    "open",
    "awaiting_response",
    "variant_chosen",
    "revert_requested",
]);

/** A project summary counts only feedback this person can read, so private notes do not leak through totals. */
export const accessibleProjectSummary = async (
    backend: LocalBackend,
    principal: Principal,
    projectId: string,
    known?: ProjectSummary
) => {
    const project = known ?? (await backend.store.listProjects()).find((p) => p.id === projectId);
    if (!project) return null;
    const items = await backend.list(forReader(principal, { projectId }));
    const statuses: Partial<Record<Status, number>> = {};
    let lastActivityAt = project.createdAt;
    for (const { annotation } of items) {
        statuses[annotation.status] = (statuses[annotation.status] ?? 0) + 1;
        for (const at of [
            annotation.createdAt,
            ...annotation.thread.map((reply) => reply.createdAt),
        ])
            if (Date.parse(at) > Date.parse(lastActivityAt)) lastActivityAt = at;
    }
    return {
        ...project,
        annotations: items.length,
        ...(project.readAt !== undefined || project.unread !== undefined
            ? {
                  unread: items.filter(
                      ({ annotation }) =>
                          !annotation.context.notatoDiagnostic &&
                          [
                              annotation.createdAt,
                              ...annotation.thread.map((reply) => reply.createdAt),
                          ].some((at) => at > (project.readAt ?? ""))
                  ).length,
              }
            : {}),
        open: Object.entries(statuses).reduce((count, [status, n]) => {
            return WAITING.has(status as Status) ? count + (n ?? 0) : count;
        }, 0),
        statuses,
        lastActivityAt,
    } satisfies ProjectSummary;
};

/** What a new project is asked for, and what it is made with: by the deployment's rules, or as asked. */
async function newProject(
    req: Request,
    principal: Principal,
    rules: ProjectRules | undefined
): Promise<{ body: ProjectRequest; made: NewProject }> {
    if (!rules?.create) {
        const body = await readJson(req, ProjectBody);
        return { body, made: { id: body.id } };
    }
    const body = await readJson(req, RuledProjectBody);
    return { body, made: await rules.create(principal, body) };
}

/**
 * The projects: anyone may list the ones their credential reaches, and an admin (or whoever the `projectRules` say)
 * creates, renames and deletes them, from the board only. On a server with logins, a new project comes with its first
 * token.
 */
export const projectRoutes: Routes = async ({ req, path, method, principal, match }, app) => {
    const { backend, auth, options } = app;
    const rules = options.projectRules;
    const summaryFor = async (id: string) =>
        accessibleProjectSummary(
            backend,
            principal,
            id,
            (await rules?.list?.(principal))?.find((project) => project.id === id)
        );
    const assertManager = async (who: Principal, projectId?: string) => {
        if (rules?.assertManager) return rules.assertManager(who, projectId);
        if (who.kind === "admin") return;
        if (
            who.kind === "member" &&
            (!projectId ||
                (backend.store.coordination &&
                    (await ownsProject(backend.store.coordination, projectId, who.username))))
        )
            return;
        throw new RequestError("Project owner access required.", 403);
    };

    if (path === "/projects" && method === "GET") {
        const listed = rules?.list
            ? await rules.list(principal)
            : await backend.store.listProjects();
        const accessible = listed.filter((p) => canAccessProject(principal, p.id));
        const visible = await Promise.all(
            accessible.map((project) =>
                accessibleProjectSummary(backend, principal, project.id, project)
            )
        );
        return json({ items: visible.filter((project) => project !== null) });
    }
    if (path === "/projects" && method === "POST") {
        await assertManager(principal);
        assertBoard(req, "projects");
        const { body, made } = await newProject(req, principal, rules);
        const created = await backend.createProject(made.id, body.name, made.fields);
        if (!created) return json({ error: `a project with id "${made.id}" already exists` }, 409);
        if (backend.store.coordination)
            await initializeProject(
                backend.store.coordination,
                created.id,
                feedbackActorId(principal)
            );
        const project = await summaryFor(created.id);
        // Apps on a server with logins need a token to send notes, so the first one comes with the project.
        if (!auth) return json({ project }, 201);
        const { token, record } = await auth.issueToken(created.id, `${created.name} app`, {
            ...made.appToken,
            createdBy: made.appToken?.createdBy ?? feedbackActorId(principal),
        });
        const agent = body.agent
            ? await auth.issueToken(created.id, `${created.name} agent`, {
                  ...made.agentToken,
                  createdBy: made.agentToken?.createdBy ?? feedbackActorId(principal),
                  purpose: "agent",
              })
            : undefined;
        return json(
            {
                project,
                token: { token, record: showToken(app, record) },
                ...(agent
                    ? { agentToken: { token: agent.token, record: showToken(app, agent.record) } }
                    : {}),
            },
            201
        );
    }

    // "Does this credential reach this project?", answered without storing or reading a note: what `notato doctor`
    // asks of a token that can only send.
    const connection = match(/^\/projects\/([^/]+)\/connection$/);
    if (connection && method === "POST") {
        const id = projectIdFrom(connection[0]);
        assertAccess(principal, id);
        if (req.body) await readJson(req, EmptyBody);
        if (!(await backend.store.getProject(id))) throw new UnknownProjectError(id);
        return json({
            ok: true,
            projectId: id,
            captureOnly: principal.kind === "token" && principal.permission === "capture",
            ...(principal.kind === "token" ? { tokenPurpose: tokenPurpose(principal) } : {}),
            // Whether a page should capture screenshots at all, as `/config` says.
            screenshots: backend.config().screenshots,
        });
    }

    const one = match(/^\/projects\/([^/]+)$/);
    if (!one) return null;
    const projectId = projectIdFrom(one[0]);
    assertAccess(principal, projectId);
    if (method === "GET") {
        const project = await summaryFor(projectId);
        return project ? json(project) : notFound();
    }
    if (method === "PATCH") {
        await assertManager(principal, projectId);
        assertBoard(req, "projects");
        const { name } = await readJson(req, RenameBody);
        return (await backend.renameProject(projectId, name))
            ? json(await summaryFor(projectId))
            : notFound();
    }
    if (method === "DELETE") {
        await assertManager(principal, projectId);
        assertBoard(req, "projects");
        if (!(await backend.deleteProject(projectId))) return notFound();
        await auth?.store.revokeProjectTokens(projectId, new Date().toISOString());
        return noContent();
    }
    return null;
};
