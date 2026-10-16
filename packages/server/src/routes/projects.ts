import { z } from "zod";
import { canAccessProject, type Principal, UnknownProjectError } from "../auth.ts";
import type { LocalBackend } from "../backend.ts";
import type { NewProject, ProjectRequest, ProjectRules } from "../http.ts";
import { PROJECT_ID, tokenPurpose } from "../storage.ts";
import {
    assertAccess,
    assertAdmin,
    assertBoard,
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

/** A project with its counts, as the list shows it; null when there is none with that id. */
const summaryOf = async (backend: LocalBackend, projectId: string) =>
    (await backend.store.listProjects()).find((p) => p.id === projectId) ?? null;

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
    const assertManager = (who: Principal) =>
        rules?.assertManager ? rules.assertManager(who) : assertAdmin(who);

    if (path === "/projects" && method === "GET") {
        const listed = rules?.list
            ? await rules.list(principal)
            : await backend.store.listProjects();
        return json({ items: listed.filter((p) => canAccessProject(principal, p.id)) });
    }
    if (path === "/projects" && method === "POST") {
        assertManager(principal);
        assertBoard(req, "projects");
        const { body, made } = await newProject(req, principal, rules);
        const created = await backend.createProject(made.id, body.name, made.fields);
        if (!created) return json({ error: `a project with id "${made.id}" already exists` }, 409);
        const project = await summaryOf(backend, created.id);
        // Apps on a server with logins need a token to send notes, so the first one comes with the project.
        if (!auth) return json({ project }, 201);
        const { token, record } = await auth.issueToken(
            created.id,
            `${created.name} app`,
            made.appToken
        );
        const agent = body.agent
            ? await auth.issueToken(created.id, `${created.name} agent`, {
                  ...made.agentToken,
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
        const project = await summaryOf(backend, projectId);
        return project ? json(project) : notFound();
    }
    if (method === "PATCH") {
        assertManager(principal);
        assertBoard(req, "projects");
        const { name } = await readJson(req, RenameBody);
        return (await backend.renameProject(projectId, name))
            ? json(await summaryOf(backend, projectId))
            : notFound();
    }
    if (method === "DELETE") {
        assertManager(principal);
        assertBoard(req, "projects");
        if (!(await backend.deleteProject(projectId))) return notFound();
        await auth?.store.revokeProjectTokens(projectId, new Date().toISOString());
        return noContent();
    }
    return null;
};
