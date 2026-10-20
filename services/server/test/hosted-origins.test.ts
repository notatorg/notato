import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_ORIGIN } from "@notato/server";
import { annotationFixture, cleanupAfterEach, multipart, tempDir } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { ADMIN_PASSWORD, adminCookie, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
describe("hosted browser integration", () => {
    it("allows an explicitly listed Chrome extension only for its project, with an app token and no board cookies", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const bob = await customer(s, "bob");
        const create = async (cookie: string) => {
            const response = await s.call("/projects", {
                method: "POST",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ name: "Extension feedback" }),
            });
            expect(response.status).toBe(201);
            return (await response.json()) as { project: { id: string }; token: { token: string } };
        };
        const mine = await create(alice.cookie);
        const other = await create(bob.cookie);
        const origins = `/projects/${mine.project.id}/origins`;
        const setOrigins = (values: string[], cookie = alice.cookie) =>
            s.call(origins, {
                method: "PUT",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ origins: values }),
            });
        const headers = { origin: EXTENSION_ORIGIN, authorization: `Bearer ${mine.token.token}` };
        const capture = `/projects/${mine.project.id}/annotations`;
        const checkConnection = () =>
            s.call(`/projects/${mine.project.id}/connection`, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: "{}",
            });
        expect((await checkConnection()).status).toBe(403);
        expect((await s.call(`/config?project=${mine.project.id}`, { headers })).status).toBe(403);
        for (const invalid of [
            "chrome-extension://*",
            "chrome-extension://short",
            `chrome-extension://${"z".repeat(32)}`,
            `${EXTENSION_ORIGIN}/page`,
            `${EXTENSION_ORIGIN}?token=x`,
            `${EXTENSION_ORIGIN}#fragment`,
            `${EXTENSION_ORIGIN}:123`,
            EXTENSION_ORIGIN.replace("://", "://user:password@"),
            "file:///",
            `moz-extension://${"a".repeat(32)}`,
        ])
            expect((await setOrigins([invalid])).status).toBe(400);
        expect((await setOrigins([EXTENSION_ORIGIN], bob.cookie)).status).toBe(403);
        const configured = await setOrigins([`${EXTENSION_ORIGIN}/`]);
        expect(configured.status).toBe(200);
        expect(await configured.json()).toEqual({ origins: [EXTENSION_ORIGIN] });
        const connected = await checkConnection();
        expect(connected.status).toBe(200);
        expect(await connected.json()).toMatchObject({ ok: true, projectId: mine.project.id });
        const preflight = await s.call(capture, {
            method: "OPTIONS",
            headers: { origin: EXTENSION_ORIGIN },
        });
        expect(preflight.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
        expect((await s.call(`/config?project=${mine.project.id}`, { headers })).status).toBe(200);
        const annotation = annotationFixture({
            projectId: mine.project.id,
            screenshots: undefined,
        });
        const posted = await s.call(capture, {
            method: "POST",
            headers,
            body: multipart(annotation, new Map()),
        });
        expect(posted.status).toBe(201);
        expect(posted.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
        expect(
            (await s.call(capture, { method: "POST", headers: { origin: EXTENSION_ORIGIN } }))
                .status
        ).toBe(401);
        expect(
            (
                await s.call(capture, {
                    method: "POST",
                    headers: { ...headers, cookie: alice.cookie },
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call(`/config?project=${other.project.id}`, {
                    headers: {
                        origin: EXTENSION_ORIGIN,
                        authorization: `Bearer ${other.token.token}`,
                    },
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call(capture, {
                    method: "POST",
                    headers: { ...headers, origin: `chrome-extension://${"a".repeat(32)}` },
                })
            ).status
        ).toBe(403);
        expect((await setOrigins([])).status).toBe(200);
        expect((await s.call(`/config?project=${mine.project.id}`, { headers })).status).toBe(403);
    });

    it("keeps operator sign-in and sign-out on the board even when SDK origins are allowed", async () => {
        const s = await startServe(defer, {
            managedAuth: fakeManagedAuth(),
            corsOrigins: ["https://app.example.com"],
        });
        expect(
            (
                await s.call("/auth/login", {
                    method: "POST",
                    headers: {
                        origin: "https://app.example.com",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
                })
            ).status
        ).toBe(403);
        const cookie = await adminCookie(s);
        expect(
            (
                await s.call("/auth/logout", {
                    method: "POST",
                    headers: { origin: "https://app.example.com", cookie },
                })
            ).status
        ).toBe(403);
        expect(await (await s.call("/auth/me", { headers: { cookie } })).json()).toMatchObject({
            authenticated: true,
            isAdmin: true,
        });
        expect((await s.call("/auth/logout", { method: "POST", headers: { cookie } })).status).toBe(
            200
        );
    });

    it("keeps authentication on the board origin and exposes no provider credentials", async () => {
        const s = await startServe(defer, {
            managedAuth: fakeManagedAuth(),
            ui: { lookup: async () => ({ body: "<div id='root'></div>", type: "text/html" }) },
        });
        const csp = (await s.call("/")).headers.get("content-security-policy");
        expect(csp).toContain("connect-src 'self';");
        expect(csp).toContain("frame-ancestors 'none'");
        const me = (await (await s.call("/auth/me")).json()) as {
            identity: { provider: string; publishableKey?: string };
        };
        expect(me.identity.provider).toBe("better-auth");
        expect(me.identity.publishableKey).toBeUndefined();
    });

    it("lets workspace owners connect their own domains without granting access to other companies", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const bob = await customer(s, "bob");
        const created = await s.call("/projects", {
            method: "POST",
            headers: { cookie: alice.cookie, "content-type": "application/json" },
            body: JSON.stringify({ name: "Checkout" }),
        });
        const made = (await created.json()) as {
            project: { id: string };
            token: { token: string };
        };
        const path = `/projects/${made.project.id}/origins`;
        const set = (cookie: string, origins: string[], origin?: string) =>
            s.call(path, {
                method: "PUT",
                headers: {
                    cookie,
                    "content-type": "application/json",
                    ...(origin ? { origin } : {}),
                },
                body: JSON.stringify({ origins }),
            });
        for (const invalid of [
            "*",
            "https://app.example.com/path",
            "https://user:pass@app.example.com",
            "https://app.example.com?query=1",
        ])
            expect((await set(alice.cookie, [invalid])).status).toBe(400);
        expect((await set(bob.cookie, ["https://app.example.com"])).status).toBe(403);
        expect((await set(alice.cookie, ["https://app.example.com/"])).status).toBe(200);
        const policy = await s.call(`/config?project=${made.project.id}`, {
            headers: {
                origin: "https://app.example.com",
                authorization: `Bearer ${made.token.token}`,
            },
        });
        expect(policy.status).toBe(200);
        expect(policy.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
        expect(await policy.json()).toMatchObject({ captureOnly: true, derivedScreenshots: true });
        expect(await (await s.call(path, { headers: { cookie: alice.cookie } })).json()).toEqual({
            origins: ["https://app.example.com"],
        });
        const capture = `/projects/${made.project.id}/annotations`;
        const preflight = await s.call(capture, {
            method: "OPTIONS",
            headers: { origin: "https://app.example.com", "access-control-request-method": "POST" },
        });
        expect(preflight.headers.get("access-control-allow-origin")).toBe(
            "https://app.example.com"
        );
        expect(
            (await s.call(capture, { headers: { origin: "https://app.example.com" } })).status
        ).toBe(401);
        const a = annotationFixture({ projectId: made.project.id, screenshots: undefined });
        const posted = await s.call(capture, {
            method: "POST",
            headers: {
                origin: "https://app.example.com",
                authorization: `Bearer ${made.token.token}`,
            },
            body: multipart(a, new Map()),
        });
        expect(posted.status).toBe(201);
        expect(posted.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
        expect(
            (
                await s.call(`/annotations/${a.id}`, {
                    headers: {
                        origin: "https://app.example.com",
                        authorization: `Bearer ${made.token.token}`,
                    },
                })
            ).headers.get("access-control-allow-origin")
        ).toBe("https://app.example.com");
        expect(
            (
                await s.call(`/annotations/${a.id}`, {
                    headers: {
                        origin: "https://app.example.com",
                        authorization: `Bearer ${made.token.token}`,
                    },
                })
            ).status
        ).toBe(403);
        expect((await set(alice.cookie, [], "https://app.example.com")).status).toBe(403); // SDK origins cannot use board management.
        expect((await set(alice.cookie, [])).status).toBe(200);
        expect(
            (
                await s.call(capture, {
                    method: "OPTIONS",
                    headers: { origin: "https://app.example.com" },
                })
            ).headers.get("access-control-allow-origin")
        ).toBeNull();
    });

    it("disables old unscoped webhooks when customer registration is enabled", async () => {
        const file = join(tempDir(defer), "notato.config.json");
        writeFileSync(
            file,
            JSON.stringify({
                webhooks: [
                    { url: "https://operator.example.com", format: "json" },
                    { url: "https://acme.example.com", format: "json", project: "alpha" },
                ],
            })
        );
        const s = await startServe(defer, { managedAuth: fakeManagedAuth(), configFile: file });
        expect(s.rt.backend.config().webhooks.map((hook) => hook.project)).toEqual(["alpha"]);
    });

    it("allows scoped SDK status preflights and reads without broadening origin, cookie or token access", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const origin = "http://localhost:5000";
        const alice = await customer(s, "alice");
        const bob = await customer(s, "bob");
        const create = async (cookie: string) => {
            const response = await s.call("/projects", {
                method: "POST",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ name: "SDK status test" }),
            });
            expect(response.status).toBe(201);
            const made = (await response.json()) as {
                project: { id: string };
                token: { token: string };
            };
            await s.rt.store.setProjectOrigins(made.project.id, [origin]);
            return made;
        };
        const mine = await create(alice.cookie);
        const other = await create(bob.cookie);
        const issued = await s.call("/tokens", {
            method: "POST",
            headers: { cookie: alice.cookie, "content-type": "application/json" },
            body: JSON.stringify({
                projectId: mine.project.id,
                name: "SDK tester",
                purpose: "app",
                permission: "full",
                expiresInDays: 1,
            }),
        });
        expect(issued.status).toBe(201);
        const token = (await issued.json()) as { token: string };
        const path = `/status?project=${encodeURIComponent(mine.project.id)}`;
        const preflight = (url: string, from = origin) =>
            s.call(url, {
                method: "OPTIONS",
                headers: {
                    origin: from,
                    "access-control-request-method": "GET",
                    "access-control-request-headers": "authorization",
                },
            });
        expect((await preflight(path)).headers.get("access-control-allow-origin")).toBe(origin);
        expect((await preflight("/status")).headers.get("access-control-allow-origin")).toBeNull();
        expect(
            (await preflight(path, "https://unlisted.example")).headers.get(
                "access-control-allow-origin"
            )
        ).toBeNull();
        const headers = { origin, authorization: `Bearer ${token.token}` };
        const status = await s.call(path, { headers });
        expect(status.status).toBe(200);
        expect(status.headers.get("access-control-allow-origin")).toBe(origin);
        expect(status.headers.get("access-control-allow-credentials")).toBeNull();
        expect(await status.json()).toMatchObject({ service: "notato", version: "t" });
        expect((await s.call(`/status?project=${other.project.id}`, { headers })).status).toBe(403);
        expect(
            (await s.call(path, { headers: { ...headers, origin: "https://unlisted.example" } }))
                .status
        ).toBe(403);
        expect((await s.call(path, { headers: { origin, cookie: alice.cookie } })).status).toBe(
            403
        );
        expect(
            (
                await s.call(path, {
                    headers: { origin, authorization: `Bearer ${mine.token.token}` },
                })
            ).status
        ).toBe(403);
    });
});
