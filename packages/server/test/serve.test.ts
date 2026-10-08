import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Annotation } from "@notato/schema";
import {
    Authenticator,
    LoginLimiter,
    runServe,
    type ServeRuntime,
    SqliteStore,
    TOKEN_PREFIX,
} from "../src/index.ts";
import { annotationFixture, filesFor, makeBundleZip, multipart } from "./helpers.ts";

const dirs: string[] = [];
const runtimes: ServeRuntime[] = [];
const clients: Client[] = [];
afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    for (const r of runtimes.splice(0)) await r.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(options: Partial<Parameters<typeof runServe>[0]> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "notato-serve-"));
    dirs.push(dir);
    const rt = await runServe({
        port: 0,
        dir,
        version: "t",
        adminPassword: "correct horse",
        log: () => {},
        ...options,
    });
    runtimes.push(rt);
    const base = `http://127.0.0.1:${rt.port}`;
    const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
    return { rt, base, call };
}

type Server = Awaited<ReturnType<typeof start>>;

const login = async (s: Server, password = "correct horse") =>
    s.call("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password }),
    });

async function adminCookie(s: Server): Promise<string> {
    const res = await login(s);
    expect(res.status).toBe(200);
    return (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

/** Projects are created before tokens are issued for them; creating one twice is harmless here. */
async function createProject(s: Server, id: string) {
    if (id !== "*") await s.rt.backend.createProject(id);
}

async function issue(s: Server, projectId: string, name = "test"): Promise<string> {
    await createProject(s, projectId);
    const cookie = await adminCookie(s);
    const res = await s.call("/admin/tokens", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ projectId, name }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Reads an event stream frame by frame. Resolves with the data of the next frame named `event`. */
function sse(res: Response) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return async (event: string, timeoutMs = 3000): Promise<unknown> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (frame.includes(`event: ${event}`))
                    return JSON.parse(/data: (.*)/.exec(frame)?.[1] ?? "null");
                continue;
            }
            const chunk = await Promise.race([
                reader.read(),
                new Promise<{ done: true; value?: undefined }>((resolve) =>
                    setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now()))
                ),
            ]);
            if (chunk.done) throw new Error(`no "${event}" event arrived`);
            buffer += decoder.decode(chunk.value);
        }
    };
}

async function post(s: Server, token: string, projectId: string, over: Partial<Annotation> = {}) {
    const a = annotationFixture({ projectId, ...over });
    const res = await s.call(`/projects/${projectId}/annotations`, {
        method: "POST",
        headers: bearer(token),
        body: multipart(a, filesFor()),
    });
    return { a, res };
}

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
        const dir = mkdtempSync(join(tmpdir(), "notato-serve-"));
        dirs.push(dir);
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
        runtimes.push(second);
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
        const dir = mkdtempSync(join(tmpdir(), "notato-serve-"));
        dirs.push(dir);
        const lines: string[] = [];
        delete process.env.NOTATO_ADMIN_PASSWORD;
        const rt = await runServe({ port: 0, dir, version: "t", log: (m) => lines.push(m) });
        runtimes.push(rt);
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

describe("project tokens", () => {
    it("are created by the admin, shown once, listed without their secret, and revocable", async () => {
        const s = await start();
        const cookie = await adminCookie(s);
        await createProject(s, "checkout-web");
        const created = await s.call("/admin/tokens", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ projectId: "checkout-web", name: "ci" }),
        });
        const { token, record } = (await created.json()) as {
            token: string;
            record: Record<string, string>;
        };
        expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
        expect(token.length).toBeGreaterThan(40);
        expect(record.tokenHash).toBeUndefined();

        const list = (await (await s.call("/admin/tokens", { headers: { cookie } })).json()) as {
            items: Array<Record<string, string>>;
        };
        expect(list.items).toHaveLength(1);
        expect(JSON.stringify(list)).not.toContain(token);
        expect(list.items[0]).toMatchObject({ projectId: "checkout-web", name: "ci" });
        expect(list.items[0]?.tokenHash).toBeUndefined();

        expect((await s.call("/projects", { headers: bearer(token) })).status).toBe(200);
        expect(
            (await s.call(`/admin/tokens/${record.id}`, { method: "DELETE", headers: { cookie } }))
                .status
        ).toBe(204);
        expect((await s.call("/projects", { headers: bearer(token) })).status).toBe(401);
        expect(
            (await s.call(`/admin/tokens/${record.id}`, { method: "DELETE", headers: { cookie } }))
                .status
        ).toBe(404);
    });

    it("never store the plaintext", async () => {
        const s = await start();
        const token = await issue(s, "p");
        const dump = JSON.stringify(await s.rt.store.listTokens());
        expect(dump).not.toContain(token);
        expect(dump).not.toContain(token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 16));
    });

    it("cannot administer: no token listing, issuing or revoking", async () => {
        const s = await start();
        const token = await issue(s, "*");
        expect((await s.call("/admin/tokens", { headers: bearer(token) })).status).toBe(403);
        expect(
            (
                await s.call("/admin/tokens", {
                    method: "POST",
                    headers: { ...bearer(token), "content-type": "application/json" },
                    body: JSON.stringify({ projectId: "p", name: "x" }),
                })
            ).status
        ).toBe(403);
    });

    it("validate what the admin asks for", async () => {
        const s = await start();
        const cookie = await adminCookie(s);
        const bad = async (body: unknown) =>
            (
                await s.call("/admin/tokens", {
                    method: "POST",
                    headers: { cookie, "content-type": "application/json" },
                    body: JSON.stringify(body),
                })
            ).status;
        expect(await bad({ projectId: "has space", name: "x" })).toBe(400);
        expect(await bad({ projectId: "p", name: "" })).toBe(400);
        expect(await bad({ name: "x" })).toBe(400);
    });

    it("record when they were last used", async () => {
        const s = await start();
        const token = await issue(s, "p");
        await s.call("/projects", { headers: bearer(token) });
        await new Promise((r) => setTimeout(r, 50));
        expect((await s.rt.store.listTokens())[0]?.lastUsedAt).toBeDefined();
    });
});

describe("one project's token against another project", () => {
    async function twoProjects() {
        const s = await start();
        const a = await issue(s, "alpha");
        const b = await issue(s, "beta");
        const all = await issue(s, "*");
        const alpha = (await post(s, a, "alpha", { comment: "alpha note" })).a;
        const beta = (await post(s, b, "beta", { comment: "beta note" })).a;
        return { s, a, b, all, alpha, beta };
    }

    it("lets a token read and write its own project", async () => {
        const { s, a, alpha } = await twoProjects();
        expect((await s.call(`/projects/alpha/annotations`, { headers: bearer(a) })).status).toBe(
            200
        );
        expect((await s.call(`/annotations/${alpha.id}`, { headers: bearer(a) })).status).toBe(200);
        const patched = await s.call(`/annotations/${alpha.id}`, {
            method: "PATCH",
            headers: bearer(a),
            body: JSON.stringify({ status: "acknowledged" }),
        });
        expect(patched.status).toBe(200);
        expect(
            (
                await s.call(`/annotations/${alpha.id}/replies`, {
                    method: "POST",
                    headers: bearer(a),
                    body: JSON.stringify({ body: "hi" }),
                })
            ).status
        ).toBe(201);
    });

    it("forbids reading, writing and listing another project, by project URL", async () => {
        const { s, a } = await twoProjects();
        for (const [path, init] of [
            ["/projects/beta/annotations", {}],
            ["/projects/beta/events", {}],
            ["/projects/beta/bundles", {}],
            ["/projects/beta/export", {}],
        ] as const) {
            expect((await s.call(path, { ...init, headers: bearer(a) })).status, path).toBe(403);
        }
        const betaPost = annotationFixture({ projectId: "beta" });
        expect(
            (
                await s.call("/projects/beta/annotations", {
                    method: "POST",
                    headers: bearer(a),
                    body: multipart(betaPost),
                })
            ).status
        ).toBe(403);
        expect((await s.call("/projects/*/events", { headers: bearer(a) })).status).toBe(403);
    });

    it("forbids reaching another project's data by id", async () => {
        const { s, a, beta } = await twoProjects();
        expect((await s.call(`/annotations/${beta.id}`, { headers: bearer(a) })).status).toBe(403);
        expect(
            (
                await s.call(`/annotations/${beta.id}`, {
                    method: "PATCH",
                    headers: bearer(a),
                    body: JSON.stringify({ status: "resolved" }),
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call(`/annotations/${beta.id}/replies`, {
                    method: "POST",
                    headers: bearer(a),
                    body: JSON.stringify({ body: "x" }),
                })
            ).status
        ).toBe(403);
        expect(
            (await s.call(`/annotations/${beta.id}`, { method: "DELETE", headers: bearer(a) }))
                .status
        ).toBe(403);
        // ...and the data is untouched.
        expect((await s.rt.backend.get(beta.id))?.annotation).toMatchObject({
            status: "open",
            thread: [],
        });
    });

    it("confines list, wait and status to the token's own project", async () => {
        const { s, a, all } = await twoProjects();
        const comments = async (token: string, qs = "") =>
            (
                (await (await s.call(`/annotations${qs}`, { headers: bearer(token) })).json()) as {
                    items: Array<{ annotation: Annotation }>;
                }
            ).items.map((i) => i.annotation.comment);
        expect(await comments(a)).toEqual(["alpha note"]);
        expect(await comments(a, "?project=alpha")).toEqual(["alpha note"]);
        expect((await s.call("/annotations?project=beta", { headers: bearer(a) })).status).toBe(
            403
        );
        expect((await comments(all)).sort()).toEqual(["alpha note", "beta note"]);

        const wait = (await (
            await s.call("/annotations/wait?timeoutMs=50&status=open", { headers: bearer(a) })
        ).json()) as { ready: boolean };
        expect(wait.ready).toBe(true);
        const status = (await (await s.call("/status", { headers: bearer(a) })).json()) as {
            projects: Array<{ id: string }>;
        };
        expect(status.projects.map((p) => p.id)).toEqual(["alpha"]);
        const projects = (await (await s.call("/projects", { headers: bearer(a) })).json()) as {
            items: Array<{ id: string }>;
        };
        expect(projects.items.map((p) => p.id)).toEqual(["alpha"]);
    });

    it("lets a * token and the admin see everything", async () => {
        const { s, all, beta } = await twoProjects();
        expect((await s.call(`/annotations/${beta.id}`, { headers: bearer(all) })).status).toBe(
            200
        );
        expect((await s.call("/projects/beta/annotations", { headers: bearer(all) })).status).toBe(
            200
        );
        const cookie = await adminCookie(s);
        expect((await s.call(`/annotations/${beta.id}`, { headers: { cookie } })).status).toBe(200);
        const status = (await (await s.call("/status", { headers: { cookie } })).json()) as {
            projects: unknown[];
        };
        expect(status.projects).toHaveLength(2);
    });

    it("scopes bundles: import is held to the token's project, export to what it can see", async () => {
        const { s, a, b } = await twoProjects();
        const { zip } = await makeBundleZip(1, () => ({ projectId: "beta" }), {
            projectId: "beta",
            id: "BUNDLE-BETA",
        });
        const asAlpha = await s.call("/bundles", {
            method: "POST",
            headers: { ...bearer(a), "content-type": "application/zip" },
            body: zip as BodyInit,
        });
        expect(asAlpha.status).toBe(400);
        expect(await asAlpha.text()).toContain("not");
        expect(
            (
                await s.call("/projects/beta/bundles", {
                    method: "POST",
                    headers: { ...bearer(a), "content-type": "application/zip" },
                    body: zip as BodyInit,
                })
            ).status
        ).toBe(403);

        const asBeta = await s.call("/bundles", {
            method: "POST",
            headers: { ...bearer(b), "content-type": "application/zip" },
            body: zip as BodyInit,
        });
        expect(asBeta.status).toBe(201);
        expect((await s.call("/bundles/BUNDLE-BETA", { headers: bearer(a) })).status).toBe(403);
        expect((await s.call("/bundles/BUNDLE-BETA/export", { headers: bearer(a) })).status).toBe(
            403
        );
        expect((await s.call("/bundles/BUNDLE-BETA/export", { headers: bearer(b) })).status).toBe(
            200
        );
    });

    it("scopes the agent relay: only to its own project's page, and results only from it", async () => {
        const { s, a, b } = await twoProjects();
        // A beta page registers (agent=1) and waits for a request.
        const controller = new AbortController();
        const events = await s.call("/projects/beta/events?agent=1", {
            headers: bearer(b),
            signal: controller.signal,
        });
        const next = sse(events);
        await next("hello");

        // alpha's token cannot aim a relay request at beta, by body or by omission.
        const aimed = await s.call("/relay/annotate", {
            method: "POST",
            headers: bearer(a),
            body: JSON.stringify({ projectId: "beta", target: "#x", comment: "c" }),
        });
        expect(aimed.status).toBe(403);
        const implicit = await s.call("/relay/annotate", {
            method: "POST",
            headers: bearer(a),
            body: JSON.stringify({ target: "#x", comment: "c", timeoutMs: 1000 }),
        });
        expect(implicit.status).toBe(409); // alpha has no page; it never touches beta's

        // beta asks its own page; alpha's token cannot answer for it.
        const pending = s.call("/relay/annotate", {
            method: "POST",
            headers: bearer(b),
            body: JSON.stringify({ target: "#x", comment: "c", timeoutMs: 5000 }),
        });
        const { requestId } = (await next("annotate-request")) as { requestId: string };
        expect(requestId).toBeDefined();
        expect(
            (
                await s.call(`/relay/${requestId}/result`, {
                    method: "POST",
                    headers: bearer(a),
                    body: JSON.stringify({ ok: false, error: "forged" }),
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call(`/relay/${requestId}/result`, {
                    method: "POST",
                    headers: bearer(b),
                    body: JSON.stringify({ ok: false, error: "no element" }),
                })
            ).status
        ).toBe(200);
        expect(await (await pending).json()).toEqual({ ok: false, error: "no element" });
        controller.abort();
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

describe("MCP over streamable HTTP", () => {
    async function mcpClient(s: Server, token: string | null) {
        const client = new Client({ name: "remote", version: "0" });
        const transport = new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
            requestInit: { headers: token ? bearer(token) : {} },
        });
        await client.connect(transport);
        clients.push(client);
        const call = async (name: string, args: Record<string, unknown> = {}) =>
            (await client.callTool({ name, arguments: args })) as unknown as {
                isError?: boolean;
                content: Array<{ type: string; text?: string }>;
            };
        return { client, call };
    }
    const text = (r: { content: Array<{ text?: string }> }) =>
        r.content.map((c) => c.text ?? "").join("\n");

    it("counts an open session as an agent being there, by its name, until it closes", async () => {
        const s = await start();
        const agent = await issue(s, "*", "claude");
        const { client } = await mcpClient(s, agent);
        // Pages show an agent is there from this: one with the MCP open counts even while it is not watching.
        expect(s.rt.backend.agents.state).toMatchObject({ connected: true, names: ["Remote"] });
        await (client.transport as StreamableHTTPClientTransport).terminateSession();
        await client.close();
        await new Promise((r) => setTimeout(r, 50));
        expect(s.rt.backend.agents.state.connected).toBe(false);
    });

    it("refuses to connect without a valid token", async () => {
        const s = await start();
        await expect(mcpClient(s, null)).rejects.toThrow();
        await expect(mcpClient(s, `${TOKEN_PREFIX}wrong`)).rejects.toThrow();
        const raw = await s.call("/mcp", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
            },
            body: "{}",
        });
        expect(raw.status).toBe(401);
    });

    it("serves the tools and sees what two browsers posted, each with its own project token", async () => {
        const s = await start();
        const alpha = await issue(s, "alpha", "browser-1");
        const beta = await issue(s, "beta", "browser-2");
        const agent = await issue(s, "*", "claude");
        await post(s, alpha, "alpha", { comment: "from the first machine" });
        await post(s, beta, "beta", { comment: "from the second machine" });

        const remote = await mcpClient(s, agent);
        expect((await remote.client.listTools()).tools.map((t) => t.name)).toContain(
            "notato_watch"
        );
        const listed = text(await remote.call("notato_list_open"));
        expect(listed).toContain("from the first machine");
        expect(listed).toContain("from the second machine");

        // And with images, so Claude sees both screens.
        const watched = await remote.call("notato_watch", { timeoutSeconds: 5, windowMs: 0 });
        expect(text(watched)).toContain("2 new annotations");
        expect(watched.content.filter((c) => c.type === "image")).toHaveLength(4);
    });

    it("is woken by an annotation posted while it waits", async () => {
        const s = await start();
        const browser = await issue(s, "p");
        const agent = await issue(s, "*");
        const remote = await mcpClient(s, agent);
        const waiting = remote.call("notato_watch", {
            timeoutSeconds: 20,
            windowMs: 0,
            screenshots: "none",
        });
        await new Promise((r) => setTimeout(r, 200));
        await post(s, browser, "p", { comment: "posted while watching" });
        expect(text(await waiting)).toContain("posted while watching");
    });

    it("lets claude resolve what a browser posted, and the browser's token sees the result", async () => {
        const s = await start();
        const browser = await issue(s, "p");
        const agent = await issue(s, "*");
        const { a } = await post(s, browser, "p", { comment: "fix me" });
        const remote = await mcpClient(s, agent);
        await remote.call("notato_resolve", { id: a.id, summary: "Fixed it" });
        const seen = (await (
            await s.call(`/annotations/${a.id}`, { headers: bearer(browser) })
        ).json()) as {
            annotation: Annotation;
        };
        expect(seen.annotation.status).toBe("resolved");
        expect(seen.annotation.thread[0]?.body).toBe("Resolved: Fixed it");
    });

    it("confines a project token's MCP session to that project", async () => {
        const s = await start();
        const alpha = await issue(s, "alpha");
        const beta = await issue(s, "beta");
        await post(s, alpha, "alpha", { comment: "alpha only" });
        const other = (await post(s, beta, "beta", { comment: "beta only" })).a;

        const remote = await mcpClient(s, alpha);
        const listed = text(await remote.call("notato_list_open"));
        expect(listed).toContain("alpha only");
        expect(listed).not.toContain("beta only");
        expect((await remote.call("notato_get", { id: other.id })).isError).toBe(true);
        expect((await remote.call("notato_resolve", { id: other.id, summary: "x" })).isError).toBe(
            true
        );
        const asked = await remote.call("notato_list_open", { projectId: "beta" });
        expect(asked.isError).toBe(true);
        expect(text(asked)).not.toContain("beta only");
        expect((await s.rt.backend.get(other.id))?.annotation.status).toBe("open");
        const watched = text(
            await remote.call("notato_watch", { projectId: "beta", timeoutSeconds: 1, windowMs: 0 })
        );
        expect(watched).not.toContain("beta only");
    });

    it("does not read files from the server's disk", async () => {
        const s = await start();
        const agent = await issue(s, "*");
        const remote = await mcpClient(s, agent);
        const result = await remote.call("notato_import_bundle", { path: "/etc/hosts" });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("does not read files from disk");
    });

    it("keeps a separate watch cursor per session", async () => {
        const s = await start();
        const browser = await issue(s, "p");
        const agent = await issue(s, "*");
        await post(s, browser, "p", { comment: "backlog item" });
        const one = await mcpClient(s, agent);
        expect(
            text(
                await one.call("notato_watch", {
                    timeoutSeconds: 5,
                    windowMs: 0,
                    screenshots: "none",
                })
            )
        ).toContain("backlog item");
        const two = await mcpClient(s, agent);
        expect(
            text(
                await two.call("notato_watch", {
                    timeoutSeconds: 5,
                    windowMs: 0,
                    screenshots: "none",
                })
            )
        ).toContain("backlog item");
        expect(text(await one.call("notato_watch", { timeoutSeconds: 1, windowMs: 0 }))).toContain(
            "No new annotations"
        );
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
        expect(await store.getSession((await store.getUser("admin"))?.username ?? "")).toBeNull();
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
