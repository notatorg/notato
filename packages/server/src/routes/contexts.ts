import { z } from "zod";
import { Authenticator, type IssueTokenOptions } from "../auth.ts";
import { RequestError } from "../backend.ts";
import type { AuthStore, Store } from "../storage.ts";
import { type DevelopmentContext, TeamCoordinator, type WorkRecord, workId } from "../team.ts";
import {
    assertAccess,
    assertBoard,
    canReadFeedback,
    forReader,
    json,
    notFound,
    type Routes,
    readJson,
} from "./common.ts";

const ContextInput = z
    .object({
        name: z.string().trim().min(1).max(120),
        branch: z.string().trim().max(200).optional(),
    })
    .strict();
export const contextRoutes: Routes = async ({ req, path, method, principal, match }, app) => {
    const list = match(/^\/projects\/([^/]+)\/(contexts|work)$/);
    const single = match(/^\/contexts\/([^/]+)(?:\/(credentials))?$/);
    const note = match(/^\/annotations\/([^/]+)\/work$/);
    if (!list && !single && !note) return null;
    if (principal.kind === "token")
        throw new RequestError("Sign in to manage checkouts and assignments.", 403);
    const teams = new TeamCoordinator(app.backend.store);
    const manage = (c: DevelopmentContext) =>
        principal.username === c.owner ||
        (app.options.teamCanManage?.(principal) ?? principal.kind === "admin");
    if (method !== "GET") assertBoard(req, "checkout and review ownership");
    if (list) {
        const project = list[0]!;
        assertAccess(principal, project);
        if (!(await app.backend.store.getProject(project))) return notFound();
        if (method === "GET") {
            const items = await teams.records.list(
                project,
                list[1] === "contexts" ? "context" : "work"
            );
            if (list[1] === "contexts") return json({ items });
            // Work records can contain PR titles, URLs, branches and claims. Keep records for private feedback
            // out of the team queue unless the signed-in person created that feedback.
            const visible = await app.backend.list(forReader(principal, { projectId: project }));
            const visibleWork = new Set(visible.map(({ annotation }) => workId(annotation)));
            return json({ items: items.filter((item) => visibleWork.has(item.id)) });
        }
        if (method === "POST" && list[1] === "contexts") {
            const body = await readJson(req, ContextInput);
            return json(
                await teams.create(project, principal.username, body.name, body.branch),
                201
            );
        }
    }
    if (single) {
        const context = await teams.context(single[0]!);
        if (!context) return notFound();
        assertAccess(principal, context.projectId);
        if (!manage(context))
            throw new RequestError(
                "Only this checkout's owner or a workspace manager can change it.",
                403
            );
        if (method === "PATCH" && !path.endsWith("/credentials")) {
            const body = await readJson(
                req,
                z
                    .object({
                        name: z.string().trim().min(1).max(120).optional(),
                        branch: z.string().max(200).optional(),
                        archived: z.boolean().optional(),
                    })
                    .strict()
            );
            return json(
                await teams.records.change<DevelopmentContext>(
                    context.id,
                    context.projectId,
                    "context",
                    (current) => {
                        if (!current) throw new RequestError("Checkout removed.", 404);
                        if (current.archived && body.archived === false)
                            throw new RequestError(
                                "Create a new checkout to replace an archived connection.",
                                409
                            );
                        return { ...current, ...body };
                    }
                )
            );
        }
        if (method === "POST" && single[1] === "credentials") {
            if (context.archived) throw new RequestError("Reconnect an active checkout.", 409);
            const options: IssueTokenOptions = {
                expiresInDays: 90,
                developmentContextId: context.id,
                createdBy: context.owner,
                ...app.options.teamTokenOptions?.(principal, context),
            };
            const auth = app.auth ?? new Authenticator(app.backend.store as Store & AuthStore);
            const capture = await auth.issueToken(context.projectId, `${context.name} capture`, {
                ...options,
                purpose: "app",
                permission: "full",
            });
            try {
                const agent = await auth.issueToken(context.projectId, `${context.name} agent`, {
                    ...options,
                    purpose: "agent",
                    permission: "full",
                });
                return json(
                    {
                        context,
                        capture: { token: capture.token, id: capture.record.id },
                        agent: { token: agent.token, id: agent.record.id },
                        server: new URL(req.url).origin,
                        mcpUrl: `${new URL(req.url).origin}/mcp?project=${encodeURIComponent(context.projectId)}`,
                    },
                    201
                );
            } catch (error) {
                await auth.revokeToken(capture.record.id);
                throw error;
            }
        }
    }
    if (note) {
        const stored = await app.backend.get(note[0]!);
        if (!stored || !(await canReadFeedback(principal, stored.annotation, app.backend)))
            return notFound();
        assertAccess(principal, stored.annotation.projectId);
        if (method === "GET") return json(await teams.work(workId(stored.annotation)));
        if (method === "PUT") {
            const body = await readJson(
                req,
                z
                    .object({
                        contextId: z.string().max(200).nullable(),
                        recover: z.boolean().default(false),
                    })
                    .strict()
            );
            const current = await teams.work(workId(stored.annotation));
            const target = body.contextId ? await teams.context(body.contextId) : null;
            if (
                stored.annotation.visibility === "personal" &&
                target &&
                target.owner !== stored.annotation.createdBy
            )
                throw new RequestError(
                    "Personal feedback can only be assigned to its creator's checkout. Share it first to assign it to a teammate.",
                    403
                );
            const source = current?.contextId ? await teams.context(current.contextId) : null;
            // Team members may take shared work for their own checkout or release their own work. Managers can assign across the team.
            if (
                !(app.options.teamCanManage?.(principal) ?? principal.kind === "admin") &&
                ((target && target.owner !== principal.username) ||
                    (source && source.owner !== principal.username))
            )
                throw new RequestError(
                    "Assign shared work to your own checkout, or ask a workspace manager to reassign it.",
                    403
                );
            const work = await teams.assign(
                stored.annotation,
                body.contextId,
                principal.username,
                body.recover,
                current?.version ?? 0
            );
            app.backend.bus.publish({
                type: "updated",
                id: stored.annotation.id,
                projectId: stored.annotation.projectId,
                seq: stored.seq,
                annotation: stored.annotation,
            });
            return json(work);
        }
        if (method === "POST") {
            const body = await readJson(
                req,
                z
                    .object({
                        branch: z.string().trim().min(1).max(200),
                        commit: z.string().regex(/^[a-f0-9]{40,64}$/i),
                    })
                    .strict()
            );
            const current = await teams.work(workId(stored.annotation));
            const context = current?.contextId ? await teams.context(current.contextId) : null;
            if (!context || !manage(context))
                throw new RequestError(
                    "Only the assigned developer or a manager can record a resolution.",
                    403
                );
            return json(
                await teams.records.change<WorkRecord>(
                    workId(stored.annotation),
                    stored.annotation.projectId,
                    "work",
                    (r) => {
                        if (!r) throw new RequestError("Review missing.", 404);
                        return {
                            ...r,
                            resolution: { ...body, at: new Date().toISOString() },
                            updatedAt: new Date().toISOString(),
                        };
                    }
                )
            );
        }
    }
    return null;
};
