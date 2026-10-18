import { z } from "zod";
import { RequestError } from "../backend.ts";
import { TeamCoordinator, type WorkRecord, withWorkPermit, workId, workView } from "../team.ts";
import { canReadFeedback, json, notFound, type Routes, readJson } from "./common.ts";
export const claimRoutes: Routes = async ({ req, method, principal, match }, app) => {
    const target = match(/^\/annotations\/([^/]+)\/(claim|work)$/);
    if (!target || principal.kind !== "token") return null;
    if (!principal.developmentContextId || principal.purpose !== "agent")
        throw new RequestError("A checkout agent credential is required.", 403);
    const stored = await app.backend.get(target[0]!);
    if (!stored || !(await canReadFeedback(principal, stored.annotation, app.backend)))
        return notFound();
    const teams = new TeamCoordinator(app.backend.store);
    if (method === "GET" && target[1] === "work") {
        const work = await teams.work(workId(stored.annotation));
        return json(work ? workView(work) : null);
    }
    if (method === "POST" && target[1] === "claim") {
        const body = await readJson(
            req,
            z
                .object({
                    action: z.enum(["claim", "heartbeat", "release"]),
                    session: z.string().min(1).max(100),
                    version: z.number().int().optional(),
                    checkoutHead: z
                        .string()
                        .regex(/^[a-f0-9]{40,64}$/i)
                        .optional(),
                })
                .strict()
        );
        return json(
            workView(
                await teams.claim(
                    stored.annotation,
                    principal.developmentContextId,
                    body.session,
                    body.action,
                    body.version,
                    body.checkoutHead
                )
            )
        );
    }
    if (method === "POST" && target[1] === "work") {
        const body = await readJson(
            req,
            z
                .object({
                    session: z.string().min(1).max(100),
                    version: z.number().int(),
                    branch: z.string().trim().min(1).max(200),
                    commit: z.string().regex(/^[a-f0-9]{40,64}$/i),
                })
                .strict()
        );
        return json(
            await withWorkPermit(
                {
                    contextId: principal.developmentContextId,
                    session: body.session,
                    version: body.version,
                    credentialId: principal.tokenId,
                },
                () =>
                    teams.records.change<WorkRecord>(
                        workId(stored.annotation),
                        stored.annotation.projectId,
                        "work",
                        (r) => {
                            if (
                                !r ||
                                r.contextId !== principal.developmentContextId ||
                                r.claim?.session !== body.session ||
                                r.claim.version !== body.version ||
                                r.claim.expiresAt <= Date.now()
                            )
                                throw new RequestError("Work ownership expired or changed.", 409);
                            return {
                                ...r,
                                resolution: {
                                    branch: body.branch,
                                    commit: body.commit,
                                    at: new Date().toISOString(),
                                },
                                updatedAt: new Date().toISOString(),
                            };
                        }
                    )
            )
        );
    }
    return null;
};
