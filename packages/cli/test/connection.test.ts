import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CheckoutConnection } from "@notato/core";
import {
    Authenticator,
    createApp,
    FileBlobStore,
    LocalBackend,
    SqliteStore,
    TeamCoordinator,
} from "@notato/server";
import { runConnection } from "../src/commands/connection.ts";
import { runApp } from "../src/commands/run.ts";
import {
    appEnvironment,
    CONNECTION_FILE,
    connectionRoot,
    readConnections,
    writeConnections,
} from "../src/connection.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f();
    removeTempDirs();
});
async function fixture() {
    const root = tempDir("notato-profile-"),
        store = new SqliteStore(join(root, "test.db")),
        backend = new LocalBackend(store, new FileBlobStore(join(root, "assets")));
    cleanup.push(() => {
        backend.agents.stop();
        store.close();
    });
    await backend.createProject("web");
    const teams = new TeamCoordinator(store),
        ctx = await teams.create("web", "local", "Dominic's checkout", "feature/cart"),
        other = await teams.create("web", "local", "Other checkout");
    const auth = new Authenticator(store);
    const app = await auth.issueToken("web", "App", {
            purpose: "app",
            permission: "full",
            developmentContextId: ctx.id,
        }),
        agent = await auth.issueToken("web", "Agent", {
            purpose: "agent",
            permission: "full",
            developmentContextId: ctx.id,
        });
    const handler = createApp({ backend, mode: "dev", version: "test" });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handler(req) });
    cleanup.push(() => server.stop(true));
    const profile: CheckoutConnection = {
        version: 1,
        name: "Cloud",
        mode: "remote",
        server: `http://127.0.0.1:${server.port}`,
        project: "web",
        context: { id: ctx.id, name: ctx.name, branch: ctx.branch },
        appToken: app.token,
        agentToken: agent.token,
    };
    const download = join(root, "download.json");
    writeFileSync(download, JSON.stringify(profile));
    return { root, profile, download, auth, ctx, other, teams, store, server };
}
it("imports and verifies both credentials, keeps keys private and lists only safe metadata", async () => {
    const s = await fixture();
    const result = await runConnection(["import", s.download], s.root);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(s.profile.appToken!);
    expect(result.stdout).not.toContain(s.profile.agentToken!);
    expect(readConnections(s.root)?.active).toBe("cloud");
    expect(statSync(join(s.root, CONNECTION_FILE)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(s.root, ".gitignore"), "utf8")).toContain(`/${CONNECTION_FILE}`);
    const env = appEnvironment(s.profile, {
        NOTATO_AGENT_TOKEN: s.profile.agentToken,
        VITE_NOTATO_SERVER: "https://wrong.example",
        KEEP: "yes",
    });
    expect(JSON.stringify(env)).not.toContain(s.profile.agentToken!);
    expect(env.VITE_NOTATO_SERVER).toBeUndefined();
    expect(env.KEEP).toBe("yes");
    expect(JSON.parse(env.VITE_NOTATO_CONNECTION!).token).toBe(s.profile.appToken);
    expect((await runConnection([], s.root)).stdout).not.toContain(s.profile.appToken!);
    const doctor = Bun.spawn(
        [
            process.execPath,
            resolve(import.meta.dir, "../src/main.ts"),
            "doctor",
            "--cwd",
            s.root,
            "--no-agents",
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    const doctorOutput = await new Response(doctor.stdout).text();
    expect(await doctor.exited).toBe(0);
    expect(doctorOutput).toContain("Checkout connection");
    expect(doctorOutput).not.toContain(s.profile.agentToken!);
    const old = readFileSync(join(s.root, CONNECTION_FILE), "utf8");
    const wrong = await s.auth.issueToken("web", "Wrong", {
        purpose: "agent",
        developmentContextId: s.other.id,
    });
    writeFileSync(s.download, JSON.stringify({ ...s.profile, agentToken: wrong.token }));
    expect((await runConnection(["import", s.download], s.root)).code).toBe(1);
    expect(readFileSync(join(s.root, CONNECTION_FILE), "utf8")).toBe(old);
    await s.auth.revokeToken(wrong.record.id);
    expect(
        (
            await runConnection(["use", "cloud"], s.root, async () => {
                throw new Error("offline");
            })
        ).code
    ).toBe(1);
    expect(readConnections(s.root)?.active).toBe("cloud");
    const local = await runConnection(
        ["local", "--project", "local-web", "--port", "4898"],
        s.root
    );
    expect(local.code).toBe(0);
    const localEnv = JSON.parse(
        appEnvironment(readConnections(s.root)!.profiles.local!).VITE_NOTATO_CONNECTION!
    );
    expect(localEnv.token).toBeUndefined();
    expect(localEnv.project).toBe("local-web");
});
it("stops at worktree boundaries and refuses tracked or linked credential files", async () => {
    const root = tempDir("notato-profile-git-"),
        checkout = join(root, "worktree");
    mkdirSync(checkout);
    writeFileSync(join(checkout, ".git"), "gitdir: elsewhere");
    const nested = join(checkout, "packages", "web");
    mkdirSync(nested, { recursive: true });
    expect(connectionRoot(nested)).toBe(checkout);
    writeConnections(root, {
        version: 1,
        active: "local",
        profiles: {
            local: { version: 1, name: "Local", mode: "local", server: "http://127.0.0.1:4896" },
        },
    });
    expect(connectionRoot(checkout)).toBe(checkout);
    const linked = join(checkout, CONNECTION_FILE);
    symlinkSync(join(root, CONNECTION_FILE), linked);
    expect(() => readConnections(checkout)).toThrow("regular private");
    expect(() => writeConnections(checkout, readConnections(root)!)).toThrow("linked");
    const tracked = tempDir("notato-profile-tracked-");
    Bun.spawnSync(["git", "init"], { cwd: tracked, stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(tracked, CONNECTION_FILE), "placeholder");
    Bun.spawnSync(["git", "add", CONNECTION_FILE], { cwd: tracked });
    expect(() => writeConnections(tracked, readConnections(root)!)).toThrow("tracked");
    expect(readFileSync(join(tracked, CONNECTION_FILE), "utf8")).toBe("placeholder");
    const ignored = tempDir("notato-profile-ignore-");
    Bun.spawnSync(["git", "init"], { cwd: ignored, stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(ignored, ".gitignore"), `/${CONNECTION_FILE}\n!${CONNECTION_FILE}\n`);
    writeConnections(ignored, readConnections(root)!);
    expect(
        Bun.spawnSync(["git", "check-ignore", "--quiet", CONNECTION_FILE], { cwd: ignored })
            .exitCode
    ).toBe(0);
});
async function until(check: () => boolean | Promise<boolean>, ms = 7000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return;
        await Bun.sleep(25);
    }
    throw new Error("Timed out waiting for profile transition");
}
it("restarts the app across Cloud/local with no agent secret and stops it on malformed profiles", async () => {
    const s = await fixture();
    expect((await runConnection(["import", s.download], s.root)).code).toBe(0);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const script = join(s.root, "app.js"),
        log = join(s.root, "runs.jsonl");
    writeFileSync(
        script,
        `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(log)},JSON.stringify({connection:JSON.parse(process.env.VITE_NOTATO_CONNECTION),agent:process.env.NOTATO_AGENT_TOKEN??null,pid:process.pid})+'\\n');setInterval(()=>{},1000);`
    );
    const controller = new AbortController();
    let ended = false;
    const appDir = join(s.root, "app");
    mkdirSync(appDir);
    const running = runApp([process.execPath, script], s.root, controller.signal, appDir).finally(
        () => {
            ended = true;
        }
    );
    cleanup.push(async () => {
        controller.abort();
        await running;
    });
    const runs = () =>
        existsSync(log)
            ? readFileSync(log, "utf8")
                  .trim()
                  .split("\n")
                  .map((l) => JSON.parse(l))
            : [];
    await until(() => runs().length === 1);
    expect(runs()[0].connection.mode).toBe("remote");
    expect(runs()[0].agent).toBeNull();
    expect(
        (await runConnection(["local", "--port", String(port), "--project", "local-web"], s.root))
            .code
    ).toBe(0);
    await until(() => runs().length === 2);
    expect(runs()[1].connection.mode).toBe("local");
    expect(runs()[1].connection.token).toBeUndefined();
    expect(ended).toBe(false);
    writeFileSync(join(s.root, CONNECTION_FILE), "broken JSON");
    await until(async () => {
        try {
            await fetch(`http://127.0.0.1:${port}/health`);
            return false;
        } catch {
            return true;
        }
    });
    expect(runs()).toHaveLength(2);
    expect(ended).toBe(false);
    controller.abort();
    expect(await running).toBe(0);
}, 20000);
it("disconnects a live MCP session on selection changes instead of keeping the previous destination", async () => {
    const s = await fixture();
    await runConnection(["import", s.download], s.root);
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve(import.meta.dir, "../src/main.ts"), "dev", "--connection-root", s.root],
        stderr: "pipe",
    });
    const client = new Client({ name: "Profile test", version: "1" });
    cleanup.push(() => client.close());
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    let closed = false;
    client.onclose = () => {
        closed = true;
    };
    await runConnection(["local", "--port", "4897"], s.root);
    await until(() => closed);
}, 20000);
