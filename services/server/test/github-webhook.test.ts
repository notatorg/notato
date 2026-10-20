import { expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { TeamCoordinator, type WorkRecord } from "@notato/server";
import {
    type CloudPullRequest,
    githubWebhookSecretFromEnv,
    previewFromDeployment,
    verifyGithubSignature,
} from "../src/github-webhook.ts";
import { encrypt } from "../src/plugins/model.ts";
import { Providers } from "../src/plugins/providers.ts";
import { cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
const secret = "github-webhook-secret-for-tests";
const key = Buffer.alloc(32, 7);
const OLD = "a".repeat(40);
const NEW = "c".repeat(40);

async function setup(installation = "123") {
    const providers = new Providers(async (url) => {
        if (new URL(url).pathname.endsWith("/pulls/42"))
            return Response.json({
                number: 42,
                title: "Improve checkout validation",
                state: "open",
                merged: false,
                head: { sha: OLD },
                base: { sha: "b".repeat(40), repo: { full_name: "example/shop" } },
            });
        return Response.json({ id: 1 });
    });
    const s = await startServe(defer, {
        managedAuth: fakeManagedAuth(),
        testPlans: true,
        plugins: { key, providers },
        githubWebhookSecret: secret,
    });
    const alice = await customer(s, "alice");
    const me = (await (await s.call("/auth/me", { headers: { cookie: alice.cookie } })).json()) as {
        workspace: { id: string };
        username: string;
    };
    const workspace = me.workspace.id;
    const actor = me.username;
    await s.rt.store.createProject({
        id: "shop",
        name: "Shop",
        workspaceId: workspace,
        createdAt: new Date().toISOString(),
    });
    const headers = {
        cookie: alice.cookie,
        "x-notato-board": "1",
        "content-type": "application/json",
    };
    const connected = await s.call("/plugins/connections", {
        method: "POST",
        headers,
        body: JSON.stringify({ provider: "github", name: "GitHub", credential: "synthetic-token" }),
    });
    const connection = (await connected.json()) as { id: string };
    // Make it an App installation connection, as the GitHub App flow stores it.
    const stored = await s.rt.store.plugins?.connection(workspace, connection.id);
    if (!stored || !s.rt.store.plugins) throw new Error("missing connection");
    await s.rt.store.plugins.saveConnection(
        {
            ...stored,
            encrypted: encrypt(
                JSON.stringify({
                    token: "",
                    installationId: installation,
                    repositories: ["example/shop"],
                }),
                key,
                `${stored.workspaceId}:${stored.provider}:${stored.id}`
            ),
        },
        actor
    );
    const created = async (previewUrl?: string) => {
        const res = await s.call("/pull-request-reviews", {
            method: "POST",
            headers,
            body: JSON.stringify({
                projectId: "shop",
                connectionId: connection.id,
                url: "https://github.com/example/shop/pull/42",
                ...(previewUrl ? { previewUrl } : {}),
            }),
        });
        // Creating a round reads the PR through the stored installation, which needs the App's own signing key.
        return res;
    };
    const teams = new TeamCoordinator(s.rt.store);
    const work = async (): Promise<WorkRecord & { pullRequest: CloudPullRequest }> => {
        const [first] = (await teams.records.list("shop", "work")) as WorkRecord[];
        return first as WorkRecord & { pullRequest: CloudPullRequest };
    };
    // Seed the round directly: creating one needs GitHub App signing credentials this test does not have.
    const seed = async (previewUrl?: string) => {
        const at = new Date().toISOString();
        await teams.records.change<WorkRecord>("pr_test", "shop", "work", (current) => {
            return (
                current ?? {
                    id: "pr_test",
                    projectId: "shop",
                    contextId: null,
                    shared: true,
                    version: 0,
                    createdAt: at,
                    updatedAt: at,
                    pullRequest: {
                        connectionId: connection.id,
                        repository: "example/shop",
                        number: 42,
                        title: "Improve checkout validation",
                        url: "https://github.com/example/shop/pull/42",
                        headSha: OLD,
                        latestHeadSha: OLD,
                        baseSha: "b".repeat(40),
                        ...(previewUrl ? { previewUrl } : {}),
                        state: "open",
                        merged: false,
                        checkedAt: at,
                        creator: "alice",
                    },
                }
            );
        });
    };
    const send = (
        event: string,
        payload: unknown,
        signWith = secret,
        extra: Record<string, string> = {}
    ) => {
        const body = JSON.stringify(payload);
        return s.call("/github/webhook", {
            method: "POST",
            headers: {
                "x-github-event": event,
                "x-hub-signature-256": `sha256=${createHmac("sha256", signWith).update(body).digest("hex")}`,
                "content-type": "application/json",
                ...extra,
            },
            body,
        });
    };
    return { s, headers, created, work, seed, send, workspace, actor };
}

const pullRequest = (over: Record<string, unknown> = {}, installation = 123) => ({
    action: "synchronize",
    repository: { full_name: "Example/Shop" },
    installation: { id: installation },
    pull_request: { number: 42, state: "open", merged: false, head: { sha: NEW } },
    ...over,
});
const deployment = (
    sha: string,
    url: string | undefined,
    over: Record<string, unknown> = {},
    installation = 123
) => ({
    repository: { full_name: "example/shop" },
    installation: { id: installation },
    deployment: { sha, environment: "Preview" },
    deployment_status: { state: "success", environment: "Preview", environment_url: url, ...over },
});

it("checks GitHub's signature and the configured secret", () => {
    const body = '{"a":1}';
    const header = `sha256=${createHmac("sha256", "s".repeat(20)).update(body).digest("hex")}`;
    expect(verifyGithubSignature("s".repeat(20), body, header)).toBe(true);
    expect(verifyGithubSignature("s".repeat(20), `${body} `, header)).toBe(false);
    expect(verifyGithubSignature("t".repeat(20), body, header)).toBe(false);
    expect(verifyGithubSignature("s".repeat(20), body, null)).toBe(false);
    expect(verifyGithubSignature("s".repeat(20), body, "sha256=zz")).toBe(false);
    expect(githubWebhookSecretFromEnv({})).toBeUndefined();
    expect(() => githubWebhookSecretFromEnv({ NOTATO_GITHUB_WEBHOOK_SECRET: "short" })).toThrow();
});

it("only trusts successful, public, non-production HTTPS preview addresses", () => {
    const url = (u: string, over: Record<string, unknown> = {}) =>
        previewFromDeployment(deployment(OLD, u, over) as never);
    expect(url("https://pr-42.shop.example.dev/")).toMatchObject({
        url: "https://pr-42.shop.example.dev/",
        environment: "Preview",
    });
    for (const bad of [
        "http://pr-42.shop.example.dev",
        "https://user:pw@pr-42.shop.example.dev",
        "https://localhost:3000",
        "https://10.0.0.1",
        "https://[::1]/",
        "https://printer.local",
        "javascript:alert(1)",
        "not a url",
    ])
        expect(url(bad)).toBeNull();
    expect(url("https://pr-42.shop.example.dev", { state: "pending" })).toBeNull();
    expect(url("https://shop.example.dev", { environment: "Production" })).toBeNull();
    expect(previewFromDeployment(deployment(OLD, undefined) as never)).toBeNull();
});

it("refuses unsigned or wrongly signed deliveries without updating the review", async () => {
    const w = await setup();
    await w.seed();
    const bad = await w.send("pull_request", pullRequest(), "wrong-secret-wrong-secret");
    expect(bad.status).toBe(401);
    expect((await w.s.call("/github/webhook", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await w.work()).pullRequest.latestHeadSha).toBe(OLD);
    expect((await w.send("ping", { zen: "hi" })).status).toBe(200);
});

it("leaves the webhook endpoint unavailable when no secret is configured", async () => {
    const off = await startServe(defer, { managedAuth: fakeManagedAuth(), testPlans: true });
    expect((await off.call("/github/webhook", { method: "POST", body: "{}" })).status).toBe(404);
});

it("keeps a review's state and newest commit current without a manual refresh", async () => {
    const w = await setup();
    await w.seed();
    const response = await w.send("pull_request", pullRequest());
    expect((await response.json()) as { updated: number }).toMatchObject({ updated: 1 });
    let pr = (await w.work()).pullRequest;
    // The reviewed commit is kept; only the latest one moves.
    expect(pr.headSha).toBe(OLD);
    expect(pr.latestHeadSha).toBe(NEW);
    await w.send(
        "pull_request",
        pullRequest({
            action: "closed",
            pull_request: { number: 42, state: "closed", merged: true, head: { sha: NEW } },
        })
    );
    pr = (await w.work()).pullRequest;
    expect(pr).toMatchObject({ state: "closed", merged: true });
    // Other actions and other pull requests do nothing.
    const before = (await w.work()).updatedAt;
    await w.send("pull_request", pullRequest({ action: "labeled" }));
    await w.send(
        "pull_request",
        pullRequest({ pull_request: { number: 7, state: "open", head: { sha: NEW } } })
    );
    expect((await w.work()).updatedAt).toBe(before);
});

it("finds the preview from a deployment, never replacing one a person entered", async () => {
    const w = await setup();
    await w.seed();
    const ready = await w.send(
        "deployment_status",
        deployment(OLD, "https://pr-42.shop.example.dev")
    );
    expect((await ready.json()) as { updated: number }).toMatchObject({ updated: 1 });
    let pr = (await w.work()).pullRequest;
    expect(pr).toMatchObject({
        previewUrl: "https://pr-42.shop.example.dev/",
        previewSource: "deployment",
        previewEnvironment: "Preview",
    });
    // A later deployment of the same commit replaces a CI-found address.
    await w.send("deployment_status", deployment(OLD, "https://pr-42-b.shop.example.dev"));
    expect((await w.work()).pullRequest.previewUrl).toBe("https://pr-42-b.shop.example.dev/");
    // Failures, production and unsafe addresses leave it alone.
    await w.send(
        "deployment_status",
        deployment(OLD, "https://x.example.dev", { state: "failure" })
    );
    await w.send(
        "deployment_status",
        deployment(OLD, "https://prod.example.dev", { environment: "production" })
    );
    await w.send("deployment_status", deployment(OLD, "http://insecure.example.dev"));
    expect((await w.work()).pullRequest.previewUrl).toBe("https://pr-42-b.shop.example.dev/");

    const typed = await setup();
    await typed.seed("https://typed.example.dev");
    await typed.send("deployment_status", deployment(OLD, "https://ci.example.dev"));
    pr = (await typed.work()).pullRequest;
    expect(pr.previewUrl).toBe("https://typed.example.dev");
    expect(pr.previewSource).toBeUndefined();
});

it("offers the preview for a newer commit without rewriting the reviewed one", async () => {
    const w = await setup();
    await w.seed("https://typed.example.dev");
    await w.send("pull_request", pullRequest());
    await w.send("deployment_status", deployment(NEW, "https://pr-42-new.shop.example.dev"));
    const pr = (await w.work()).pullRequest;
    expect(pr.headSha).toBe(OLD);
    expect(pr.previewUrl).toBe("https://typed.example.dev");
    expect(pr.latestPreview).toMatchObject({
        sha: NEW,
        url: "https://pr-42-new.shop.example.dev/",
    });
});

it("ignores events from another installation, an unauthorised repository or a revoked connection", async () => {
    const w = await setup("123");
    await w.seed();
    const other = await w.send("pull_request", pullRequest({}, 999));
    expect((await other.json()) as { updated: number }).toMatchObject({ updated: 0 });
    const elsewhere = await w.send(
        "pull_request",
        pullRequest({ repository: { full_name: "example/other" } })
    );
    expect((await elsewhere.json()) as { updated: number }).toMatchObject({ updated: 0 });
    expect((await w.work()).pullRequest.latestHeadSha).toBe(OLD);
    const wrongDeployment = await w.send(
        "deployment_status",
        deployment(OLD, "https://pr-42.shop.example.dev", {}, 999)
    );
    expect((await wrongDeployment.json()) as { updated: number }).toMatchObject({ updated: 0 });
    expect((await w.work()).pullRequest.previewUrl).toBeUndefined();

    const connection = (await w.work()).pullRequest.connectionId;
    const stored = await w.s.rt.store.plugins?.connection(w.workspace, connection);
    if (!stored || !w.s.rt.store.plugins) throw new Error("missing connection");
    await w.s.rt.store.plugins.saveConnection({ ...stored, revoked: true }, w.actor);
    const revoked = await w.send("pull_request", pullRequest());
    expect((await revoked.json()) as { updated: number }).toMatchObject({ updated: 0 });
});

it("tells the board when GitHub events are on", async () => {
    const w = await setup();
    const list = (await (
        await w.s.call("/pull-request-reviews", { headers: w.headers })
    ).json()) as {
        automation: { webhooks: boolean };
    };
    expect(list.automation.webhooks).toBe(true);
});
