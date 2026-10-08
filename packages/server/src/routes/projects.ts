import { z } from "zod";
import { canAccessProject } from "../auth.ts";
import type { LocalBackend } from "../backend.ts";
import { PROJECT_ID } from "../storage.ts";
import { shownToken } from "./account.ts";
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
} from "./common.ts";

const ProjectBody = z.object({
    id: z.string().regex(PROJECT_ID, "a project id is letters, digits and _ . @ - (not only dots)"),
    name: z.string().max(200).optional(),
});

const RenameBody = z.object({ name: z.string().min(1).max(200) });

/** A project with its counts, as the list shows it; null when there is none with that id. */
const summaryOf = async (backend: LocalBackend, projectId: string) =>
    (await backend.store.listProjects()).find((p) => p.id === projectId) ?? null;

/**
 * The projects: anyone may list the ones their credential reaches, and an admin creates, renames and deletes them,
 * from the board only. On a server with logins, a new project comes with its first token.
 */
export const projectRoutes: Routes = async ({ req, path, method, principal, match }, app) => {
    const { backend, auth } = app;

    if (path === "/projects" && method === "GET") {
        return json({
            items: (await backend.store.listProjects()).filter((p) =>
                canAccessProject(principal, p.id)
            ),
        });
    }
    if (path === "/projects" && method === "POST") {
        assertAdmin(principal);
        assertBoard(req, "projects");
        const body = await readJson(req, ProjectBody);
        const created = await backend.createProject(body.id, body.name);
        if (!created) return json({ error: `a project with id "${body.id}" already exists` }, 409);
        const project = await summaryOf(backend, created.id);
        // Apps on a server with logins need a token to send notes, so the first one comes with the project.
        if (!auth) return json({ project }, 201);
        const { token, record } = await auth.issueToken(created.id, `${created.name} app`);
        return json({ project, token: { token, record: shownToken(record) } }, 201);
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
        assertAdmin(principal);
        assertBoard(req, "projects");
        const { name } = await readJson(req, RenameBody);
        return (await backend.renameProject(projectId, name))
            ? json(await summaryOf(backend, projectId))
            : notFound();
    }
    if (method === "DELETE") {
        assertAdmin(principal);
        assertBoard(req, "projects");
        if (!(await backend.deleteProject(projectId))) return notFound();
        await auth?.store.revokeProjectTokens(projectId, new Date().toISOString());
        return noContent();
    }
    return null;
};
