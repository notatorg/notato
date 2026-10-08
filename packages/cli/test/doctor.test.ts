import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DevRuntime, runDev, runServe, type ServeRuntime } from "@notato/server";
import { type Check, DOCTOR_PROJECT, formatChecks, runDoctor } from "../src/commands/doctor.ts";
import { federatedRepo, HOST_MAIN } from "./federated-repo.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const devs: DevRuntime[] = [];
const serves: ServeRuntime[] = [];
const aborts: AbortController[] = [];
const stray: Array<{ stop(force?: boolean): void }> = [];
afterEach(async () => {
    for (const a of aborts.splice(0)) a.abort();
    for (const d of devs.splice(0)) await d.close();
    for (const s of serves.splice(0)) await s.stop();
    for (const s of stray.splice(0)) s.stop(true);
    removeTempDirs();
});

const tmp = () => tempDir("notato-doctor-");
const quiet = () => {};
const noAgents = { agents: false as const };

async function dev() {
    const rt = await runDev({ port: 0, dir: tmp(), version: "t", stdio: false, log: quiet });
    devs.push(rt);
    return { rt, url: `http://127.0.0.1:${rt.port}` };
}

async function serve() {
    const rt = await runServe({
        port: 0,
        dir: tmp(),
        version: "t",
        adminPassword: "pw",
        log: quiet,
    });
    serves.push(rt);
    return { rt, url: `http://127.0.0.1:${rt.port}` };
}

const by = (checks: Check[], name: string) => checks.find((c) => c.name === name);

/** A page: an event stream held open, which is how the SDK shows up on the server. */
async function openPage(url: string, project: string, token?: string, agent = false) {
    const controller = new AbortController();
    aborts.push(controller);
    const query = new URLSearchParams();
    if (agent) query.set("agent", "1");
    if (token) query.set("token", token);
    const res = await fetch(`${url}/projects/${project}/events?${query}`, {
        signal: controller.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // the hello frame: the server has registered the page
}

describe("doctor against a local dev server", () => {
    it("passes the end-to-end check, leaves nothing behind, and warns that no page is connected", async () => {
        const { rt, url } = await dev();
        const checks = await runDoctor({ server: url, ...noAgents });
        expect(by(checks, "Server")?.status).toBe("ok");
        expect(by(checks, "Access")).toMatchObject({
            status: "ok",
            detail: expect.stringContaining("dev mode"),
        });
        expect(by(checks, "End to end")).toMatchObject({
            status: "ok",
            detail: expect.stringContaining("screenshot bytes matched"),
        });
        expect(await rt.local?.list()).toEqual([]);
        // The project the test note created goes with it, so the board is as it was.
        expect(await rt.local?.store.getProject(DOCTOR_PROJECT)).toBeNull();
        expect((await rt.local?.store.listProjects())?.map((p) => p.id)).toEqual([]);
        const browser = by(checks, "Browser");
        expect(browser?.status).toBe("warn");
        expect(browser?.detail).toContain("no page is connected");
        expect(browser?.fix).toContain("CORS");
    });

    it("keeps a notato-doctor project that was there before, and never touches the person's own", async () => {
        const { rt, url } = await dev();
        await rt.local?.createProject(DOCTOR_PROJECT, "Doctor");
        expect(by(await runDoctor({ server: url, ...noAgents }), "End to end")?.status).toBe("ok");
        expect((await rt.local?.store.getProject(DOCTOR_PROJECT))?.name).toBe("Doctor");

        const mine = await runDoctor({ server: url, project: "checkout-web", ...noAgents });
        expect(by(mine, "End to end")?.status).toBe("ok");
        expect(await rt.local?.store.getProject("checkout-web")).not.toBeNull();
        expect(await rt.local?.list()).toEqual([]);
    });

    it("reports a connected page, and agent pages by project", async () => {
        const { url } = await dev();
        await openPage(url, "checkout-web", undefined, true);
        const checks = await runDoctor({ server: url, ...noAgents });
        // Plain assertions: Bun's toMatchObject rewrites a property it matched with an asymmetric matcher.
        const browser = by(checks, "Browser");
        expect(browser?.status).toBe("ok");
        expect(browser?.detail).toBe("1 page is connected (agent pages: checkout-web)");
    });

    it("does not count a Claude waiting in notato_watch as a browser", async () => {
        const { rt, url } = await dev();
        const waiting = rt.backend.waitForNew({ status: "open" }, 2000);
        const checks = await runDoctor({ server: url, ...noAgents });
        expect(by(checks, "Browser")?.status).toBe("warn");
        await waiting;
    });
});

describe("doctor when the server is missing or wrong", () => {
    it("fails with what to do when nothing is listening, and stops there", async () => {
        const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
        const port = probe.port;
        probe.stop(true);
        const checks = await runDoctor({ server: `http://127.0.0.1:${port}`, ...noAgents });
        expect(checks).toHaveLength(1);
        expect(checks[0]).toMatchObject({ name: "Server", status: "fail" });
        expect(checks[0]?.fix).toContain("claude mcp add notato");
    });

    it("recognises a server that is not Notato", async () => {
        const other = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => Response.json({ ok: true }),
        });
        stray.push(other);
        const checks = await runDoctor({ server: `http://127.0.0.1:${other.port}`, ...noAgents });
        expect(checks[0]).toMatchObject({
            status: "fail",
            detail: expect.stringContaining("not Notato"),
        });
    });
});

describe("doctor against a server older than the CLI", () => {
    /** What `notato dev` looked like before login and page counts existed. */
    function oldServer() {
        const store = new Map<string, unknown>();
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(req) {
                const url = new URL(req.url);
                if (url.pathname === "/health")
                    return Response.json({ ok: true, service: "notato" });
                if (url.pathname === "/status")
                    return Response.json({
                        ok: true,
                        service: "notato",
                        mode: "dev",
                        watchers: 1,
                        projects: [],
                    });
                const post = /^\/projects\/([^/]+)\/annotations$/.exec(url.pathname);
                if (post && req.method === "POST") {
                    const form = await req.formData();
                    const annotation = JSON.parse(form.get("annotation") as string);
                    const file = form.get(
                        `asset:${annotation.screenshots.full.id}`
                    ) as unknown as File;
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    const hash = Array.from(
                        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
                        (b) => b.toString(16).padStart(2, "0")
                    ).join("");
                    annotation.screenshots.full.id = hash;
                    store.set(annotation.id, { seq: 1, annotation });
                    store.set(`asset:${hash}`, bytes);
                    return Response.json({ seq: 1, annotation }, { status: 201 });
                }
                const one = /^\/annotations\/([^/]+)$/.exec(url.pathname);
                if (one) {
                    if (req.method === "DELETE") return new Response(null, { status: 204 });
                    return Response.json(store.get(one[1] ?? ""));
                }
                const asset = /^\/assets\/([^/]+)$/.exec(url.pathname);
                if (asset) return new Response(store.get(`asset:${asset[1]}`) as BodyInit);
                return Response.json({ error: "not found" }, { status: 404 });
            },
        });
        stray.push(server);
        return `http://127.0.0.1:${server.port}`;
    }

    it("does not print 'undefined', and does not claim no browser is connected when it cannot tell", async () => {
        const checks = await runDoctor({ server: oldServer(), ...noAgents });
        const access = by(checks, "Access");
        expect(access?.status).toBe("ok");
        expect(access?.detail).toBe("no login needed");
        expect(by(checks, "End to end")?.status).toBe("ok");
        const browser = by(checks, "Browser");
        expect(browser?.status).toBe("warn");
        expect(browser?.detail).toContain("does not report connected pages");
        expect(browser?.detail).not.toContain("no page is connected");
        expect(browser?.fix).toContain("restart");
        expect(formatChecks(checks)).not.toContain("undefined");
    });
});

describe("doctor against a shared server", () => {
    it("fails Access when a token is needed, and says how to get one", async () => {
        const { url } = await serve();
        const checks = await runDoctor({ server: url, ...noAgents });
        expect(by(checks, "Access")).toMatchObject({
            status: "fail",
            detail: expect.stringContaining("needs a token"),
        });
        expect(by(checks, "Access")?.fix).toContain("notato project create");
        expect(by(checks, "Access")?.fix).toContain("notato token create");
        expect(by(checks, "End to end")).toBeUndefined();
    });

    it("passes with a * token, and with a project token for the right project", async () => {
        const { rt, url } = await serve();
        const all = (await rt.auth.issueToken("*", "agent")).token;
        await rt.backend.createProject("checkout-web");
        const mine = (await rt.auth.issueToken("checkout-web", "browser")).token;
        // A * token with --project: the person's own project.
        expect(
            by(
                await runDoctor({ server: url, token: all, project: "checkout-web", ...noAgents }),
                "End to end"
            )?.status
        ).toBe("ok");
        // A * token without: the notato-doctor project an admin made for it, which doctor leaves in place.
        await rt.backend.createProject(DOCTOR_PROJECT);
        expect(
            by(await runDoctor({ server: url, token: all, ...noAgents }), "End to end")?.status
        ).toBe("ok");
        expect(await rt.store.getProject(DOCTOR_PROJECT)).not.toBeNull();
        const scoped = await runDoctor({
            server: url,
            token: mine,
            project: "checkout-web",
            ...noAgents,
        });
        expect(by(scoped, "Access")?.detail).toBe("the token is accepted");
        expect(by(scoped, "End to end")?.status).toBe("ok");
        expect(await rt.backend.list()).toEqual([]);
    });

    it("explains, rather than fails, when the shared server has no project to test with", async () => {
        const { rt, url } = await serve();
        const all = (await rt.auth.issueToken("*", "agent")).token;
        const checks = await runDoctor({ server: url, token: all, ...noAgents });
        const e2e = by(checks, "End to end");
        expect(e2e?.status).toBe("warn");
        expect(e2e?.detail).toContain("only takes notes for projects created on it");
        expect(e2e?.fix).toContain("--project");
        expect(e2e?.fix).toContain(`notato project create ${DOCTOR_PROJECT}`);
        expect(formatChecks(checks)).not.toContain("problem");
        // Nothing was created to make the test pass.
        expect(await rt.store.getProject(DOCTOR_PROJECT)).toBeNull();
        expect(await rt.backend.list()).toEqual([]);
    });

    it("tells you to pass --project with the token's own project", async () => {
        const { rt, url } = await serve();
        await rt.backend.createProject("checkout-web");
        const mine = (await rt.auth.issueToken("checkout-web", "browser")).token;
        const checks = await runDoctor({ server: url, token: mine, ...noAgents });
        expect(by(checks, "End to end")).toMatchObject({
            status: "warn",
            fix: expect.stringContaining("--project checkout-web"),
        });
        // Asked for another project by name, it is a real failure, with the same advice.
        const wrong = await runDoctor({ server: url, token: mine, project: "other", ...noAgents });
        expect(by(wrong, "End to end")).toMatchObject({
            status: "fail",
            fix: expect.stringContaining("--project checkout-web"),
        });
    });

    it("fails with the server's own words when the project given does not exist there", async () => {
        const { rt, url } = await serve();
        const all = (await rt.auth.issueToken("*", "agent")).token;
        const checks = await runDoctor({ server: url, token: all, project: "nope", ...noAgents });
        expect(by(checks, "End to end")?.status).toBe("fail");
        expect(by(checks, "End to end")?.detail).toContain("notato project create nope");
    });

    it("rejects a bad token", async () => {
        const { url } = await serve();
        const checks = await runDoctor({ server: url, token: "notato_wrong", ...noAgents });
        expect(by(checks, "Access")?.status).toBe("fail");
    });

    it("sees pages that connect with a project token", async () => {
        const { rt, url } = await serve();
        await rt.backend.createProject("checkout-web");
        const mine = (await rt.auth.issueToken("checkout-web", "browser")).token;
        await openPage(url, "checkout-web", mine);
        const all = (await rt.auth.issueToken("*", "agent")).token;
        expect(
            by(await runDoctor({ server: url, token: all, ...noAgents }), "Browser")?.status
        ).toBe("ok");
    });
});

describe("doctor: Claude Code and the app", () => {
    it("checks that claude lists the notato server", async () => {
        const { url } = await dev();
        const registered = await runDoctor({
            server: url,
            which: () => "/bin/claude",
            run: async () => ({ code: 0, output: "notato: npx notato dev - ✓ Connected" }),
        });
        expect(by(registered, "Claude Code")?.status).toBe("ok");
        const missing = await runDoctor({
            server: url,
            which: () => "/bin/claude",
            run: async () => ({ code: 0, output: "other: foo" }),
        });
        expect(by(missing, "Claude Code")).toMatchObject({
            status: "warn",
            fix: expect.stringContaining("npx notato init"),
        });
        const none = await runDoctor({ server: url, which: () => null });
        expect(by(none, "Claude Code")?.detail).toContain("not on PATH");
    });

    it("asks claude from the app's folder and the repo root, not from wherever doctor runs", async () => {
        const { url } = await dev();
        const repo = tmp();
        mkdirSync(join(repo, ".git"));
        const appDir = join(repo, "apps", "web");
        mkdirSync(appDir, { recursive: true });
        const asked: Array<string | undefined> = [];
        // Registered for the repo root only, as `init --agent-dir .` does.
        const checks = await runDoctor({
            server: url,
            cwd: appDir,
            agentIds: ["claude"],
            which: () => "/bin/claude",
            run: async (_command, dir) => {
                asked.push(dir);
                return { code: 0, output: dir === repo ? "notato: npx notato dev" : "" };
            },
        });
        expect(asked).toEqual([appDir, repo]);
        expect(by(checks, "Claude Code")?.status).toBe("ok");
    });

    it("checks that the app renders <Notato />", async () => {
        const { url } = await dev();
        const wired = tmp();
        mkdirSync(join(wired, "src"));
        writeFileSync(join(wired, "package.json"), "{}");
        writeFileSync(join(wired, "src/main.tsx"), 'import { Notato } from "@notato/react"\n');
        expect(by(await runDoctor({ server: url, cwd: wired, ...noAgents }), "App")?.status).toBe(
            "ok"
        );

        const bare = tmp();
        mkdirSync(join(bare, "src"));
        writeFileSync(join(bare, "package.json"), "{}");
        writeFileSync(join(bare, "src/main.tsx"), "export {}\n");
        expect(by(await runDoctor({ server: url, cwd: bare, ...noAgents }), "App")).toMatchObject({
            status: "warn",
            fix: expect.stringContaining("init"),
        });
    });
});

describe("formatChecks", () => {
    it("marks each check, shows fixes only for problems, and summarises", () => {
        const text = formatChecks([
            { name: "Server", status: "ok", detail: "fine", fix: "unused" },
            { name: "Browser", status: "warn", detail: "no page", fix: "open the app" },
            { name: "End to end", status: "fail", detail: "broken", fix: "restart" },
        ]);
        expect(text).toContain("✓ Server: fine");
        expect(text).toContain("! Browser: no page\n    → open the app");
        expect(text).toContain("✗ End to end: broken\n    → restart");
        expect(text).not.toContain("unused");
        expect(text).toContain("1 problem found.");
        expect(formatChecks([{ name: "a", status: "ok", detail: "x" }])).toContain(
            "Everything works."
        );
        expect(formatChecks([{ name: "a", status: "warn", detail: "x" }])).toContain(
            "Working, with a warning above."
        );
    });
});

describe("doctor and the screenshot setting", () => {
    async function devWith(configText: string | null) {
        const dir = tmp();
        const configFile = join(dir, "notato.config.json");
        if (configText !== null) writeFileSync(configFile, configText);
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

    it("says screenshots are on by default, and proves one is kept", async () => {
        const checks = await runDoctor({ server: await devWith(null), ...noAgents });
        expect(by(checks, "Screenshots")).toMatchObject({ status: "ok" });
        expect(by(checks, "Screenshots")?.detail).toMatch(/^on/);
        expect(by(checks, "End to end")?.detail).toContain("screenshot bytes matched");
    });

    it("with them off, proves the server kept the note but not the screenshot", async () => {
        const checks = await runDoctor({
            server: await devWith('{ "screenshots": "off" }'),
            ...noAgents,
        });
        expect(by(checks, "Screenshots")).toMatchObject({ status: "ok" });
        expect(by(checks, "Screenshots")?.detail).toContain("off");
        expect(by(checks, "End to end")).toMatchObject({ status: "ok" });
        expect(by(checks, "End to end")?.detail).toContain("not the screenshot");
    });

    it("warns about a broken settings file, which turns them off to be safe", async () => {
        const checks = await runDoctor({
            server: await devWith('{ "screenshots": "off", }'),
            ...noAgents,
        });
        expect(by(checks, "Screenshots")).toMatchObject({ status: "warn" });
        expect(by(checks, "Screenshots")?.detail).toContain("broken");
        expect(by(checks, "Screenshots")?.fix).toContain("notato config");
        expect(by(checks, "End to end")).toMatchObject({ status: "ok" });
    });

    it("warns when agents are turned off, and says how to turn them on", async () => {
        expect(
            by(await runDoctor({ server: await devWith(null), ...noAgents }), "Agents")
        ).toBeUndefined();
        const checks = await runDoctor({
            server: await devWith('{ "mcp": "off" }'),
            ...noAgents,
        });
        expect(by(checks, "Agents")).toMatchObject({ status: "warn" });
        expect(by(checks, "Agents")?.fix).toContain("npx notato config set mcp on");
        // Apps still send: the loop up to the agent works.
        expect(by(checks, "End to end")).toMatchObject({ status: "ok" });
    });
});

describe("doctor and webhooks", () => {
    it("shows them, and does not send the team's channel its own test annotation", async () => {
        const got: string[] = [];
        const receiver = Bun.serve({
            port: 0,
            fetch(req) {
                got.push(req.headers.get("x-notato-event") ?? "");
                return new Response("ok");
            },
        });
        try {
            const dir = tmp();
            const configFile = join(dir, "notato.config.json");
            writeFileSync(
                configFile,
                JSON.stringify({ webhooks: [{ url: `http://127.0.0.1:${receiver.port}/in` }] })
            );
            const rt = await runDev({
                port: 0,
                dir: join(dir, "data"),
                version: "t",
                stdio: false,
                log: quiet,
                configFile,
            });
            devs.push(rt);
            const checks = await runDoctor({ server: `http://127.0.0.1:${rt.port}`, ...noAgents });
            expect(by(checks, "Webhooks")).toMatchObject({ status: "ok" });
            expect(by(checks, "Webhooks")?.detail).toContain("1 configured");
            expect(by(checks, "End to end")).toMatchObject({ status: "ok" });
            await Bun.sleep(150);
            expect(got).toEqual([]);
        } finally {
            receiver.stop(true);
        }
    });
});

describe("doctor in a repo of several apps", () => {
    const appCheck = async (root: string) =>
        (await runDoctor({ server: "http://127.0.0.1:1", cwd: root, agents: false })).find(
            (c) => c.name === "App"
        );

    it("is satisfied when the host renders <Notato />, and names the module that inherits it", async () => {
        const root = federatedRepo({
            "app-shell/src/main.tsx": `${HOST_MAIN}\n// @notato/react\n`,
        });
        const app = await appCheck(root);
        expect(app?.status).toBe("ok");
        expect(app?.detail).toBe(
            "app-shell renders <Notato />; the 1 federated module it loads inherits it"
        );
    });

    it("warns, and points at the federation host, when nothing is wired", async () => {
        const app = await appCheck(federatedRepo());
        expect(app?.status).toBe("warn");
        expect(app?.detail).toBe("no <Notato /> found in any of 3 apps");
        expect(app?.fix).toContain("in app-shell, the federation host");
    });

    it("checks the app itself when run inside one", async () => {
        const root = federatedRepo();
        const unwired = (
            await runDoctor({
                server: "http://127.0.0.1:1",
                cwd: join(root, "developer-portal"),
                agents: false,
            })
        ).find((c) => c.name === "App");
        expect(unwired?.detail).toBe("no <Notato /> found in .");
    });
});
