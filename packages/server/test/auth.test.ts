import { describe, expect, it } from "bun:test";
import {
    Authenticator,
    LoginLimiter,
    type NewSession,
    type Principal,
    runServe,
    type SessionRecord,
    SqliteStore,
    sha256Hex,
    TOKEN_PREFIX,
    type TokenRecord,
    type UserRecord,
} from "../src/index.ts";
import { annotationFixture, cleanupAfterEach, makeApp, multipart, tempDir } from "./helpers.ts";
import { adminCookie, bearer, createProject, issue, login, startServe } from "./serve-helpers.ts";

// Signing in to a shared server (`notato serve`): which routes need credentials, the admin's session, where a token
// may be presented, and which browser origins may write.

const defer = cleanupAfterEach();
const start = (options: Parameters<typeof startServe>[1] = {}) => startServe(defer, options);

describe("public and protected routes", () => {
    it("answers /health, /auth/me and the login without credentials, and asks for them everywhere else", async () => {
        const s = await start();
        expect((await s.call("/health")).status).toBe(200);
        expect(await (await s.call("/auth/me")).json()).toMatchObject({
            mode: "serve",
            authRequired: true,
            authenticated: false,
        });
        for (const path of [
            "/status",
            "/projects",
            "/annotations",
            "/annotations/x",
            `/assets/${"a".repeat(64)}`,
            "/projects/p/annotations",
            "/projects/p/events",
            "/bundles/x",
            "/admin/tokens",
        ]) {
            const res = await s.call(path);
            expect(res.status, path).toBe(401);
            expect(res.headers.get("www-authenticate")).toBe("Bearer");
        }
        expect(
            (await s.call("/projects/p/annotations", { method: "POST", body: new FormData() }))
                .status
        ).toBe(401);
        expect((await s.call("/bundles", { method: "POST", body: "x" })).status).toBe(401);
        expect((await s.call("/relay/annotate", { method: "POST", body: "{}" })).status).toBe(401);
    });

    it("rejects bogus, malformed and unprefixed credentials", async () => {
        const s = await start();
        const attempts: Array<Record<string, string>> = [
            { authorization: "Bearer nope" },
            { authorization: `Bearer ${TOKEN_PREFIX}doesnotexist` },
            { authorization: "Basic YWRtaW46Y29ycmVjdCBob3JzZQ==" },
            { cookie: "notato_session=forged" },
        ];
        for (const headers of attempts)
            expect((await s.call("/projects", { headers })).status).toBe(401);
    });
});

describe("admin login", () => {
    it("signs in with the right password and sets a hardened session cookie", async () => {
        const s = await start();
        const res = await login(s);
        expect(res.status).toBe(200);
        const cookie = res.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("notato_session=");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Lax");
        expect(cookie).not.toContain("Secure");
        const session = cookie.split(";")[0] as string;
        expect(
            await (await s.call("/auth/me", { headers: { cookie: session } })).json()
        ).toMatchObject({
            authenticated: true,
            username: "admin",
        });
        expect((await s.call("/projects", { headers: { cookie: session } })).status).toBe(200);
    });

    it("marks the cookie Secure behind a trusted TLS-terminating proxy, and only then", async () => {
        const trusted = await start({ trustProxy: true });
        const body = JSON.stringify({ username: "admin", password: "correct horse" });
        const secure = await trusted.call("/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
            body,
        });
        expect(secure.headers.get("set-cookie")).toContain("Secure");
        const direct = await start();
        const spoofed = await direct.call("/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
            body,
        });
        expect(spoofed.headers.get("set-cookie")).not.toContain("Secure");
    });

    it("refuses a wrong password or an unknown user with the same message", async () => {
        const s = await start();
        const wrong = await login(s, "wrong");
        expect(wrong.status).toBe(401);
        const unknown = await s.call("/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "nobody", password: "x" }),
        });
        expect(unknown.status).toBe(401);
        expect(await unknown.json()).toEqual(await wrong.json());
        expect(wrong.headers.get("set-cookie")).toBeNull();
        expect(
            (
                await s.call("/auth/login", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                })
            ).status
        ).toBe(400);
    });

    it("rate-limits repeated failures, even for the right password afterwards", async () => {
        const s = await start();
        for (let i = 0; i < 8; i++) expect((await login(s, `guess-${i}`)).status).toBe(401);
        const blocked = await login(s);
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    });

    it("logout ends the session", async () => {
        const s = await start();
        const cookie = await adminCookie(s);
        const out = await s.call("/auth/logout", { method: "POST", headers: { cookie } });
        expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
        expect((await s.call("/projects", { headers: { cookie } })).status).toBe(401);
    });

    it("a changed NOTATO_ADMIN_PASSWORD takes effect on the next start", async () => {
        const dir = tempDir(defer, "notato-serve-");
        const first = await runServe({
            port: 0,
            dir,
            version: "t",
            adminPassword: "one",
            log: () => {},
        });
        await first.stop();
        const second = await runServe({
            port: 0,
            dir,
            version: "t",
            adminPassword: "two",
            log: () => {},
        });
        defer(() => second.stop());
        const attempt = (password: string) =>
            fetch(`http://127.0.0.1:${second.port}/auth/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ username: "admin", password }),
            });
        expect((await attempt("one")).status).toBe(401);
        expect((await attempt("two")).status).toBe(200);
    });

    it("generates a password once when none is given, and the account then works with it", async () => {
        const dir = tempDir(defer, "notato-serve-");
        const lines: string[] = [];
        delete process.env.NOTATO_ADMIN_PASSWORD;
        const rt = await runServe({ port: 0, dir, version: "t", log: (m) => lines.push(m) });
        defer(() => rt.stop());
        const password = /with the password (\S+)/.exec(lines.join("\n"))?.[1] ?? "";
        expect(password.length).toBeGreaterThanOrEqual(16);
        const res = await fetch(`http://127.0.0.1:${rt.port}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "admin", password }),
        });
        expect(res.status).toBe(200);
    });
});

describe("token in the query string", () => {
    it("works for GET (EventSource cannot set headers) but never for writes", async () => {
        const s = await start();
        const token = await issue(s, "p");
        const controller = new AbortController();
        const events = await s.call(`/projects/p/events?token=${token}`, {
            signal: controller.signal,
        });
        expect(events.status).toBe(200);
        controller.abort();
        expect((await s.call(`/projects/p/annotations?token=${token}`)).status).toBe(200);
        const a = annotationFixture({ projectId: "p" });
        expect(
            (
                await s.call(`/projects/p/annotations?token=${token}`, {
                    method: "POST",
                    body: multipart(a),
                })
            ).status
        ).toBe(401);
        expect((await s.call("/projects?token=wrong")).status).toBe(401);
    });
});

describe("browser origin checks in serve mode", () => {
    it("rejects a write from a foreign origin even with a valid session, and accepts the UI's own origin", async () => {
        const s = await start();
        const cookie = await adminCookie(s);
        await createProject(s, "p");
        const body = JSON.stringify({ projectId: "p", name: "x" });
        const foreign = await s.call("/admin/tokens", {
            method: "POST",
            headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
            body,
        });
        expect(foreign.status).toBe(403);
        expect((await s.rt.store.listTokens()).length).toBe(0);
        const own = await s.call("/admin/tokens", {
            method: "POST",
            headers: { cookie, "content-type": "application/json", origin: s.base },
            body,
        });
        expect(own.status).toBe(201);
    });

    it("answers CORS only for configured origins, plus private networks", async () => {
        const s = await start({ corsOrigins: ["https://staging.example.com"] });
        const token = await issue(s, "p");
        const ok = await s.call("/projects/p/annotations", {
            headers: { ...bearer(token), origin: "https://staging.example.com" },
        });
        expect(ok.headers.get("access-control-allow-origin")).toBe("https://staging.example.com");
        const other = await s.call("/projects/p/annotations", {
            headers: { ...bearer(token), origin: "https://elsewhere.example" },
        });
        expect(other.headers.get("access-control-allow-origin")).toBeNull();
        const preflight = await s.call("/projects/p/annotations", {
            method: "OPTIONS",
            headers: {
                origin: "https://staging.example.com",
                "access-control-request-headers": "authorization",
            },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    });
});

describe("Authenticator", () => {
    it("expires sessions, and refuses a session id as if it were a token", async () => {
        let now = new Date("2026-10-05T10:00:00Z");
        const store = new SqliteStore(":memory:");
        const auth = new Authenticator(store, {
            sessionTtlMs: 60_000,
            now: () => now,
            limiter: new LoginLimiter(8, 600_000, () => now.getTime()),
        });
        await auth.ensureAdmin("admin", "pw");
        const result = await auth.login("admin", "pw", "ip");
        if (!result.ok) throw new Error("login failed");
        const cookie = result.cookie.split(";")[0] as string;
        const req = () => new Request("http://x/projects", { headers: { cookie } });
        expect(await auth.identify(req(), new URL("http://x/projects"))).toMatchObject({
            kind: "admin",
            username: "admin",
        });
        now = new Date("2026-10-05T10:01:01Z");
        expect(await auth.identify(req(), new URL("http://x/projects"))).toBeNull();
        // The expired session is gone from the database, not only refused.
        const sessionId = await sha256Hex(new TextEncoder().encode(cookie.split("=")[1] ?? ""));
        expect(await store.getSession(sessionId)).toBeNull();
        store.close();
    });

    it("only ever stores hashes of sessions and tokens", async () => {
        const store = new SqliteStore(":memory:");
        const auth = new Authenticator(store);
        await auth.ensureAdmin("admin", "pw");
        const login = await auth.login("admin", "pw", "ip");
        await store.createProject({ id: "p", name: "p", createdAt: new Date().toISOString() });
        const { token } = await auth.issueToken("p", "n");
        const dump = JSON.stringify({
            tokens: await store.listTokens(),
            user: await store.getUser("admin"),
        });
        expect(dump).not.toContain(token);
        expect(dump).not.toContain('pw"');
        expect((await store.getUser("admin"))?.passwordHash).toStartWith("$argon2id$");
        if (login.ok) expect(dump).not.toContain(login.cookie.split(";")[0]?.split("=")[1] ?? "x");
        store.close();
    });

    it("LoginLimiter blocks after the threshold and forgives after the window", () => {
        let t = 0;
        const limiter = new LoginLimiter(3, 1000, () => t);
        for (let i = 0; i < 3; i++) limiter.fail("ip");
        expect(limiter.retryAfter("ip")).toBeGreaterThan(0);
        expect(limiter.retryAfter("other")).toBe(0);
        t = 2000;
        expect(limiter.retryAfter("ip")).toBe(0);
        limiter.fail("ip");
        limiter.succeed("ip");
        expect(limiter.retryAfter("ip")).toBe(0);
    });
});

/** Accounts with more to them than the built-in admin, made by extending the built-in rather than starting again. */
class TeamAccounts extends Authenticator {
    readonly ended: string[] = [];
    readonly admins: string[] = [];

    protected override async passwordRefusal(user: UserRecord | null) {
        return user?.username === "sso" ? "sign in with your company's identity provider" : null;
    }
    protected override async newSession(user: UserRecord): Promise<NewSession | string> {
        return user.username === "outsider"
            ? "this account has no team"
            : { ttlMs: 5_000, fields: { team: "red" } };
    }
    protected override async sessionPrincipal(session: SessionRecord): Promise<Principal | null> {
        return session.username === "admin"
            ? { kind: "admin", username: "admin" }
            : { kind: "member", username: session.username, projectIds: ["p"] };
    }
    protected override async tokenPrincipal(record: TokenRecord): Promise<Principal | null> {
        return record.name === "suspended" ? null : super.tokenPrincipal(record);
    }
    protected override async endSession(id: string) {
        this.ended.push(id);
        await super.endSession(id);
    }
    protected override async addAdmin(user: UserRecord) {
        this.admins.push(user.username);
        await super.addAdmin(user);
    }
}

describe("an Authenticator extended with accounts of its own", () => {
    it("says who a session or a token is, who may sign in, and what a session holds", async () => {
        const store = new SqliteStore(":memory:");
        defer(() => store.close());
        const sessions: SessionRecord[] = [];
        const createSession = store.createSession.bind(store);
        store.createSession = async (session) => {
            sessions.push(session);
            await createSession(session);
        };
        const auth = new TeamAccounts(store);
        await auth.ensureAdmin("admin", "pw");
        await auth.ensureAdmin("admin", "pw");
        expect(auth.admins).toEqual(["admin"]);
        for (const username of ["sso", "outsider", "carol"])
            await store.upsertUser({
                username,
                passwordHash: await Bun.password.hash("pw", { algorithm: "argon2id" }),
                createdAt: new Date().toISOString(),
            });

        // Refused before the password is checked; refused after it only when it was right.
        expect(await auth.login("sso", "wrong", "ip")).toMatchObject({ ok: false, status: 403 });
        expect(await auth.login("outsider", "wrong", "ip")).toMatchObject({ status: 401 });
        expect(await auth.login("outsider", "pw", "ip")).toEqual({
            ok: false,
            status: 403,
            error: "this account has no team",
        });

        const result = await auth.login("carol", "pw", "ip");
        if (!result.ok) throw new Error("sign-in failed");
        expect(result.cookie).toContain("Max-Age=5");
        const stored = sessions.at(-1);
        expect(stored).toMatchObject({ username: "carol", team: "red" });
        expect(Date.parse(stored?.expiresAt ?? "") - Date.parse(stored?.createdAt ?? "")).toBe(
            5_000
        );
        const cookie = result.cookie.split(";")[0] as string;
        const signedIn = new Request("http://x/", { headers: { cookie } });
        expect(await auth.identify(signedIn, new URL("http://x/"))).toEqual({
            kind: "member",
            username: "carol",
            projectIds: ["p"],
        });

        await store.createProject({ id: "p", name: "p", createdAt: new Date().toISOString() });
        const kept = await auth.issueToken("p", "kept");
        const suspended = await auth.issueToken("p", "suspended");
        const asToken = (token: string) =>
            auth.identify(
                new Request("http://x/", { headers: bearer(token) }),
                new URL("http://x/")
            );
        expect(await asToken(kept.token)).toMatchObject({ kind: "token", tokenId: kept.record.id });
        expect(await asToken(suspended.token)).toBeNull();
        // Only a token that was let in counts as used.
        const used = Object.fromEntries(
            (await store.listTokens()).map((t) => [t.name, t.lastUsedAt])
        );
        expect(used.kept).toBeString();
        expect(used.suspended).toBeUndefined();

        await auth.logout(signedIn);
        expect(auth.ended).toEqual([(await auth.sessionId(signedIn)) as string]);
        expect(await auth.identify(signedIn, new URL("http://x/"))).toBeNull();
    });

    it("can carry its session in a host-only cookie, and keep tokens out of URLs", async () => {
        const store = new SqliteStore(":memory:");
        defer(() => store.close());
        const auth = new Authenticator(store, { cookieName: "__Host-team", queryTokens: false });
        await auth.ensureAdmin("admin", "pw");
        const result = await auth.login("admin", "pw", "ip");
        if (!result.ok) throw new Error("sign-in failed");
        // Browsers keep a `__Host-` cookie only when it is Secure, so it always is.
        expect(result.cookie).toStartWith("__Host-team=");
        expect(result.cookie).toContain("; Secure");
        const value = result.cookie.split(";")[0]?.split("=")[1] ?? "";
        const as = (cookie: string) =>
            auth.identify(new Request("http://x/", { headers: { cookie } }), new URL("http://x/"));
        expect(await as(`__Host-team=${value}`)).toMatchObject({ kind: "admin" });
        expect(await as(`notato_session=${value}`)).toBeNull();
        expect(await auth.logout(new Request("http://x/"))).toContain("; Secure");

        await store.createProject({ id: "p", name: "p", createdAt: new Date().toISOString() });
        const { token } = await auth.issueToken("p", "page");
        const url = new URL(`http://x/projects/p/events?token=${token}`);
        expect(await auth.identify(new Request(url), url)).toBeNull();
        expect(
            await auth.identify(new Request(url, { headers: bearer(token) }), url)
        ).toMatchObject({ kind: "token" });
    });
});

describe("a server on the public internet (strictOrigins)", () => {
    it("is signed in to and out of from its own board only, even by an origin it lets call the API", async () => {
        const listed = "https://app.example.com";
        const strict = await start({
            corsOrigins: [listed],
            extension: { name: "strict", http: () => ({ strictOrigins: true }) },
        });
        const signIn = (s: typeof strict, origin?: string) =>
            s.call("/auth/login", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(origin ? { origin } : {}),
                },
                body: JSON.stringify({ username: "admin", password: "correct horse" }),
            });
        const refused = await signIn(strict, listed);
        expect(refused.status).toBe(403);
        expect(((await refused.json()) as { error: string }).error).toContain("sign-in");
        expect((await signIn(strict)).status).toBe(200);
        const cookie = await adminCookie(strict);
        const signOut = await strict.call("/auth/logout", {
            method: "POST",
            headers: { cookie, origin: listed },
        });
        expect(signOut.status).toBe(403);
        // A server that is not strict lets the origins it lists sign in, as before.
        const open = await start({ corsOrigins: [listed] });
        expect((await signIn(open, listed)).status).toBe(200);
    });
});

describe("the login rate limit behind a proxy", () => {
    it("counts by the address the proxy saw, not the one the client claims", async () => {
        const local = makeApp();
        defer(local.cleanup);
        const auth = new Authenticator(local.store);
        await auth.ensureAdmin("admin", "right");
        const ctx = makeApp({ auth, trustProxy: true });
        defer(ctx.cleanup);
        let last = 0;
        for (let i = 0; i < 10; i += 1) {
            const res = await ctx.call("/auth/login", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    // The client makes up a new first address each time; the proxy appends the real one.
                    "x-forwarded-for": `10.0.0.${i}, 203.0.113.7`,
                },
                body: JSON.stringify({ username: "admin", password: "wrong" }),
            });
            last = res.status;
        }
        expect(last).toBe(429);
    });
});
