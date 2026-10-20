import { createHash } from "node:crypto";
import {
    assertAccess,
    assertBoard,
    json,
    RequestError,
    readJson,
    TeamCoordinator,
    type WorkRecord,
} from "@notato/server";
import { z } from "zod";
import type { CloudRoutes } from "../context.ts";
import { fingerprint, PluginError } from "../plugins/model.ts";
import { ProviderError } from "../plugins/providers.ts";
import { pluginsFor } from "./plugins.ts";

const Input = z
    .object({
        projectId: z.string().min(1).max(200),
        connectionId: z.uuid(),
        url: z.string().url().max(2000),
        previewUrl: z.string().url().max(2000).optional(),
    })
    .strict();
const repoPR = (url: string) => {
    const value = new URL(url),
        m = /^\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(value.pathname);
    if (
        value.origin !== "https://github.com" ||
        value.username ||
        value.password ||
        !m ||
        !Number.isSafeInteger(Number(m[2])) ||
        Number(m[2]) < 1
    )
        throw new RequestError("Enter a GitHub pull request URL.");
    return { repository: m[1]!, number: Number(m[2]) };
};
const routes: CloudRoutes = async ({ req, path, method, principal, match }, app) => {
    if (!path.startsWith("/pull-request-reviews")) return null;
    if (principal.kind !== "member") throw new RequestError("Workspace sign-in required.", 403);
    const teams = new TeamCoordinator(app.backend.store),
        workspace = principal.workspaceId,
        actor = principal.username;
    const service = pluginsFor(
            app.backend,
            app.options.publicOrigin ?? new URL(req.url).origin,
            app.options.plugins
        ),
        repository = service.ready().repository;
    const member = await repository.membership(workspace, actor);
    if (!member) throw new RequestError("Workspace access revoked.", 403);
    if (method !== "GET") assertBoard(req, "pull request reviews");
    const connection = async (id: string) => {
        const c = await repository.connection(workspace, id);
        if (!c || c.revoked || c.provider !== "github")
            throw new RequestError("Select an active GitHub connection from this workspace.", 400);
        return c;
    };
    const reachable = async (id: string) => {
        const w = await teams.work(id);
        if (!w?.pullRequest) throw new RequestError("PR review not found.", 404);
        assertAccess(principal, w.projectId);
        if ((await app.backend.store.getProject(w.projectId))?.workspaceId !== workspace)
            throw new RequestError("PR review not found.", 404);
        return w;
    };
    if (path === "/pull-request-reviews") {
        if (method === "GET") {
            const projects = await app.backend.store.listProjects(workspace);
            const works = (await Promise.all(projects.map((p) => teams.records.list(p.id, "work"))))
                .flat()
                .filter((w): w is WorkRecord => "pullRequest" in w && !!w.pullRequest);
            return json({
                items: works.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
                connections: (await repository.connections(workspace))
                    .filter((c) => c.provider === "github" && !c.revoked)
                    .map((c) => ({ id: c.id, name: c.name })),
                projects,
                automation: { webhooks: Boolean(app.options.githubWebhookSecret) },
            });
        }
        if (method === "POST") {
            const body = await readJson(req, Input);
            assertAccess(principal, body.projectId);
            if ((await app.backend.store.getProject(body.projectId))?.workspaceId !== workspace)
                throw new RequestError("Project not found.", 404);
            const c = await connection(body.connectionId),
                target = repoPR(body.url);
            if (
                member.role === "member" &&
                !(await repository.actions(workspace)).some(
                    (a) =>
                        !a.archived &&
                        a.projectId === body.projectId &&
                        a.connectionId === c.id &&
                        a.destination.provider === "github" &&
                        a.destination.repository.toLowerCase() === target.repository.toLowerCase()
                )
            )
                throw new RequestError(
                    "Ask a workspace owner to configure this repository for the project through a GitHub action, or start the PR review for you.",
                    403
                );
            const pr = await service.providers.pullRequest(
                await service.secret(c),
                target.repository,
                target.number
            );
            if (body.previewUrl) {
                const u = new URL(body.previewUrl);
                if (
                    u.username ||
                    u.password ||
                    (u.protocol !== "https:" &&
                        !(
                            u.protocol === "http:" &&
                            ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
                        ))
                )
                    throw new RequestError(
                        "Use an HTTPS preview URL, or loopback HTTP for local development."
                    );
            }
            const existing = (
                (await teams.records.list(body.projectId, "work")) as WorkRecord[]
            ).find(
                (w) =>
                    w.pullRequest?.repository.toLowerCase() === pr.repository.toLowerCase() &&
                    w.pullRequest.number === pr.number &&
                    w.pullRequest.headSha === pr.headSha
            );
            if (existing) return json(existing);
            const id = `pr_${createHash("sha256").update(`${body.projectId}:${pr.repository.toLowerCase()}:${pr.number}:${pr.headSha}`).digest("hex")}`,
                at = new Date().toISOString();
            const work = await teams.records.change<WorkRecord>(
                id,
                body.projectId,
                "work",
                (current) =>
                    current ?? {
                        id,
                        projectId: body.projectId,
                        contextId: null,
                        shared: true,
                        version: 0,
                        createdAt: at,
                        updatedAt: at,
                        pullRequest: {
                            ...pr,
                            latestHeadSha: pr.headSha,
                            connectionId: c.id,
                            previewUrl: body.previewUrl,
                            creator: actor,
                        },
                    }
            );
            return json(work, 201);
        }
    }
    const item = match(
        /^\/pull-request-reviews\/([^/]+)(?:\/(capture-key|refresh|assign|publication|preview|publish|reconcile))?$/
    );
    if (!item) return null;
    const work = await reachable(item[0]!),
        pr = work.pullRequest!,
        action = item[1];
    const notes = () =>
        app.backend.list({ projectId: work.projectId, workId: work.id, limit: 501 });
    if (
        method === "GET" &&
        ![
            "capture-key",
            "refresh",
            "assign",
            "publication",
            "preview",
            "publish",
            "reconcile",
        ].includes(action ?? "")
    ) {
        const items = await notes();
        return json({
            work,
            notes: items.slice(0, 500),
            truncated: items.length > 500,
            contexts: await teams.records.list(work.projectId, "context"),
        });
    }
    if (action === "capture-key" && method === "POST") {
        const issued = await app.auth.issueToken(work.projectId, `PR #${pr.number} capture`, {
            purpose: "app",
            permission: "capture",
            captureWorkId: work.id,
            ownership: "user",
            ownerUsername: actor,
            workspaceId: workspace,
            createdBy: actor,
            expiresInDays: 7,
        });
        return json(
            {
                token: issued.token,
                id: issued.record.id,
                projectId: work.projectId,
                server: app.options.publicOrigin ?? new URL(req.url).origin,
                expiresAt: issued.record.expiresAt,
            },
            201
        );
    }
    if (action === "refresh" && method === "POST") {
        const c = await connection(pr.connectionId),
            fresh = await service.providers.pullRequest(
                await service.secret(c),
                pr.repository,
                pr.number
            );
        return json(
            await teams.records.change<WorkRecord>(work.id, work.projectId, "work", (r) => {
                if (!r?.pullRequest) throw new RequestError("Review removed.", 404);
                return {
                    ...r,
                    pullRequest: {
                        ...r.pullRequest,
                        state: fresh.state,
                        merged: fresh.merged,
                        latestHeadSha: fresh.headSha,
                        checkedAt: fresh.checkedAt,
                    },
                    updatedAt: new Date().toISOString(),
                };
            })
        );
    }
    if (action === "assign" && method === "PUT") {
        const body = await readJson(
            req,
            z
                .object({ contextId: z.string().nullable(), recover: z.boolean().default(false) })
                .strict()
        );
        const context = body.contextId ? await teams.context(body.contextId) : null,
            previous = work.contextId ? await teams.context(work.contextId) : null;
        if (
            body.contextId &&
            (!context || context.archived || context.projectId !== work.projectId)
        )
            throw new RequestError("Select an active checkout in this project.");
        if (
            member.role === "member" &&
            ((context && context.owner !== actor) || (previous && previous.owner !== actor))
        )
            throw new RequestError(
                "Take shared work for your own checkout or ask a manager to reassign it.",
                403
            );
        const assigned = await teams.records.change<WorkRecord>(
            work.id,
            work.projectId,
            "work",
            (r) => {
                if (!r) throw new RequestError("Review removed.", 404);
                if (r.version !== work.version || r.contextId !== work.contextId)
                    throw new RequestError(
                        "Review ownership changed. Reload before assigning it.",
                        409
                    );
                if (r.claim && !body.recover)
                    throw new RequestError(
                        "The previous agent may still be editing. Confirm recovery before reassigning.",
                        409
                    );
                return {
                    ...r,
                    contextId: body.contextId,
                    claim: undefined,
                    version: r.version + 1,
                    assignedBy: actor,
                    updatedAt: new Date().toISOString(),
                };
            }
        );
        for (const note of await notes())
            app.backend.bus.publish({
                type: "updated",
                id: note.annotation.id,
                projectId: work.projectId,
                seq: note.seq,
                annotation: note.annotation,
            });
        return json(assigned);
    }
    if (action === "preview" || action === "publish") {
        if (method !== "POST") return null;
        const input = await readJson(
            req,
            z
                .object({
                    hash: z
                        .string()
                        .regex(/^[a-f0-9]{64}$/)
                        .optional(),
                    operation: z.uuid().optional(),
                })
                .strict()
        );
        const c = await connection(pr.connectionId),
            all = await notes(),
            publicNotes = all.filter(
                (n) => !n.annotation.peopleOnly && n.annotation.visibility !== "personal"
            );
        if (!publicNotes.length)
            throw new RequestError("Add public feedback before publishing a summary.", 409);
        if (publicNotes.length > 50)
            throw new RequestError("Publish at most 50 feedback targets in one review round.", 409);
        const text = `## Notato feedback review\n\nReviewed commit: ${pr.headSha}\n\n${publicNotes.map(({ annotation: a }, i) => `${i + 1}. **${a.status}** — ${a.comment.slice(0, 1000)}\n   Page: ${a.route.split(/[?#]/)[0]}\n   [View feedback](${service.origin}/#/p/${encodeURIComponent(work.projectId)}/a/${encodeURIComponent(a.id)})`).join("\n\n")}${work.resolution ? `\n\nFix recorded on ${work.resolution.branch}: ${work.resolution.commit}. Verify the preview before merging.` : ""}`;
        const hash = fingerprint(service.ready().key, {
            text,
            connectionRevision: c.revision,
            head: pr.headSha,
            work: work.id,
        });
        if (action === "preview")
            return json({
                text,
                hash,
                operation: crypto.randomUUID(),
                count: publicNotes.length,
                excluded: all.length - publicNotes.length,
                commit: pr.headSha,
            });
        if (input.hash !== hash || !input.operation)
            throw new RequestError(
                "Feedback or authorization changed. Preview the summary again.",
                409
            );
        if (work.publication?.status === "sent" && work.publication.hash === hash)
            return json(work.publication);
        const fresh = await service.providers.pullRequest(
            await service.secret(c),
            pr.repository,
            pr.number
        );
        if (fresh.headSha !== pr.headSha)
            throw new RequestError(
                "The PR head changed. Start a new review round for the current commit before publishing.",
                409
            );
        if (!(await repository.membership(workspace, actor)))
            throw new RequestError("Workspace access revoked.", 403);
        const currentConnection = await connection(c.id);
        if (currentConnection.revision !== c.revision)
            throw new RequestError("Authorization changed. Preview again.", 409);
        let alreadyPublished = false;
        const reserved = await teams.records.change<WorkRecord>(
            work.id,
            work.projectId,
            "work",
            (r) => {
                if (!r) throw new RequestError("Review removed.", 404);
                if (
                    r.recoveryRequired ||
                    r.version !== work.version ||
                    r.pullRequest?.connectionId !== c.id
                )
                    throw new RequestError(
                        "The project or review ownership changed. Reconnect and preview again.",
                        409
                    );
                if (r.publication?.status === "sent" && r.publication.hash === hash) {
                    alreadyPublished = true;
                    return r;
                }
                if (r.publication && r.publication.status !== "sent")
                    throw new RequestError(
                        "A previous publication is uncertain. Check GitHub and reconcile it before sending again.",
                        409
                    );
                return {
                    ...r,
                    publication: {
                        status: "sending",
                        operation: input.operation!,
                        commit: pr.headSha,
                        hash,
                        at: new Date().toISOString(),
                    },
                };
            }
        );
        if (alreadyPublished) return json(reserved.publication);
        try {
            const result = await service.providers.publishPullRequestReview(
                await service.secret(c),
                pr.repository,
                pr.number,
                pr.headSha,
                `${text}\n\n<!-- notato-review:${input.operation} -->`
            );
            const saved = await teams.records.change<WorkRecord>(
                work.id,
                work.projectId,
                "work",
                (r) => {
                    if (!r?.publication) throw new RequestError("Publication removed.", 409);
                    return r.publication.operation !== input.operation
                        ? r
                        : {
                              ...r,
                              publication: { ...r.publication, status: "sent", url: result.url },
                          };
                }
            );
            return json(saved.publication, 201);
        } catch (error) {
            await teams.records.change<WorkRecord>(work.id, work.projectId, "work", (r) => {
                if (!r?.publication || r.publication.operation !== input.operation)
                    throw new RequestError("Publication changed.", 409);
                return {
                    ...r,
                    publication:
                        error instanceof ProviderError && error.disposition !== "review"
                            ? undefined
                            : {
                                  ...r.publication,
                                  status: "uncertain",
                                  error: (error as Error).message,
                              },
                };
            });
            if (error instanceof ProviderError && error.disposition !== "review") throw error;
            throw new RequestError(
                "GitHub delivery needs review. Use Check publication before trying again.",
                409
            );
        }
    }
    if (action === "reconcile" && method === "POST") {
        if (!work.publication) throw new RequestError("There is no publication to check.", 409);
        const c = await connection(pr.connectionId),
            found = await service.providers.findPullRequestReview(
                await service.secret(c),
                pr.repository,
                pr.number,
                work.publication.operation,
                work.publication.commit
            );
        if (!found)
            return json({
                found: false,
                message:
                    "No matching review was found in the latest 100 reviews. Check GitHub directly; automatic retry is disabled.",
            });
        const saved = await teams.records.change<WorkRecord>(
            work.id,
            work.projectId,
            "work",
            (r) => {
                if (!r?.publication) throw new RequestError("Publication removed.", 409);
                if (r.publication.operation !== work.publication?.operation) return r;
                return {
                    ...r,
                    publication: {
                        ...r.publication,
                        status: "sent",
                        url: found.url,
                        error: undefined,
                    },
                };
            }
        );
        return json({ found: true, publication: saved.publication });
    }
    return null;
};

export const pullRequestRoutes: CloudRoutes = async (request, app) => {
    try {
        return await routes(request, app);
    } catch (error) {
        if (error instanceof PluginError) throw new RequestError(error.message, error.status);
        if (error instanceof ProviderError)
            throw new RequestError(
                error.message,
                error.status === 429
                    ? 429
                    : error.status === 401 || error.status === 403
                      ? 403
                      : 502
            );
        throw error;
    }
};
