import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DevRuntime, runDev, runServe, type ServeRuntime } from "../src/index.ts";

const dirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
const devs: DevRuntime[] = [];
const serves: ServeRuntime[] = [];
afterEach(async () => {
    for (const s of servers.splice(0)) s.stop(true);
    for (const d of devs.splice(0)) await d.close();
    for (const r of serves.splice(0)) await r.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "notato-whh-"));
    dirs.push(dir);
    return dir;
};
const quiet = () => {};

function receiver(status = 200) {
    const got: Array<{ event: string | null; signed: boolean; body: string }> = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            got.push({
                event: req.headers.get("x-notato-event"),
                signed: req.headers.has("x-notato-signature"),
                body: await req.text(),
            });
            return new Response("ok", { status });
        },
    });
    servers.push(server);
    return { port: server.port, got };
}

async function dev(webhooks: unknown[]) {
    const dir = tmp();
    const configFile = join(dir, "notato.config.json");
    writeFileSync(configFile, JSON.stringify({ webhooks }));
    const rt = await runDev({
        port: 0,
        dir: join(dir, "data"),
        version: "t",
        stdio: false,
        log: quiet,
        configFile,
    });
    devs.push(rt);
    return `http://127.0.0.1:${rt.port}`;
}

describe("GET /webhooks, for the settings panel", () => {
    it("shows what and how, never the URL's path or the secret", async () => {
        const base = await dev([
            {
                url: "https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN",
                name: "team",
                format: "slack",
                events: ["annotation.resolved"],
                secret: "sign-with-this",
            },
            { url: "https://ci.example.com/notato?key=abc123", project: "shop" },
        ]);
        const res = await fetch(`${base}/webhooks`);
        expect(res.status).toBe(200);
        const text = await res.text();
        for (const secret of [
            "SUPERSECRETTOKEN",
            "T000",
            "sign-with-this",
            "abc123",
            "/services",
            "key=",
        ])
            expect(text, secret).not.toContain(secret);
        const body = JSON.parse(text) as { items: Array<Record<string, unknown>> };
        expect(body.items).toEqual([
            {
                index: 0,
                name: "team",
                host: "hooks.slack.com",
                format: "slack",
                events: ["annotation.resolved"],
                project: null,
                signed: true,
            },
            {
                index: 1,
                name: "ci.example.com",
                host: "ci.example.com",
                format: "json",
                events: null,
                project: "shop",
                signed: false,
            },
        ]);
    });

    it("is empty with none configured", async () => {
        const base = await dev([]);
        expect(
            ((await (await fetch(`${base}/webhooks`)).json()) as { items: unknown[] }).items
        ).toEqual([]);
    });
});

describe("POST /webhooks/test", () => {
    it("sends a sample event to that webhook, and says what the other end answered", async () => {
        const r = receiver();
        const base = await dev([{ url: `http://127.0.0.1:${r.port}/in`, secret: "k" }]);
        const res = await fetch(`${base}/webhooks/test`, {
            method: "POST",
            body: JSON.stringify({ index: 0 }),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
        expect(r.got).toHaveLength(1);
        expect(r.got[0]?.event).toBe("annotation.created");
        expect(r.got[0]?.signed).toBe(true);
        expect(r.got[0]?.body).toContain("test event from Notato");
    });

    it("reports a refusal, without retrying", async () => {
        const r = receiver(403);
        const base = await dev([{ url: `http://127.0.0.1:${r.port}/in` }]);
        const body = (await (
            await fetch(`${base}/webhooks/test`, {
                method: "POST",
                body: JSON.stringify({ index: 0 }),
            })
        ).json()) as { ok: boolean; detail: string };
        expect(body.ok).toBe(false);
        expect(body.detail).toContain("403");
        expect(r.got).toHaveLength(1);
    });

    it("unknown webhook is a 404, and a missing secret is said, not sent unsigned", async () => {
        const r = receiver();
        const base = await dev([
            { url: `http://127.0.0.1:${r.port}/in`, secret: "env:NOTATO_TEST_SECRET_NOT_SET" },
        ]);
        const post = (index: number) =>
            fetch(`${base}/webhooks/test`, { method: "POST", body: JSON.stringify({ index }) });
        expect((await post(5)).status).toBe(404);
        const missing = await post(0);
        expect(missing.status).toBe(409);
        expect(((await missing.json()) as { error: string }).error).toContain(
            "NOTATO_TEST_SECRET_NOT_SET"
        );
        expect(r.got).toHaveLength(0);
    });
});

describe("on a shared server, only an admin", () => {
    it("a project token is refused both, and an admin session is not", async () => {
        const dir = tmp();
        const rt = await runServe({
            port: 0,
            dir,
            version: "t",
            adminPassword: "correct horse",
            log: quiet,
        });
        serves.push(rt);
        const base = `http://127.0.0.1:${rt.port}`;
        const login = await fetch(`${base}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "admin", password: "correct horse" }),
        });
        const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
        await rt.backend.createProject("shop");
        const made = await fetch(`${base}/admin/tokens`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ projectId: "shop", name: "t" }),
        });
        const { token } = (await made.json()) as { token: string };
        const asToken = { authorization: `Bearer ${token}` };
        expect((await fetch(`${base}/webhooks`, { headers: asToken })).status).toBe(403);
        expect(
            (
                await fetch(`${base}/webhooks/test`, {
                    method: "POST",
                    headers: asToken,
                    body: JSON.stringify({ index: 0 }),
                })
            ).status
        ).toBe(403);
        expect((await fetch(`${base}/webhooks`, { headers: { cookie } })).status).toBe(200);
    });
});
