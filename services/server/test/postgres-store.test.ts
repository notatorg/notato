import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeBundle } from "@notato/core";
import { SCHEMA_VERSION } from "@notato/schema";
import { PostgresStore } from "../src/postgres-store.ts";
import {
    type AuthStore,
    HOSTED_LIMITS,
    QuotaError,
    type Store,
    WorkspaceOwnershipError,
} from "../src/storage.ts";
import { annotationFixture, cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { startServe } from "./serve-helpers.ts";

const at = "2026-10-12T12:00:00.000Z";

import { embeddedPostgres } from "./postgres.ts";

const defer = cleanupAfterEach();

describe.each(["postgres"] as const)("%s storage contract", (_kind) => {
    let store: Store & AuthStore;
    beforeAll(async () => {
        store = process.env.NOTATO_TEST_DATABASE_URL
            ? await PostgresStore.connect(process.env.NOTATO_TEST_DATABASE_URL)
            : (await embeddedPostgres()).store;
    });
    afterAll(async () => {
        await store?.close();
    });

    it("keeps project visits per account, notices replies, and forgets reads when a project is deleted", async () => {
        for (const username of ["reader-one", "reader-two"])
            await store.upsertUser({ username, passwordHash: "hash", createdAt: at });
        const project = { id: "read-state", name: "Read state", createdAt: at };
        await store.createProject(project);
        const noteAt = "2026-10-12T12:00:01.000Z";
        const replyAt = "2026-10-12T12:00:02.000Z";
        const note = annotationFixture({ projectId: project.id, createdAt: noteAt });
        await store.insertAnnotation(note);
        const summary = async (username: string) =>
            (await store.listProjects(undefined, username)).find((p) => p.id === project.id);
        expect((await summary("reader-one"))?.unread).toBe(1);
        expect(
            (await store.listProjects("default", "reader-one")).find((p) => p.id === project.id)
                ?.unread
        ).toBe(1);
        await store.markProjectRead(project.id, "reader-one", noteAt);
        expect((await summary("reader-one"))?.unread).toBe(0);
        expect((await summary("reader-two"))?.unread).toBe(1);
        await store.updateAnnotation(note.id, (a) => ({
            ...a,
            thread: [
                ...a.thread,
                { id: "reply", createdAt: replyAt, author: { kind: "human" }, body: "New thought" },
            ],
        }));
        expect((await summary("reader-one"))?.unread).toBe(1);
        await store.markProjectRead(project.id, "reader-one", replyAt);
        await store.markProjectRead(project.id, "reader-one", noteAt);
        expect((await summary("reader-one"))?.readAt).toBe(replyAt);
        expect((await summary("reader-one"))?.unread).toBe(0);
        expect(
            (await store.listProjects()).find((p) => p.id === project.id)?.readAt
        ).toBeUndefined();
        expect(
            (await store.listProjects()).find((p) => p.id === project.id)?.unread
        ).toBeUndefined();
        await store.deleteProject(project.id);
        await store.createProject(project);
        await store.insertAnnotation(note);
        expect((await summary("reader-one"))?.readAt).toBeUndefined();
        expect((await summary("reader-one"))?.unread).toBe(1);
        await store.deleteProject(project.id);
    });

    it("creates accounts and workspaces atomically, without email-based linking or privileged signup", async () => {
        await store.upsertUser({
            username: "admin",
            passwordHash: "hash",
            isAdmin: true,
            createdAt: at,
        });
        const account = {
            provider: "better-auth",
            subject: "alice",
            username: "alice",
            email: "admin@example.com",
            displayName: "Alice",
            createdAt: at,
            workspace: { id: "acme", name: "Acme", createdAt: at },
        };
        const users = await Promise.all(
            Array.from({ length: 5 }, (_, n) =>
                store.provisionIdentity({
                    ...account,
                    username: `alice${n}`,
                    workspace: { ...account.workspace, id: `acme${n}` },
                })
            )
        );
        expect(new Set(users.map((u) => u.username)).size).toBe(1);
        expect(users[0]?.isAdmin).toBe(false);
        expect(await store.listWorkspaces()).toHaveLength(2);
        const alice = users[0];
        if (!alice) throw new Error("not provisioned");
        const membership = (await store.listMemberships(alice.username))[0];
        if (!membership) throw new Error("not a member");
        expect(membership.role).toBe("owner");
        await expect(
            store.removeMembership(membership.workspaceId, alice.username)
        ).rejects.toBeInstanceOf(WorkspaceOwnershipError);
        await expect(store.setMembership({ ...membership, role: "member" })).rejects.toBeInstanceOf(
            WorkspaceOwnershipError
        );
        const changed = await store.provisionIdentity({
            ...account,
            email: "alice@example.com",
            displayName: "Alice New",
        });
        expect(changed.username).toBe(alice.username);
        expect(changed.displayName).toBe("Alice New");
        expect((await store.getUser("admin"))?.isAdmin).toBe(true);
        await expect(
            store.createWorkspace({ id: "orphan", name: "Orphan", createdAt: at }, "missing")
        ).rejects.toThrow();
        expect(await store.getWorkspace("orphan")).toBeNull();
    });

    it("atomically denies new registrations but permits the existing provider subject when signups close", async () => {
        const account = {
            provider: "signup-gate",
            subject: "known",
            username: "gate-known",
            email: "gate@example.com",
            displayName: "Known",
            createdAt: at,
            workspace: { id: "gate-private", name: "Private", createdAt: at },
        };
        const before = (await store.listWorkspaces()).length;
        await expect(store.provisionIdentity(account, false)).rejects.toMatchObject({
            status: 403,
        });
        expect(await store.getUser(account.username)).toBeNull();
        expect(await store.getWorkspace(account.workspace.id)).toBeNull();
        expect(await store.listMemberships(account.username)).toEqual([]);
        const first = await store.provisionIdentity(account, true);
        const existing = await store.provisionIdentity(
            { ...account, username: "unused", email: "changed@example.com" },
            false
        );
        expect(existing.username).toBe(first.username);
        expect(existing.email).toBe("changed@example.com");
        await expect(
            store.provisionIdentity(
                { ...account, subject: "stranger", username: "gate-stranger" },
                false
            )
        ).rejects.toMatchObject({ status: 403 });
        expect(await store.getUser("gate-stranger")).toBeNull();
        expect((await store.listWorkspaces()).length).toBe(before + 1);
        expect(await store.deleteWorkspace(account.workspace.id, first.username)).not.toBeNull();
    });

    it("keeps annotation filters, summaries, image association and handed cursors consistent", async () => {
        await store.createProject({ id: "alpha", name: "Alpha", createdAt: at });
        await store.createProject({ id: "beta", name: "Beta", createdAt: at });
        expect(await store.getProjectOrigins("alpha")).toEqual([]);
        expect(await store.setProjectOrigins("alpha", ["https://app.example.com"])).toBe(true);
        expect(await store.getProjectOrigins("alpha")).toEqual(["https://app.example.com"]);
        expect(await store.setProjectOrigins("missing", [])).toBe(false);
        const a = annotationFixture({
            projectId: "alpha",
            createdAt: at,
            intent: "fix",
            author: { kind: "human", name: "Alice" },
        });
        const b = annotationFixture({ projectId: "beta", createdAt: at, peopleOnly: true });
        const first = await store.insertAnnotation(a);
        await store.insertAnnotation(b);
        expect(
            (
                await store.listAnnotations({
                    projectId: ["alpha"],
                    intent: "fix",
                    authorName: "Alice",
                    peopleOnly: false,
                    diagnostic: false,
                })
            ).map((x) => x.annotation.id)
        ).toEqual([a.id]);
        expect(await store.listAnnotations({ projectId: [] })).toHaveLength(0);
        expect(await store.listAnnotations({ status: [] })).toHaveLength(0);
        expect(await store.projectsWithAsset(a.screenshots?.full?.id ?? "")).toEqual(
            expect.arrayContaining(["alpha", "beta"])
        );
        const updated = await store.updateAnnotation(a.id, (current) => ({
            ...current,
            status: "resolved",
            thread: [
                {
                    id: "reply",
                    createdAt: "2026-10-13T12:00:00.000Z",
                    body: "Answer",
                    author: { kind: "human", name: "Alice" },
                },
            ],
        }));
        expect(updated?.seq).toBe(first.seq);
        const pending = await store.listAnnotations({
            projectId: "alpha",
            lastReplyBy: "human",
            unhanded: true,
        });
        expect(pending).toHaveLength(1);
        await store.markHanded([{ id: a.id, replyId: "reply" }]);
        expect(await store.listAnnotations({ projectId: "alpha", unhanded: true })).toHaveLength(0);
        const project = (await store.listProjects()).find((p) => p.id === "alpha");
        expect(project).toMatchObject({
            annotations: 1,
            open: 0,
            statuses: { resolved: 1 },
            lastActivityAt: "2026-10-13T12:00:00.000Z",
        });
        expect(
            await store.listAnnotations({ afterSeq: first.seq, excludeIds: [b.id] })
        ).toHaveLength(0);
    });

    it("serialises annotation updates without losing concurrent replies and rolls back invalid mutations", async () => {
        const a = annotationFixture({ projectId: "alpha" });
        await store.insertAnnotation(a);
        await Promise.all(
            Array.from({ length: 8 }, (_, n) =>
                store.updateAnnotation(a.id, (current) => ({
                    ...current,
                    thread: [
                        ...current.thread,
                        {
                            id: `reply-${n}`,
                            createdAt: at,
                            body: `reply ${n}`,
                            author: { kind: "human" },
                        },
                    ],
                }))
            )
        );
        expect((await store.getAnnotation(a.id))?.annotation.thread).toHaveLength(8);
        await expect(
            store.updateAnnotation(a.id, (current) => ({
                ...current,
                comment: "",
                status: "invalid" as never,
            }))
        ).rejects.toThrow();
        expect((await store.getAnnotation(a.id))?.annotation.comment).toBe(a.comment);
        expect(await store.deleteAnnotation(a.id)).toBe(true);
        expect(await store.deleteAnnotation(a.id)).toBe(false);
    });

    it("handles single-use invitations and preserves existing ownership on redemption", async () => {
        await store.provisionIdentity({
            provider: "better-auth",
            subject: "invitee",
            username: "invitee",
            email: "invitee@example.com",
            displayName: "Invitee",
            createdAt: at,
            workspace: { id: "invitee-ws", name: "Invitee", createdAt: at },
        });
        await store.createInvitation({
            id: "invite",
            workspaceId: "invitee-ws",
            email: "invitee@example.com",
            role: "member",
            tokenHash: "invite-hash",
            createdBy: "invitee",
            createdAt: at,
            expiresAt: "2027-01-01T00:00:00.000Z",
        });
        expect(await store.acceptInvitation("invite-hash", "admin", at)).toBeNull();
        const attempts = await Promise.all([
            store.acceptInvitation("invite-hash", "invitee", at),
            store.acceptInvitation("invite-hash", "invitee", at),
        ]);
        expect(attempts.filter(Boolean)).toHaveLength(1);
        expect(attempts.find(Boolean)?.role).toBe("owner");
        expect((await store.getInvitation("invite-hash"))?.acceptedAt).toBe(at);
        expect(await store.revokeInvitation("invitee-ws", "invite", at)).toBe(false);
        await store.createInvitation({
            id: "revoked",
            workspaceId: "invitee-ws",
            email: "invitee@example.com",
            role: "member",
            tokenHash: "revoked-hash",
            createdBy: "invitee",
            createdAt: at,
            expiresAt: "2027-01-01T00:00:00.000Z",
        });
        expect(await store.revokeInvitation("default", "revoked", at)).toBe(false);
        expect(await store.revokeInvitation("invitee-ws", "revoked", at)).toBe(true);
        expect(await store.acceptInvitation("revoked-hash", "invitee", at)).toBeNull();
    });

    it("persists and revokes sessions, workspace selections and tokens; deletes a project's bundles and notes", async () => {
        await store.createSession({
            id: "session",
            username: "admin",
            createdAt: at,
            expiresAt: "2027-01-01T00:00:00.000Z",
        });
        await store.setSessionWorkspace("session", "default");
        expect((await store.getSession("session"))?.workspaceId).toBe("default");
        await store.deleteSessionsFor("admin");
        expect(await store.getSession("session")).toBeNull();
        await store.createToken({
            id: "token",
            projectId: "beta",
            workspaceId: "default",
            tokenHash: "hash-token",
            name: "App",
            createdAt: at,
        });
        await store.touchToken("token", at);
        expect((await store.findToken("hash-token"))?.lastUsedAt).toBe(at);
        await store.revokeProjectTokens("beta", at);
        expect((await store.listTokens())[0]?.revokedAt).toBe(at);
        expect(await store.revokeToken("token", at)).toBe(false);
        const bundle = {
            id: "bundle",
            projectId: "beta",
            createdAt: at,
            importedAt: at,
            author: {},
            annotationCount: 1,
        };
        expect(await store.insertBundle(bundle)).toBe(true);
        expect(await store.insertBundle(bundle)).toBe(false);
        expect(await store.getBundle("bundle")).toEqual(bundle);
        expect(await store.listBundles("beta")).toEqual([bundle]);
        expect(await store.deleteProject("beta")).toHaveLength(1);
        expect(await store.getBundle("bundle")).toBeNull();
        expect(await store.getProject("beta")).toBeNull();
    });
    it("retains an owner when two owners are removed concurrently", async () => {
        await store.createWorkspace({ id: "owner-race", name: "Owners", createdAt: at }, "admin");
        await store.setMembership({
            workspaceId: "owner-race",
            username: "invitee",
            role: "owner",
            createdAt: at,
        });
        const attempts = await Promise.allSettled([
            store.removeMembership("owner-race", "admin"),
            store.removeMembership("owner-race", "invitee"),
        ]);
        expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(
            (await store.listWorkspaceMembers("owner-race")).filter(
                (member) => member.role === "owner"
            )
        ).toHaveLength(1);
    });
    it("enforces durable quotas under concurrent writes, charges uploaded bytes and stores security metadata", async () => {
        await store.createUser({ username: "quota-owner", passwordHash: "hash", createdAt: at });
        await store.createWorkspace({ id: "quota", name: "Quota", createdAt: at }, "quota-owner");
        const first = annotationFixture({ projectId: "quota-a", screenshots: undefined });
        const second = annotationFixture({ projectId: "quota-a", screenshots: undefined });
        const bytes = Buffer.byteLength(JSON.stringify(first));
        expect(typeof store.setHostedLimits).toBe("function");
        store.setHostedLimits?.({
            notes: 1,
            bytes: bytes * 2 + 79,
            projects: 2,
            workspaces: 1,
            tokens: 1,
        });
        const attempts = await Promise.allSettled(
            ["quota-a", "quota-b", "quota-c"].map((id) =>
                store.createProject({ id, name: id, workspaceId: "quota", createdAt: at })
            )
        );
        expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(2);
        expect(await store.listProjects("quota")).toHaveLength(2);
        const selected = (await store.listProjects("quota"))[0];
        if (!selected) throw new Error("quota test project missing");
        first.projectId = selected.id;
        second.projectId = selected.id;
        await store.insertAnnotation(first, 80);
        await expect(store.insertAnnotation(second)).rejects.toBeInstanceOf(QuotaError);
        store.setHostedLimits?.({
            notes: 10,
            bytes: bytes * 2 + 79,
            projects: 2,
            workspaces: 1,
            tokens: 1,
        });
        await expect(store.checkIngestBudget?.(second, 0)).rejects.toBeInstanceOf(QuotaError);
        await expect(store.insertAnnotation(second)).rejects.toBeInstanceOf(QuotaError);
        await expect(
            store.updateAnnotation(first.id, (a) => ({ ...a, comment: "large".repeat(5000) }))
        ).rejects.toBeInstanceOf(QuotaError);
        expect((await store.getAnnotation(first.id))?.annotation.comment).toBe(first.comment);
        await store.deleteAnnotation(first.id);
        await store.insertAnnotation(second);
        await expect(
            store.createWorkspace({ id: "too-many", name: "Another", createdAt: at }, "quota-owner")
        ).rejects.toBeInstanceOf(QuotaError);
        expect(await store.getWorkspace("too-many")).toBeNull();
        const token = {
            id: "quota-token",
            projectId: selected.id,
            workspaceId: "quota",
            tokenHash: "quota-hash",
            name: "Capture",
            permission: "capture" as const,
            expiresAt: new Date(Date.now() + 86400_000).toISOString(),
            createdAt: at,
        };
        await store.createToken(token);
        expect(await store.findToken("quota-hash")).toMatchObject({
            permission: "capture",
            expiresAt: token.expiresAt,
        });
        await expect(
            store.createToken({ ...token, id: "too-many", tokenHash: "too-many" })
        ).rejects.toBeInstanceOf(QuotaError);
        const now = new Date().toISOString();
        await store.registerIdentitySession("better-auth", "quota", "device", now);
        expect(await store.listIdentitySessions("better-auth", "quota")).toEqual(["device"]);
        await store.revokeIdentitySession("better-auth", "quota", "device", now);
        await store.registerIdentitySession("better-auth", "quota", "device", now);
        expect(await store.identitySessionRevoked("better-auth", "quota", "device")).toBe(true);
        expect(await store.listIdentitySessions("better-auth", "quota")).toEqual([]);
        const entry = {
            id: "quota-audit",
            workspaceId: "quota",
            actor: "member:quota-owner",
            action: "PATCH /workspace",
            outcome: 0,
            createdAt: now,
        };
        await store.appendAudit(entry);
        await store.appendAudit({ ...entry, outcome: 200 });
        expect(await store.listAudit("quota")).toEqual([{ ...entry, outcome: 200 }]);
        expect(await store.listAudit("foreign-workspace")).toEqual([]);
    });
});

describe("hosted bundle records", () => {
    it("counts bundles toward a workspace's feedback storage, caps them, and refuses oversized details", async () => {
        const { store, pg } = await embeddedPostgres();
        defer(() => store.close());
        await store.upsertUser({ username: "bundle-owner", passwordHash: "hash", createdAt: at });
        await store.createWorkspace(
            { id: "bundles", name: "Bundles", createdAt: at },
            "bundle-owner"
        );
        await store.createProject({
            id: "bundled",
            name: "Bundled",
            workspaceId: "bundles",
            createdAt: at,
        });
        const bundle = (id: string, appName?: string) => ({
            id,
            projectId: "bundled",
            createdAt: at,
            importedAt: at,
            author: {},
            appName,
            annotationCount: 1,
        });
        await expect(store.insertBundle(bundle("huge", "x".repeat(9000)))).rejects.toMatchObject({
            status: 413,
        });
        await expect(
            store.checkBundleBudget(bundle("huge", "x".repeat(9000)))
        ).rejects.toMatchObject({ status: 413 });
        const note = annotationFixture({ projectId: "bundled", screenshots: undefined });
        store.setHostedLimits({
            ...HOSTED_LIMITS,
            jsonBytes: Buffer.byteLength(JSON.stringify(note)) + 1000,
        });
        expect(await store.insertBundle(bundle("first", "a".repeat(1000)))).toBe(true);
        // The bundle's details take room the note would have had.
        await expect(store.insertAnnotation(note)).rejects.toBeInstanceOf(QuotaError);
        await expect(store.insertBundle(bundle("second", "b".repeat(1000)))).rejects.toBeInstanceOf(
            QuotaError
        );
        expect(await store.insertBundle(bundle("first", "a".repeat(1000)))).toBe(false);
        store.setHostedLimits(HOSTED_LIMITS);
        await pg.query(
            "INSERT INTO notato.bundles (id,project_id,created_at,imported_at,json) SELECT 'bulk-'||g,'bundled',$1,$1,'{}' FROM generate_series(1,9999) g",
            [at]
        );
        // Refused before an import stores anything, and again as a record is written.
        await expect(store.checkBundleBudget(bundle("one-more"))).rejects.toBeInstanceOf(
            QuotaError
        );
        await expect(store.insertBundle(bundle("one-more"))).rejects.toBeInstanceOf(QuotaError);
        expect(await store.listBundles("bundled")).toHaveLength(10_000);
        // They go with their project, and the allowance with them.
        await store.deleteProject("bundled");
        await store.createProject({
            id: "bundled",
            name: "Bundled",
            workspaceId: "bundles",
            createdAt: at,
        });
        await store.checkBundleBudget(bundle("one-more"));
        expect(await store.insertBundle(bundle("one-more"))).toBe(true);
        expect(
            await store.insertBundle({
                ...bundle("newest"),
                importedAt: "2026-10-12T13:00:00.000Z",
            })
        ).toBe(true);
        expect((await store.listBundles("bundled", 1)).map((b) => b.id)).toEqual(["newest"]);
        expect((await store.listBundles("bundled")).map((b) => b.id)).toEqual([
            "newest",
            "one-more",
        ]);
    });

    it("refuses a bundle with no room before any of its notes is stored", async () => {
        const { store, pg } = await embeddedPostgres();
        const s = await startServe(defer, { store, managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const created = await s.call("/projects", {
            method: "POST",
            headers: { cookie: alice.cookie, "content-type": "application/json" },
            body: JSON.stringify({ name: "Bundled app" }),
        });
        const { project } = (await created.json()) as { project: { id: string } };
        await pg.query(
            "INSERT INTO notato.bundles (id,project_id,created_at,imported_at,json) SELECT 'bulk-'||g,$2,$1,$1,'{}' FROM generate_series(1,10000) g",
            [at, project.id]
        );
        const note = annotationFixture({ projectId: project.id, screenshots: undefined });
        const zip = await writeBundle(
            {
                id: "tester-bundle",
                projectId: project.id,
                createdAt: at,
                author: { name: "Tester" },
                annotations: [note],
                schemaVersion: SCHEMA_VERSION,
            },
            async () => undefined
        );
        const send = () =>
            s.call(`/projects/${project.id}/bundles`, {
                method: "POST",
                headers: { cookie: alice.cookie, "content-type": "application/zip" },
                body: new Uint8Array(zip),
            });
        expect((await send()).status).toBe(429);
        expect(await store.getAnnotation(note.id)).toBeNull();
        expect(await store.getBundle("tester-bundle")).toBeNull();
        await pg.query("DELETE FROM notato.bundles WHERE id LIKE 'bulk-%'");
        expect((await send()).status).toBe(201);
        expect(await store.getAnnotation(note.id)).not.toBeNull();
        expect((await store.getBundle("tester-bundle"))?.projectId).toBe(project.id);
    });
});

describe("hosted Postgres startup", () => {
    it("upgrades version 14 with private atomic capture receipts while preserving notes", async () => {
        const { pg, database, store } = await embeddedPostgres();
        const note = annotationFixture({ projectId: "receipt-migration" });
        await store.createProject({ id: note.projectId, name: "Migration", createdAt: at });
        await store.insertAnnotation(note);
        await pg.exec(
            "ALTER TABLE notato.annotations DROP COLUMN capture_scope; ALTER TABLE notato.annotations DROP COLUMN capture_fingerprint; UPDATE notato.meta SET value='14' WHERE key='schema_version'"
        );
        const upgraded = await PostgresStore.open(database);
        try {
            expect(await upgraded.getAnnotation(note.id)).not.toBeNull();
            expect(await upgraded.getCaptureReceipt(note.id)).toBeNull();
            const next = annotationFixture({ projectId: note.projectId });
            const receipt = { scope: "credential-scope", fingerprint: "submitted-content" };
            await upgraded.insertAnnotation(next, 0, receipt);
            expect(await upgraded.getCaptureReceipt(next.id)).toEqual(receipt);
            expect(JSON.stringify(await upgraded.getAnnotation(next.id))).not.toContain(
                "fingerprint"
            );
            await upgraded.deleteAnnotation(next.id);
            expect(await upgraded.getCaptureReceipt(next.id)).toBeNull();
        } finally {
            await upgraded.close();
        }
    });

    it("upgrades a version 7 deployment without losing records and protects its new read-state table", async () => {
        const { pg, database, store } = await embeddedPostgres();
        const at = "2026-10-12T12:00:00.000Z";
        await store.upsertUser({ username: "reader", passwordHash: "hash", createdAt: at });
        await store.createProject({ id: "notes", name: "Notes", createdAt: at });
        await store.insertAnnotation(annotationFixture({ projectId: "notes", createdAt: at }));
        await pg.exec(
            "DROP TABLE notato.project_reads; UPDATE notato.meta SET value='7' WHERE key='schema_version'"
        );
        const upgraded = await PostgresStore.open(database);
        try {
            expect((await upgraded.listProjects(undefined, "reader"))[0]?.unread).toBe(1);
            await upgraded.markProjectRead("notes", "reader", at);
            expect((await upgraded.listProjects(undefined, "reader"))[0]?.unread).toBe(0);
            for (const role of ["anon", "authenticated"]) {
                const result = await pg.query<{ allowed: boolean }>(
                    "SELECT has_table_privilege($1,'notato.project_reads','SELECT') AS allowed",
                    [role]
                );
                expect(result.rows[0]?.allowed).toBe(false);
            }
        } finally {
            await upgraded.close();
        }
    });

    it("keeps provider browser roles away from application records", async () => {
        const { pg, store } = await embeddedPostgres();
        try {
            for (const role of ["anon", "authenticated"]) {
                expect(
                    (
                        await pg.query<{ allowed: boolean }>(
                            "SELECT has_schema_privilege($1,'notato','USAGE') AS allowed",
                            [role]
                        )
                    ).rows[0]?.allowed
                ).toBe(false);
                expect(
                    (
                        await pg.query<{ allowed: boolean }>(
                            "SELECT has_table_privilege($1,'notato.users','SELECT') AS allowed",
                            [role]
                        )
                    ).rows[0]?.allowed
                ).toBe(false);
            }
            expect(
                (
                    await pg.query<{ enabled: boolean }>(
                        "SELECT bool_and(relrowsecurity) AS enabled FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='notato' AND c.relkind='r'"
                    )
                ).rows[0]?.enabled
            ).toBe(true);
        } finally {
            await store.close();
        }
    });

    it("runs the same registration and project API on Postgres", async () => {
        const { store } = await embeddedPostgres();
        const s = await startServe(defer, { store, managedAuth: fakeManagedAuth() });
        const a = await customer(s, "alice");
        const b = await customer(s, "bob");
        const created = await s.call("/projects", {
            method: "POST",
            headers: { cookie: a.cookie, "content-type": "application/json" },
            body: JSON.stringify({ name: "Hosted app" }),
        });
        expect(created.status).toBe(201);
        expect(await (await s.call("/projects", { headers: { cookie: b.cookie } })).json()).toEqual(
            { items: [] }
        );
    });
});
