import { describe, expect, it } from "bun:test";
import { type AuthStore, DataControlError, type Store } from "../src/storage.ts";
import { annotationFixture, cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { embeddedPostgres } from "./postgres.ts";
import { adminCookie, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
async function storage(_kind: "postgres"): Promise<Store & AuthStore> {
    const store = (await embeddedPostgres()).store;
    defer(() => store.close());
    for (const username of ["owner", "member", "other"])
        await store.upsertUser({
            username,
            passwordHash: "hash",
            createdAt: new Date().toISOString(),
            isAdmin: false,
        });
    await store.createWorkspace(
        { id: "company", name: "Company", createdAt: new Date().toISOString() },
        "owner"
    );
    await store.setMembership({
        workspaceId: "company",
        username: "member",
        role: "member",
        createdAt: new Date().toISOString(),
    });
    await store.createProject({
        id: "notes",
        name: "Notes",
        createdAt: new Date().toISOString(),
        workspaceId: "company",
    });
    return store;
}
describe.each(["postgres"] as const)("%s data lifecycle", (kind) => {
    it("checks ownership inside transactions, deletes a company, invalidates its keys and rehomes members", async () => {
        const store = await storage(kind);
        const note = annotationFixture({ projectId: "notes", screenshots: undefined });
        await store.insertAnnotation(note);
        await store.createToken({
            id: "key",
            projectId: "notes",
            workspaceId: "company",
            name: "Key",
            tokenHash: "hash",
            createdAt: new Date().toISOString(),
            createdBy: "owner",
        });
        await store.createSession({
            id: "session",
            username: "member",
            workspaceId: "company",
            createdAt: new Date().toISOString(),
            expiresAt: "2099-01-01T00:00:00.000Z",
        });
        await expect(store.deleteWorkspace("company", "member")).rejects.toBeInstanceOf(
            DataControlError
        );
        await expect(store.deleteWorkspace("company", "other")).rejects.toBeInstanceOf(
            DataControlError
        );
        expect(await store.getAnnotation(note.id)).not.toBeNull();
        expect((await store.deleteWorkspace("company", "owner"))?.[0]?.annotation.id).toBe(note.id);
        expect(await store.getProject("notes")).toBeNull();
        expect(await store.findToken("hash")).toBeNull();
        const next = (await store.listMemberships("member"))[0];
        expect(next?.role).toBe("owner");
        expect((await store.getSession("session"))?.workspaceId).toBe(next?.workspaceId);
        await expect(store.deleteWorkspace("default", "owner")).rejects.toBeInstanceOf(
            DataControlError
        );
    });
    it("leaves retention off by default and ages by server receipt, not untrusted client timestamps", async () => {
        const store = await storage(kind);
        const note = annotationFixture({
            projectId: "notes",
            screenshots: undefined,
            createdAt: "1900-01-01T00:00:00.000Z",
        });
        await store.insertAnnotation(note);
        expect(await store.expiredAnnotations("2099-01-01T00:00:00.000Z")).toHaveLength(0);
        await expect(store.setWorkspacePolicy("company", "member", 7)).rejects.toBeInstanceOf(
            DataControlError
        );
        await store.setWorkspacePolicy("company", "owner", 7);
        expect(await store.expiredAnnotations(new Date().toISOString())).toHaveLength(0);
        expect(await store.expiredAnnotations("2099-01-01T00:00:00.000Z")).toHaveLength(1);
        await store.setWorkspacePolicy("company", "owner", null);
        expect(await store.deleteExpiredAnnotation(note.id, "2099-01-01T00:00:00.000Z")).toBeNull();
        await store.setWorkspacePolicy("company", "owner", 7);
        expect(
            (await store.deleteExpiredAnnotation(note.id, "2099-01-01T00:00:00.000Z"))?.annotation
                .id
        ).toBe(note.id);
    });
    it("requires handing over shared ownership and revokes a deleted account's issued keys", async () => {
        const store = await storage(kind);
        await expect(
            store.deleteAccount("owner", new Date().toISOString(), true)
        ).rejects.toBeInstanceOf(DataControlError);
        await store.setMembership({
            workspaceId: "company",
            username: "member",
            role: "owner",
            createdAt: new Date().toISOString(),
        });
        await store.createToken({
            id: "key",
            projectId: "notes",
            workspaceId: "company",
            name: "Key",
            tokenHash: "hash",
            createdBy: "owner",
            createdAt: new Date().toISOString(),
        });
        expect(await store.deleteAccount("owner", new Date().toISOString(), true)).toEqual([]);
        expect(await store.getUser("owner")).toBeNull();
        expect((await store.findToken("hash"))?.revokedAt).toBeDefined();
        expect((await store.listWorkspaceMembers("company"))[0]?.role).toBe("owner");
    });
    it("deletes explicitly confirmed private workspaces and blocks old provider tokens from recreating the account", async () => {
        const store = await storage(kind);
        const account = {
            provider: "better-auth",
            subject: "subject",
            username: "customer",
            email: "customer@example.com",
            displayName: "Customer",
            createdAt: new Date().toISOString(),
            workspace: { id: "private", name: "Private", createdAt: new Date().toISOString() },
        };
        await store.provisionIdentity(account);
        await expect(
            store.deleteAccount("customer", new Date().toISOString())
        ).rejects.toBeInstanceOf(DataControlError);
        expect(await store.deleteAccount("customer", new Date().toISOString(), true)).toEqual([]);
        expect(await store.getWorkspace("private")).toBeNull();
        await expect(store.provisionIdentity(account)).rejects.toBeInstanceOf(DataControlError);
        expect(await store.pendingIdentityDeletions(new Date().toISOString())).toEqual([
            { provider: "better-auth", subject: "subject" },
        ]);
        await store.identityDeletionResult(
            "better-auth",
            "subject",
            true,
            new Date().toISOString()
        );
        expect(await store.pendingIdentityDeletions("2099-01-01T00:00:00.000Z")).toEqual([]);
        await expect(store.provisionIdentity(account)).rejects.toBeInstanceOf(DataControlError);
    });
});
describe("data control HTTP permissions", () => {
    it("requires owner access for retention and deletion and denies cross-origin writes", async () => {
        const managed = fakeManagedAuth();
        const verify = managed.verify.bind(managed);
        managed.verify = async (token) => {
            const identity = await verify(token);
            return identity ? { ...identity, issuedAt: new Date().toISOString() } : null;
        };
        const s = await startServe(defer, { managedAuth: managed });
        const alice = await customer(s, "alice"),
            bob = await customer(s, "bob");
        const me = (await (
            await s.call("/auth/me", { headers: { cookie: alice.cookie } })
        ).json()) as { username: string; workspace: { id: string; name: string } };
        const request = (path: string, body: unknown, cookie = alice.cookie, origin?: string) =>
            s.call(path, {
                method: path === "/workspace" ? "DELETE" : "PUT",
                headers: {
                    cookie,
                    "content-type": "application/json",
                    "X-Notato-Board": "1",
                    ...(origin ? { origin } : {}),
                },
                body: JSON.stringify(body),
            });
        expect(
            (
                await request(
                    "/workspace/policy",
                    { retentionDays: 7 },
                    alice.cookie,
                    "https://evil.example"
                )
            ).status
        ).toBe(403);
        expect(
            (await request("/workspace", { confirm: me.workspace.name }, bob.cookie)).status
        ).toBe(400);
        expect((await request("/workspace/policy", { retentionDays: 7 })).status).toBe(200);
        expect((await request("/workspace", { confirm: "Wrong" })).status).toBe(400);
        expect((await request("/workspace", { confirm: me.workspace.name })).status).toBe(403);
        expect(
            (await request("/workspace", { confirm: me.workspace.name, accessToken: "bob" })).status
        ).toBe(403);
        expect(
            (await request("/workspace", { confirm: me.workspace.name, accessToken: "alice" }))
                .status
        ).toBe(204);
        expect((await s.call("/auth/me", { headers: { cookie: alice.cookie } })).status).toBe(200);
        const admin = await adminCookie(s);
        expect((await request("/workspace", { confirm: me.workspace.name }, admin)).status).toBe(
            403
        );
    });
});

it("requires the native password for account deletion and invalidates existing cookies", async () => {
    const s = await startServe(defer);
    await s.rt.auth.createAccount("tester", "a strong test password");
    await s.rt.store.createWorkspace(
        { id: "personal", name: "Personal", createdAt: new Date().toISOString() },
        "tester"
    );
    const login = await s.call("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "tester", password: "a strong test password" }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const remove = (password: string) =>
        s.call("/auth/account", {
            method: "DELETE",
            headers: { cookie, "content-type": "application/json", "X-Notato-Board": "1" },
            body: JSON.stringify({ confirm: "tester", password, deletePrivateWorkspaces: true }),
        });
    expect((await remove("wrong")).status).toBe(403);
    expect((await s.call("/auth/me", { headers: { cookie } })).status).toBe(200);
    const deleted = await remove("a strong test password");
    expect(deleted.status).toBe(202);
    expect(deleted.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await s.rt.store.getUser("tester")).toBeNull();
    const me = (await (await s.call("/auth/me", { headers: { cookie } })).json()) as {
        authenticated: boolean;
    };
    expect(me.authenticated).toBe(false);
});
