import { expect, it } from "bun:test";
import { BetaLimiter, betaCookie, betaFromEnv, invitationCookie } from "../src/beta.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import { cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { embeddedPostgres } from "./postgres.ts";
import { startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
function required<T>(value: T | null | undefined): T {
    if (value == null) throw new Error("Missing test fixture");
    return value;
}
const sessionCookie = (response: Response) =>
    (
        response.headers.getSetCookie().find((v) => /^(?:__Host-)?notato_session=/.test(v)) ?? ""
    ).split(";")[0] as string;
async function setup() {
    const managed = fakeManagedAuth();
    const verify = managed.verify;
    managed.config.signupMode = "closed";
    managed.verify = async (token) =>
        token === "bob2" ? { ...required(await verify("bob")), subject: "bob2" } : verify(token);
    const s = await startServe(defer, {
        managedAuth: managed,
        beta: { admins: new Set(["alice@example.com"]) },
        testPlans: true,
    });
    const alice = await customer(s, "alice");
    const headers = { origin: s.base, "x-notato-board": "1", "content-type": "application/json" };
    const admin = { ...headers, cookie: alice.cookie };
    const post = (path: string, value: unknown, cookie?: string) =>
        s.call(path, {
            method: "POST",
            headers: { ...headers, ...(cookie ? { cookie } : {}) },
            body: JSON.stringify(value),
        });
    const patch = (value: unknown) =>
        s.call("/beta/admin", { method: "PATCH", headers: admin, body: JSON.stringify(value) });
    const join = (email: string) =>
        post("/beta/waitlist", { email, sdk: "React", useCase: "Test my app" });
    const list = async () =>
        (await (await s.call("/beta/admin/requests", { headers: admin })).json()) as {
            items: Array<{ id: string; email: string; state: string }>;
        };
    const invite = async (email: string) => {
        const item = required((await list()).items.find((v) => v.email === email));
        const response = await post(
            `/beta/admin/requests/${item.id}/invite`,
            { days: 7 },
            alice.cookie
        );
        expect(response.status).toBe(201);
        const issued = (await response.json()) as { url: string; invitation: { id: string } };
        expect(issued).not.toHaveProperty("tokenHash");
        const token = required(issued.url.split("/invite/")[1]);
        const checked = await post("/beta/invitation", { token });
        expect(checked.status).toBe(200);
        return {
            id: item.id,
            token,
            cookie: required(required(checked.headers.get("set-cookie")).split(";")[0]),
            response,
        };
    };
    return { s, alice, admin, headers, post, patch, join, list, invite };
}
it("validates beta operator configuration and isolates the secure invitation cookie", () => {
    expect(betaFromEnv({})).toBeUndefined();
    expect(() => betaFromEnv({ NOTATO_BETA_ENABLED: "yes" })).toThrow();
    expect(() => betaFromEnv({ NOTATO_BETA_ENABLED: "1" })).toThrow();
    expect(() =>
        betaFromEnv({ NOTATO_BETA_ENABLED: "1", NOTATO_BETA_ADMIN_EMAILS: "*@example.com" })
    ).toThrow();
    expect(
        betaFromEnv({
            NOTATO_BETA_ENABLED: "1",
            NOTATO_BETA_ADMIN_EMAILS: "Alice@Example.com",
        })?.admins.has("alice@example.com")
    ).toBe(true);
    expect(invitationCookie("value", true, 60)).toContain(
        "__Host-notato_beta=value; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure"
    );
    const req = new Request("https://notato.example", {
        headers: { cookie: "notato_beta=forged; __Host-notato_beta=real" },
    });
    expect(betaCookie(req, true)).toBe("real");
    expect(
        betaCookie(
            new Request("https://notato.example", { headers: { cookie: "notato_beta=forged" } }),
            true
        )
    ).toBeUndefined();
    const limiter = new BetaLimiter();
    for (let i = 0; i < 5; i++) expect(limiter.allow("one", 1000)).toBe(true);
    expect(limiter.allow("one", 1000)).toBe(false);
    expect(limiter.allow("one", 61001)).toBe(true);
});
it("keeps waitlist requests private, bounded and idempotent without creating accounts", async () => {
    const { s, admin, headers, post, list } = await setup();
    const first = await post("/beta/waitlist", {
        email: " Bob@Example.com ",
        sdk: "React",
        useCase: "First message",
    });
    const duplicate = await post("/beta/waitlist", {
        email: "bob@example.com",
        sdk: "Other",
        useCase: "Overwrite attempt",
    });
    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(await first.json()).toEqual(await duplicate.json());
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect((await list()).items).toHaveLength(1);
    const stored = required((await s.rt.store.listBetaRequests()).items[0]);
    expect(stored.sdk).toBe("React");
    expect(stored.useCase).toBe("First message");
    expect((await s.rt.store.betaOverview()).users).toBe(1);
    expect((await s.call("/beta/admin")).status).toBe(401);
    expect((await s.call("/beta/admin/requests")).status).toBe(401);
    expect((await post("/beta/admin/sync", {})).status).toBe(401);
    expect((await post("/beta/admin/sync", {}, admin.cookie)).status).toBe(404);
    expect((await post("/beta/waitlist", { email: "bad" })).status).toBe(400);
    expect(
        (
            await s.call("/beta/waitlist", {
                method: "POST",
                headers: { ...headers, origin: "https://attacker.example" },
                body: JSON.stringify({ email: "x@example.com" }),
            })
        ).status
    ).toBe(403);
    expect(
        (await post("/beta/waitlist", { email: "bot@example.com", website: "spam" })).status
    ).toBe(202);
    expect((await list()).items).toHaveLength(1);
    expect(
        (await s.call("/beta/waitlist", { method: "POST", headers, body: "x".repeat(9000) })).status
    ).toBe(413);
    expect((await post("/beta/waitlist", { email: "sixth@example.com" })).status).toBe(429);
    expect((await s.call("/auth/me", { headers: admin })).status).toBe(200);
});
it("requires a live, email-bound invitation and admission capacity even with a valid provider identity", async () => {
    const { s, alice, admin, post, patch, join, invite } = await setup();
    expect((await post("/auth/session", { accessToken: "bob" })).status).toBe(403);
    expect((await join("bob@example.com")).status).toBe(202);
    const issued = await invite("bob@example.com");
    expect((await s.rt.store.betaOverview()).users).toBe(1); // Issuing an invite never provisions an account.
    expect((await post("/auth/session", { accessToken: "carol" }, issued.cookie)).status).toBe(403);
    expect((await post("/auth/session", { accessToken: "bob" }, issued.cookie)).status).toBe(403); // paused by default
    expect((await patch({ paused: false, maxUsers: 1 })).status).toBe(200);
    // Two independently verified subjects cannot claim the same invitation, even with the same email.
    const attempts = await Promise.all([
        post("/auth/session", { accessToken: "bob" }, issued.cookie),
        post("/auth/session", { accessToken: "bob2" }, issued.cookie),
    ]);
    expect(attempts.map((v) => v.status).sort()).toEqual([200, 403]);
    const admitted = required(attempts.find((v) => v.status === 200));
    expect(
        admitted.headers
            .getSetCookie()
            .some((v) => v.includes("notato_beta=;") && v.includes("Max-Age=0"))
    ).toBe(true);
    const bobCookie = sessionCookie(admitted);
    const me = (await (await s.call("/auth/me", { headers: { cookie: bobCookie } })).json()) as {
        betaAdmin: boolean;
    };
    expect(me.betaAdmin).toBe(false);
    expect((await s.call("/beta/admin", { headers: { cookie: bobCookie } })).status).toBe(403);
    expect((await s.call("/beta/admin/requests", { headers: { cookie: bobCookie } })).status).toBe(
        403
    );
    expect((await post("/beta/invitation", { token: issued.token })).status).toBe(403);
    expect((await join("carol@example.com")).status).toBe(202);
    const row = required(
        (await s.rt.store.listBetaRequests()).items.find((v) => v.email === "carol@example.com")
    );
    expect(
        (await post(`/beta/admin/requests/${row.id}/invite`, { days: 7 }, alice.cookie)).status
    ).toBe(409);
    expect((await patch({ paused: true, maxUsers: 1 })).status).toBe(200);
    expect((await s.call("/auth/me", { headers: { cookie: bobCookie } })).status).toBe(200);
    const identity = attempts[0]?.status === 200 ? "bob" : "bob2";
    expect((await post("/auth/session", { accessToken: identity })).status).toBe(200); // existing admitted user, no invite needed
    expect(
        ((await (await s.call("/beta/admin", { headers: admin })).json()) as { active: number })
            .active
    ).toBe(1);
});
it("revokes sessions and credentials, blocks owned workspaces, and requires a fresh invitation to restore access", async () => {
    const { s, alice, post, patch, join, invite, admin } = await setup();
    await patch({ paused: false, maxUsers: 10 });
    await join("bob@example.com");
    const issued = await invite("bob@example.com");
    const login = await post("/auth/session", { accessToken: "bob" }, issued.cookie);
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);
    const me = (await (await s.call("/auth/me", { headers: { cookie } })).json()) as {
        username: string;
        workspace: { id: string };
    };
    await s.rt.store.selectWorkspacePlan(me.workspace.id, me.username, "pro", 0);
    const created = await post("/projects", { name: "Beta app", agent: true }, cookie);
    expect(created.status).toBe(201);
    const project = (await created.json()) as {
        project: { id: string };
        token: { token: string };
        agentToken: { token: string };
    };
    const key = await post(
        "/tokens",
        { projectId: project.project.id, name: "Personal", purpose: "app", permission: "full" },
        cookie
    );
    expect(key.status).toBe(201);
    const personal = (await key.json()) as { token: string };
    expect(
        (
            await s.call("/beta/admin", {
                headers: { authorization: `Bearer ${project.agentToken.token}` },
            })
        ).status
    ).toBe(403);
    const revoked = await post(`/beta/admin/requests/${issued.id}/revoke`, {}, alice.cookie);
    expect(revoked.status).toBe(200);
    expect(
        (
            (await (await s.call("/auth/me", { headers: { cookie } })).json()) as {
                authenticated: boolean;
            }
        ).authenticated
    ).toBe(false);
    for (const token of [personal.token, project.token.token, project.agentToken.token])
        expect(
            (
                await s.call(`/projects/${project.project.id}/annotations`, {
                    headers: { authorization: `Bearer ${token}` },
                })
            ).status
        ).toBe(401);
    expect((await post("/auth/session", { accessToken: "bob" })).status).toBe(403);
    const replacement = await invite("bob@example.com");
    expect((await post("/auth/session", { accessToken: "bob" })).status).toBe(403); // inviting is not itself restoration
    expect((await post("/auth/session", { accessToken: "bob" }, replacement.cookie)).status).toBe(
        200
    );
    expect(
        (
            await s.call(`/projects/${project.project.id}/annotations`, {
                headers: { authorization: `Bearer ${personal.token}` },
            })
        ).status
    ).toBe(401); // personal keys stay revoked
    expect(
        (
            await s.call(`/projects/${project.project.id}/annotations`, {
                headers: { authorization: `Bearer ${project.agentToken.token}` },
            })
        ).status
    ).toBe(401); // Project-creation keys are personal and remain revoked after offboarding.
    expect((await s.call("/beta/admin", { headers: admin })).status).toBe(200);
});

it("upgrades v13, protects waitlist data, expires and rotates reservations, and paginates requests", async () => {
    const { pg, store, database } = await embeddedPostgres();
    defer(() => store.close());
    await pg.exec(
        "DROP TABLE notato.beta_requests; DROP TABLE notato.beta_settings; UPDATE notato.meta SET value='13' WHERE key='schema_version'"
    );
    const upgraded = await PostgresStore.open(database);
    expect(await upgraded.betaSettings()).toEqual({ paused: true, maxUsers: 10 });
    for (const role of ["anon", "authenticated"]) {
        for (const table of ["beta_requests", "beta_settings"])
            expect(
                (
                    await pg.query<{ allowed: boolean }>(
                        "SELECT has_table_privilege($1,$2,'SELECT') AS allowed",
                        [role, `notato.${table}`]
                    )
                ).rows[0]?.allowed
            ).toBe(false);
    }
    const now = new Date().toISOString();
    await upgraded.upsertUser({ username: "beta-admin", passwordHash: "hash", createdAt: now });
    for (let i = 0; i < 55; i++)
        await upgraded.requestBeta({
            id: String(i).padStart(26, "0"),
            email: `tester${i}@example.com`,
            sdk: "",
            useCase: "",
            createdAt: now,
        });
    const first = await upgraded.listBetaRequests();
    expect(first.items).toHaveLength(50);
    const second = await upgraded.listBetaRequests(undefined, first.nextCursor);
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map((v) => v.id)).size).toBe(55);
    const a = required(first.items[0]).id;
    const b = required(first.items[1]).id;
    const c = required(first.items[2]).id;
    await upgraded.configureBeta({ paused: false, maxUsers: 2 });
    const future = new Date(Date.now() + 86400_000).toISOString();
    await upgraded.inviteBeta(a, "beta-admin", "first-hash", future);
    await upgraded.inviteBeta(b, "beta-admin", "second-hash", future);
    await expect(upgraded.inviteBeta(c, "beta-admin", "third-hash", future)).rejects.toThrow(
        "All beta places"
    );
    await expect(upgraded.configureBeta({ paused: false, maxUsers: 1 })).rejects.toThrow(
        "reservations"
    );
    await upgraded.inviteBeta(a, "beta-admin", "replacement-hash", future);
    expect(await upgraded.betaInvitation("first-hash")).toBeNull();
    expect(await upgraded.betaInvitation("replacement-hash")).not.toBeNull();
    await upgraded.inviteBeta(a, "beta-admin", "expired-hash", "2000-01-01T00:00:00.000Z");
    expect(await upgraded.betaInvitation("expired-hash")).toBeNull();
    await upgraded.inviteBeta(c, "beta-admin", "third-hash", future);
    await upgraded.revokeBeta(b);
    await upgraded.configureBeta({ paused: true, maxUsers: 1 });
    expect(JSON.stringify(await upgraded.listBetaRequests())).not.toContain("third-hash");
    expect(
        (
            await pg.query<{ token_hash: string }>(
                "SELECT token_hash FROM notato.beta_requests WHERE id=$1",
                [c]
            )
        ).rows[0]?.token_hash
    ).toBe("third-hash");
});
