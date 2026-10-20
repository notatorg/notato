import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeBundle } from "@notato/core";
import { SCHEMA_VERSION } from "@notato/schema";
import { PostgresStore } from "../src/postgres-store.ts";
import type { TokenRecord } from "../src/storage.ts";
import { annotationFixture, cleanupAfterEach, tempDir } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { embeddedPostgres } from "./postgres.ts";
import { startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
async function setup(_kind: "postgres") {
    const store = (await embeddedPostgres()).store;
    const configFile = join(tempDir(defer, "token-purpose-config-"), "notato.config.json");
    const s = await startServe(defer, {
        configFile,
        store,
        managedAuth: fakeManagedAuth(),
        testPlans: true,
    });
    const account = await customer(s, "alice");
    const board = {
        cookie: account.cookie,
        "content-type": "application/json",
        origin: s.base,
        "X-Notato-Board": "1",
    };
    const me = (await (await s.call("/auth/me", { headers: board })).json()) as {
        username: string;
        workspace: { id: string };
    };
    await store.selectWorkspacePlan(me.workspace.id, me.username, "pro", 0);
    await s.rt.backend.createWorkspaceProject("p", "Project", me.workspace.id);
    await s.rt.backend.createWorkspaceProject("q", "Other project", me.workspace.id);
    await store.setProjectOrigins("p", ["http://localhost:5000"]);
    const token = async (purpose: "app" | "agent", permission: "capture" | "full") => {
        const response = await s.call("/tokens", {
            method: "POST",
            headers: board,
            body: JSON.stringify({
                projectId: "p",
                name: `${purpose}-${permission}`,
                purpose,
                permission,
                expiresInDays: 90,
            }),
        });
        expect(response.status).toBe(201);
        const result = (await response.json()) as { token: string; record: TokenRecord };
        expect(result.record.purpose).toBe(purpose);
        expect(result.record).not.toHaveProperty("tokenHash");
        return result;
    };
    return { s, store, board, me, token, configFile };
}

describe.each(["postgres"] as const)("%s token purposes", (kind) => {
    it("persists capture receipts without double charging retries or exposing later replies", async () => {
        const { s, store, token, me } = await setup(kind);
        const app = await token("app", "capture");
        const other = await token("app", "capture");
        const note = annotationFixture({ projectId: "p", screenshots: undefined });
        const send = (value = note, key = app.token) => {
            const form = new FormData();
            form.set("annotation", JSON.stringify(value));
            return s.call("/projects/p/annotations", {
                method: "POST",
                headers: { authorization: `Bearer ${key}`, origin: "http://localhost:5000" },
                body: form,
            });
        };
        expect((await send()).status).toBe(201);
        const before = await store.monthlyNoteUsage(me.workspace.id);
        const receipt = await store.getCaptureReceipt(note.id);
        expect(receipt?.scope).toHaveLength(64);
        expect(receipt?.fingerprint).toHaveLength(64);
        await s.rt.backend.reply(note.id, "Private board reply", { kind: "human" });
        const retry = await send();
        expect(retry.status).toBe(200);
        expect(JSON.stringify(await retry.json())).not.toContain("Private board reply");
        expect(await store.monthlyNoteUsage(me.workspace.id)).toEqual(before);
        expect((await store.workspaceUsage(me.workspace.id)).notes).toBe(1);
        expect((await send({ ...note, comment: "Another submission" })).status).toBe(409);
        expect((await send(note, other.token)).status).toBe(409);
        expect(await store.getCaptureReceipt(note.id)).toEqual(receipt);
    });

    it("accepts a capture bundle through the allowed origin and charges only its new notes", async () => {
        const { s, store, token, me } = await setup(kind);
        const app = await token("app", "capture");
        const note = annotationFixture({
            projectId: "p",
            screenshots: undefined,
            status: "resolved",
        });
        const zip = await writeBundle(
            {
                id: "capture-batch",
                projectId: "p",
                createdAt: note.createdAt,
                author: { name: "Tester" },
                annotations: [note],
                schemaVersion: SCHEMA_VERSION,
            },
            async () => undefined
        );
        const upload = (origin = "http://localhost:5000") =>
            s.call("/projects/p/bundles", {
                method: "POST",
                headers: {
                    authorization: `Bearer ${app.token}`,
                    origin,
                    "content-type": "application/zip",
                },
                body: new Uint8Array(zip),
            });
        expect((await upload("https://untrusted.example")).status).toBe(403);
        expect((await upload()).status).toBe(201);
        const before = await store.monthlyNoteUsage(me.workspace.id);
        expect((await upload()).status).toBe(200);
        expect(await store.monthlyNoteUsage(me.workspace.id)).toEqual(before);
        expect((await store.getAnnotation(note.id))?.annotation.status).toBe("open");
        expect((await store.workspaceUsage(me.workspace.id)).notes).toBe(1);
        expect(
            (
                await s.call("/projects/p/bundles", {
                    headers: {
                        authorization: `Bearer ${app.token}`,
                        origin: "http://localhost:5000",
                    },
                })
            ).status
        ).toBe(403);
    });

    it("lets app/tester feedback tokens capture, read, reply and edit through an allowed SDK origin without MCP or agent operations", async () => {
        const { s, store, token } = await setup(kind);
        const app = await token("app", "full");
        const headers = {
            authorization: `Bearer ${app.token}`,
            origin: "http://localhost:5000",
            "content-type": "application/json",
        };
        const capabilities = await s.call("/config?project=p", { headers });
        expect(await capabilities.json()).toMatchObject({
            captureOnly: false,
            derivedScreenshots: true,
        });
        const note = annotationFixture({
            projectId: "p",
            author: { kind: "agent", name: "Supplied name" },
            screenshots: undefined,
        });
        const form = new FormData();
        form.set("annotation", JSON.stringify(note));
        const captured = await s.call("/projects/p/annotations", {
            method: "POST",
            headers: { authorization: headers.authorization, origin: headers.origin },
            body: form,
        });
        expect(captured.status).toBe(201);
        expect(
            ((await captured.json()) as { annotation: { author: { kind: string } } }).annotation
                .author.kind
        ).toBe("human");
        const read = await s.call(`/annotations/${note.id}`, { headers });
        expect(read.status).toBe(200);
        expect(read.headers.get("access-control-allow-origin")).toBe(headers.origin);
        expect(
            (
                await s.call(`/annotations/${note.id}`, {
                    headers: { ...headers, origin: "https://attacker.test" },
                })
            ).status
        ).toBe(403);
        const replied = await s.call(`/annotations/${note.id}/replies`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                body: "Tester reply",
                author: { kind: "agent", name: "Tester" },
            }),
        });
        expect(replied.status).toBe(201);
        expect((await store.getAnnotation(note.id))?.annotation.thread.at(-1)?.author.kind).toBe(
            "human"
        );
        expect(
            (
                await s.call(`/annotations/${note.id}`, {
                    method: "PATCH",
                    headers,
                    body: JSON.stringify({ comment: "Updated by tester" }),
                })
            ).status
        ).toBe(200);
        expect(
            (
                await s.call("/projects/q/annotations", {
                    headers: { authorization: headers.authorization },
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call("/projects/p/annotations", {
                    headers: { ...headers, "X-Notato-Agent": "untrusted-agent" },
                })
            ).status
        ).toBe(403);
        expect((await s.call("/projects/p/events?agent=1", { headers })).status).toBe(403);
        expect(
            (await s.call("/relay/annotate", { method: "POST", headers, body: "{}" })).status
        ).toBe(403);
        // Waiting for new notes is how an agent watches: an app token never makes a page show one watching.
        const wait = "/annotations/wait?timeoutMs=50";
        expect(
            (await s.call(wait, { headers: { authorization: headers.authorization } })).status
        ).toBe(403);
        const agent = await token("agent", "full");
        expect(
            (await s.call(wait, { headers: { authorization: `Bearer ${agent.token}` } })).status
        ).toBe(200);
        for (const method of ["GET", "POST", "DELETE"]) {
            expect(
                (
                    await s.call("/mcp", {
                        method,
                        headers: {
                            authorization: headers.authorization,
                            "content-type": "application/json",
                        },
                        ...(method === "POST" ? { body: "{}" } : {}),
                    })
                ).status
            ).toBe(403);
        }
        await s.rt.auth.revokeToken(app.record.id);
        expect((await s.call(`/annotations/${note.id}`, { headers })).status).toBe(401);
    });

    it("keeps personal tokens private to their user and project credentials independent of their creator", async () => {
        const { s, store, board, me, token } = await setup(kind);
        const personal = await token("app", "full");
        expect(personal.record.ownership).toBe("user");
        expect(personal.record.ownerUsername).toBe(me.username);
        const bob = await customer(s, "bob");
        const bobHeaders = { ...board, cookie: bob.cookie };
        const bobMe = (await (await s.call("/auth/me", { headers: bobHeaders })).json()) as {
            username: string;
        };
        await store.setMembership({
            workspaceId: me.workspace.id,
            username: bobMe.username,
            role: "member",
            createdAt: new Date().toISOString(),
        });
        await s.call("/auth/workspace", {
            method: "POST",
            headers: bobHeaders,
            body: JSON.stringify({ workspaceId: me.workspace.id }),
        });
        const create = (
            headers: typeof board,
            ownership: string,
            purpose = "app",
            projectId = "p"
        ) =>
            s.call("/tokens", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    name: ownership,
                    projectId,
                    purpose,
                    permission: "full",
                    ownership,
                }),
            });
        const bobToken = await create(bobHeaders, "user");
        expect(bobToken.status).toBe(201);
        const bobKey = (await bobToken.json()) as { token: string; record: TokenRecord };
        expect(bobKey.record.ownerUsername).toBe(bobMe.username);
        const listing = (await (await s.call("/tokens", { headers: bobHeaders })).json()) as {
            items: TokenRecord[];
        };
        expect(listing.items.map((t) => t.id)).toEqual([bobKey.record.id]);
        expect(
            (
                await s.call(`/tokens/${personal.record.id}`, {
                    method: "DELETE",
                    headers: bobHeaders,
                })
            ).status
        ).toBe(404);
        expect((await create(bobHeaders, "service")).status).toBe(403);
        expect((await create(bobHeaders, "project", "agent")).status).toBe(403);
        expect((await create(board, "project", "agent", "*")).status).toBe(400);
        const service = await create(board, "service");
        expect(service.status).toBe(201);
        const serviceKey = (await service.json()) as { token: string; record: TokenRecord };
        const agent = await token("agent", "full");
        expect(agent.record.ownership).toBe("project");
        // Personal feedback is attributed to the account, whatever the SDK supplies.
        const note = annotationFixture({
            projectId: "p",
            author: { kind: "human", name: "Impersonated" },
            screenshots: undefined,
        });
        const form = new FormData();
        form.set("annotation", JSON.stringify(note));
        expect(
            (
                await s.call("/projects/p/annotations", {
                    method: "POST",
                    headers: { authorization: `Bearer ${bobKey.token}` },
                    body: form,
                })
            ).status
        ).toBe(201);
        expect((await store.getAnnotation(note.id))?.annotation.author.name).toBe("bob");
        await s.call(`/annotations/${note.id}/replies`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${bobKey.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                body: "Reply",
                author: { kind: "human", name: "Another person" },
            }),
        });
        expect((await store.getAnnotation(note.id))?.annotation.thread.at(-1)?.author.name).toBe(
            "bob"
        );
        await store.removeMembership(me.workspace.id, bobMe.username);
        expect(
            (
                await s.call("/projects/p/annotations", {
                    headers: { authorization: `Bearer ${bobKey.token}` },
                })
            ).status
        ).toBe(401);
        // Transfer ownership before the creator leaves; shared credentials survive, personal ones do not.
        await store.setMembership({
            workspaceId: me.workspace.id,
            username: bobMe.username,
            role: "owner",
            createdAt: new Date().toISOString(),
        });
        await store.removeMembership(me.workspace.id, me.username);
        for (const key of [serviceKey.token, agent.token])
            expect(
                (
                    await s.call("/projects/p/annotations", {
                        headers: { authorization: `Bearer ${key}` },
                    })
                ).status
            ).toBe(200);
        expect(
            (
                await s.call("/projects/p/annotations", {
                    headers: { authorization: `Bearer ${personal.token}` },
                })
            ).status
        ).toBe(401);
    });

    it("requires agent-purpose credentials for MCP, blocks browser agent reads, and lets human feedback continue while agents are off", async () => {
        const { s, token, configFile, board } = await setup(kind);
        expect(
            (
                await s.call("/mcp", {
                    method: "POST",
                    headers: {
                        cookie: board.cookie,
                        "content-type": "application/json",
                        accept: "application/json, text/event-stream",
                    },
                    body: "{}",
                })
            ).status
        ).toBe(403);
        const capture = await token("app", "capture"),
            feedback = await token("app", "full"),
            agent = await token("agent", "full");
        for (const key of [capture, feedback]) {
            const response = await s.call("/mcp", {
                method: "POST",
                headers: {
                    authorization: `Bearer ${key.token}`,
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                },
                body: "{}",
            });
            expect(response.status).toBe(403);
            expect(await response.text()).toContain("agent token is required");
        }
        expect(
            (
                await s.call("/projects/p/annotations", {
                    headers: { authorization: `Bearer ${capture.token}` },
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call("/projects/p/annotations", {
                    headers: {
                        authorization: `Bearer ${agent.token}`,
                        origin: "http://localhost:5000",
                    },
                })
            ).status
        ).toBe(403);
        const client = new Client({ name: "Purpose test", version: "1" });
        const transport = new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${agent.token}` } },
        });
        await client.connect(transport);
        defer(() => client.close().catch(() => {}));
        expect((await client.listTools()).tools.length).toBeGreaterThan(0);
        // A live MCP session cannot be reused with a human token.
        expect(
            (
                await s.call("/mcp", {
                    method: "GET",
                    headers: {
                        authorization: `Bearer ${feedback.token}`,
                        "mcp-session-id": transport.sessionId ?? "",
                        accept: "text/event-stream",
                    },
                })
            ).status
        ).toBe(403);
        writeFileSync(configFile, JSON.stringify({ mcp: "off" }));
        s.rt.backend.config.invalidate?.();
        expect(
            (
                await s.call("/projects/p/annotations", {
                    headers: { authorization: `Bearer ${agent.token}` },
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call("/projects/p/annotations", {
                    headers: { authorization: `Bearer ${feedback.token}` },
                })
            ).status
        ).toBe(200);
    });

    it("rejects invalid purpose/scope combinations and counts both human access levels in the same Free allowance", async () => {
        const { s, store, board, me, token } = await setup(kind);
        for (const body of [
            { purpose: "app", permission: "full", projectId: "*" },
            { purpose: "agent", permission: "capture", projectId: "p" },
            { purpose: "unknown", permission: "full", projectId: "p" },
        ])
            expect(
                (
                    await s.call("/tokens", {
                        method: "POST",
                        headers: board,
                        body: JSON.stringify({ name: "Invalid", ...body }),
                    })
                ).status
            ).toBe(400);
        const capture = await token("app", "capture"),
            feedback = await token("app", "full"),
            agent = await token("agent", "full");
        for (let i = 0; i < 4; i++) await token("app", "capture");
        await s.rt.backend.deleteProject("q");
        const state = (await (await s.call("/billing/recovery", { headers: board })).json()) as {
            canConvert: boolean;
            requirements: Array<{ id: string; current: number; met: boolean }>;
        };
        expect(state.canConvert).toBe(false);
        expect(state.requirements.find((r) => r.id === "tokens")).toMatchObject({
            current: 7,
            met: false,
        });
        await s.rt.auth.revokeToken(capture.record.id);
        await store.selectWorkspacePlan(me.workspace.id, me.username, "free", 0);
        const extra = await s.call("/tokens", {
            method: "POST",
            headers: board,
            body: JSON.stringify({
                name: "Extra human",
                projectId: "p",
                purpose: "app",
                permission: "capture",
            }),
        });
        expect(extra.status).toBe(429);
        expect(
            (
                await s.call("/projects/p/annotations", {
                    headers: { authorization: `Bearer ${feedback.token}` },
                })
            ).status
        ).toBe(200);
        expect(
            (
                await s.call("/projects/p/annotations", {
                    headers: { authorization: `Bearer ${agent.token}` },
                })
            ).status
        ).toBe(200);
    });
});

it("upgrades Postgres v11 tokens with the same conservative purpose mapping", async () => {
    const { store, pg, database } = await embeddedPostgres();
    for (const permission of ["capture", "full"] as const)
        await store.createToken({
            id: permission,
            name: permission,
            projectId: "p",
            tokenHash: permission,
            permission,
            createdAt: new Date().toISOString(),
        });
    await pg.exec(
        "ALTER TABLE notato.tokens DROP COLUMN purpose; UPDATE notato.meta SET value='11' WHERE key='schema_version'"
    );
    const upgraded = await PostgresStore.open(database);
    defer(() => upgraded.close());
    expect(await upgraded.findToken("capture")).toMatchObject({
        id: "capture",
        purpose: "app",
        permission: "capture",
    });
    expect(await upgraded.findToken("full")).toMatchObject({
        id: "full",
        purpose: "agent",
        permission: "full",
    });
});

it("migrates v12 token ownership and provider binding without changing credentials", async () => {
    const { store, pg, database } = await embeddedPostgres();
    const at = new Date().toISOString();
    await store.upsertUser({
        username: "owner",
        passwordHash: "synthetic",
        createdAt: at,
        identityProvider: "provider:one",
        identitySubject: "owner",
    });
    await pg.query(
        "UPDATE notato.users SET identity_provider=$1,identity_subject=$2 WHERE username=$3",
        ["provider:one", "owner", "owner"]
    );
    await store.createWorkspace({ id: "company", name: "Company", createdAt: at }, "owner");
    for (const [id, purpose, createdBy] of [
        ["embedded", "app", undefined],
        ["personal", "app", "owner"],
        ["agent", "agent", "owner"],
    ] as const)
        await store.createToken({
            id,
            name: id,
            projectId: "project",
            workspaceId: "company",
            tokenHash: id,
            purpose,
            permission: "full",
            createdBy,
            createdAt: at,
        });
    await pg.exec(
        "ALTER TABLE notato.tokens DROP COLUMN ownership, DROP COLUMN owner_username, DROP COLUMN identity_namespace; UPDATE notato.meta SET value='12' WHERE key='schema_version'"
    );
    const upgraded = await PostgresStore.open(database);
    defer(() => upgraded.close());
    expect(await upgraded.findToken("personal")).toMatchObject({
        tokenHash: "personal",
        ownership: "user",
        ownerUsername: "owner",
        identityNamespace: "provider:one",
    });
    expect(await upgraded.findToken("embedded")).toMatchObject({
        tokenHash: "embedded",
        ownership: "service",
        identityNamespace: "provider:one",
    });
    expect(await upgraded.findToken("agent")).toMatchObject({
        tokenHash: "agent",
        ownership: "project",
        identityNamespace: "provider:one",
    });
});
