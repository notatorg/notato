import { createHmac, timingSafeEqual } from "node:crypto";
import type { WorkRecord } from "@notato/server";
import { z } from "zod";

/** What cloud adds to a pull request review beyond the open server's record, written by GitHub events. */
export type CloudPullRequest = NonNullable<WorkRecord["pullRequest"]> & {
    /** Where `previewUrl` came from: absent means a person entered it, which automation never replaces. */
    previewSource?: "deployment";
    previewEnvironment?: string;
    /** A ready preview for a commit newer than the reviewed one, to start the next review from. */
    latestPreview?: { sha: string; url: string; environment?: string; at: string };
};

/** `X-Hub-Signature-256`: `sha256=` and the hex HMAC of the raw body under the App's webhook secret. */
export function verifyGithubSignature(
    secret: string,
    body: string,
    header: string | null
): boolean {
    if (!header?.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", secret).update(body).digest();
    const given = Buffer.from(header.slice(7), "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
}

const Repository = z.object({ full_name: z.string().max(200) });
const Installation = z.object({ id: z.union([z.number(), z.string()]) });
export const PullRequestEvent = z.object({
    action: z.string().max(40),
    repository: Repository,
    installation: Installation,
    pull_request: z.object({
        number: z.number().int().positive(),
        state: z.enum(["open", "closed"]),
        merged: z.boolean().optional(),
        head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    }),
});
export const DeploymentStatusEvent = z.object({
    repository: Repository,
    installation: Installation,
    deployment: z.object({
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        environment: z.string().max(200).optional(),
    }),
    deployment_status: z.object({
        state: z.string().max(40),
        environment: z.string().max(200).optional(),
        environment_url: z.string().max(2000).optional(),
    }),
});

/**
 * A preview address worth showing people: HTTPS, a real host name, no credentials, and not a production
 * environment. Anything else is ignored rather than trusted.
 */
export function previewFromDeployment(
    event: z.infer<typeof DeploymentStatusEvent>
): { url: string; environment?: string } | null {
    const status = event.deployment_status;
    if (status.state !== "success" || !status.environment_url) return null;
    const environment = status.environment ?? event.deployment.environment;
    if (environment && /^prod(uction)?$/i.test(environment.trim())) return null;
    try {
        const url = new URL(status.environment_url);
        if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            !url.hostname.includes(".") ||
            /^[\d.]+$/.test(url.hostname) ||
            url.hostname.startsWith("[") ||
            url.hostname.endsWith(".local") ||
            url.hostname.endsWith(".internal")
        )
            return null;
        return { url: url.href, ...(environment ? { environment } : {}) };
    } catch {
        return null;
    }
}

export function githubWebhookSecretFromEnv(env = process.env): string | undefined {
    const secret = env.NOTATO_GITHUB_WEBHOOK_SECRET;
    if (!secret) return undefined;
    if (secret.length < 20)
        throw new Error("NOTATO_GITHUB_WEBHOOK_SECRET must be the GitHub App's webhook secret");
    return secret;
}
