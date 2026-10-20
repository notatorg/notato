import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { InstanceAuth } from "../src/better-auth.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(mode = "closed", extraEnv: Record<string, string> = {}) {
    const db = new PGlite();
    cleanup.push(() => db.close());
    const connection = {
        async query(sql: string, parameters: unknown[] = []) {
            const result = await db.query(sql, parameters);
            return {
                rows: result.rows,
                rowCount: result.rows.length || result.affectedRows || 0,
                command: sql.split(" ")[0],
            };
        },
        release() {},
        on() {},
        removeListener() {},
    };
    const pool = {
        ...connection,
        async connect() {
            return connection;
        },
        async end() {},
    } as unknown as Pool;
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const auth = new InstanceAuth(
        pool,
        {
            async send(message) {
                sent.push(message);
            },
        },
        {
            NOTATO_AUTH_SECRET: "synthetic-test-secret-only-".repeat(3),
            NOTATO_PUBLIC_URL: "http://localhost:4799",
            NOTATO_ADMIN_EMAIL: "admin@example.test",
            NOTATO_ADMIN_PASSWORD: "test administrator password",
            NOTATO_SIGNUP_MODE: mode,
            ...extraEnv,
        }
    );
    await auth.initialize();
    const call = (path: string, body?: unknown, cookie = "", extra: Record<string, string> = {}) =>
        auth.handler(
            new Request(`http://localhost:4799/api/auth${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: {
                    "Content-Type": "application/json",
                    Origin: "http://localhost:4799",
                    ...(cookie ? { cookie } : {}),
                    ...extra,
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
        );
    const browser = () => {
        const jar = new Map<string, string>();
        const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
        return {
            cookie,
            async call(path: string, body?: unknown, extra: Record<string, string> = {}) {
                const response = await call(path, body, cookie(), extra);
                for (const value of response.headers.getSetCookie()) {
                    const pair = value.split(";")[0] ?? "";
                    const at = pair.indexOf("=");
                    if (at >= 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
                }
                return response;
            },
        };
    };
    return { auth, db, pool, sent, call, browser };
}

describe("self-hosted Better Auth", () => {
    it("creates an administrator, accepts their password and keeps signup closed", async () => {
        const { call, auth } = await fixture();
        const login = await call("/sign-in/email", {
            email: "admin@example.test",
            password: "test administrator password",
        });
        expect(login.status).toBe(200);
        const cookie = login.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
        const identity = await auth.verifyRequest(
            new Request("http://localhost:4799/", { headers: { cookie } })
        );
        expect(identity).toMatchObject({
            email: "admin@example.test",
            displayName: "Instance administrator",
            instanceAdmin: true,
            assuranceLevel: "aal1",
        });
        expect(
            (
                await call("/sign-up/email", {
                    name: "Other",
                    email: "other@example.test",
                    password: "test account password",
                })
            ).status
        ).toBe(403);
    });
});

it("uses the configured initial administrator name and preserves later edits on restart", async () => {
    const f = await fixture("closed", { NOTATO_ADMIN_NAME: "  Test owner  " });
    const b = f.browser();
    await b.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    const request = () =>
        new Request("http://localhost:4799/", { headers: { cookie: b.cookie() } });
    expect((await f.auth.verifyRequest(request()))?.displayName).toBe("Test owner");
    expect((await b.call("/update-user", { name: "  Updated owner  " })).status).toBe(200);
    expect(await f.auth.verifyRequest(request())).toMatchObject({
        displayName: "Updated owner",
        instanceAdmin: true,
    });
    const restarted = new InstanceAuth(
        f.pool,
        { async send() {} },
        {
            NOTATO_AUTH_SECRET: "synthetic-test-secret-only-".repeat(3),
            NOTATO_PUBLIC_URL: "http://localhost:4799",
            NOTATO_ADMIN_NAME: "A different bootstrap name",
        }
    );
    await restarted.initialize();
    expect(await restarted.verifyRequest(request())).toMatchObject({
        displayName: "Updated owner",
        instanceAdmin: true,
    });
});

it("rejects anonymous and invalid display-name updates without changing the account", async () => {
    const f = await fixture();
    expect((await f.call("/update-user", { name: "Anonymous" })).status).toBe(401);
    const b = f.browser();
    await b.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    for (const name of ["", "   ", "x".repeat(101), null, 42])
        expect((await b.call("/update-user", { name })).status).toBe(400);
    const identity = await f.auth.verifyRequest(
        new Request("http://localhost:4799/", { headers: { cookie: b.cookie() } })
    );
    expect(identity).toMatchObject({ displayName: "Instance administrator", instanceAdmin: true });
});

it("keeps profile edits on the same identity and synchronizes the name used by the board and collaborators", async () => {
    const f = await fullServer();
    const b = f.browser();
    await b.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    const before = (await (await f.request(b.cookie(), "/auth/me")).json()) as {
        username: string;
        name: string;
        workspace: { id: string; name: string };
    };
    const noBoardHeader = await f.runtime.handle(
        new Request("http://localhost:4799/api/auth/update-user", {
            method: "POST",
            headers: {
                cookie: b.cookie(),
                Origin: "http://localhost:4799",
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: "Refused name" }),
        })
    );
    expect(noBoardHeader.status).toBe(403);
    expect(
        (
            await f.request(b.cookie(), "/api/auth/update-user", "POST", {
                name: "New display name",
            })
        ).status
    ).toBe(200);
    const after = await (await f.request(b.cookie(), "/auth/me")).json();
    expect(after).toMatchObject({
        username: before.username,
        name: "New display name",
        workspace: before.workspace,
        instanceAdmin: true,
    });
    expect(await f.runtime.store.getUser(before.username)).toMatchObject({
        displayName: "New display name",
    });
});

function totp(uri: string) {
    const secret = new URL(uri).searchParams.get("secret")!;
    let bits = "";
    for (const letter of secret.replace(/=+$/, ""))
        bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(letter).toString(2).padStart(5, "0");
    const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const mac = createHmac("sha1", key).update(counter).digest();
    return String((mac.readUInt32BE(mac[mac.length - 1]! & 15) & 0x7fffffff) % 1000000).padStart(
        6,
        "0"
    );
}

it("protects the instance administrator in the API and database", async () => {
    const { auth, db, browser } = await fixture();
    const b = browser();
    await b.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    const identity = await auth.verifyRequest(
        new Request("http://localhost:4799/", { headers: { cookie: b.cookie() } })
    );
    for (const path of ["/admin/remove-user", "/admin/ban-user", "/admin/set-role"])
        expect((await b.call(path, { userId: identity!.subject, role: "user" })).status).toBe(403);
    await expect(
        db.query("DELETE FROM notato_auth_user WHERE id=$1", [identity!.subject])
    ).rejects.toThrow();
    await expect(
        db.query("UPDATE notato_auth_user SET role='user' WHERE id=$1", [identity!.subject])
    ).rejects.toThrow("cannot be demoted");
    await expect(
        db.query("UPDATE notato_auth_user SET banned=TRUE WHERE id=$1", [identity!.subject])
    ).rejects.toThrow("cannot be demoted");
});

it("allows explicit public registration, verifies email and ignores a client-supplied admin role", async () => {
    const { auth, call, sent, db } = await fixture("open");
    expect(
        (
            await call("/sign-up/email", {
                name: "Alice",
                email: "alice@example.test",
                password: "test account password",
                role: "admin",
            })
        ).status
    ).toBe(400);
    expect(
        (
            await call("/sign-up/email", {
                name: "Alice",
                email: "alice@example.test",
                password: "test account password",
            })
        ).status
    ).toBe(200);
    expect(
        (
            await call("/sign-in/email", {
                email: "alice@example.test",
                password: "test account password",
            })
        ).status
    ).toBe(403);
    const link = sent
        .find((message) => message.subject.includes("Verify"))!
        .text.match(/http[^\s]+/)![0];
    expect((await auth.handler(new Request(link))).status).toBe(302);
    const result = await call("/sign-in/email", {
        email: "alice@example.test",
        password: "test account password",
    });
    expect(result.status).toBe(200);
    const user = await db.query<{ role: string }>(
        "SELECT role FROM notato_auth_user WHERE email='alice@example.test'"
    );
    expect(user.rows[0]?.role).toBe("user");
});

it("binds closed-registration invitations to one address and rejects expired invitations", async () => {
    const { auth, call, sent, db } = await fixture();
    await auth.invite("alice@example.test");
    const link = new URL(sent[0]!.text.match(/http[^\s]+/)![0]);
    const token = link.searchParams.get("registration")!;
    const extra = { "x-notato-invitation": token };
    expect(
        (
            await call(
                "/sign-up/email",
                { name: "Wrong", email: "wrong@example.test", password: "test account password" },
                "",
                extra
            )
        ).status
    ).toBe(403);
    expect(
        (
            await call(
                "/sign-up/email",
                { name: "Alice", email: "alice@example.test", password: "test account password" },
                "",
                extra
            )
        ).status
    ).toBe(200);
    await auth.invite("later@example.test");
    const expired = new URL(sent.at(-1)!.text.match(/http[^\s]+/)![0]).searchParams.get(
        "registration"
    )!;
    await db.exec("UPDATE notato_instance_invitation SET expires_at=now()-interval '1 hour'");
    expect(
        (
            await call(
                "/sign-up/email",
                { name: "Later", email: "later@example.test", password: "test account password" },
                "",
                { "x-notato-invitation": expired }
            )
        ).status
    ).toBe(403);
});

it("supports password reset through email and invalidates previous sessions", async () => {
    const { auth, sent, browser } = await fixture();
    const b = browser();
    await b.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    const old = b.cookie();
    expect(
        (
            await b.call("/request-password-reset", {
                email: "admin@example.test",
                redirectTo: "http://localhost:4799/?reset=1",
            })
        ).status
    ).toBe(200);
    const link = new URL(sent.at(-1)!.text.match(/http[^\s]+/)![0]);
    const token = link.pathname.split("/").at(-1)!;
    expect(
        (await b.call("/reset-password", { token, newPassword: "replacement account password" }))
            .status
    ).toBe(200);
    expect(
        await auth.verifyRequest(
            new Request("http://localhost:4799/", { headers: { cookie: old } })
        )
    ).toBeNull();
    expect(
        (
            await b.call("/sign-in/email", {
                email: "admin@example.test",
                password: "replacement account password",
            })
        ).status
    ).toBe(200);
});

it("changes a password with the current one, without email, and refuses a wrong or short one", async () => {
    const { auth, sent, browser } = await fixture();
    const b = browser();
    const email = "admin@example.test";
    await b.call("/sign-in/email", { email, password: "test administrator password" });
    const here = b.cookie();
    const before = sent.length;
    const change = (currentPassword: string, newPassword: string) =>
        b.call("/change-password", { currentPassword, newPassword, revokeOtherSessions: false });
    expect((await change("not the current password", "replacement account password")).status).toBe(
        400
    );
    expect((await change("test administrator password", "too short")).status).toBe(400);
    expect(
        (await change("test administrator password", "replacement account password")).status
    ).toBe(200);
    // No email is involved, and this device stays signed in.
    expect(sent.length).toBe(before);
    expect(
        await auth.verifyRequest(
            new Request("http://localhost:4799/", { headers: { cookie: here } })
        )
    ).not.toBeNull();
    const fresh = browser();
    expect(
        (await fresh.call("/sign-in/email", { email, password: "test administrator password" }))
            .status
    ).toBe(401);
    expect(
        (await fresh.call("/sign-in/email", { email, password: "replacement account password" }))
            .status
    ).toBe(200);
});

it("reports the generated administrator password until it is changed, and only for the administrator", async () => {
    const { auth, browser } = await fixture("open");
    const email = "admin@example.test";
    expect(await auth.bootstrapPasswordInUse(email)).toBe(true);
    expect(await auth.bootstrapPasswordInUse("someone@example.test")).toBe(false);
    const b = browser();
    await b.call("/sign-in/email", { email, password: "test administrator password" });
    expect(
        (
            await b.call("/change-password", {
                currentPassword: "test administrator password",
                newPassword: "replacement account password",
            })
        ).status
    ).toBe(200);
    expect(await auth.bootstrapPasswordInUse(email)).toBe(false);
});

it("does not reveal which addresses have accounts when signing in, signing up or asking for a reset", async () => {
    const { call, sent } = await fixture("open");
    const body = async (response: Response) => ({
        status: response.status,
        text: (await response.text()).replace(/"id":"[^"]+"|"(created|updated)At":"[^"]+"/g, ""),
    });
    const wrong = await body(
        await call("/sign-in/email", {
            email: "admin@example.test",
            password: "a wrong password!!",
        })
    );
    const unknown = await body(
        await call("/sign-in/email", {
            email: "nobody@example.test",
            password: "a wrong password!!",
        })
    );
    expect(unknown).toEqual(wrong);
    const before = sent.length;
    const known = await body(
        await call("/request-password-reset", { email: "admin@example.test" })
    );
    const missing = await body(
        await call("/request-password-reset", { email: "nobody@example.test" })
    );
    expect(missing).toEqual(known);
    expect(sent.length).toBeLessThanOrEqual(before + 1);
    const signup = (email: string) =>
        call("/sign-up/email", { name: "Someone", email, password: "a perfectly good password" });
    const taken = await signup("admin@example.test");
    const fresh = await signup("fresh@example.test");
    expect(taken.status).toBe(fresh.status);
});

it("enrolls optional TOTP, challenges future logins and accepts a recovery code once", async () => {
    const { auth, browser } = await fixture();
    const b = browser();
    await b.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    const enabled = await b.call("/two-factor/enable", { password: "test administrator password" });
    expect(enabled.status).toBe(200);
    const setup = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
    expect((await b.call("/two-factor/verify-totp", { code: totp(setup.totpURI) })).status).toBe(
        200
    );
    await b.call("/sign-out", {});
    const login = await b.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    expect(await login.json()).toMatchObject({ twoFactorRedirect: true });
    expect(
        await auth.verifyRequest(
            new Request("http://localhost:4799/", { headers: { cookie: b.cookie() } })
        )
    ).toBeNull();
    expect(
        (await b.call("/two-factor/verify-backup-code", { code: setup.backupCodes[0] })).status
    ).toBe(200);
    expect(
        await auth.verifyRequest(
            new Request("http://localhost:4799/", { headers: { cookie: b.cookie() } })
        )
    ).not.toBeNull();
    await b.call("/sign-out", {});
    await b.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    expect(
        (await b.call("/two-factor/verify-backup-code", { code: setup.backupCodes[0] })).status
    ).toBe(401);
});

async function fullServer(
    mode = "closed",
    extraEnv: Record<string, string> = {},
    beta?: import("../src/beta.ts").BetaPolicy
) {
    const { PostgresStore } = await import("../src/postgres-store.ts");
    const { runCloud } = await import("../src/index.ts");
    const { FileBlobStore } = await import("@notato/server");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const f = await fixture(mode, extraEnv);
    const { auth, db } = f;
    const dir = mkdtempSync(join(tmpdir(), "notato-full-auth-"));
    const store = await PostgresStore.open({
        async query<T>(sql: string, params: unknown[] = []) {
            return (await db.query<T>(sql, params)).rows;
        },
        async transaction<T>(
            work: (tx: import("../src/postgres-store.ts").PgConnection) => Promise<T>
        ) {
            return db.transaction(async (tx) =>
                work({
                    async query<R>(sql: string, params: unknown[] = []) {
                        return (await tx.query<R>(sql, params)).rows;
                    },
                })
            );
        },
        async close() {},
    });
    const runtime = await runCloud({
        port: 0,
        dir,
        version: "test",
        store,
        managedAuth: auth,
        blobs: new FileBlobStore(`${dir}/assets`),
        billing: null,
        beta: beta ?? null,
        plugins: { key: Buffer.from("ab".repeat(32), "hex") },
        log() {},
    });
    cleanup.push(async () => {
        await runtime.stop();
        rmSync(dir, { recursive: true, force: true });
    });
    const request = (cookie: string, path: string, method = "GET", body?: unknown) =>
        runtime.handle(
            new Request(`http://localhost:4799${path}`, {
                method,
                headers: {
                    cookie,
                    host: "localhost:4799",
                    "X-Notato-Board": "1",
                    Origin: "http://localhost:4799",
                    "Sec-Fetch-Site": "same-origin",
                    "Content-Type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
        );
    return { ...f, runtime, request };
}

it("serves real accounts with unrestricted workspaces, workflows and protected account deletion", async () => {
    const f = await fullServer();
    const { browser } = f;
    const b = browser();
    await b.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    const request = (path: string, method = "GET", body?: unknown) =>
        f.request(b.cookie(), path, method, body);
    const me = (await (await request("/auth/me")).json()) as {
        username: string;
        instanceAdmin: boolean;
    };
    expect(me.instanceAdmin).toBe(true);
    const second = await request("/workspaces", "POST", { name: "Second workspace" });
    if (second.status !== 201) throw new Error(`Workspace creation failed: ${await second.text()}`);
    expect((await request("/workspaces", "POST", { name: "Third workspace" })).status).toBe(201);
    expect(
        (
            await request("/auth/account", "DELETE", {
                confirm: me.username,
                password: "test administrator password",
            })
        ).status
    ).toBe(403);
    const plugins = (await (await request("/plugins")).json()) as { limits: { workflows: number } };
    expect(plugins.limits.workflows).toBeGreaterThan(100);
});

it("revokes other identity sessions even if they have not opened the board", async () => {
    const f = await fullServer();
    const a = f.browser();
    const b = f.browser();
    const credentials = { email: "admin@example.test", password: "test administrator password" };
    await a.call("/sign-in/email", credentials);
    await f.request(a.cookie(), "/auth/me");
    await b.call("/sign-in/email", credentials);
    expect((await f.request(a.cookie(), "/auth/sessions/revoke-others", "POST", {})).status).toBe(
        200
    );
    expect(
        await f.auth.verifyRequest(
            new Request("http://localhost:4799/", { headers: { cookie: a.cookie() } })
        )
    ).not.toBeNull();
    expect(
        await f.auth.verifyRequest(
            new Request("http://localhost:4799/", { headers: { cookie: b.cookie() } })
        )
    ).toBeNull();
});

it("denies instance administration to ordinary users and blocks their personal keys immediately on suspension", async () => {
    const f = await fullServer("open");
    const member = f.browser();
    const administrator = f.browser();
    await member.call("/sign-up/email", {
        name: "Member",
        email: "member@example.test",
        password: "test member password",
    });
    const verification = f.sent
        .find((message) => message.to === "member@example.test")!
        .text.match(/http[^\s]+/)![0];
    await f.auth.handler(new Request(verification));
    await member.call("/sign-in/email", {
        email: "member@example.test",
        password: "test member password",
    });
    const me = (await (await f.request(member.cookie(), "/auth/me")).json()) as {
        username: string;
        instanceAdmin: boolean;
        workspace: { id: string };
    };
    expect(me.instanceAdmin).toBe(false);
    expect((await f.request(member.cookie(), "/instance/users")).status).toBe(403);
    expect(
        (
            await f.request(member.cookie(), "/instance/invitations", "POST", {
                email: "other@example.test",
            })
        ).status
    ).toBe(403);
    const created = await f.request(member.cookie(), "/projects", "POST", {
        name: "Member project",
    });
    const project = (await created.json()) as { project: { id: string } };
    const issued = await f.runtime.auth.issueToken(project.project.id, "Personal agent", {
        purpose: "agent",
        ownership: "user",
        ownerUsername: me.username,
        createdBy: me.username,
        workspaceId: me.workspace.id,
        expiresInDays: 1,
    });
    const read = () =>
        f.runtime.handle(
            new Request(`http://localhost:4799/projects/${project.project.id}/annotations`, {
                headers: { Authorization: `Bearer ${issued.token}` },
            })
        );
    expect((await read()).status).toBe(200);
    const user = await f.auth.verifyRequest(
        new Request("http://localhost:4799/", { headers: { cookie: member.cookie() } })
    );
    await administrator.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    expect((await administrator.call("/admin/ban-user", { userId: user!.subject })).status).toBe(
        200
    );
    expect((await read()).status).toBe(401);
    expect(
        await f.auth.verifyRequest(
            new Request("http://localhost:4799/", { headers: { cookie: member.cookie() } })
        )
    ).toBeNull();
});

it("runs optional waitlist admissions and verified email signup on the instance's own database", async () => {
    const f = await fullServer(
        "closed",
        { NOTATO_BETA_ENABLED: "1" },
        { admins: new Set(["admin@example.test"]) }
    );
    const administrator = f.browser();
    await administrator.call("/sign-in/email", {
        email: "admin@example.test",
        password: "test administrator password",
    });
    expect(
        (
            await f.request(administrator.cookie(), "/beta/admin", "PATCH", {
                paused: false,
                maxUsers: 10,
            })
        ).status
    ).toBe(200);
    expect(
        (
            await f.request("", "/beta/waitlist", "POST", {
                email: "invited@example.test",
                sdk: "web",
                useCase: "Testing",
                website: "",
            })
        ).status
    ).toBe(202);
    const requests = (await (
        await f.request(administrator.cookie(), "/beta/admin/requests")
    ).json()) as { items: Array<{ id: string }> };
    const invited = await f.request(
        administrator.cookie(),
        `/beta/admin/requests/${requests.items[0]!.id}/invite`,
        "POST",
        { days: 7 }
    );
    expect(invited.status).toBe(201);
    const invitation = (await invited.json()) as { url: string };
    const token = new URL(invitation.url).hash.split("/").at(-1)!;
    const opened = await f.request("", "/beta/invitation", "POST", { token });
    expect(opened.status).toBe(200);
    const betaCookie = opened.headers.getSetCookie()[0]!.split(";")[0]!;
    const member = f.browser();
    expect(
        (
            await member.call(
                "/sign-up/email",
                {
                    name: "Invited",
                    email: "invited@example.test",
                    password: "test member password",
                },
                { cookie: betaCookie }
            )
        ).status
    ).toBe(200);
    const verifyLink = f.sent
        .find(
            (message) => message.to === "invited@example.test" && message.subject.includes("Verify")
        )!
        .text.match(/http[^\s]+/)![0];
    await f.auth.handler(new Request(verifyLink));
    await member.call("/sign-in/email", {
        email: "invited@example.test",
        password: "test member password",
    });
    const me = (await (
        await f.request(`${member.cookie()}; ${betaCookie}`, "/auth/me")
    ).json()) as { authenticated: boolean; workspace: { id: string } };
    expect(me.authenticated).toBe(true);
    expect(me.workspace.id).toBeTruthy();
});
