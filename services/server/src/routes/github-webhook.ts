import { json, TeamCoordinator, type WorkRecord } from "@notato/server";
import type { Principal } from "../auth.ts";
import type { CloudApp, CloudRoutes } from "../context.ts";
import {
    type CloudPullRequest,
    DeploymentStatusEvent,
    PullRequestEvent,
    previewFromDeployment,
    verifyGithubSignature,
} from "../github-webhook.ts";
import { boundedText } from "../http-body.ts";
import { pluginsFor } from "./plugins.ts";

const safe = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

/**
 * A GitHub event may change a review round only when its own connection vouches for it: the round's GitHub App
 * connection must be the installation that sent it, with that repository authorised. A valid signature alone proves
 * only that GitHub sent it, not that it concerns this workspace.
 */
async function vouched(
    app: CloudApp,
    origin: string,
    work: WorkRecord,
    installation: string
): Promise<boolean> {
    const pr = work.pullRequest;
    if (!pr) return false;
    const project = await app.backend.store.getProject(work.projectId);
    const service = pluginsFor(app.backend, origin, app.options.plugins);
    const repository = app.backend.store.plugins;
    if (!project?.workspaceId || !repository || !service.key) return false;
    try {
        const connection = await repository.connection(project.workspaceId, pr.connectionId);
        if (!connection || connection.revoked || connection.provider !== "github") return false;
        const secret = await service.secret(connection);
        return (
            secret.installationId === installation &&
            Boolean(
                secret.repositories?.some((r) => r.toLowerCase() === pr.repository.toLowerCase())
            )
        );
    } catch {
        return false;
    }
}

/**
 * GitHub App webhooks: pull request state and head changes, and preview addresses from deployment statuses. They
 * replace "Refresh PR status" and typing a preview URL; both remain as fallbacks. Needs
 * `NOTATO_GITHUB_WEBHOOK_SECRET`; without it the route does not exist.
 */
export const githubWebhookRoutes: CloudRoutes<Principal | null> = async (
    { req, path, method },
    app
) => {
    if (path !== "/github/webhook" || method !== "POST") return null;
    const secret = app.options.githubWebhookSecret;
    if (!secret) return json({ error: "not found" }, 404);
    const raw = await boundedText(req, 2 * 1024 * 1024);
    if (!verifyGithubSignature(secret, raw, req.headers.get("x-hub-signature-256")))
        return json({ error: "invalid signature" }, 401);
    const event = req.headers.get("x-github-event");
    if (event === "ping") return json({ ok: true });
    const origin = app.options.publicOrigin ?? new URL(req.url).origin;
    const teams = new TeamCoordinator(app.backend.store);
    const now = new Date().toISOString();
    let updated = 0;

    if (event === "pull_request") {
        const parsed = PullRequestEvent.safeParse(safe(raw));
        if (!parsed.success || !["synchronize", "closed", "reopened"].includes(parsed.data.action))
            return json({ ok: true, updated });
        const { repository, installation, pull_request: pr } = parsed.data;
        for (const work of await app.backend.store.pullRequestWorks(repository.full_name, {
            number: pr.number,
        })) {
            if (!(await vouched(app, origin, work, String(installation.id)))) continue;
            await teams.records.change<WorkRecord>(work.id, work.projectId, "work", (r) =>
                r?.pullRequest
                    ? {
                          ...r,
                          pullRequest: {
                              ...r.pullRequest,
                              state: pr.state,
                              merged: pr.merged ?? false,
                              latestHeadSha: pr.head.sha,
                              checkedAt: now,
                          },
                          updatedAt: now,
                      }
                    : (r as WorkRecord)
            );
            updated++;
        }
        return json({ ok: true, updated });
    }

    if (event === "deployment_status") {
        const parsed = DeploymentStatusEvent.safeParse(safe(raw));
        const preview = parsed.success ? previewFromDeployment(parsed.data) : null;
        if (!parsed.success || !preview) return json({ ok: true, updated });
        const { repository, installation, deployment } = parsed.data;
        for (const work of await app.backend.store.pullRequestWorks(repository.full_name, {
            sha: deployment.sha,
        })) {
            const current = work.pullRequest as CloudPullRequest | undefined;
            if (!current || !(await vouched(app, origin, work, String(installation.id)))) continue;
            await teams.records.change<WorkRecord>(work.id, work.projectId, "work", (r) => {
                const pr = r?.pullRequest as CloudPullRequest | undefined;
                if (!r || !pr) return r as WorkRecord;
                let next: CloudPullRequest = pr;
                if (pr.headSha === deployment.sha) {
                    // A person's own entry stays; a CI-found one follows the latest successful deployment.
                    if (!pr.previewUrl || pr.previewSource === "deployment")
                        next = {
                            ...next,
                            previewUrl: preview.url,
                            previewSource: "deployment",
                            ...(preview.environment
                                ? { previewEnvironment: preview.environment }
                                : {}),
                        };
                } else if (pr.latestHeadSha === deployment.sha) {
                    next = {
                        ...next,
                        latestPreview: {
                            sha: deployment.sha,
                            url: preview.url,
                            ...(preview.environment ? { environment: preview.environment } : {}),
                            at: now,
                        },
                    };
                }
                return next === pr ? r : { ...r, pullRequest: next, updatedAt: now };
            });
            updated++;
        }
        return json({ ok: true, updated });
    }
    return json({ ok: true, updated });
};
