import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
    createConfigSource,
    type DevRuntime,
    mcpRefusal,
    runDev,
    runServe,
    type ServeRuntime,
} from "../src/index.ts";
import { annotationFixture, multipart } from "./helpers.ts";

const dirs: string[] = [];
const devs: DevRuntime[] = [];
const serves: ServeRuntime[] = [];
const clients: Client[] = [];
afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    for (const r of devs.splice(0)) await r.close();
    for (const r of serves.splice(0)) await r.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "notato-mcp-"));
    dirs.push(dir);
    return dir;
};

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

/** A dev server with its own data and config file, as `notato start` runs one. */
async function dev(options: { port?: number; config?: object; mcp?: boolean } = {}) {
    const dir = tmp();
    const configFile = join(dir, "notato.config.json");
    if (options.config) writeFileSync(configFile, JSON.stringify(options.config));
    const rt = await runDev({
        port: options.port ?? 0,
        dir,
        configFile,
        version: "t",
        stdio: false,
        mcp: options.mcp,
        log: () => {},
    });
    devs.push(rt);
    const base = `http://127.0.0.1:${rt.port}`;
    return { rt, base, configFile };
}

async function httpClient(url: string, headers: Record<string, string> = {}) {
    const client = new Client({ name: "claude-code", version: "0" });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
    );
    clients.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
    return { client, call };
}

/** The process's own MCP, as an agent that started `notato dev` over stdio has it. */
async function stdioClient(rt: DevRuntime) {
    const client = new Client({ name: "codex-mcp-client", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([rt.mcp.connect(s), client.connect(c)]);
    clients.push(client);
    return async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

const initialize = (headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
    },
    body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "probe", version: "0" },
        },
    }),
});

async function post(base: string, project = "web") {
    const a = annotationFixture({ projectId: project, comment: "the button is cut off" });
    const res = await fetch(`${base}/projects/${project}/annotations`, {
        method: "POST",
        body: multipart(a),
    });
    expect(res.status).toBe(201);
    return a;
}

const setMcp = (base: string, value: "on" | "off" | null) =>
    fetch(`${base}/settings/mcp`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
    });

describe("the mcp setting", () => {
    it("is on by default, and the file, the environment and a flag each win over the one before", () => {
        const dir = tmp();
        const file = join(dir, "notato.config.json");
        expect(createConfigSource({ file, env: {} })()).toMatchObject({
            mcp: true,
            source: { mcp: "default" },
        });
        writeFileSync(file, JSON.stringify({ mcp: "off" }));
        expect(createConfigSource({ file, env: {} })()).toMatchObject({
            mcp: false,
            source: { mcp: "file" },
        });
        expect(createConfigSource({ file, env: { NOTATO_MCP: "on" } })()).toMatchObject({
            mcp: true,
            source: { mcp: "env" },
        });
        expect(
            createConfigSource({ file, env: { NOTATO_MCP: "on" }, flags: { mcp: false } })()
        ).toMatchObject({ mcp: false, source: { mcp: "flag" } });
    });

    it("fails closed on a broken file, and every refusal says how to turn it back on", () => {
        const dir = tmp();
        const file = join(dir, "notato.config.json");
        writeFileSync(file, "{ nope");
        const broken = createConfigSource({ file, env: {} })();
        expect(broken.mcp).toBe(false);
        expect(mcpRefusal(broken)).toContain("cannot be read");

        writeFileSync(file, JSON.stringify({ mcp: "off" }));
        expect(mcpRefusal(createConfigSource({ file, env: {} })())).toContain(
            "npx notato config set mcp on"
        );
        expect(mcpRefusal(createConfigSource({ file, env: { NOTATO_MCP: "off" } })())).toContain(
            "$NOTATO_MCP"
        );
        expect(
            mcpRefusal(createConfigSource({ file, env: {}, flags: { mcp: false } })())
        ).toContain("--no-mcp");
        writeFileSync(file, "{}");
        expect(mcpRefusal(createConfigSource({ file, env: {} })())).toBeNull();
    });
});

describe("MCP over HTTP on the dev server", () => {
    it("serves the tools at /mcp to an agent on this machine, with no token", async () => {
        const { base, rt } = await dev();
        const a = await post(base);
        const { call } = await httpClient(`${base}/mcp`);
        const list = await call("notato_list_open");
        expect(text(list)).toContain(a.id);
        // An agent with the MCP open is there, named after its client, so pages say one is connected.
        expect(rt.local?.agents.state).toMatchObject({ connected: true, names: ["Claude"] });
        await call("notato_resolve", { id: a.id, summary: "widened it" });
        expect((await rt.local?.get(a.id))?.annotation.status).toBe("resolved");
    });

    it("refuses web pages, even ones on this machine", async () => {
        const { base } = await dev();
        for (const origin of ["https://evil.example", "http://localhost:5173", "null"]) {
            const res = await fetch(`${base}/mcp`, initialize({ origin }));
            expect(res.status, origin).toBe(403);
            expect(res.headers.get("access-control-allow-origin")).toBeNull();
        }
        const preflight = await fetch(`${base}/mcp`, {
            method: "OPTIONS",
            headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
        });
        expect(preflight.status).toBe(403);
        // The same request with no Origin, as an agent sends it, is let in.
        expect((await fetch(`${base}/mcp`, initialize())).status).toBe(200);
    });

    it("is never served through a dev tunnel or a proxy, even with the device token", async () => {
        const dir = tmp();
        const rt = await runDev({
            port: 0,
            dir,
            configFile: join(dir, "notato.config.json"),
            version: "t",
            stdio: false,
            tunnel: true,
            tunnelDriver: { installed: () => false },
            log: () => {},
        });
        devs.push(rt);
        const base = `http://127.0.0.1:${rt.port}`;
        const token = (
            JSON.parse(await Bun.file(join(dir, "device.json")).text()) as { token: string }
        ).token;
        const tunnelled = await fetch(
            `${base}/mcp`,
            initialize({ "x-forwarded-for": "203.0.113.9", authorization: `Bearer ${token}` })
        );
        expect(tunnelled.status).toBe(403);
        expect(await tunnelled.text()).toContain("not through a dev tunnel");
        // The rest of the API still answers the tunnel with the device token, as phones need.
        const api = await fetch(`${base}/config`, {
            headers: { "x-forwarded-for": "203.0.113.9", authorization: `Bearer ${token}` },
        });
        expect(api.status).toBe(200);
    });

    it("refuses agents while the config file has it off, and says how to turn it on", async () => {
        const { base } = await dev({ config: { mcp: "off" } });
        const res = await fetch(`${base}/mcp`, initialize());
        expect(res.status).toBe(403);
        expect(await res.text()).toContain("npx notato config set mcp on");
    });

    it("drops open sessions and the agent's presence the moment the board turns it off, and lets them back in after", async () => {
        const { base, rt, configFile } = await dev();
        await post(base);
        const { call } = await httpClient(`${base}/mcp`);
        expect((await call("notato_list_open")).isError).toBeFalsy();
        expect(rt.local?.agents.state.connected).toBe(true);

        expect((await setMcp(base, "off")).status).toBe(200);
        expect(await Bun.file(configFile).json()).toEqual({ mcp: "off" });
        expect(rt.local?.agents.state.connected).toBe(false);
        const config = (await (await fetch(`${base}/config`)).json()) as {
            agent: { connected: boolean };
        };
        expect(config.agent.connected).toBe(false);
        await expect(call("notato_list_open")).rejects.toThrow();

        expect((await setMcp(base, null)).status).toBe(200);
        const again = await httpClient(`${base}/mcp`);
        expect((await again.call("notato_list_open")).isError).toBeFalsy();
    });

    it("answers a watch that was waiting when it was turned off, at once, with how to turn it back on", async () => {
        const { base } = await dev();
        const { call } = await httpClient(`${base}/mcp`);
        const started = Date.now();
        const watching = call("notato_watch", { timeoutSeconds: 30, windowMs: 0 });
        await new Promise((r) => setTimeout(r, 200));
        await setMcp(base, "off");
        const result = await watching;
        expect(Date.now() - started).toBeLessThan(5000);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("npx notato config set mcp on");
        // The next call is refused at the door.
        await expect(call("notato_list_open")).rejects.toThrow(/MCP is turned off/);
    });

    it("refuses the tools of an agent that started this notato dev over stdio", async () => {
        const { base, rt } = await dev();
        const a = await post(base);
        const call = await stdioClient(rt);
        expect(text(await call("notato_list_open"))).toContain(a.id);
        await setMcp(base, "off");
        const refused = await call("notato_list_open");
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("MCP is turned off");
        expect(text(refused)).not.toContain(a.id);
    });

    it("hands over nothing from a watch that was waiting when it was turned off", async () => {
        const { base, rt } = await dev();
        const call = await stdioClient(rt);
        const watching = call("notato_watch", { timeoutSeconds: 5, windowMs: 0 });
        await new Promise((r) => setTimeout(r, 100));
        await setMcp(base, "off");
        await post(base);
        const result = await watching;
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("MCP is turned off");
    });

    it("refuses an agent attached from another process, which stays attached", async () => {
        const first = await dev();
        const a = await post(first.base);
        const second = await dev({ port: first.rt.port });
        expect(second.rt.role).toBe("client");
        const call = await stdioClient(second.rt);
        expect(text(await call("notato_list_open"))).toContain(a.id);

        await setMcp(first.base, "off");
        const refused = await call("notato_list_open");
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("MCP is turned off");
        // Its health check still answers, so it does not think the server is gone and try to take over.
        await new Promise((r) => setTimeout(r, 3500));
        expect(second.rt.role).toBe("client");
        expect(first.rt.local?.agents.state.connected).toBe(false);
    });

    it("stays off with --no-mcp, whatever the board writes", async () => {
        const { base } = await dev({ mcp: false });
        const settings = (await (await fetch(`${base}/settings`)).json()) as {
            settings: Array<{ name: string; value: string; source: string }>;
        };
        expect(settings.settings.find((s) => s.name === "mcp")).toMatchObject({
            value: "off",
            source: "flag",
        });
        await setMcp(base, "on");
        const res = await fetch(`${base}/mcp`, initialize());
        expect(res.status).toBe(403);
        expect(await res.text()).toContain("--no-mcp");
    });
});

describe("MCP off on a shared server", () => {
    async function serve(config: object) {
        const dir = tmp();
        const configFile = join(dir, "notato.config.json");
        writeFileSync(configFile, JSON.stringify(config));
        const rt = await runServe({
            port: 0,
            dir,
            configFile,
            version: "t",
            adminPassword: "correct horse",
            log: () => {},
        });
        serves.push(rt);
        await rt.backend.createProject("web");
        const agent = (await rt.auth.issueToken("*", "agent")).token;
        const app = (await rt.auth.issueToken("web", "app")).token;
        return { base: `http://127.0.0.1:${rt.port}`, agent, app };
    }

    it("closes /mcp and refuses agent tokens, while apps keep sending", async () => {
        const s = await serve({ mcp: "off" });
        const mcp = await fetch(
            `${s.base}/mcp`,
            initialize({ authorization: `Bearer ${s.agent}` })
        );
        expect(mcp.status).toBe(403);
        const api = await fetch(`${s.base}/projects/web/annotations`, {
            headers: { authorization: `Bearer ${s.agent}` },
        });
        expect(api.status).toBe(403);
        expect(((await api.json()) as { error: string }).error).toContain("MCP is turned off");

        const a = annotationFixture({ projectId: "web" });
        const sent = await fetch(`${s.base}/projects/web/annotations`, {
            method: "POST",
            headers: { authorization: `Bearer ${s.app}` },
            body: multipart(a),
        });
        expect(sent.status).toBe(201);
    });

    it("lets the agent token in when it is on", async () => {
        const s = await serve({});
        const { call } = await httpClient(`${s.base}/mcp`, { authorization: `Bearer ${s.agent}` });
        expect((await call("notato_list_open")).isError).toBeFalsy();
    });
});
