import { expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Annotation } from "@notato/schema";
import {
    type DevelopmentContext,
    TeamCoordinator,
    type WorkRecord,
    withWorkPermit,
} from "@notato/server";
import { Providers } from "../src/plugins/providers.ts";
import { pluginsFor } from "../src/routes/plugins.ts";
import { annotationFixture, cleanupAfterEach, multipart } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
async function setup() {
    let head = "a".repeat(40),
        writes = 0,
        uncertain = false;
    const reviews: Array<{ id: number; body: string; commit_id: string }> = [];
    const managed = fakeManagedAuth();
    managed.verify = async (token) =>
        ["alice", "bob", "carol", "dan", "qa"].includes(token)
            ? {
                  provider: "better-auth",
                  subject: token,
                  email: `${token}@example.com`,
                  displayName: token,
                  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              }
            : null;
    const providers = new Providers(async (url, init) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/reviews") && init?.method === "POST") {
            writes++;
            const body = JSON.parse(String(init.body));
            reviews.push({ id: writes, body: body.body, commit_id: body.commit_id });
            if (uncertain) throw new Error("lost response");
            return Response.json({ id: writes });
        }
        if (path.endsWith("/reviews")) return Response.json(reviews);
        if (path.endsWith("/pulls/42"))
            return Response.json({
                number: 42,
                title: "Improve checkout validation",
                state: "open",
                merged: false,
                head: { sha: head },
                base: { sha: "b".repeat(40), repo: { full_name: "example/shop" } },
            });
        return Response.json({ id: 1 });
    });
    const s = await startServe(defer, {
        managedAuth: managed,
        testPlans: true,
        plugins: { key: Buffer.alloc(32, 7), providers },
    });
    const sessions = new Map<string, { cookie: string; username: string }>();
    for (const name of ["alice", "bob", "carol", "dan", "qa"]) {
        const session = await customer(s, name);
        const me = (await (
            await s.call("/auth/me", { headers: { cookie: session.cookie } })
        ).json()) as { username: string; workspace: { id: string } };
        sessions.set(name, { cookie: session.cookie, username: me.username });
    }
    const alice = sessions.get("alice")!;
    const me = (await (await s.call("/auth/me", { headers: { cookie: alice.cookie } })).json()) as {
        workspace: { id: string };
    };
    const workspace = me.workspace.id;
    await s.rt.store.selectWorkspacePlan(workspace, alice.username, "team", 0);
    for (const [name, session] of sessions) {
        if (name === "alice") continue;
        await s.rt.store.setMembership({
            workspaceId: workspace,
            username: session.username,
            role: "member",
            createdAt: new Date().toISOString(),
        });
        const res = await s.call("/auth/workspace", {
            method: "POST",
            headers: { cookie: session.cookie, "x-notato-board": "1" },
            body: JSON.stringify({ workspaceId: workspace }),
        });
        expect(res.status).toBe(200);
        session.cookie = (res.headers.get("set-cookie") ?? session.cookie).split(";")[0]!;
    }
    await s.rt.store.createProject({
        id: "shop",
        name: "Checkout app",
        workspaceId: workspace,
        createdAt: new Date().toISOString(),
    });
    const board = (name = "alice") => ({
        cookie: sessions.get(name)!.cookie,
        "x-notato-board": "1",
        "content-type": "application/json",
    });
    const api = async (path: string, method = "GET", body?: unknown, name = "alice") =>
        s.call(path, {
            method,
            headers: board(name),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const c = await api("/plugins/connections", "POST", {
        provider: "github",
        name: "Team GitHub",
        credential: "synthetic-provider-token",
    });
    expect(c.status).toBe(201);
    const connection = (await c.json()) as { id: string };
    const createPR = async () => {
        const res = await api("/pull-request-reviews", "POST", {
            projectId: "shop",
            connectionId: connection.id,
            url: "https://github.com/example/shop/pull/42",
            previewUrl: "https://preview.example.com",
        });
        expect([200, 201]).toContain(res.status);
        return (await res.json()) as WorkRecord;
    };
    const capture = async (token: string, id: string, extra: Partial<Annotation> = {}) =>
        s.call("/projects/shop/annotations", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: multipart(
                annotationFixture({ id, projectId: "shop", screenshots: undefined, ...extra })
            ),
        });
    return {
        ...s,
        workspace,
        sessions,
        api,
        board,
        connection,
        createPR,
        capture,
        setHead: (value: string) => {
            head = value;
        },
        setUncertain: () => {
            uncertain = true;
        },
        writes: () => writes,
    };
}
it("runs four developer checkouts and one tester in one project with atomic MCP ownership", async () => {
    const s = await setup(),
        pairs: Array<{
            context: DevelopmentContext;
            agent: { token: string; id: string };
            capture: { token: string };
        }> = [];
    const actionResponse = await s.api("/plugins/actions", "POST", {
        name: "Shared team issues",
        connectionId: s.connection.id,
        projectId: "shop",
        destination: { provider: "github", repository: "example/shop", labels: [] },
    });
    const savedAction = (await actionResponse.json()) as { id: string };
    expect(actionResponse.status).toBe(201);
    expect(
        (
            await s.api("/plugins/workflows", "POST", {
                name: "Route shared feedback",
                actionId: savedAction.id,
                trigger: "created",
                enabled: true,
            })
        ).status
    ).toBe(201);
    expect(
        (
            await s.api(
                "/pull-request-reviews",
                "POST",
                {
                    projectId: "shop",
                    connectionId: s.connection.id,
                    url: "https://github.com/unapproved/repository/pull/42",
                },
                "bob"
            )
        ).status
    ).toBe(403);
    for (const name of ["alice", "bob", "carol", "dan"]) {
        const r = await s.api(
            "/projects/shop/contexts",
            "POST",
            { name: `${name}'s checkout`, branch: `feature/${name}` },
            name
        );
        expect(r.status).toBe(201);
        const c = (await r.json()) as DevelopmentContext;
        const issued = await s.api(`/contexts/${c.id}/credentials`, "POST", {}, name);
        expect(issued.status).toBe(201);
        pairs.push((await issued.json()) as (typeof pairs)[number]);
        const paired = pairs[pairs.length - 1]!;
        for (const [purpose, token] of [
            ["app", paired.capture.token],
            ["agent", paired.agent.token],
        ] as const) {
            const verified = await s.call("/projects/shop/connection", {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(verified.status).toBe(200);
            expect(await verified.json()).toMatchObject({
                tokenPurpose: purpose,
                projectId: "shop",
            });
        }
    }
    expect(
        (await s.api(`/contexts/${pairs[0]!.context.id}/credentials`, "POST", {}, "bob")).status
    ).toBe(403);
    for (const [i, pair] of pairs.entries()) {
        expect((await s.capture(pair.capture.token, `dev-${i}`)).status).toBe(201);
    }
    for (const [i, pair] of pairs.entries()) {
        const headers = { Authorization: `Bearer ${pair.agent.token}` };
        const listed = (await (await s.call("/projects/shop/annotations", { headers })).json()) as {
            items: Array<{ annotation: Annotation }>;
        };
        expect(listed.items.map((n) => n.annotation.id)).toEqual([`dev-${i}`]);
        expect((await s.call(`/annotations/dev-${(i + 1) % 4}`, { headers })).status).toBe(404);
    }
    for (const [index, pair] of pairs.entries()) {
        expect(
            (
                await s.call(`/annotations/dev-${index}`, {
                    headers: { Authorization: `Bearer ${pair.capture.token}` },
                })
            ).status
        ).toBe(200);
        expect(
            (
                await s.call(`/annotations/dev-${(index + 1) % 4}`, {
                    headers: { Authorization: `Bearer ${pair.capture.token}` },
                })
            ).status
        ).toBe(404);
        const appStream = await s.call("/projects/shop/events?agent=1", {
            headers: { Authorization: `Bearer ${pair.capture.token}` },
        });
        expect(appStream.status).toBe(200);
        await appStream.body?.cancel();
        const peers = [
            new Client({ name: `Developer ${index} A`, version: "1" }),
            new Client({ name: `Developer ${index} B`, version: "1" }),
        ];
        for (const peer of peers) {
            await peer.connect(
                new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
                    requestInit: { headers: { Authorization: `Bearer ${pair.agent.token}` } },
                })
            );
            defer(() => peer.close());
        }
        const claimed = await Promise.all(
            peers.map((peer) =>
                peer.callTool({ name: "notato_claim", arguments: { id: `dev-${index}` } })
            )
        );
        expect(claimed.filter((c) => !c.isError)).toHaveLength(1);
        const won = claimed[0]!.isError ? 1 : 0,
            lost = won === 0 ? 1 : 0;
        expect(
            (
                await peers[lost]!.callTool({
                    name: "notato_reply",
                    arguments: { id: `dev-${index}`, body: "Should not write" },
                })
            ).isError
        ).toBe(true);
        await peers[won]!.callTool({ name: "notato_release", arguments: { id: `dev-${index}` } });
    }
    const beforeQA = (await (await s.api("/plugins")).json()) as {
        history: Array<{ noteId: string }>;
    };
    expect(beforeQA.history).toHaveLength(0);
    const pr = await s.createPR();
    const key = (await (
        await s.api(`/pull-request-reviews/${pr.id}/capture-key`, "POST", {}, "qa")
    ).json()) as { token: string };
    expect((await s.capture(key.token, "qa-target", { visibility: "shared" })).status).toBe(201);
    expect(
        (
            await s.call("/annotations/qa-target", {
                headers: { Authorization: `Bearer ${pairs[0]!.agent.token}` },
            })
        ).status
    ).toBe(404);
    expect(
        (
            await s.api(`/pull-request-reviews/${pr.id}/assign`, "PUT", {
                contextId: pairs[0]!.context.id,
            })
        ).status
    ).toBe(200);
    const service = pluginsFor(s.rt.backend, s.base),
        storedAction = await service.repository!.action(s.workspace, savedAction.id);
    if (!storedAction) throw new Error("fixture action");
    await expect(service.payload(storedAction, "dev-0", true)).rejects.toThrow("Personal checkout");
    expect((await service.payload(storedAction, "qa-target", true)).noteIds).toEqual(["qa-target"]);
    const clients = [
        new Client({ name: "Developer agent A", version: "1" }),
        new Client({ name: "Developer agent B", version: "1" }),
    ];
    for (const client of clients) {
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${pairs[0]!.agent.token}` } },
            })
        );
        defer(() => client.close());
    }
    const results = await Promise.all(
        clients.map((client) =>
            client.callTool({ name: "notato_list_open", arguments: { scope: "shared" } }).then(() =>
                client.callTool({
                    name: "notato_claim",
                    arguments: { id: "qa-target", checkoutHead: "a".repeat(40) },
                })
            )
        )
    );
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    const winner = results[0]!.isError ? clients[1]! : clients[0]!;
    expect(
        (await winner.callTool({ name: "notato_acknowledge", arguments: { id: "qa-target" } }))
            .isError
    ).toBeUndefined();
    const reassigned = await s.api(`/pull-request-reviews/${pr.id}/assign`, "PUT", {
        contextId: pairs[1]!.context.id,
        recover: true,
    });
    expect(reassigned.status).toBe(200);
    expect(
        (
            await winner.callTool({
                name: "notato_resolve",
                arguments: { id: "qa-target", summary: "late" },
            })
        ).isError
    ).toBe(true);
    const teams = new TeamCoordinator(s.rt.store),
        note = (await s.rt.store.getAnnotation("qa-target"))!.annotation;
    const direct = await teams.claim(
        note,
        pairs[1]!.context.id,
        "direct-bob",
        "claim",
        undefined,
        "a".repeat(40)
    );
    await s.rt.store.removeMembership(s.workspace, s.sessions.get("bob")!.username);
    await expect(
        withWorkPermit(
            {
                contextId: pairs[1]!.context.id,
                session: "direct-bob",
                version: direct.claim!.version,
                credentialId: pairs[1]!.agent.id,
            },
            () => s.rt.store.updateAnnotation("qa-target", (a) => ({ ...a, status: "resolved" }))
        )
    ).rejects.toThrow("revoked");

    expect(
        (
            await s.call("/projects/shop/annotations", {
                headers: { Authorization: `Bearer ${pairs[1]!.agent.token}` },
            })
        ).status
    ).toBe(401);
}, 20000);
it("pins feedback to a PR commit, previews outbound content, deduplicates and reconciles uncertain GitHub reviews", async () => {
    const s = await setup(),
        pr = await s.createPR();
    expect((await s.createPR()).id).toBe(pr.id);
    const key = (await (
        await s.api(`/pull-request-reviews/${pr.id}/capture-key`, "POST")
    ).json()) as { token: string };
    await s.capture(key.token, "pr-public", {
        comment: "Fix the validation label",
        visibility: "shared",
    });
    await s.capture(key.token, "pr-private", {
        comment: "PRIVATE SECRET",
        peopleOnly: true,
        visibility: "shared",
    });
    const preview = (await (
        await s.api(`/pull-request-reviews/${pr.id}/preview`, "POST", {})
    ).json()) as { text: string; hash: string; operation: string };
    expect(preview.text).toContain("Fix the validation label");
    expect(preview.text).not.toContain("PRIVATE SECRET");
    expect(
        (
            await s.api(`/pull-request-reviews/${pr.id}/publish`, "POST", {
                hash: "0".repeat(64),
                operation: preview.operation,
            })
        ).status
    ).toBe(409);
    expect(s.writes()).toBe(0);
    const payload = { hash: preview.hash, operation: preview.operation };
    expect((await s.api(`/pull-request-reviews/${pr.id}/publish`, "POST", payload)).status).toBe(
        201
    );
    expect((await s.api(`/pull-request-reviews/${pr.id}/publish`, "POST", payload)).status).toBe(
        200
    );
    expect(s.writes()).toBe(1);
    s.setHead("c".repeat(40));
    const refreshed = (await (
        await s.api(`/pull-request-reviews/${pr.id}/refresh`, "POST", {})
    ).json()) as WorkRecord;
    expect(refreshed.pullRequest?.headSha).toBe("a".repeat(40));
    expect(refreshed.pullRequest?.latestHeadSha).toBe("c".repeat(40));
    const next = await s.createPR();
    expect(next.id).not.toBe(pr.id);
    const nextKey = (await (
        await s.api(`/pull-request-reviews/${next.id}/capture-key`, "POST")
    ).json()) as { token: string };
    await s.capture(nextKey.token, "round-two", {
        comment: "New preview feedback",
        visibility: "shared",
    });
    const p2 = (await (
        await s.api(`/pull-request-reviews/${next.id}/preview`, "POST", {})
    ).json()) as { hash: string; operation: string };
    s.setUncertain();
    expect(
        (
            await s.api(`/pull-request-reviews/${next.id}/publish`, "POST", {
                hash: p2.hash,
                operation: p2.operation,
            })
        ).status
    ).toBe(409);
    expect(s.writes()).toBe(2);
    expect(
        (
            await s.api(`/pull-request-reviews/${next.id}/publish`, "POST", {
                hash: p2.hash,
                operation: p2.operation,
            })
        ).status
    ).toBe(409);
    expect(s.writes()).toBe(2);
    const checked = (await (
        await s.api(`/pull-request-reviews/${next.id}/reconcile`, "POST", {})
    ).json()) as { found: boolean };
    expect(checked.found).toBe(true);
});
it("lets Free try an existing project, a checkout pair and PR capture within six keys", async () => {
    const s = await setup(),
        owner = s.sessions.get("alice")!;
    for (const name of ["bob", "carol", "dan", "qa"])
        await s.rt.store.removeMembership(s.workspace, s.sessions.get(name)!.username);
    await s.rt.store.selectWorkspacePlan(s.workspace, owner.username, "free", 0);
    await s.rt.auth.issueToken("shop", "Initial app", {
        workspaceId: s.workspace,
        createdBy: owner.username,
        ownership: "service",
        purpose: "app",
        permission: "capture",
    });
    await s.rt.auth.issueToken("shop", "Initial agent", {
        workspaceId: s.workspace,
        createdBy: owner.username,
        ownership: "project",
        purpose: "agent",
    });
    const context = (await (
        await s.api("/projects/shop/contexts", "POST", { name: "My checkout" })
    ).json()) as DevelopmentContext;
    expect((await s.api(`/contexts/${context.id}/credentials`, "POST", {})).status).toBe(201);
    const pr = await s.createPR();
    expect((await s.api(`/pull-request-reviews/${pr.id}/capture-key`, "POST", {})).status).toBe(
        201
    );
    expect((await s.rt.store.workspaceUsage(s.workspace)).tokens).toBe(5);
});
