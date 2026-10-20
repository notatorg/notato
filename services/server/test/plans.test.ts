import { describe, expect, it, setSystemTime } from "bun:test";
import { StripeBilling } from "../src/billing.ts";
import { runCloud } from "../src/index.ts";
import { HOSTED_LIMITS, QuotaError } from "../src/storage.ts";
import { annotationFixture, cleanupAfterEach, tempDir } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { embeddedPostgres } from "./postgres.ts";
import { startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
it("refuses test selection on a native server and when Stripe billing is configured before opening data", async () => {
    const dir = tempDir(defer);
    await expect(
        runCloud({
            dir,
            port: 0,
            version: "test",
            managedAuth: null,
            billing: null,
            testPlans: true,
        })
    ).rejects.toThrow("requires hosted identity");
    const billing = new StripeBilling({
        key: "sk_test_testing",
        webhookSecret: "whsec_testing",
        origin: "https://notato.example",
        plans: [
            {
                id: "team",
                name: "Team",
                priceId: "price_team",
                limits: { notes: 100, bytes: 100000, projects: 1, tokens: 2 },
            },
        ],
    });
    await expect(
        runCloud({
            dir,
            port: 0,
            version: "test",
            managedAuth: fakeManagedAuth(),
            billing,
            testPlans: true,
        })
    ).rejects.toThrow("payment billing to be disabled");
});
const workspace = (id: string) => ({ id, name: id, createdAt: new Date().toISOString() });
const user = (username: string) => ({
    username,
    passwordHash: "synthetic",
    createdAt: new Date().toISOString(),
});
const project = (id: string, workspaceId = "personal") => ({
    id,
    name: id,
    workspaceId,
    createdAt: new Date().toISOString(),
});
const note = (projectId = "p") => annotationFixture({ projectId, screenshots: undefined });
async function setup(_kind: "postgres") {
    const store = (await embeddedPostgres()).store;
    defer(() => store.close());
    store.setHostedLimits(HOSTED_LIMITS);
    store.setTestPlans(true);
    await store.upsertUser(user("owner"));
    await store.createWorkspace(workspace("personal"), "owner");
    await store.createProject(project("p"));
    return store;
}
describe.each(["postgres"] as const)("%s test plans", (kind) => {
    it("keeps one private free workspace per account while allowing separately upgraded teams and seats", async () => {
        const s = await setup(kind);
        await expect(s.createProject(project("second"))).rejects.toBeInstanceOf(QuotaError);
        await expect(s.createWorkspace(workspace("another"), "owner")).rejects.toThrow(
            "already has a free"
        );
        await s.createWorkspace(workspace("company"), "owner", { id: "pro", extraSeats: 2 });
        expect((await s.getWorkspaceLimits("company"))?.members).toBe(5);
        for (let i = 0; i < 5; i++) {
            const username = `person${i}`;
            await s.upsertUser(user(username));
            if (i < 4)
                await s.setMembership({
                    workspaceId: "company",
                    username,
                    role: "member",
                    createdAt: new Date().toISOString(),
                });
            else
                await expect(
                    s.setMembership({
                        workspaceId: "company",
                        username,
                        role: "member",
                        createdAt: new Date().toISOString(),
                    })
                ).rejects.toBeInstanceOf(QuotaError);
        }
        await expect(
            s.setMembership({
                workspaceId: "personal",
                username: "person0",
                role: "member",
                createdAt: new Date().toISOString(),
            })
        ).rejects.toBeInstanceOf(QuotaError);
        await expect(
            s.createInvitation({
                id: "invite",
                workspaceId: "personal",
                email: "person@example.test",
                role: "member",
                tokenHash: "hash",
                createdBy: "owner",
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 86400_000).toISOString(),
            })
        ).rejects.toThrow("private");
        await expect(s.selectWorkspacePlan("company", "person0", "team", 0)).rejects.toThrow(
            "owner required"
        );
        await expect(s.selectWorkspacePlan("company", "owner", "free", 0)).rejects.toThrow(
            "already has a free"
        );
        await expect(s.selectWorkspacePlan("company", "owner", "pro", 0)).rejects.toThrow(
            "exceeds"
        );
        expect((await s.getWorkspaceLimits("company"))?.members).toBe(5);
        await s.selectWorkspacePlan("company", "owner", "team", 0);
        expect((await s.getWorkspaceLimits("company"))?.members).toBe(10);
        expect((await s.getWorkspaceLimits("personal"))?.members).toBe(1);
    });
    it("never grants a second Free workspace alongside paid workspaces, including simultaneous creation", async () => {
        const s = await setup(kind);
        await s.selectWorkspacePlan("personal", "owner", "pro", 0);
        await s.createWorkspace(workspace("company"), "owner", { id: "team", extraSeats: 0 });
        const attempts = await Promise.allSettled([
            s.createWorkspace(workspace("free-one"), "owner"),
            s.createWorkspace(workspace("free-two"), "owner"),
        ]);
        expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(1);
        expect(await s.ownedFreeWorkspace("owner")).not.toBeNull();
        await expect(s.selectWorkspacePlan("personal", "owner", "free", 0)).rejects.toThrow(
            "already has a free"
        );
        await expect(s.createWorkspace(workspace("free-three"), "owner")).rejects.toThrow(
            "already has a free"
        );
    });
    it("counts accepted notes in UTC months and retains receipts after deletions, project recreation, and workspace recreation", async () => {
        setSystemTime(new Date("2030-04-15T12:00:00Z"));
        defer(() => setSystemTime());
        const s = await setup(kind);
        for (let i = 0; i < 100; i++) await s.insertAnnotation(note());
        expect((await s.monthlyNoteUsage("personal")).notes).toBe(100);
        await expect(
            s.insertAnnotation({ ...note(), createdAt: "2000-01-01T00:00:00Z" })
        ).rejects.toBeInstanceOf(QuotaError);
        const existing = (await s.listAnnotations({ projectId: "p" }))[0];
        if (!existing) throw new Error("expected stored annotation");
        await s.updateAnnotation(existing.annotation.id, (a) => ({ ...a, status: "resolved" }));
        expect((await s.monthlyNoteUsage("personal")).notes).toBe(100);
        await s.deleteProject("p");
        await s.createProject(project("new"));
        expect((await s.workspaceUsage("personal")).notes).toBe(0);
        await expect(s.insertAnnotation(note("new"))).rejects.toBeInstanceOf(QuotaError);
        await s.deleteWorkspace("personal", "owner");
        const replacement = (await s.listMemberships("owner"))[0];
        if (!replacement) throw new Error("expected replacement workspace");
        await s.createProject(project("replacement", replacement.workspaceId));
        expect((await s.monthlyNoteUsage(replacement.workspaceId)).notes).toBe(100);
        await expect(s.insertAnnotation(note("replacement"))).rejects.toBeInstanceOf(QuotaError);
        setSystemTime(new Date("2030-05-01T00:00:00Z"));
        await s.insertAnnotation(note("replacement"));
        expect(await s.monthlyNoteUsage(replacement.workspaceId)).toEqual({
            notes: 1,
            periodStart: "2030-05-01T00:00:00.000Z",
            periodEnd: "2030-06-01T00:00:00.000Z",
        });
    });
    it("keeps monthly usage through plan changes, bounds concurrent final-slot uploads, and never consumes receipts on failed inserts", async () => {
        const s = await setup(kind);
        for (let i = 0; i < 99; i++) await s.insertAnnotation(note());
        const attempts = await Promise.allSettled([
            s.insertAnnotation(note()),
            s.insertAnnotation(note()),
        ]);
        expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
        expect((await s.monthlyNoteUsage("personal")).notes).toBe(100);
        await s.selectWorkspacePlan("personal", "owner", "pro", 0);
        const a = note();
        await s.insertAnnotation(a);
        await expect(s.insertAnnotation(a)).rejects.toThrow();
        expect((await s.monthlyNoteUsage("personal")).notes).toBe(101);
        await s.selectWorkspacePlan("personal", "owner", "free", 0);
        await expect(s.insertAnnotation(note())).rejects.toBeInstanceOf(QuotaError);
        expect((await s.workspaceUsage("personal")).notes).toBe(101);
    });
    it("enforces storage independently of note counts and permits deletion without refunding monthly usage", async () => {
        const s = await setup(kind);
        const a = note();
        await s.insertAnnotation(a, 200 * 1024 ** 2);
        await expect(s.insertAnnotation(note(), 60 * 1024 ** 2)).rejects.toBeInstanceOf(QuotaError);
        expect((await s.monthlyNoteUsage("personal")).notes).toBe(1);
        await s.deleteAnnotation(a.id);
        await s.insertAnnotation(note(), 60 * 1024 ** 2);
        expect((await s.monthlyNoteUsage("personal")).notes).toBe(2);
    });
    it("limits Free keys across purposes, excludes revoked or expired keys, and ignores saved test plans when the feature is disabled", async () => {
        const s = await setup(kind);
        const key = (id: string, permission: "capture" | "full") => ({
            id,
            name: id,
            permission,
            projectId: "p",
            workspaceId: "personal",
            createdBy: "owner",
            tokenHash: id,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        });
        await s.createToken(key("capture", "capture"));
        await s.createToken(key("agent", "full"));
        for (let i = 0; i < 4; i++)
            await s.createToken(key(`active-${i}`, i % 2 ? "full" : "capture"));
        await expect(s.createToken(key("over-limit", "capture"))).rejects.toBeInstanceOf(
            QuotaError
        );
        await s.revokeToken("capture", new Date().toISOString());
        await s.createToken({
            ...key("expired", "capture"),
            expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        await s.createToken({ ...key("feedback", "full"), purpose: "app" });
        expect((await s.workspaceUsage("personal")).tokens).toBe(6);
        expect((await s.selectWorkspacePlan("personal", "owner", "free", 0)).id).toBe("free");
        await s.selectWorkspacePlan("personal", "owner", "team", 0);
        await s.createToken(key("other-agent", "full"));
        await expect(s.selectWorkspacePlan("personal", "owner", "free", 0)).rejects.toThrow(
            "exceeds"
        );
        s.setTestPlans(false);
        await expect(s.selectWorkspacePlan("personal", "owner", "pro", 0)).rejects.toThrow(
            "disabled"
        );
        expect((await s.getWorkspaceLimits("personal"))?.projects).toBe(HOSTED_LIMITS.projects);
    });
});

it("allows only the current owner to choose test plans, refuses browser origins and client-provided limits, and keeps provider billing separate", async () => {
    const s = await startServe(defer, { managedAuth: fakeManagedAuth(), testPlans: true });
    const alice = await customer(s, "alice"),
        bob = await customer(s, "bob");
    const me = await (await s.call("/auth/me", { headers: { cookie: alice.cookie } })).json();
    expect(
        (
            await s.call("/workspaces", {
                method: "POST",
                headers: { cookie: alice.cookie, "content-type": "application/json" },
                body: JSON.stringify({ name: "Second free workspace" }),
            })
        ).status
    ).toBe(409);
    const call = (cookie: string, body: unknown, origin?: string) =>
        s.call("/billing/plan", {
            method: "POST",
            headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) },
            body: JSON.stringify(body),
        });
    expect((await call(alice.cookie, { plan: "team", extraSeats: 2 })).status).toBe(200);
    expect((await call(alice.cookie, { plan: "pro", limits: { projects: 1000000 } })).status).toBe(
        400
    );
    expect((await call(alice.cookie, { plan: "pro" }, "https://evil.example")).status).toBe(403);
    expect((await call(alice.cookie, { plan: "free", extraSeats: 1 })).status).toBe(400);
    await s.rt.store.setMembership({
        workspaceId: me.workspace.id,
        username: (await (await s.call("/auth/me", { headers: { cookie: bob.cookie } })).json())
            .username,
        role: "member",
        createdAt: new Date().toISOString(),
    });
    await s.call("/auth/workspace", {
        method: "POST",
        headers: { cookie: bob.cookie, "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: me.workspace.id }),
    });
    expect((await call(bob.cookie, { plan: "team" })).status).toBe(403);
    const info = await (await s.call("/billing", { headers: { cookie: alice.cookie } })).json();
    expect(info).toMatchObject({
        enabled: false,
        selfServicePlans: true,
        testMode: true,
        selection: { id: "team", extraSeats: 2 },
        limits: { members: 12, notesPerMonth: 10000 },
        monthlyNotes: { notes: 0 },
    });
    expect(await s.rt.store.getBilling(me.workspace.id)).toBeNull();
    const disabled = await startServe(defer, { managedAuth: fakeManagedAuth() });
    const c = await customer(disabled, "alice");
    expect(
        (
            await disabled.call("/billing/plan", {
                method: "POST",
                headers: { cookie: c.cookie, "content-type": "application/json" },
                body: JSON.stringify({ plan: "team" }),
            })
        ).status
    ).toBe(403);
});
