import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Annotation } from "@notato/schema";
import {
    cleanupAfterEach,
    filesFor,
    multipart,
    annotationFixture as privateFixture,
    waitFor,
} from "./helpers.ts";
import { bearer, post as captureFeedback, type Server, sse, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
const annotationFixture = (over: Partial<Annotation> = {}) =>
    privateFixture({ visibility: "shared", ...over });
const post: typeof captureFeedback = (server, token, project, over = {}) =>
    captureFeedback(server, token, project, { visibility: "shared", ...over });
const at = "2026-10-12T12:00:00.000Z";
const password = "workspace password";

async function signIn(s: Server, username: string) {
    const res = await s.call("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(200);
    return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] as string };
}

async function setup() {
    const s = await startServe(defer);
    for (const username of ["alice", "bob", "carol"])
        await s.rt.auth.createAccount(username, password);
    for (const id of ["acme", "other", "empty"])
        await s.rt.store.createWorkspace({ id, name: id, createdAt: at }, "admin");
    for (const [username, workspaceId, role] of [
        ["alice", "acme", "admin"],
        ["bob", "acme", "member"],
        ["carol", "other", "owner"],
    ] as const)
        await s.rt.store.setMembership({ username, workspaceId, role, createdAt: at });
    await s.rt.backend.createWorkspaceProject("alpha", "Alpha", "acme");
    await s.rt.backend.createWorkspaceProject("beta", "Beta", "other");
    const a = await s.rt.auth.issueToken("alpha", "Alpha app");
    const b = await s.rt.auth.issueToken("beta", "Beta app");
    const own = await post(s, a.token, "alpha", { comment: "Acme private feedback" });
    // Separate image bytes ensure content-addressed assets are not accidentally shared by the fixtures.
    const other = annotationFixture({
        projectId: "beta",
        comment: "Other company private feedback",
        screenshots: undefined,
    });
    await s.rt.backend.ingest(other, new Map(), { projectId: "beta" });
    return {
        s,
        alice: await signIn(s, "alice"),
        bob: await signIn(s, "bob"),
        a,
        b,
        own: ((await own.res.json()) as { annotation: Annotation }).annotation,
        other,
    };
}

function write(headers: Record<string, string>, body: unknown, method = "POST"): RequestInit {
    return {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
    };
}

describe("hosted workspace access", () => {
    it("limits HTTP lists, direct reads, mutations, screenshots, bundles and relay to the selected workspace", async () => {
        const { s, alice, own, other, b } = await setup();
        const projects = (await (await s.call("/projects", { headers: alice })).json()) as {
            items: { id: string }[];
        };
        expect(projects.items.map((p) => p.id)).toEqual(["alpha"]);
        const notes = (await (await s.call("/annotations", { headers: alice })).json()) as {
            items: { annotation: { projectId: string } }[];
        };
        expect(notes.items.map((item) => item.annotation.projectId)).toEqual(["alpha"]);
        for (const path of [
            "/projects/beta",
            "/projects/beta/annotations",
            "/projects/beta/markdown",
            "/projects/beta/export",
            "/projects/beta/bundles",
            "/projects/beta/events",
            `/annotations/${other.id}`,
            `/annotations/${other.id}/markdown`,
            "/annotations?project=beta",
            "/config?project=beta",
        ])
            expect((await s.call(path, { headers: alice })).status).toBe(403);
        expect(
            (
                await s.call(
                    `/annotations/${other.id}`,
                    write(alice, { status: "resolved" }, "PATCH")
                )
            ).status
        ).toBe(403);
        expect(
            (await s.call(`/annotations/${other.id}`, { method: "DELETE", headers: alice })).status
        ).toBe(403);
        expect(
            (await s.call(`/annotations/${other.id}/replies`, write(alice, { body: "intrusion" })))
                .status
        ).toBe(403);
        expect(
            (
                await s.call(
                    "/relay/annotate",
                    write(alice, { projectId: "beta", target: "body", comment: "intrusion" })
                )
            ).status
        ).toBe(403);
        expect(
            (
                await s.call("/bundles", {
                    method: "POST",
                    headers: alice,
                    body: new Uint8Array([1]),
                })
            ).status
        ).toBe(403);
        // A foreign screenshot is unavailable even when its exact hash is known.
        const image = new Uint8Array([...filesFor().values()][0] as Uint8Array);
        image[image.length - 1] = (image[image.length - 1] ?? 0) ^ 1;
        const blob = await s.rt.backend.blobs.put(image);
        const foreign = annotationFixture({
            projectId: "beta",
            screenshots: {
                full: { id: blob.id, mime: "image/png", w: 1, h: 1 },
            },
        });
        const sent = await s.call("/projects/beta/annotations", {
            method: "POST",
            headers: bearer(b.token),
            body: multipart(foreign, new Map([[blob.id, image]])),
        });
        expect(sent.status).toBe(201);
        expect((await s.call(`/assets/${blob.id}`, { headers: alice })).status).toBe(404);
        const ownAsset = await s.call(`/assets/${own.screenshots?.full?.id}`, { headers: alice });
        expect(ownAsset.status).toBe(200);
        expect(ownAsset.headers.get("cache-control")).toContain("no-store");
        expect((await s.call(`/annotations/${own.id}`, { headers: alice })).status).toBe(200);
    });

    it("lets owners/admins manage their projects and workspace tokens, without operator privileges", async () => {
        const { s, alice, bob } = await setup();
        for (const path of ["/admin/tokens", "/admin/workspaces", "/settings", "/webhooks"])
            expect((await s.call(path, { headers: alice })).status).toBe(403);
        expect((await s.call("/projects", write(bob, { id: "member-project" }))).status).toBe(403);
        expect((await s.call("/tokens", { headers: bob })).status).toBe(200);
        expect(
            (await s.call("/projects", write(alice, { id: "intrusion", workspaceId: "other" })))
                .status
        ).toBe(403);
        const created = await s.call("/projects", write(alice, { id: "new-project" }));
        expect(created.status).toBe(201);
        expect((await s.rt.store.getProject("new-project"))?.workspaceId).toBe("acme");
        const issued = await s.call(
            "/tokens",
            write(alice, { projectId: "alpha", name: "Acme agent", purpose: "agent" })
        );
        expect(issued.status).toBe(201);
        const token = (await issued.json()) as {
            token: string;
            record: { workspaceId: string; id: string };
        };
        expect(token.record.workspaceId).toBe("acme");
        const headers = bearer(token.token);
        const projects = (await (await s.call("/projects", { headers })).json()) as {
            items: { id: string }[];
        };
        expect(projects.items.map((p) => p.id).sort()).toEqual(["alpha"]);
        expect((await s.call("/projects/beta", { headers })).status).toBe(403);
        expect((await s.call("/admin/tokens", { headers })).status).toBe(403);
        expect(
            (
                await s.call(
                    "/tokens",
                    write(alice, {
                        projectId: "alpha",
                        name: "wrong",
                        workspaceId: "other",
                        purpose: "agent",
                    })
                )
            ).status
        ).toBe(403);
        const foreign = await s.rt.auth.issueToken("*", "Other agent", { workspaceId: "other" });
        expect(
            (await s.call(`/tokens/${foreign.record.id}`, { method: "DELETE", headers: alice }))
                .status
        ).toBe(404);
        const list = (await (await s.call("/tokens", { headers: alice })).json()) as {
            items: { workspaceId: string }[];
        };
        expect(list.items.every((record) => record.workspaceId === "acme")).toBe(true);
        expect(
            (await s.call(`/tokens/${token.record.id}`, { method: "DELETE", headers: alice }))
                .status
        ).toBe(204);
        expect((await s.call("/projects", { headers })).status).toBe(401);
        expect(
            (await s.call("/projects/alpha", write(alice, { name: "Renamed" }, "PATCH"))).status
        ).toBe(200);
        expect(
            (await s.call("/projects/new-project", { method: "DELETE", headers: alice })).status
        ).toBe(204);
    });

    it("switches only to memberships, including an empty workspace with no data or agent metadata", async () => {
        const { s, alice } = await setup();
        expect(
            (await s.call("/auth/workspace", write(alice, { workspaceId: "other" }))).status
        ).toBe(403);
        await s.rt.store.setMembership({
            workspaceId: "empty",
            username: "alice",
            role: "member",
            createdAt: at,
        });
        s.rt.backend.agents.touch("foreign", "Other company agent", ["beta"]);
        expect(
            (await s.call("/auth/workspace", write(alice, { workspaceId: "empty" }))).status
        ).toBe(200);
        expect(await (await s.call("/auth/me", { headers: alice })).json()).toMatchObject({
            isAdmin: false,
            workspace: { id: "empty", role: "member" },
        });
        expect(await (await s.call("/projects", { headers: alice })).json()).toEqual({ items: [] });
        expect(await (await s.call("/annotations", { headers: alice })).json()).toEqual({
            items: [],
        });
        const status = (await (await s.call("/status", { headers: alice })).json()) as Record<
            string,
            unknown
        >;
        expect(status.agents).toMatchObject({ connected: false, names: [] });
        expect(status.config).not.toHaveProperty("file");
        expect(status).not.toHaveProperty("watchers");
        expect(status.pages).toBe(0);
    });

    it("filters wildcard streams and closes them when tokens are revoked or the selected workspace changes", async () => {
        const { s, alice, a, b } = await setup();
        const token = await s.rt.auth.issueToken("*", "Acme stream", { workspaceId: "acme" });
        const stop = new AbortController();
        defer(() => stop.abort());
        const response = await s.call("/projects/*/events?scope=shared", {
            headers: bearer(token.token),
            signal: stop.signal,
        });
        const next = sse(response);
        await next("hello");
        await post(s, b.token, "beta", { comment: "foreign stream event" });
        const own = await post(s, a.token, "alpha", { comment: "own stream event" });
        expect(await next("created")).toMatchObject({
            id: own.a.id,
            projectId: "alpha",
        });
        // Check EOF directly on a separate stream; a revoked token must receive no following payload.
        const revoked = await s.call("/projects/*/events?scope=shared", {
            headers: bearer(token.token),
            signal: stop.signal,
        });
        const reader = (revoked.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        await s.rt.auth.revokeToken(token.record.id);
        await post(s, a.token, "alpha", { comment: "after revocation" });
        expect((await reader.read()).done).toBe(true);
        const switched = await s.call("/projects/*/events?scope=shared", {
            headers: alice,
            signal: stop.signal,
        });
        const switchedReader = (switched.body as ReadableStream<Uint8Array>).getReader();
        await switchedReader.read();
        await s.rt.store.setMembership({
            workspaceId: "other",
            username: "alice",
            role: "member",
            createdAt: at,
        });
        await s.call("/auth/workspace", write(alice, { workspaceId: "other" }));
        await post(s, b.token, "beta", { comment: "after workspace switch" });
        expect((await switchedReader.read()).done).toBe(true);
        stop.abort();
    });

    it("scopes MCP reads and pending watches and immediately rejects a removed membership", async () => {
        const { s, alice, a, other } = await setup();
        const client = new Client({ name: "workspace-agent", version: "0" });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
                requestInit: { headers: alice },
            })
        );
        defer(() => client.close().catch(() => {}));
        const call = (name: string, args: Record<string, unknown> = {}) =>
            client.callTool({
                name,
                arguments: ["notato_list_open", "notato_watch"].includes(name)
                    ? { scope: "shared", ...args }
                    : args,
            });
        const listed = JSON.stringify(await call("notato_list_open"));
        expect(listed).toContain("Acme private feedback");
        expect(listed).not.toContain("Other company private feedback");
        expect(JSON.stringify(await call("notato_get", { id: other.id }))).not.toContain(
            "Other company private feedback"
        );
        await call("notato_watch", {
            timeoutSeconds: 1,
            scope: "shared",
            windowMs: 0,
            screenshots: "none",
        });
        const watchers = s.rt.backend.bus.size;
        const waiting = call("notato_watch", {
            timeoutSeconds: 1,
            scope: "shared",
            windowMs: 0,
            screenshots: "none",
        }).then(
            (result) => JSON.stringify(result),
            (error: Error) => error.message
        );
        expect(await waitFor(() => s.rt.backend.bus.size > watchers)).toBe(true);
        await s.rt.store.removeMembership("acme", "alice");
        await post(s, a.token, "alpha", { comment: "must not reach removed member" });
        const outcome = await waiting;
        expect(outcome).not.toContain("must not reach removed member");
        expect((await s.call("/projects", { headers: alice })).status).toBe(401);
        await expect(call("notato_list_open")).rejects.toThrow();
    });

    it("keeps workspace agent tokens scoped over MCP, including projects added during the session", async () => {
        const { s, other } = await setup();
        const token = await s.rt.auth.issueToken("*", "Acme agent", { workspaceId: "acme" });
        const client = new Client({ name: "Acme agent", version: "0" });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
                requestInit: { headers: bearer(token.token) },
            })
        );
        defer(() => client.close().catch(() => {}));
        const call = (name: string, args: Record<string, unknown> = {}) =>
            client.callTool({
                name,
                arguments: ["notato_list_open", "notato_watch"].includes(name)
                    ? { scope: "shared", ...args }
                    : args,
            });
        const listed = JSON.stringify(await call("notato_list_open"));
        expect(listed).toContain("Acme private feedback");
        expect(listed).not.toContain("Other company private feedback");
        expect(JSON.stringify(await call("notato_get", { id: other.id }))).not.toContain(
            "Other company private feedback"
        );
        await s.rt.backend.createWorkspaceProject("later", "Later", "acme");
        const app = await s.rt.auth.issueToken("later", "Later app");
        await post(s, app.token, "later", { comment: "new project during agent session" });
        expect(JSON.stringify(await call("notato_list_open"))).toContain(
            "new project during agent session"
        );
        expect(s.rt.backend.agents.stateFor("later").connected).toBe(true);
        // An explicitly requested foreign project cannot escape the backend scope.
        expect(JSON.stringify(await call("notato_list_open", { projectId: "beta" }))).not.toContain(
            "Other company private feedback"
        );
        await s.rt.auth.revokeToken(token.record.id);
        await expect(call("notato_list_open")).rejects.toThrow();
    });
});
