import { describe, expect, it } from "bun:test";
import { sha256Hex } from "@notato/server";
import { PostgresStore } from "../src/postgres-store.ts";
import { DEFAULT_WORKSPACE_ID, HOSTED_LIMITS, WorkspaceOwnershipError } from "../src/storage.ts";
import { annotationFixture, cleanupAfterEach } from "./helpers.ts";
import { embeddedPostgres } from "./postgres.ts";
import { adminCookie, bearer, issue, type Server, startServe } from "./serve-helpers.ts";

// Workspaces, memberships and operator provisioning, ported from the retired monolith's workspace tests to the cloud's
// Postgres store and routes. Its SQLite version-5 migration has no counterpart here: the cloud is Postgres-only.

const defer = cleanupAfterEach();
const at = "2026-10-12T12:00:00.000Z";
const password = "a member password";

/** A store on a database of its own, closed once the test is over; `limited` adds the hosted resource limits. */
async function database(limited = false) {
    const db = await embeddedPostgres();
    defer(() => db.store.close());
    if (limited) db.store.setHostedLimits(HOSTED_LIMITS);
    return db;
}

async function account(store: PostgresStore, username: string) {
    expect(await store.createUser({ username, passwordHash: "unused", createdAt: at })).toBe(true);
}

/** Two owners, `dom` and `sam`, of `acme`. */
async function twoOwners(store: PostgresStore) {
    await account(store, "dom");
    await account(store, "sam");
    await store.createWorkspace({ id: "acme", name: "Acme", createdAt: at }, "dom");
    await store.setMembership({
        workspaceId: "acme",
        username: "sam",
        role: "owner",
        createdAt: at,
    });
}

const owners = async (store: PostgresStore, workspace = "acme") =>
    (await store.listWorkspaceMembers(workspace)).filter((m) => m.role === "owner");

async function signIn(s: Server, username: string) {
    const res = await s.call("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(200);
    return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] as string };
}

function write(headers: Record<string, string>, body: unknown, method = "POST"): RequestInit {
    return {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
    };
}

describe("workspace ownership", () => {
    it("creates a workspace with its owner atomically and keeps the first on a duplicate create", async () => {
        const { store } = await database();
        await account(store, "dom");
        const workspace = { id: "acme", name: "Acme", createdAt: at };
        expect(await store.createWorkspace(workspace, "dom")).toBe(true);
        expect(await store.createWorkspace({ ...workspace, name: "Replacement" }, "missing")).toBe(
            false
        );
        expect(await store.getWorkspace("acme")).toEqual(workspace);
        expect(await store.getMembership("acme", "dom")).toMatchObject({ role: "owner" });
        expect(await store.listWorkspaceMembers("acme")).toHaveLength(1);
        await expect(
            store.createWorkspace({ ...workspace, id: "orphan" }, "missing")
        ).rejects.toThrow();
        expect(await store.getWorkspace("orphan")).toBeNull();
    });

    it("supports membership of several workspaces without granting operator privileges", async () => {
        const { store } = await database();
        await account(store, "dom");
        await account(store, "sam");
        for (const id of ["acme", "other"]) {
            await store.createWorkspace({ id, name: id, createdAt: at }, "dom");
            await store.setMembership({
                workspaceId: id,
                username: "sam",
                role: "admin",
                createdAt: at,
            });
        }
        expect((await store.listMemberships("sam")).map((m) => m.workspaceId)).toEqual([
            "acme",
            "other",
        ]);
        expect((await store.getUser("sam"))?.isAdmin).toBe(false);
        // A role change keeps when the person joined, and touches only that workspace.
        await store.setMembership({
            workspaceId: "acme",
            username: "sam",
            role: "member",
            createdAt: "2030-01-01T00:00:00.000Z",
        });
        expect(await store.getMembership("acme", "sam")).toMatchObject({
            role: "member",
            createdAt: at,
        });
        expect((await store.getMembership("other", "sam"))?.role).toBe("admin");
        expect(await store.removeMembership("acme", "sam")).toBe(true);
        expect(await store.removeMembership("acme", "sam")).toBe(false);
        expect((await store.listMemberships("sam")).map((m) => m.workspaceId)).toEqual(["other"]);
    });

    it("refuses to remove or demote the final owner, and allows transferring ownership", async () => {
        const { store } = await database();
        await account(store, "dom");
        await account(store, "sam");
        await store.createWorkspace({ id: "acme", name: "Acme", createdAt: at }, "dom");
        await expect(store.removeMembership("acme", "dom")).rejects.toBeInstanceOf(
            WorkspaceOwnershipError
        );
        await expect(
            store.setMembership({
                workspaceId: "acme",
                username: "dom",
                role: "admin",
                createdAt: at,
            })
        ).rejects.toBeInstanceOf(WorkspaceOwnershipError);
        expect(await store.getMembership("acme", "dom")).toMatchObject({ role: "owner" });
        await store.setMembership({
            workspaceId: "acme",
            username: "sam",
            role: "owner",
            createdAt: at,
        });
        expect(await store.removeMembership("acme", "dom")).toBe(true);
        expect(Array.from(await store.listWorkspaceMembers("acme"))).toEqual([
            { workspaceId: "acme", username: "sam", role: "owner", createdAt: at },
        ]);
    });

    it("keeps an owner when two store connections remove both owners at once", async () => {
        const { store, database: db } = await database();
        await twoOwners(store);
        // A second store on the same database, as a second instance of the service would have.
        const second = await PostgresStore.open(db);
        defer(() => second.close());
        const removals = await Promise.allSettled([
            store.removeMembership("acme", "dom"),
            second.removeMembership("acme", "sam"),
        ]);
        expect(removals.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const refused = removals.find((r) => r.status === "rejected");
        expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(
            WorkspaceOwnershipError
        );
        expect(await owners(store)).toHaveLength(1);
        expect(await store.listWorkspaceMembers("acme")).toHaveLength(1);
    });

    it("keeps an owner when one owner is demoted while the other is removed", async () => {
        const { store, database: db } = await database();
        await twoOwners(store);
        const second = await PostgresStore.open(db);
        defer(() => second.close());
        const changes = await Promise.allSettled([
            store.setMembership({
                workspaceId: "acme",
                username: "dom",
                role: "member",
                createdAt: at,
            }),
            second.removeMembership("acme", "sam"),
        ]);
        expect(changes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(await owners(store)).toHaveLength(1);
    });

    it("keeps an owner when both owners demote each other at once", async () => {
        const { store, database: db } = await database();
        await twoOwners(store);
        const second = await PostgresStore.open(db);
        defer(() => second.close());
        const changes = await Promise.allSettled([
            store.setMembership({
                workspaceId: "acme",
                username: "dom",
                role: "admin",
                createdAt: at,
            }),
            second.setMembership({
                workspaceId: "acme",
                username: "sam",
                role: "admin",
                createdAt: at,
            }),
        ]);
        expect(changes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(await owners(store)).toHaveLength(1);
        expect(await store.listWorkspaceMembers("acme")).toHaveLength(2);
    });

    for (const limited of [false, true])
        it(`rejects memberships and projects whose workspace or account is missing${limited ? ", with hosted limits" : ""}`, async () => {
            const { store } = await database(limited);
            await account(store, "dom");
            await expect(
                store.setMembership({
                    workspaceId: "missing",
                    username: "dom",
                    role: "member",
                    createdAt: at,
                })
            ).rejects.toThrow();
            await expect(
                store.setMembership({
                    workspaceId: "missing",
                    username: "dom",
                    role: "owner",
                    createdAt: at,
                })
            ).rejects.toThrow();
            await expect(
                store.setMembership({
                    workspaceId: DEFAULT_WORKSPACE_ID,
                    username: "missing",
                    role: "member",
                    createdAt: at,
                })
            ).rejects.toThrow();
            expect(await store.listMemberships("dom")).toEqual([]);
            expect(await store.listWorkspaceMembers(DEFAULT_WORKSPACE_ID)).toEqual([]);
            await expect(
                store.createProject({
                    id: "shop",
                    name: "Shop",
                    createdAt: at,
                    workspaceId: "missing",
                })
            ).rejects.toThrow();
            expect(await store.getProject("shop")).toBeNull();
            expect(await store.getWorkspace("missing")).toBeNull();
        });

    it("keeps project summaries and counts within the requested workspace, including empty ones", async () => {
        const { store } = await database();
        await account(store, "dom");
        for (const id of ["acme", "other", "empty"])
            await store.createWorkspace({ id, name: id, createdAt: at }, "dom");
        for (const workspaceId of ["acme", "other", DEFAULT_WORKSPACE_ID]) {
            const id = `${workspaceId}-shop`;
            await store.createProject({ id, name: id, workspaceId, createdAt: at });
            await store.insertAnnotation(
                annotationFixture({ projectId: id, screenshots: undefined })
            );
        }
        // Notes without a project record can belong only to the default workspace.
        await store.insertAnnotation(
            annotationFixture({ projectId: "legacy", screenshots: undefined })
        );
        expect(await store.listProjects("acme")).toMatchObject([
            { id: "acme-shop", workspaceId: "acme", annotations: 1 },
        ]);
        expect(await store.listProjects("other")).toMatchObject([
            { id: "other-shop", annotations: 1 },
        ]);
        expect(await store.listProjects("empty")).toEqual([]);
        expect((await store.listProjects(DEFAULT_WORKSPACE_ID)).map((p) => p.id).sort()).toEqual([
            "default-shop",
            "legacy",
        ]);
    });
});

describe("operator provisioning", () => {
    it("creates ordinary accounts and workspaces without changing a duplicate or returning passwords", async () => {
        const s = await startServe(defer);
        const cookie = await adminCookie(s);
        const call = (path: string, method: string, body?: unknown) =>
            s.call(path, {
                method,
                headers: { cookie, "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        const created = await call("/admin/users", "POST", { username: "dom", password });
        expect(created.status).toBe(201);
        const shown = (await created.json()) as Record<string, unknown>;
        expect(shown).toMatchObject({ username: "dom", isAdmin: false });
        expect(JSON.stringify(shown)).not.toContain(password);
        expect(shown).not.toHaveProperty("passwordHash");
        const hash = (await s.rt.store.getUser("dom"))?.passwordHash;
        expect(
            (await call("/admin/users", "POST", { username: "dom", password: "another password" }))
                .status
        ).toBe(409);
        expect((await s.rt.store.getUser("dom"))?.passwordHash).toBe(hash);
        expect(
            (await call("/admin/users", "POST", { username: "bad", password, isAdmin: true }))
                .status
        ).toBe(400);
        expect(await s.rt.store.getUser("bad")).toBeNull();
        expect(
            (await call("/admin/users", "POST", { username: "short", password: "short" })).status
        ).toBe(400);
        expect(await s.rt.store.getUser("short")).toBeNull();

        const workspace = { id: "acme", name: "Acme", owner: "dom" };
        expect(
            (await call("/admin/workspaces", "POST", { ...workspace, owner: "nobody" })).status
        ).toBe(404);
        expect(await s.rt.store.getWorkspace("acme")).toBeNull();
        expect((await call("/admin/workspaces", "POST", workspace)).status).toBe(201);
        expect((await call("/admin/workspaces", "POST", workspace)).status).toBe(409);
        expect((await call("/projects", "POST", { id: "shop", workspaceId: "acme" })).status).toBe(
            201
        );
        expect(
            (await call("/projects", "POST", { id: "orphan", workspaceId: "missing" })).status
        ).toBe(404);
        expect(await s.rt.store.getProject("orphan")).toBeNull();
        const detail = await call("/admin/workspaces/acme", "GET");
        expect(await detail.json()).toMatchObject({
            workspace: { id: "acme" },
            members: [{ username: "dom", role: "owner" }],
            projects: [{ id: "shop", workspaceId: "acme" }],
        });
        expect((await call("/admin/workspaces/acme/members/dom", "DELETE")).status).toBe(409);
        expect(
            (await call("/admin/workspaces/acme/members/dom", "PUT", { role: "admin" })).status
        ).toBe(409);
        expect(
            (await call("/admin/workspaces/acme/members/nobody", "PUT", { role: "member" })).status
        ).toBe(404);
        expect(
            (await call("/admin/workspaces/missing/members/dom", "PUT", { role: "member" })).status
        ).toBe(404);
        expect((await call("/admin/workspaces/acme", "PATCH", { name: "Acme Ltd" })).status).toBe(
            200
        );
        expect((await s.rt.store.getWorkspace("acme"))?.name).toBe("Acme Ltd");
    });

    it("keeps an owner when the operator removes both owners at once", async () => {
        const s = await startServe(defer);
        const cookie = await adminCookie(s);
        for (const username of ["dom", "sam"]) await s.rt.auth.createAccount(username, password);
        await s.rt.store.createWorkspace({ id: "acme", name: "Acme", createdAt: at }, "dom");
        await s.rt.store.setMembership({
            workspaceId: "acme",
            username: "sam",
            role: "owner",
            createdAt: at,
        });
        const statuses = await Promise.all(
            ["dom", "sam"].map(
                async (username) =>
                    (
                        await s.call(`/admin/workspaces/acme/members/${username}`, {
                            method: "DELETE",
                            headers: { cookie },
                        })
                    ).status
            )
        );
        expect(statuses.sort()).toEqual([204, 409]);
        expect(
            (await s.rt.store.listWorkspaceMembers("acme")).filter((m) => m.role === "owner")
        ).toHaveLength(1);
    });

    it("refuses unauthenticated callers, project and wildcard tokens, and writes from other pages", async () => {
        const s = await startServe(defer);
        const cookie = await adminCookie(s);
        // The board issues tokens for one project; a wildcard one (as older servers made) is issued directly.
        const tokens = [
            await issue(s, "shop"),
            (await s.rt.auth.issueToken("*", "Every project")).token,
        ];
        for (const path of ["/admin/workspaces", "/admin/workspaces/default"]) {
            expect((await s.call(path)).status).toBe(401);
            for (const token of tokens)
                expect((await s.call(path, { headers: bearer(token) })).status).toBe(403);
        }
        for (const token of tokens)
            expect(
                (
                    await s.call(
                        "/admin/users",
                        write(bearer(token), { username: "intruder", password })
                    )
                ).status
            ).toBe(403);
        for (const [path, method] of [
            ["/admin/users", "POST"],
            ["/admin/workspaces", "POST"],
            ["/admin/workspaces/default", "PATCH"],
            ["/admin/workspaces/default/members/admin", "PUT"],
        ] as const) {
            const res = await s.call(path, {
                method,
                headers: {
                    cookie,
                    origin: "http://localhost:3000",
                    "content-type": "application/json",
                },
                body: "{}",
            });
            expect(res.status).toBe(403);
        }
        expect(await s.rt.store.getUser("intruder")).toBeNull();
        expect((await s.rt.store.getWorkspace(DEFAULT_WORKSPACE_ID))?.name).toBe(
            "Default workspace"
        );
    });

    it("never treats a workspace owner as a server operator, even with a session from before workspaces", async () => {
        const s = await startServe(defer);
        await s.rt.auth.createAccount("dom", password);
        await s.rt.store.createWorkspace({ id: "acme", name: "Acme", createdAt: at }, "dom");
        const signedIn = await signIn(s, "dom");
        expect(await (await s.call("/auth/me", { headers: signedIn })).json()).toMatchObject({
            authenticated: true,
            isAdmin: false,
            workspace: { id: "acme", role: "owner" },
        });
        for (const path of ["/admin/workspaces", "/admin/tokens", "/settings"])
            expect((await s.call(path, { headers: signedIn })).status).toBe(403);
        expect(
            (await s.call("/admin/users", write(signedIn, { username: "x", password }))).status
        ).toBe(403);
        // A session with no selected workspace (as one stored before workspaces existed) reaches nothing.
        const value = "old-session";
        await s.rt.store.createSession({
            id: await sha256Hex(new TextEncoder().encode(value)),
            username: "dom",
            createdAt: at,
            expiresAt: "2099-01-01T00:00:00.000Z",
        });
        const name = signedIn.cookie.split("=")[0];
        const headers = { cookie: `${name}=${value}` };
        for (const path of [
            "/projects",
            "/annotations",
            "/admin/tokens",
            "/admin/workspaces",
            "/mcp",
        ])
            expect((await s.call(path, { headers })).status).toBe(401);
        await expect(s.rt.auth.ensureAdmin("dom", "operator password")).rejects.toThrow(
            "ordinary account"
        );
        expect((await s.rt.store.getUser("dom"))?.isAdmin).toBe(false);
    });
});

describe("membership of several workspaces", () => {
    it("lists every membership and applies only the selected workspace's role", async () => {
        const s = await startServe(defer);
        await s.rt.auth.createAccount("sam", password);
        for (const id of ["acme", "other"])
            await s.rt.store.createWorkspace({ id, name: id, createdAt: at }, "admin");
        await s.rt.store.setMembership({
            workspaceId: "acme",
            username: "sam",
            role: "admin",
            createdAt: at,
        });
        await s.rt.store.setMembership({
            workspaceId: "other",
            username: "sam",
            role: "member",
            createdAt: at,
        });
        const sam = await signIn(s, "sam");
        const me = (await (await s.call("/auth/me", { headers: sam })).json()) as {
            isAdmin: boolean;
            workspace: { id: string; role: string };
            workspaces: { id: string; role: string }[];
        };
        expect(me.isAdmin).toBe(false);
        expect(me.workspaces.map((w) => [w.id, w.role]).sort()).toEqual([
            ["acme", "admin"],
            ["other", "member"],
        ]);
        expect(me.workspace.id).toBe("acme");

        // An admin of acme makes projects there, and only there.
        expect((await s.call("/projects", write(sam, { id: "acme-app" }))).status).toBe(201);
        expect((await s.rt.store.getProject("acme-app"))?.workspaceId).toBe("acme");
        expect(
            (await s.call("/projects", write(sam, { id: "sneak", workspaceId: "other" }))).status
        ).toBe(403);

        // In the workspace where sam is a member, the same account cannot.
        expect((await s.call("/auth/workspace", write(sam, { workspaceId: "other" }))).status).toBe(
            200
        );
        expect(await (await s.call("/auth/me", { headers: sam })).json()).toMatchObject({
            workspace: { id: "other", role: "member" },
        });
        expect((await s.call("/projects", write(sam, { id: "other-app" }))).status).toBe(403);
        expect(await s.rt.store.getProject("other-app")).toBeNull();
        expect(await (await s.call("/projects", { headers: sam })).json()).toEqual({ items: [] });

        // Leaving one workspace leaves the other as it was.
        await s.rt.store.removeMembership("acme", "sam");
        expect((await s.rt.store.listMemberships("sam")).map((m) => m.workspaceId)).toEqual([
            "other",
        ]);
        expect(await (await s.call("/auth/me", { headers: sam })).json()).toMatchObject({
            workspace: { id: "other", role: "member" },
        });
    });
});
