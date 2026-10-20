import { describe, expect, it } from "bun:test";
import { generateSecret, LoginLimiter, sha256Hex } from "@notato/server";
import { Authenticator } from "../src/auth.ts";
import {
    clientAddress,
    HostedGuard,
    INGRESS_LIMITS,
    limitedResponse,
} from "../src/hosted-guard.ts";
import { annotationFixture, cleanupAfterEach, filesFor, multipart, waitFor } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { ADMIN_PASSWORD, adminCookie, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
const json = (cookie: string, body: unknown) => ({
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
});
async function project(s: Awaited<ReturnType<typeof startServe>>, cookie: string) {
    const response = await s.call("/projects", json(cookie, { name: "Sensitive" }));
    expect(response.status).toBe(201);
    return (await response.json()) as {
        project: { id: string };
        token: { token: string; record: { id: string; expiresAt: string; permission: string } };
    };
}

describe("hosted least privilege", () => {
    it("issues expiring capture tokens and blocks feedback reads, mutation, assets, bundles, relays and MCP", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const made = await project(s, alice.cookie);
        expect(made.token.record.permission).toBe("capture");
        expect(Date.parse(made.token.record.expiresAt) - Date.now()).toBeLessThanOrEqual(
            90 * 86400_000
        );
        const headers = { authorization: `Bearer ${made.token.token}` };
        const a = annotationFixture({ projectId: made.project.id, screenshots: undefined });
        expect(
            (
                await s.call(`/projects/${made.project.id}/annotations`, {
                    method: "POST",
                    headers,
                    body: multipart(a, new Map()),
                })
            ).status
        ).toBe(201);
        const paths = [
            "/annotations",
            `/projects/${made.project.id}/annotations`,
            `/annotations/${a.id}`,
            `/annotations/${a.id}.md`,
            "/annotations/wait",
            "/events",
            "/status",
            "/projects",
            "/tokens",
            "/config/mentions",
            "/relay",
            `/projects/${made.project.id}/bundles`,
            `/assets/${"a".repeat(64)}`,
        ];
        for (const path of paths) expect((await s.call(path, { headers })).status).toBe(403);
        for (const path of [
            `/annotations/${a.id}`,
            `/annotations/${a.id}/replies`,
            "/tokens",
            "/workspace/invitations",
            "/relay",
            "/annotations/handed",
        ])
            expect((await s.call(path, { method: "POST", headers, body: "{}" })).status).toBe(403);
        expect((await s.call("/mcp", { method: "POST", headers, body: "{}" })).status).toBe(403);
        expect(await (await s.call("/config", { headers })).json()).toMatchObject({
            captureOnly: true,
            mentions: [],
            agent: { connected: false },
        });
        expect((await s.call(`/annotations?token=${made.token.token}`)).status).toBe(401);
    });

    it("does not disclose existing feedback on retry, or reuse a guessed screenshot without its bytes", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const made = await project(s, alice.cookie);
        const a = annotationFixture({
            projectId: made.project.id,
            comment: "Sensitive existing report",
        });
        expect(
            (
                await s.call(`/projects/${made.project.id}/annotations`, {
                    method: "POST",
                    headers: { cookie: alice.cookie },
                    body: multipart(a, filesFor()),
                })
            ).status
        ).toBe(201);
        const headers = { authorization: `Bearer ${made.token.token}` };
        const retry = await s.call(`/projects/${made.project.id}/annotations`, {
            method: "POST",
            headers,
            body: multipart(a, filesFor()),
        });
        expect(retry.status).toBe(409);
        expect(await retry.text()).not.toContain("Sensitive existing report");
        const copy = annotationFixture({ projectId: made.project.id });
        expect(
            (
                await s.call(`/projects/${made.project.id}/annotations`, {
                    method: "POST",
                    headers,
                    body: multipart(copy, new Map()),
                })
            ).status
        ).toBe(400);
        const shared = await s.call(`/shared/${"a".repeat(64)}.png?sig=legacy`);
        expect(shared.status).toBe(404);
        expect(shared.headers.get("cache-control")).toBe("no-store");
    });

    it("allows explicit private integration access, expiration and revocation, without browser access", async () => {
        const s = await startServe(defer, {
            managedAuth: fakeManagedAuth(),
            corsOrigins: ["https://app.example.com"],
        });
        const alice = await customer(s, "alice");
        const made = await project(s, alice.cookie);
        const issued = await s.call(
            "/tokens",
            json(alice.cookie, {
                projectId: made.project.id,
                name: "Private agent",
                permission: "full",
                expiresInDays: 7,
            })
        );
        const token = (await issued.json()) as { token: string; record: { id: string } };
        const headers = { authorization: `Bearer ${token.token}` };
        expect((await s.call("/annotations", { headers })).status).toBe(200);
        expect(
            (
                await s.call("/annotations", {
                    headers: { ...headers, origin: "https://app.example.com" },
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call("/mcp", {
                    method: "POST",
                    headers: { ...headers, origin: "https://app.example.com" },
                    body: "{}",
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call(`/tokens/${token.record.id}`, {
                    method: "DELETE",
                    headers: { cookie: alice.cookie },
                })
            ).status
        ).toBe(204);
        expect((await s.call("/annotations", { headers })).status).toBe(401);
        let now = new Date();
        const auth = new Authenticator(s.rt.store, { managed: fakeManagedAuth(), now: () => now });
        const expiring = await auth.issueToken(made.project.id, "short", {
            expiresInDays: 1,
        });
        now = new Date(now.getTime() + 86400_001);
        expect(
            await auth.identify(
                new Request(s.base, { headers: { authorization: `Bearer ${expiring.token}` } }),
                new URL(s.base)
            )
        ).toBeNull();
        const legacy = generateSecret("notato_");
        await s.rt.store.createToken({
            id: "legacy",
            name: "old",
            projectId: "*",
            tokenHash: await sha256Hex(new TextEncoder().encode(legacy)),
            createdAt: new Date().toISOString(),
        });
        expect(
            (await s.call("/annotations", { headers: { authorization: `Bearer ${legacy}` } }))
                .status
        ).toBe(401);
        expect(
            (
                await s.call(
                    "/tokens",
                    json(alice.cookie, { projectId: "*", name: "bad", permission: "capture" })
                )
            ).status
        ).toBe(400);
    });

    it("rejects cookie requests from allowed SDK origins, protocol downgrade, foreign hosts and form CSRF", async () => {
        process.env.NOTATO_PUBLIC_URL = "https://feedback.example.com";
        const s = await startServe(
            defer,
            {
                managedAuth: fakeManagedAuth(),
                trustProxy: true,
                allowedHosts: ["feedback.example.com"],
                corsOrigins: ["http://feedback.example.com", "https://app.example.com"],
            },
            { "x-forwarded-proto": "https" }
        );
        delete process.env.NOTATO_PUBLIC_URL;
        const alice = await customer(s, "alice");
        const request = (origin: string, extra: Record<string, string> = {}, method = "GET") =>
            s.rt.handle(
                new Request("http://feedback.example.com/workspace", {
                    method,
                    headers: {
                        host: "feedback.example.com",
                        "x-forwarded-proto": "https",
                        cookie: alice.cookie,
                        origin,
                        ...extra,
                    },
                    ...(method === "PATCH" ? { body: JSON.stringify({ name: "Changed" }) } : {}),
                })
            );
        expect((await request("https://app.example.com")).status).toBe(403);
        expect((await request("http://feedback.example.com")).status).toBe(403);
        expect(
            (await request("https://feedback.example.com", { host: "evil.example.com" })).status
        ).toBe(403);
        expect(
            (await request("https://feedback.example.com", { "x-forwarded-proto": "http" })).status
        ).toBe(400);
        expect(
            (
                await request(
                    "https://feedback.example.com",
                    { "sec-fetch-site": "same-origin" },
                    "PATCH"
                )
            ).status
        ).toBe(403);
        expect(
            (
                await request(
                    "https://feedback.example.com",
                    {
                        "sec-fetch-site": "same-origin",
                        "x-notato-board": "1",
                        "content-type": "application/json",
                    },
                    "PATCH"
                )
            ).status
        ).toBe(200);
        const privateOrigin = await s.call("/config", {
            headers: { origin: "http://localhost:5173" },
        });
        expect(privateOrigin.status).toBe(403);
        expect(privateOrigin.headers.get("access-control-allow-origin")).toBeNull();
    });
});

describe("account devices and MFA", () => {
    it("does not share memberships, cookies or private keys across identity issuers with the same subject", async () => {
        const s = await startServe(defer);
        const issuer = (namespace: string) => ({
            ...fakeManagedAuth(),
            config: {
                provider: "better-auth" as const,
                url: "https://notato.example.test",
                identityNamespace: namespace,
            },
            async verify() {
                return {
                    provider: namespace,
                    subject: "alice",
                    email: "same@example.com",
                    displayName: "Alice",
                    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                };
            },
        });
        const a = issuer("instance-a");
        const b = issuer("instance-b");
        const jwt = (_url: string) => "verified-test-session";
        const authA = new Authenticator(s.rt.store, { managed: a });
        const authB = new Authenticator(s.rt.store, { managed: b });
        const first = await authA.managedLogin(jwt(a.config.url), new Request(s.base), "a");
        const second = await authB.managedLogin(jwt(b.config.url), new Request(s.base), "b");
        if (!first.ok || !second.ok) throw new Error("namespace fixture failed");
        const cookieA = first.cookie.split(";")[0] ?? "";
        const cookieB = second.cookie.split(";")[0] ?? "";
        const requestA = new Request(s.base, { headers: { cookie: cookieA } });
        const requestB = new Request(s.base, { headers: { cookie: cookieB } });
        const principalA = await authA.identify(requestA, new URL(s.base));
        const principalB = await authB.identify(requestB, new URL(s.base));
        if (principalA?.kind !== "member" || principalB?.kind !== "member")
            throw new Error("namespace members missing");
        expect(principalA.username).not.toBe(principalB.username);
        expect(principalA.workspaceId).not.toBe(principalB.workspaceId);
        expect(await authB.identify(requestA, new URL(s.base))).toBeNull();
        await s.rt.backend.createWorkspaceProject("issuer-a", "Issuer A", principalA.workspaceId);
        const key = await authA.issueToken("issuer-a", "Private", {
            workspaceId: principalA.workspaceId,
            permission: "full",
            createdBy: principalA.username,
        });
        const request = new Request(s.base, { headers: { authorization: `Bearer ${key.token}` } });
        expect(await authA.identify(request, new URL(s.base))).not.toBeNull();
        expect(await authB.identify(request, new URL(s.base))).toBeNull();
    });
    it("permanently revokes an offboarded issuer's private keys and invitations, and deletes selected workspace cookies", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const bob = await customer(s, "bob");
        const aliceMe = (await (
            await s.call("/auth/me", { headers: { cookie: alice.cookie } })
        ).json()) as { username: string; workspace: { id: string } };
        const bobMe = (await (
            await s.call("/auth/me", { headers: { cookie: bob.cookie } })
        ).json()) as { username: string };
        await s.rt.store.setMembership({
            workspaceId: aliceMe.workspace.id,
            username: bobMe.username,
            role: "owner",
            createdAt: new Date().toISOString(),
        });
        const made = await project(s, alice.cookie);
        const privateResponse = await s.call(
            "/tokens",
            json(alice.cookie, {
                projectId: made.project.id,
                name: "Private",
                permission: "full",
                purpose: "app",
                ownership: "user",
            })
        );
        const privateKey = (await privateResponse.json()) as { token: string };
        const invited = await s.call(
            "/workspace/invitations",
            json(alice.cookie, { email: "carol@example.com", role: "admin" })
        );
        const invitation = (await invited.json()) as { url: string };
        const secret = new URL(invitation.url).searchParams.get("invite");
        await s.rt.store.removeMembership(aliceMe.workspace.id, aliceMe.username);
        expect(
            (
                await s.call("/annotations", {
                    headers: { authorization: `Bearer ${privateKey.token}` },
                })
            ).status
        ).toBe(401);
        expect((await s.call(`/invitations/${secret}`)).status).toBe(404);
        await s.rt.store.setMembership({
            workspaceId: aliceMe.workspace.id,
            username: aliceMe.username,
            role: "owner",
            createdAt: new Date().toISOString(),
        });
        expect(
            (
                await s.call("/annotations", {
                    headers: { authorization: `Bearer ${privateKey.token}` },
                })
            ).status
        ).toBe(401);
        expect(
            await (await s.call("/auth/me", { headers: { cookie: alice.cookie } })).json()
        ).toMatchObject({ authenticated: false });
        expect(
            (await s.call("/config", { headers: { authorization: `Bearer ${made.token.token}` } }))
                .status
        ).toBe(401); // Project-creation app keys belong to the offboarded account.
    });
    it("uses a host-prefixed secure cookie for HTTPS and ignores injected legacy cookie names", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const auth = new Authenticator(s.rt.store, {
            managed: fakeManagedAuth(),
            secureCookies: true,
        });
        const result = await auth.managedLogin("alice", new Request(s.base), "test", true);
        if (!result.ok) throw new Error("test sign-in failed");
        expect(result.cookie).toStartWith("__Host-notato_session=");
        expect(result.cookie).toContain("Secure");
        expect(result.cookie).toContain("HttpOnly");
        expect(result.cookie).not.toContain("Domain=");
        const cookie = result.cookie.split(";")[0] ?? "";
        expect(
            await auth.identify(new Request(s.base, { headers: { cookie } }), new URL(s.base))
        ).not.toBeNull();
        expect(
            await auth.identify(
                new Request(s.base, {
                    headers: {
                        cookie: cookie.replace("__Host-notato_session=", "notato_session="),
                    },
                }),
                new URL(s.base)
            )
        ).toBeNull();
    });
    it("revokes other device tokens even after their native cookies expire, and never lets replay restore them", async () => {
        const devices = {
            one: "11111111-1111-4111-8111-111111111111",
            two: "22222222-2222-4222-8222-222222222222",
            three: "33333333-3333-4333-8333-333333333333",
        };
        const managed = fakeManagedAuth();
        managed.verify = async (token) =>
            token in devices
                ? {
                      provider: "better-auth",
                      subject: "alice",
                      email: "alice@example.com",
                      displayName: "Alice",
                      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                      assuranceLevel: "aal2",
                      sessionId: devices[token as keyof typeof devices],
                  }
                : null;
        const s = await startServe(defer, { managedAuth: managed });
        const one = await customer(s, "one");
        const two = await customer(s, "two");
        const expiredId = await s.rt.auth.sessionId(
            new Request(s.base, { headers: { cookie: one.cookie } })
        );
        if (expiredId) await s.rt.store.deleteSession(expiredId); // cookie history is gone; device registry must survive.
        expect((await s.call("/auth/sessions/revoke-others", json(two.cookie, {}))).status).toBe(
            200
        );
        expect((await s.call("/auth/session", json("", { accessToken: "one" }))).status).toBe(401);
        const refreshed = await customer(s, "two", two.cookie);
        expect(
            (
                await s.call("/auth/logout", {
                    method: "POST",
                    headers: { cookie: refreshed.cookie },
                })
            ).status
        ).toBe(200);
        expect((await s.call("/auth/session", json("", { accessToken: "two" }))).status).toBe(401);
        const three = await customer(s, "three");
        const sessions = (await (
            await s.call("/auth/sessions", { headers: { cookie: three.cookie } })
        ).json()) as { items: { id: string; current: boolean }[] };
        expect(sessions.items.some((item) => item.current)).toBe(true);
        expect(JSON.stringify(sessions)).not.toContain(devices.three);
        const bob = await customer(
            await startServe(defer, { managedAuth: fakeManagedAuth() }),
            "bob"
        );
        // No cross-account session credential is accepted by this server.
        expect(
            (
                await s.call(`/auth/sessions/${sessions.items[0]?.id}`, {
                    method: "DELETE",
                    headers: { cookie: bob.cookie },
                })
            ).status
        ).toBe(401);
    });

    it("requires server-verified MFA and invalidates pre-MFA cookies without trusting metadata", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const legacy = await customer(s, "alice");
        const managed = fakeManagedAuth();
        managed.config.requireMfa = true;
        managed.config.operatorLogin = false;
        const verify = managed.verify;
        managed.verify = async (token) => {
            const identity = await verify("alice");
            return identity
                ? {
                      ...identity,
                      assuranceLevel: token === "strong" ? "aal2" : "aal1",
                      sessionId: "11111111-1111-4111-8111-111111111111",
                  }
                : null;
        };
        // The same records, now served by a service that requires multi-factor sign-in.
        process.env.NOTATO_PUBLIC_URL = "https://feedback.example.com";
        const strict = await startServe(
            defer,
            { managedAuth: managed, store: s.rt.store, trustProxy: true },
            { "x-forwarded-proto": "https" }
        );
        delete process.env.NOTATO_PUBLIC_URL;
        const auth = strict.rt.auth;
        const exchange = (token: string) =>
            strict.call("/auth/session", json("", { accessToken: token }));
        expect((await exchange("weak")).status).toBe(401);
        expect(
            await auth.identify(
                new Request(s.base, { headers: { cookie: legacy.cookie } }),
                new URL(s.base)
            )
        ).toBeNull();
        expect((await exchange("strong")).status).toBe(200);
        expect((await auth.login("admin", "correct horse", "test")).ok).toBe(false);
    });

    it("records redacted security attempts within the right workspace and restricts audit access", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const bob = await customer(s, "bob");
        await s.call("/workspace", {
            ...json(alice.cookie, { name: "Secret company name" }),
            method: "PATCH",
        });
        const aliceAudit = (await (
            await s.call("/workspace/audit", { headers: { cookie: alice.cookie } })
        ).json()) as { items: { actor: string; action: string; outcome: number }[] };
        expect(
            aliceAudit.items.some(
                (entry) => entry.action === "PATCH /workspace" && entry.outcome === 200
            )
        ).toBe(true);
        expect(JSON.stringify(aliceAudit)).not.toContain("Secret company name");
        expect(JSON.stringify(aliceAudit)).not.toContain(alice.cookie);
        const bobAudit = (await (
            await s.call("/workspace/audit", { headers: { cookie: bob.cookie } })
        ).json()) as { items: { action: string }[] };
        expect(bobAudit.items.some((entry) => entry.action === "PATCH /workspace")).toBe(false);
    });

    it("files attempts on another company's project in the caller's own log, by route, never as typed", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const bob = await customer(s, "bob");
        const made = await project(s, alice.cookie);
        const audit = async (cookie: string) =>
            (
                (await (await s.call("/workspace/audit", { headers: { cookie } })).json()) as {
                    items: { actor: string; action: string; outcome: number }[];
                }
            ).items;
        const before = await audit(alice.cookie);
        const forged = encodeURIComponent("PATCH /workspace (owner)");
        for (const path of [
            `/projects/${made.project.id}`,
            `/projects/${made.project.id}/${forged}`,
        ])
            expect(
                (await s.call(path, { method: "DELETE", headers: { cookie: bob.cookie } })).status
            ).toBe(path.endsWith(forged) ? 404 : 403);
        // A malformed escape is the caller's mistake (400), not a server failure.
        expect(
            (
                await s.call("/projects/%E0%A4%A", {
                    method: "DELETE",
                    headers: { cookie: bob.cookie },
                })
            ).status
        ).toBe(400);
        expect(await audit(alice.cookie)).toEqual(before);
        const own = await audit(bob.cookie);
        const attempts = own.filter((entry) => entry.action.startsWith("DELETE"));
        expect(attempts.map((entry) => `${entry.action} ${entry.outcome}`).sort()).toEqual([
            "DELETE /projects/:id 400",
            "DELETE /projects/:id 403",
            "DELETE /projects/:id/:id 404",
        ]);
        expect(JSON.stringify(own)).not.toContain(made.project.id);
        // The company's own attempts are still filed with it.
        const renamed = await s.call(`/projects/${made.project.id}`, {
            ...json(alice.cookie, { name: "Renamed" }),
            method: "PATCH",
        });
        expect(renamed.status).toBe(200);
        expect((await audit(alice.cookie))[0]).toMatchObject({
            action: "PATCH /projects/:id",
            outcome: 200,
        });
    });

    it("chooses a hosted project's id itself, so another company's ids are neither revealed nor taken", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const bob = await customer(s, "bob");
        const made = await project(s, alice.cookie);
        for (const id of [made.project.id, "checkout"]) {
            const response = await s.call("/projects", json(bob.cookie, { id, name: "Mine" }));
            expect(response.status).toBe(201);
            const created = (await response.json()) as { project: { id: string } };
            expect(created.project.id).toStartWith("project_");
            expect(created.project.id).not.toBe(id);
        }
        expect((await s.rt.store.getProject(made.project.id))?.name).toBe("Sensitive");
        expect(await s.rt.store.getProject("checkout")).toBeNull();
    });
});

describe("hosted ingress bounds", () => {
    it("limits concurrency and rates without growing an unbounded client map, and releases stream leases", async () => {
        let now = 0;
        const guard = new HostedGuard(() => now);
        const leases = Array.from({ length: 24 }, () => guard.acquire("one"));
        expect((guard.acquire("one") as Response).status).toBe(429);
        for (const lease of leases) if (!(lease instanceof Response)) lease.release();
        for (let i = 0; i < 576; i++) {
            const lease = guard.acquire("one");
            if (!(lease instanceof Response)) lease.release();
        }
        expect((guard.acquire("one") as Response).status).toBe(429);
        now = 60_001;
        const lease = guard.acquire("one");
        expect(lease instanceof Response).toBe(false);
        if (!(lease instanceof Response)) lease.release();
        let released = 0;
        const response = limitedResponse(new Response("ok"), () => released++);
        expect(await response.text()).toBe("ok");
        expect(released).toBe(1);
        const stream = limitedResponse(new Response(new ReadableStream()), () => released++);
        await stream.body?.cancel();
        expect(released).toBe(2);
    });

    it("never refuses a newcomer because the client table is full", () => {
        let now = 0;
        const guard = new HostedGuard(() => now, { ...INGRESS_LIMITS, clients: 3 });
        const held = guard.acquire("busy");
        for (const client of ["a", "b"]) {
            const lease = guard.acquire(client);
            if (!(lease instanceof Response)) lease.release();
        }
        // Full: the idle client seen longest ago makes room, whether or not its minute is over.
        now = 1000;
        const newcomer = guard.acquire("c");
        expect(newcomer instanceof Response).toBe(false);
        if (!(newcomer instanceof Response)) newcomer.release();
        // Every tracked client busy: newcomers share one bucket, limited but not refused.
        const busy = ["c", "d"].map((client) => guard.acquire(client));
        const overflow = Array.from({ length: 24 }, (_, i) => guard.acquire(`new-${i}`));
        expect(overflow.filter((lease) => lease instanceof Response)).toHaveLength(0);
        expect((guard.acquire("one more") as Response).status).toBe(429);
        for (const lease of [held, ...busy, ...overflow])
            if (!(lease instanceof Response)) lease.release();
        expect(guard.acquire("one more") instanceof Response).toBe(false);
    });

    it("counts an IPv6 client by its /64", () => {
        expect(clientAddress("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
        expect(clientAddress("2001:0DB8:0001:0002:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
        expect(clientAddress("[2001:db8:1:2::9%en0]")).toBe("2001:db8:1:2::/64");
        expect(clientAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
        expect(clientAddress("2001:db8:1:3::1")).not.toBe(clientAddress("2001:db8:1:2::1"));
        expect(clientAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
        expect(clientAddress("203.0.113.9")).toBe("203.0.113.9");
        expect(clientAddress("unknown")).toBe("unknown");
        const guard = new HostedGuard(() => 0);
        const leases = Array.from({ length: 24 }, (_, i) =>
            guard.acquire(clientAddress(`2001:db8:1:2::${i.toString(16)}`))
        );
        expect(leases.filter((lease) => lease instanceof Response)).toHaveLength(0);
        expect((guard.acquire(clientAddress("2001:db8:1:2:ffff::1")) as Response).status).toBe(429);
    });

    it("keeps open streams out of the active pool, with caps per client, per credential and in all", () => {
        const guard = new HostedGuard(() => 0, {
            ...INGRESS_LIMITS,
            clientActive: 1,
            active: 1,
            clientStreams: 2,
            streams: 3,
            credentialStreams: 1,
        });
        const streams = [guard.acquireStream("a"), guard.acquireStream("a")];
        expect((guard.acquireStream("a") as Response).status).toBe(429);
        const active = guard.acquire("a");
        expect(active instanceof Response).toBe(false);
        expect((guard.acquire("b") as Response).status).toBe(429);
        streams.push(guard.acquireStream("b"));
        expect((guard.acquireStream("c") as Response).status).toBe(429);
        const watch = guard.holdStream("token:one");
        expect((guard.holdStream("token:one") as Response).status).toBe(429);
        expect(guard.holdStream("token:two") instanceof Response).toBe(false);
        for (const lease of [...streams, active, watch])
            if (!(lease instanceof Response)) lease.release();
        expect(guard.acquireStream("c") instanceof Response).toBe(false);
        expect(guard.holdStream("token:one") instanceof Response).toBe(false);
    });

    it("answers ordinary requests while every stream slot is open, and caps one credential's streams", async () => {
        const s = await startServe(defer, {
            managedAuth: fakeManagedAuth(),
            ingress: { ...INGRESS_LIMITS, clientActive: 2, active: 2, credentialStreams: 3 },
        });
        const alice = await customer(s, "alice");
        const headers = { cookie: alice.cookie };
        const open: Response[] = [];
        defer(() => Promise.all(open.map((stream) => stream.body?.cancel())));
        for (let i = 0; i < 3; i++) {
            const stream = await s.call("/projects/*/events", { headers });
            expect(stream.status).toBe(200);
            open.push(stream);
        }
        // More open streams than the whole active pool, and the board still answers.
        for (const path of ["/auth/me", "/projects", "/workspace"])
            expect((await s.call(path, { headers })).status).toBe(200);
        const extra = await s.call("/projects/*/events/", { headers });
        expect(extra.status).toBe(429);
        expect((await s.call("/annotations/wait?timeoutMs=50", { headers })).status).toBe(429);
        await open.pop()?.body?.cancel();
        expect(
            await waitFor(
                async () =>
                    (await s.call("/annotations/wait?timeoutMs=50", { headers })).status === 200
            )
        ).toBe(true);
    });
});

describe("capture connection probes", () => {
    it("tests scoped origins without storing feedback and refuses other companies, excessive bodies and revoked keys", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice"),
            bob = await customer(s, "bob");
        const a = await project(s, alice.cookie),
            b = await project(s, bob.cookie);
        await s.rt.store.setProjectOrigins(a.project.id, ["https://app.example.com"]);
        const call = (id: string, origin: string, body = "{}") =>
            s.call(`/projects/${id}/connection`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${a.token.token}`,
                    origin,
                    "content-type": "application/json",
                },
                body,
            });
        const good = await call(a.project.id, "https://app.example.com");
        expect(good.status).toBe(200);
        expect(await good.json()).toEqual({
            ok: true,
            projectId: a.project.id,
            captureOnly: true,
            tokenPurpose: "app",
            screenshots: true,
        });
        expect((await call(a.project.id, "https://evil.example")).status).toBe(403);
        expect((await call(b.project.id, "https://app.example.com")).status).toBe(403);
        expect(
            (
                await call(
                    a.project.id,
                    "https://app.example.com",
                    JSON.stringify({ extra: "x".repeat(65536) })
                )
            ).status
        ).toBe(413);
        expect(await s.rt.backend.list()).toEqual([]);
        await s.rt.auth.revokeToken(a.token.record.id);
        expect((await call(a.project.id, "https://app.example.com")).status).toBe(401);
    });
});

describe("the open server's routes, as the hosted service answers them", () => {
    it("shows a member's /status and /config only their own workspace, and none of the operator's setup", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const bob = await customer(s, "bob");
        const mine = await project(s, alice.cookie);
        const theirs = await project(s, bob.cookie);
        const status = (await (
            await s.call("/status", { headers: { cookie: alice.cookie } })
        ).json()) as {
            projects: Array<{ id: string }>;
            watchers?: number;
            config: Record<string, unknown>;
        };
        expect(status.projects.map((p) => p.id)).toEqual([mine.project.id]);
        expect(status.watchers).toBeUndefined();
        expect(status.config).toEqual({ screenshots: "on", mcp: "on", webhooks: 0 });
        const config = (cookie: string, id: string) =>
            s.call(`/config?project=${id}`, { headers: { cookie } });
        expect((await config(alice.cookie, mine.project.id)).status).toBe(200);
        expect((await config(alice.cookie, theirs.project.id)).status).toBe(403);
        expect((await s.call("/webhooks", { headers: { cookie: alice.cookie } })).status).toBe(403);
        const operator = (await (
            await s.call("/status", { headers: { cookie: await adminCookie(s) } })
        ).json()) as { projects: unknown[]; watchers?: number };
        expect(operator.projects).toHaveLength(2);
        expect(operator.watchers).toBeNumber();
    });

    it("sends a webhook test only for the board, never for another page the server trusts", async () => {
        const s = await startServe(defer);
        const cookie = await adminCookie(s);
        const test = (headers: Record<string, string>) =>
            s.call("/webhooks/test", {
                method: "POST",
                headers: { cookie, "content-type": "application/json", ...headers },
                body: JSON.stringify({ index: 0 }),
            });
        expect((await test({ origin: "http://localhost:3000" })).status).toBe(403);
        // From the board, it gets as far as finding there is no such webhook.
        expect((await test({})).status).toBe(404);
    });

    it("counts failed password sign-ins per IPv6 network, not per address in it", async () => {
        const s = await startServe(defer);
        const auth = new Authenticator(s.rt.store, { limiter: new LoginLimiter(2) });
        for (const address of ["2001:db8:1:2::1", "2001:db8:1:2::ffff"])
            expect(await auth.login("admin", "wrong", address)).toMatchObject({ status: 401 });
        expect(await auth.login("admin", ADMIN_PASSWORD, "2001:db8:1:2:abcd::9")).toMatchObject({
            status: 429,
        });
        expect(await auth.login("admin", ADMIN_PASSWORD, "2001:db8:1:3::1")).toMatchObject({
            ok: true,
        });
    });
});
