import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { planLimits } from "../src/plans.ts";
import type { WorkspaceBilling, WorkspaceCleanup } from "../src/storage.ts";
import { annotationFixture, cleanupAfterEach, waitFor } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { embeddedPostgres } from "./postgres.ts";
import { startServe } from "./serve-helpers.ts";

interface State extends WorkspaceCleanup {
    owner: boolean;
    usage: { bytes: number };
    canConvert: boolean;
    blockers: string[];
    requirements: Array<{
        id: string;
        step: number;
        current?: number;
        limit?: number;
        met: boolean;
    }>;
    deletionChoices: Array<{ id: string; name: string; canDelete: boolean; reason?: string }>;
}
const defer = cleanupAfterEach();
async function setup(_kind: "postgres" = "postgres") {
    const store = (await embeddedPostgres()).store;
    const managedAuth = fakeManagedAuth();
    const verify = managedAuth.verify.bind(managedAuth);
    managedAuth.verify = async (token) => {
        const identity = await verify(token);
        return identity ? { ...identity, issuedAt: new Date().toISOString() } : null;
    };
    const s = await startServe(defer, {
        store,
        managedAuth,
        workspacePlans: true,
    });
    const alice = await customer(s, "alice");
    const headers = {
        cookie: alice.cookie,
        "content-type": "application/json",
        "X-Notato-Board": "1",
        origin: s.base,
    };
    const me = (await (await s.call("/auth/me", { headers })).json()) as {
        username: string;
        workspace: { id: string; name: string };
    };
    await s.rt.store.setBillingCustomer(me.workspace.id, "cus_recovery");
    const status = async (value: string, end = Date.now() + 3600_000) => {
        const state: WorkspaceBilling = {
            workspaceId: me.workspace.id,
            customerId: "cus_recovery",
            subscriptionId: "sub_recovery",
            plan: "pro",
            status: value,
            periodEnd: new Date(end).toISOString(),
            ...(["active", "trialing"].includes(value)
                ? {
                      entitlement: { id: "pro", extraSeats: 0 },
                      limits: planLimits({ id: "pro", extraSeats: 0 }),
                  }
                : {}),
        };
        await s.rt.store.applyBillingEvent(crypto.randomUUID(), state, new Date().toISOString());
    };
    await status("active");
    for (const id of ["keep", "remove"])
        await s.rt.backend.createWorkspaceProject(id, id, me.workspace.id);
    const cleanup = (kind: string, id: string, extra = {}) =>
        s.call("/billing/recovery/cleanup", {
            method: "POST",
            headers,
            body: JSON.stringify({ kind, id, confirm: "DELETE", ...extra }),
        });
    const complete = () =>
        s.call("/billing/recovery/complete", {
            method: "POST",
            headers,
            body: JSON.stringify({ confirm: me.workspace.name }),
        });
    const info = async (query = "") =>
        (await (await s.call(`/billing/recovery${query}`, { headers })).json()) as State;
    return { s, headers, me, status, cleanup, complete, info };
}

describe.each(["postgres"] as const)("%s recovery wizard", (kind) => {
    it("blocks normal data and integrations after nonpayment, exposes cleanup metadata only, and reactivates Free after explicit cleanup", async () => {
        const { s, headers, me, status, cleanup, complete, info } = await setup(kind);
        const stored = annotationFixture({
            projectId: "remove",
            comment: "SENSITIVE NOTE BODY",
            route: "/cleanup-route",
        });
        await s.rt.store.insertAnnotation(stored, 300 * 1024 ** 2);
        const keys = [];
        for (const permission of ["capture", "capture", "full", "full"] as const)
            keys.push(
                await s.rt.auth.issueToken("keep", permission, {
                    workspaceId: me.workspace.id,
                    permission,
                    createdBy: me.username,
                    expiresInDays: 90,
                })
            );
        const bob = await customer(s, "bob");
        const bobName = (
            (await (await s.call("/auth/me", { headers: { cookie: bob.cookie } })).json()) as {
                username: string;
            }
        ).username;
        await s.rt.store.setMembership({
            workspaceId: me.workspace.id,
            username: bobName,
            role: "member",
            createdAt: new Date().toISOString(),
        });
        await status("past_due");
        expect(
            (
                (await (await s.call("/auth/me", { headers })).json()) as {
                    workspace: { recoveryRequired: boolean };
                }
            ).workspace.recoveryRequired
        ).toBe(true);
        for (const path of [
            "/projects",
            "/projects/keep",
            "/projects/keep/events",
            "/projects/keep/annotations",
            "/projects/keep/annotations/markdown",
            `/annotations/${stored.id}`,
            `/assets/${"a".repeat(64)}`,
            "/workspace",
            "/tokens",
            "/config",
            "/status",
            "/annotations",
            "/projects/keep/bundles",
        ]) {
            const res = await s.call(path, { headers });
            expect(res.status).toBe(402);
            expect(await res.text()).not.toContain("SENSITIVE NOTE BODY");
        }
        expect(
            (
                await s.call(`/annotations/${stored.id}`, {
                    method: "PATCH",
                    headers,
                    body: JSON.stringify({ status: "resolved" }),
                })
            ).status
        ).toBe(402);
        for (const key of keys) {
            expect(
                (
                    await s.call("/projects/keep/annotations", {
                        headers: { authorization: `Bearer ${key.token}` },
                    })
                ).status
            ).toBe(402);
            expect(
                (
                    await s.call("/mcp", {
                        method: "POST",
                        headers: {
                            authorization: `Bearer ${key.token}`,
                            "content-type": "application/json",
                            accept: "application/json, text/event-stream",
                        },
                        body: "{}",
                    })
                ).status
            ).toBe(402);
        }
        let state = await info();
        expect(state.projects).toHaveLength(2);
        expect(state.usage.bytes).toBeGreaterThan(300 * 1024 ** 2);
        expect(state.notes[0]).toMatchObject({ id: stored.id, route: "/cleanup-route" });
        expect(JSON.stringify(state)).not.toContain("SENSITIVE NOTE BODY");
        expect(JSON.stringify(state)).not.toContain("tokenHash");
        expect(state.canConvert).toBe(false);
        expect((await complete()).status).toBe(409); // Subscription must be canceled, not merely delinquent.
        const bobHeaders = { ...headers, cookie: bob.cookie };
        expect(
            (
                await s.call("/auth/workspace", {
                    method: "POST",
                    headers: bobHeaders,
                    body: JSON.stringify({ workspaceId: me.workspace.id }),
                })
            ).status
        ).toBe(200);
        const guest = (await (
            await s.call("/billing/recovery", { headers: bobHeaders })
        ).json()) as Partial<State>;
        expect(guest.owner).toBe(false);
        expect(guest.projects).toBeUndefined();
        expect(guest.notes).toBeUndefined();
        expect(
            (
                await s.call("/billing/recovery/cleanup", {
                    method: "POST",
                    headers: bobHeaders,
                    body: JSON.stringify({ kind: "project", id: "keep", confirm: "DELETE" }),
                })
            ).status
        ).toBe(403);
        expect((await cleanup("project", "remove", { confirm: "WRONG" })).status).toBe(400);
        expect(await s.rt.store.getAnnotation(stored.id)).not.toBeNull();
        await status("canceled");
        expect((await cleanup("project", "remove")).status).toBe(200);
        expect((await cleanup("member", me.username)).status).toBe(400);
        expect((await cleanup("member", bobName)).status).toBe(200);
        expect((await cleanup("token", keys[1]?.record.id ?? "missing-capture")).status).toBe(200);
        expect((await cleanup("token", keys[3]?.record.id ?? "missing-agent")).status).toBe(200);
        state = await info();
        expect(state.canConvert).toBe(true);
        expect(state.blockers).toEqual([]);
        expect((await s.call("/projects", { headers })).status).toBe(402); // Cleanup alone never unlocks access.
        expect((await complete()).status).toBe(200);
        expect((await s.call("/projects", { headers })).status).toBe(200);
        expect((await s.rt.store.getWorkspacePlan(me.workspace.id))?.id).toBe("free");
        expect((await s.rt.store.monthlyNoteUsage(me.workspace.id)).notes).toBe(1);
        expect(await s.rt.store.getAnnotation(stored.id)).toBeNull();
    });

    it("enforces one Free workspace, scopes cleanup, validates pagination, and never refunds monthly receipts", async () => {
        const { s, headers, me, status, cleanup, complete, info } = await setup(kind);
        await s.rt.store.createWorkspace(
            { id: "other-free", name: "Other Free", createdAt: new Date().toISOString() },
            me.username,
            { id: "free", extraSeats: 0 }
        );
        await s.rt.backend.createWorkspaceProject("foreign", "Foreign", "other-free");
        const foreignToken = await s.rt.auth.issueToken("foreign", "FOREIGN TOKEN", {
            workspaceId: "other-free",
            permission: "capture",
            createdBy: me.username,
            expiresInDays: 90,
        });
        const note = annotationFixture({ projectId: "foreign" });
        await s.rt.store.insertAnnotation(note);
        for (let n = 0; n < 101; n++)
            await s.rt.store.insertAnnotation(
                annotationFixture({ id: crypto.randomUUID(), projectId: "keep" })
            );
        await status("canceled");
        expect((await info()).otherFreeWorkspace).toMatchObject({ id: "other-free" });
        expect((await cleanup("project", "foreign")).status).toBe(404);
        expect((await cleanup("token", foreignToken.record.id)).status).toBe(404);
        expect(JSON.stringify(await info())).not.toContain("FOREIGN TOKEN");
        expect((await cleanup("note", note.id)).status).toBe(404);
        expect((await s.call("/billing/recovery?project=foreign", { headers })).status).toBe(404);
        expect((await s.call("/billing/recovery?before=NaN", { headers })).status).toBe(400);
        expect(
            (
                await s.call("/billing/recovery/cleanup", {
                    method: "POST",
                    headers: { ...headers, origin: "https://attacker.test" },
                    body: JSON.stringify({ kind: "project", id: "keep", confirm: "DELETE" }),
                })
            ).status
        ).toBe(403);
        const first = await info();
        expect(first.notes).toHaveLength(50);
        expect(first.next).toBeGreaterThan(0);
        const second = await info(`?before=${first.next}`);
        expect(second.notes).toHaveLength(50);
        expect(new Set([...first.notes, ...second.notes].map((a) => a.id)).size).toBe(100);
        expect((await cleanup("project", "remove")).status).toBe(200);
        expect((await complete()).status).toBe(409);
        await s.rt.backend.deleteWorkspace("other-free", me.username);
        expect((await info()).canConvert).toBe(true);
        expect((await complete()).status).toBe(200);
        expect((await s.rt.store.monthlyNoteUsage(me.workspace.id)).notes).toBe(101);
        await expect(
            s.rt.store.insertAnnotation(
                annotationFixture({ id: crypto.randomUUID(), projectId: "keep" })
            )
        ).rejects.toThrow("monthly note");
    });

    it("validates every bulk item before deleting, rejects unbounded requests, and reports refreshed token counts", async () => {
        const { s, headers, me, status, info } = await setup(kind);
        await s.rt.store.createWorkspace(
            { id: "foreign-bulk", name: "Foreign", createdAt: new Date().toISOString() },
            me.username
        );
        await s.rt.backend.createWorkspaceProject(
            "foreign-bulk-project",
            "Foreign",
            "foreign-bulk"
        );
        const keys = [];
        for (let i = 0; i < 8; i++)
            keys.push(
                await s.rt.auth.issueToken("keep", `Agent ${i}`, {
                    workspaceId: me.workspace.id,
                    permission: "full",
                    createdBy: me.username,
                    expiresInDays: 90,
                })
            );
        await status("canceled");
        const bulk = (body: unknown) =>
            s.call("/billing/recovery/cleanup", {
                method: "POST",
                headers,
                body: JSON.stringify(body),
            });
        const base = { kind: "project", confirm: "DELETE" };
        expect((await bulk({ ...base, ids: ["remove", "foreign-bulk-project"] })).status).toBe(404);
        expect(await s.rt.store.getProject("remove")).not.toBeNull();
        for (const ids of [[], ["remove", "remove"], Array.from({ length: 51 }, (_, i) => `p${i}`)])
            expect((await bulk({ ...base, ids })).status).toBe(400);
        expect((await bulk({ ...base, id: "remove", ids: ["remove"] })).status).toBe(400);
        expect((await bulk({ ...base, ids: ["remove"], confirm: "WRONG" })).status).toBe(400);
        expect((await info()).requirements.find((r) => r.id === "tokens")).toMatchObject({
            current: 8,
            limit: 6,
            met: false,
            step: 3,
        });
        const ids = keys.slice(1).map((k) => k.record.id);
        const result = await bulk({ kind: "token", ids, confirm: "DELETE" });
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual({ ok: true, completed: ids, failed: [] });
        expect((await info()).requirements.find((r) => r.id === "tokens")).toMatchObject({
            current: 1,
            limit: 6,
            met: true,
        });
        expect((await bulk({ ...base, ids: ["remove"] })).status).toBe(200);
    });

    it("bulk deletes notes without refunding monthly usage and prevents bulk self-removal", async () => {
        const { s, headers, me, status } = await setup(kind);
        const notes = [
            annotationFixture({ id: crypto.randomUUID(), projectId: "keep" }),
            annotationFixture({ id: crypto.randomUUID(), projectId: "keep" }),
        ];
        for (const note of notes) await s.rt.store.insertAnnotation(note);
        const bob = await customer(s, "bob");
        const member = (
            (await (await s.call("/auth/me", { headers: { cookie: bob.cookie } })).json()) as {
                username: string;
            }
        ).username;
        await s.rt.store.setMembership({
            workspaceId: me.workspace.id,
            username: member,
            role: "member",
            createdAt: new Date().toISOString(),
        });
        await status("canceled");
        const bulk = (kind: string, ids: string[]) =>
            s.call("/billing/recovery/cleanup", {
                method: "POST",
                headers,
                body: JSON.stringify({ kind, ids, confirm: "DELETE" }),
            });
        expect((await bulk("member", [member, me.username])).status).toBe(400);
        expect(await s.rt.store.getMembership(me.workspace.id, member)).not.toBeNull();
        expect((await bulk("member", [member])).status).toBe(200);
        expect(
            (
                await bulk(
                    "note",
                    notes.map((n) => n.id)
                )
            ).status
        ).toBe(200);
        for (const note of notes) expect(await s.rt.store.getAnnotation(note.id)).toBeNull();
        expect((await s.rt.store.monthlyNoteUsage(me.workspace.id)).notes).toBe(2);
    });

    it("deletes either workspace only after fresh identity verification, preserves the selected workspace and account receipts", async () => {
        const { s, headers, me, status, info } = await setup(kind);
        await s.rt.store.createWorkspace(
            { id: "other-free", name: "Other Free", createdAt: new Date().toISOString() },
            me.username,
            { id: "free", extraSeats: 0 }
        );
        await s.rt.backend.createWorkspaceProject("other-free-project", "Personal", "other-free");
        await s.rt.store.insertAnnotation(
            annotationFixture({ id: crypto.randomUUID(), projectId: "other-free-project" })
        );
        await status("canceled");
        const destroy = (workspaceId: string, confirm: string, accessToken?: string) =>
            s.call("/billing/recovery/delete-workspace", {
                method: "POST",
                headers,
                body: JSON.stringify({ workspaceId, confirm, accessToken }),
            });
        expect((await info()).deletionChoices).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: me.workspace.id, canDelete: true }),
                expect.objectContaining({ id: "other-free", canDelete: true }),
            ])
        );
        expect((await destroy("other-free", "WRONG", "alice")).status).toBe(400);
        expect((await destroy("other-free", "Other Free")).status).toBe(403);
        expect((await destroy("other-free", "Other Free", "bob")).status).toBe(403);
        const result = await destroy("other-free", "Other Free", "alice");
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual({ ok: true, currentDeleted: false });
        expect(await s.rt.store.getWorkspace("other-free")).toBeNull();
        expect(await s.rt.store.getProject("other-free-project")).toBeNull();
        expect(
            (
                (await (await s.call("/auth/me", { headers })).json()) as {
                    workspace: { id: string };
                }
            ).workspace.id
        ).toBe(me.workspace.id);
        expect((await s.rt.store.monthlyNoteUsage(me.workspace.id)).notes).toBe(1);
        const current = await destroy(me.workspace.id, me.workspace.name, "alice");
        expect(current.status).toBe(200);
        expect(await current.json()).toEqual({ ok: true, currentDeleted: true });
        const next = (await (await s.call("/auth/me", { headers })).json()) as {
            authenticated: boolean;
            workspace: { id: string };
        };
        expect(next.authenticated).toBe(true);
        expect(next.workspace.id).not.toBe(me.workspace.id);
        expect((await s.rt.store.monthlyNoteUsage(next.workspace.id)).notes).toBe(1);
    });

    it("rejects deleting unrelated owned workspaces, other people's workspaces and live subscriptions", async () => {
        const { s, headers, me, status, info } = await setup(kind);
        await s.rt.store.createWorkspace(
            { id: "unrelated-paid", name: "Unrelated", createdAt: new Date().toISOString() },
            me.username,
            { id: "team", extraSeats: 0 }
        );
        const bob = await customer(s, "bob");
        const foreign = (
            (await (await s.call("/auth/me", { headers: { cookie: bob.cookie } })).json()) as {
                workspace: { id: string; name: string };
            }
        ).workspace;
        const destroy = (workspaceId: string, confirm: string, otherHeaders = headers) =>
            s.call("/billing/recovery/delete-workspace", {
                method: "POST",
                headers: otherHeaders,
                body: JSON.stringify({ workspaceId, confirm, accessToken: "alice" }),
            });
        expect(
            (await info()).deletionChoices.find((w) => w.id === me.workspace.id)?.canDelete
        ).toBe(false);
        expect((await destroy(me.workspace.id, me.workspace.name)).status).toBe(409);
        await status("canceled");
        expect((await destroy("unrelated-paid", "Unrelated")).status).toBe(404);
        expect((await destroy(foreign.id, foreign.name)).status).toBe(404);
        expect(
            (
                await destroy(me.workspace.id, me.workspace.name, {
                    ...headers,
                    origin: "https://attacker.test",
                })
            ).status
        ).toBe(403);
        expect(await s.rt.store.getWorkspace(me.workspace.id)).not.toBeNull();
    });
});

it("revokes existing streams, long polls and MCP reads when a paid lease expires, and restores access after verified payment", async () => {
    const { s, headers, me, status } = await setup();
    const key = await s.rt.auth.issueToken("keep", "Agent", {
        workspaceId: me.workspace.id,
        permission: "full",
        createdBy: me.username,
        expiresInDays: 90,
    });
    const client = new Client({ name: "Recovery test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key.token}` } },
    });
    await client.connect(transport);
    defer(() => client.close().catch(() => {}));
    const abort = new AbortController();
    defer(() => abort.abort());
    const baseline = s.rt.backend.bus.size;
    const stream = await s.call("/projects/*/events", { headers, signal: abort.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("Missing event stream");
    await reader.read();
    const waiting = s.call("/annotations/wait?timeoutMs=250", { headers });
    expect(await waitFor(() => s.rt.backend.bus.size >= baseline + 2)).toBe(true);
    await status("active", Date.now() - 1000);
    const note = annotationFixture({ projectId: "keep" });
    // An internal event wakes a pre-existing stream; it must close without disclosing the payload.
    s.rt.backend.bus.publish({
        type: "created",
        id: note.id,
        projectId: "keep",
        seq: 1,
        annotation: note,
    });
    let received = "";
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
    }
    expect(received).not.toContain(note.id);
    expect(received).not.toContain(note.comment);
    expect(((await (await waiting).json()) as { ready: boolean }).ready).toBe(false);
    await expect(client.listTools()).rejects.toThrow();
    expect((await s.call("/projects", { headers })).status).toBe(402);
    await status("active");
    expect((await s.call("/projects", { headers })).status).toBe(200);
});

it("reports partial bulk cleanup honestly when storage removal fails", async () => {
    const { s, headers, status } = await setup();
    const notes = [
        annotationFixture({ id: crypto.randomUUID(), projectId: "keep" }),
        annotationFixture({ id: crypto.randomUUID(), projectId: "keep" }),
    ];
    for (const note of notes) await s.rt.store.insertAnnotation(note);
    await status("canceled");
    const remove = s.rt.backend.remove.bind(s.rt.backend);
    s.rt.backend.remove = async (id) => {
        if (id === notes[1]?.id) throw new Error("private storage diagnostics must not escape");
        return remove(id);
    };
    const response = await s.call("/billing/recovery/cleanup", {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "note", ids: notes.map((n) => n.id), confirm: "DELETE" }),
    });
    expect(response.status).toBe(207);
    expect(await response.json()).toEqual({
        ok: false,
        completed: [notes[0]?.id],
        failed: [notes[1]?.id],
    });
    expect(await s.rt.store.getAnnotation(notes[0]?.id ?? "")).toBeNull();
    expect(await s.rt.store.getAnnotation(notes[1]?.id ?? "")).not.toBeNull();
});
