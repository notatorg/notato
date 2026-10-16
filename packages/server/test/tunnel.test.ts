import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AGENT_HEADER,
    type CommandResult,
    createTunnelGate,
    type DevRuntime,
    fromOutside,
    type HostedProcess,
    loadDeviceAccess,
    outsideRefusal,
    runDev,
    saveDeviceAccess,
    startTunnel,
    tunnelUrlIn,
} from "../src/index.ts";
import { annotationFixture, makeApp, multipart } from "./helpers.ts";

const dirs: string[] = [];
const runtimes: DevRuntime[] = [];
const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "notato-tunnel-"));
    dirs.push(dir);
    return dir;
};
afterEach(async () => {
    for (const r of runtimes.splice(0)) await r.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tunnelHost = (port: number) => `abc123xy-${port}.uks1.devtunnels.ms`;
const TUNNEL_HOST = tunnelHost(4748);

// What `devtunnel host` printed for a real tunnel.
const hostOutput = (port: number) => [
    `Hosting port: ${port}`,
    `Connect via browser: https://${tunnelHost(port)}`,
    `Inspect network activity: https://abc123xy-${port}-inspect.uks1.devtunnels.ms`,
    "",
    "Ready to accept connections for tunnel: quiet-lake-3x1.uks1",
];
const HOST_OUTPUT = hostOutput(4748);

/** What a request through a dev tunnel looks like when the tunnel keeps the Host header. */
const tunnelled = (path: string, headers: Record<string, string> = {}) =>
    new Request(`http://${TUNNEL_HOST}${path}`, {
        headers: {
            host: TUNNEL_HOST,
            "x-forwarded-for": "85.255.17.194",
            "x-forwarded-proto": "https",
            ...headers,
        },
    });

/** A fake devtunnel CLI: records the commands, answers from a script, and hosts with canned output. */
function fakeDevtunnel(options: { loggedIn?: () => boolean; existing?: string[] } = {}) {
    const calls: string[][] = [];
    const tunnels = new Map<string, number[]>((options.existing ?? []).map((id) => [id, [4748]]));
    let hostedPort = 4748;
    let killed: (() => void) | undefined;
    const run = async (args: string[]): Promise<CommandResult> => {
        calls.push(args);
        const [command, sub] = args;
        if (command === "user") {
            return (options.loggedIn?.() ?? true)
                ? { code: 0, output: "Logged in as dom@example.com using Microsoft.\n" }
                : { code: 1, output: "Login token expired.\nLogin required.\n" };
        }
        if (command === "create") {
            tunnels.set("quiet-lake-3x1.uks1", []);
            return {
                code: 0,
                output: JSON.stringify({
                    tunnel: { tunnelId: "quiet-lake-3x1.uks1", hostRequestHeader: "unchanged" },
                }),
            };
        }
        if (command === "port" && sub === "create") {
            hostedPort = Number(args[4]);
            tunnels.get(args[2] ?? "")?.push(hostedPort);
            return {
                code: 0,
                output: JSON.stringify({
                    port: { tunnelId: args[2], portNumber: Number(args[4]) },
                }),
            };
        }
        if (command === "show") {
            const ports = tunnels.get(args[1] ?? "");
            return ports
                ? {
                      code: 0,
                      output: JSON.stringify({
                          tunnel: {
                              tunnelId: args[1],
                              ports: ports.map((portNumber) => ({ portNumber })),
                          },
                      }),
                  }
                : { code: 1, output: "Tunnel not found." };
        }
        return { code: 1, output: `unexpected: ${args.join(" ")}` };
    };
    const host = (args: string[]): HostedProcess => {
        calls.push(args);
        const exited = new Promise<number>((resolve) => {
            killed = () => resolve(0);
        });
        async function* lines() {
            for (const line of hostOutput(hostedPort)) yield line;
        }
        return { lines: lines(), exited, kill: () => killed?.() };
    };
    return { calls, run, host, installed: () => true, retryMs: 5 };
}

describe("requests from outside", () => {
    it("are what came through a tunnel or a proxy, not what came from this machine", () => {
        expect(fromOutside(new Request("http://127.0.0.1:4748/status"))).toBe(false);
        expect(fromOutside(new Request("http://localhost:4748/status"))).toBe(false);
        expect(fromOutside(tunnelled("/status"))).toBe(true);
        // A tunnel that rewrites Host to localhost still says where the request came from.
        expect(
            fromOutside(
                new Request("http://localhost:4748/", { headers: { "x-forwarded-for": "1.2.3.4" } })
            )
        ).toBe(true);
    });

    it("need the device token, while local ones go through as before", async () => {
        const gate = createTunnelGate("notato_device_the-right-token-0123456789");
        expect(await gate.authorize(new Request("http://localhost:4748/status"))).toBeNull();
        expect((await gate.authorize(tunnelled("/status")))?.status).toBe(401);
        expect(
            (
                await gate.authorize(
                    tunnelled("/status", { authorization: "Bearer notato_device_wrong" })
                )
            )?.status
        ).toBe(401);
        expect(
            await gate.authorize(
                tunnelled("/status", {
                    authorization: "Bearer notato_device_the-right-token-0123456789",
                })
            )
        ).toBeNull();
    });

    it("may carry the device token in the query string on a GET, as an event stream sends it", async () => {
        const gate = createTunnelGate("notato_device_the-right-token-0123456789");
        const outside = (path: string, method = "GET") =>
            new Request(`https://${TUNNEL_HOST}${path}`, {
                method,
                headers: { host: TUNNEL_HOST },
            });
        expect(
            await gate.authorize(
                outside("/projects/p/events?token=notato_device_the-right-token-0123456789")
            )
        ).toBeNull();
        expect((await gate.authorize(outside("/projects/p/events?token=nope")))?.status).toBe(401);
        // Never for a write: a token in a URL ends up in logs.
        expect(
            (
                await gate.authorize(
                    outside(
                        "/projects/p/annotations?token=notato_device_the-right-token-0123456789",
                        "POST"
                    )
                )
            )?.status
        ).toBe(401);
    });

    it("cannot make a page believe an agent is there when the gate turns them away", async () => {
        const gate = createTunnelGate("notato_device_the-right-token-0123456789");
        const ctx = makeApp({ authorize: gate.authorize, allowedHosts: "any" });
        try {
            const res = await ctx.call("/projects", {
                headers: { host: TUNNEL_HOST, [AGENT_HEADER]: "spoofed" },
            });
            expect(res.status).toBe(401);
            expect(ctx.backend.agents.state.connected).toBe(false);
        } finally {
            ctx.cleanup();
        }
    });
});

describe("the tunnel URL", () => {
    it("is the browser URL devtunnel prints for the port, not its inspect URL", () => {
        expect(HOST_OUTPUT.map((line) => tunnelUrlIn(line, 4748)).filter(Boolean)).toEqual([
            `https://${TUNNEL_HOST}`,
        ]);
        expect(tunnelUrlIn(`Connect via browser: https://${TUNNEL_HOST}`, 4747)).toBeNull();
    });
});

describe("device access", () => {
    it("keeps its token from run to run, and follows the port", () => {
        const dir = tmp();
        const first = loadDeviceAccess(dir, 4748);
        expect(first.token).toMatch(/^notato_device_[\w-]{40,}$/);
        saveDeviceAccess(dir, {
            ...first,
            server: `https://${TUNNEL_HOST}`,
            tunnelId: "quiet-lake-3x1.uks1",
        });
        const again = loadDeviceAccess(dir, 4749);
        expect(again.token).toBe(first.token);
        expect(again).toMatchObject({
            server: `https://${TUNNEL_HOST}`,
            local: "http://localhost:4749",
            tunnelId: "quiet-lake-3x1.uks1",
        });
    });
});

describe("startTunnel", () => {
    it("waits for a sign-in, then makes a tunnel with anonymous access that keeps the Host header, and hosts it", async () => {
        const dir = tmp();
        let signedIn = false;
        const cli = fakeDevtunnel({ loggedIn: () => signedIn });
        const logs: string[] = [];
        const access = loadDeviceAccess(dir, 4748);
        const tunnel = startTunnel({ dir, port: 4748, access, log: (m) => logs.push(m), ...cli });
        await Bun.sleep(20);
        expect(logs.some((m) => m.includes("devtunnel user login"))).toBe(true);
        expect(cli.calls.some((c) => c[0] === "create")).toBe(false);

        signedIn = true;
        expect(await tunnel.ready).toBe(`https://${TUNNEL_HOST}`);
        const create = cli.calls.find((c) => c[0] === "create") ?? [];
        expect(create).toContain("--allow-anonymous");
        expect(create.join(" ")).toContain("--host-header unchanged");
        expect(cli.calls.find((c) => c[0] === "port")?.join(" ")).toContain(
            "-p 4748 --protocol http --host-header unchanged"
        );
        expect(cli.calls.at(-1)).toEqual(["host", "quiet-lake-3x1.uks1"]);

        const saved = JSON.parse(readFileSync(join(dir, "device.json"), "utf8"));
        expect(saved).toMatchObject({
            server: `https://${TUNNEL_HOST}`,
            tunnelId: "quiet-lake-3x1.uks1",
            local: "http://localhost:4748",
        });
        expect(saved.token).toBe(access.token);
        tunnel.stop();
    });

    it("hosts the same tunnel again next time, so the URL stays the same", async () => {
        const dir = tmp();
        saveDeviceAccess(dir, { ...loadDeviceAccess(dir, 4748), tunnelId: "quiet-lake-3x1.uks1" });
        const cli = fakeDevtunnel({ existing: ["quiet-lake-3x1.uks1"] });
        const tunnel = startTunnel({
            dir,
            port: 4748,
            access: loadDeviceAccess(dir, 4748),
            log: () => {},
            ...cli,
        });
        await tunnel.ready;
        expect(cli.calls.some((c) => c[0] === "create")).toBe(false);
        expect(cli.calls.at(-1)).toEqual(["host", "quiet-lake-3x1.uks1"]);
        tunnel.stop();
    });

    it("says what to install when there is no devtunnel CLI, and leaves the server alone", async () => {
        const logs: string[] = [];
        const tunnel = startTunnel({
            dir: tmp(),
            port: 4748,
            access: loadDeviceAccess(tmp(), 4748),
            log: (m) => logs.push(m),
            installed: () => false,
        });
        expect(await tunnel.ready).toBeNull();
        expect(logs.join("\n")).toContain("brew install --cask devtunnel");
    });
});

describe("notato dev --tunnel", () => {
    it("answers through the tunnel only with the device token, and locally as before", async () => {
        const dir = tmp();
        const dev = await runDev({
            port: 0,
            dir,
            version: "test",
            stdio: false,
            log: () => {},
            tunnel: true,
            tunnelDriver: fakeDevtunnel(),
        });
        runtimes.push(dev);
        expect(await dev.tunnel?.ready).toBe(`https://${tunnelHost(dev.port)}`);
        const access = JSON.parse(readFileSync(join(dir, "device.json"), "utf8"));
        expect(access.local).toBe(`http://localhost:${dev.port}`);

        const through = (headers: Record<string, string> = {}) =>
            fetch(`http://127.0.0.1:${dev.port}/status`, {
                headers: {
                    host: tunnelHost(dev.port),
                    "x-forwarded-for": "85.255.17.194",
                    ...headers,
                },
            });
        expect((await through()).status).toBe(401);
        expect((await through({ authorization: "Bearer notato_device_nope" })).status).toBe(401);
        expect((await through({ authorization: `Bearer ${access.token}` })).status).toBe(200);
        expect((await fetch(`http://127.0.0.1:${dev.port}/status`)).status).toBe(200);
        // Any other name is still refused, token or not.
        const other = await fetch(`http://127.0.0.1:${dev.port}/status`, {
            headers: { host: "evil.example.com", authorization: `Bearer ${access.token}` },
        });
        expect(other.status).toBe(403);
    });

    it("does nothing about tunnels without --tunnel", async () => {
        const dir = tmp();
        const dev = await runDev({ port: 0, dir, version: "test", stdio: false, log: () => {} });
        runtimes.push(dev);
        expect(dev.tunnel).toBeUndefined();
        expect(existsSync(join(dir, "device.json"))).toBe(false);
    });
});

describe("what the device token reaches", () => {
    /** Whether a request from outside is refused, as `createApp` asks (a POST may say it means PATCH). */
    const refused = (method: string, path: string, headers: Record<string, string> = {}) =>
        outsideRefusal(tunnelled(path, headers), method, path)?.status ?? null;

    it("is what an app asks for: its notes, screenshots, events, bundles and relay answers", () => {
        for (const [method, path] of [
            ["GET", "/health"],
            ["GET", "/config"],
            ["GET", "/status"],
            ["GET", "/inject.js"],
            ["GET", "/projects/shop/annotations"],
            ["POST", "/projects/shop/annotations"],
            ["GET", "/projects/shop/events"],
            ["POST", "/projects/shop/bundles"],
            ["POST", "/projects/shop/connection"],
            ["GET", "/annotations/a1"],
            ["PATCH", "/annotations/a1"],
            ["DELETE", "/annotations/a1"],
            ["POST", "/annotations/a1/replies"],
            ["POST", "/annotations/a1/variants/choose"],
            ["GET", "/annotations/a1/screenshot"],
            ["GET", `/assets/${"a".repeat(64)}`],
            ["POST", "/relay/r1/result"],
        ] as const)
            expect(refused(method, path), `${method} ${path}`).toBeNull();
    });

    it("is never the board's part or an agent's", () => {
        for (const [method, path] of [
            ["GET", "/settings"],
            ["PUT", "/settings/screenshots"],
            ["PUT", "/settings/mcp"],
            ["POST", "/settings/webhooks"],
            ["POST", "/settings/webhooks/test"],
            ["POST", "/settings/webhooks/preview"],
            ["DELETE", "/settings/webhooks/0"],
            ["GET", "/webhooks"],
            ["POST", "/webhooks/test"],
            ["GET", "/projects"],
            ["POST", "/projects"],
            ["PATCH", "/projects/shop"],
            ["DELETE", "/projects/shop"],
            ["GET", "/projects/shop/export"],
            ["GET", "/tokens"],
            ["POST", "/tokens"],
            ["DELETE", "/tokens/t1"],
            ["POST", "/admin/tokens"],
            ["GET", "/annotations"],
            ["GET", "/annotations/wait"],
            ["POST", "/annotations/handed"],
            ["PUT", "/annotations/a1/variants"],
            ["POST", "/annotations/a1/links"],
            ["POST", "/relay/annotate"],
            ["POST", "/bundles"],
            ["GET", "/"],
        ] as const)
            expect(refused(method, path), `${method} ${path}`).toBe(403);
        // An agent connects on this machine: an app's route with an agent's header is refused too.
        expect(refused("GET", "/config", { [AGENT_HEADER]: "spoofed" })).toBe(403);
    });

    it("is everything from this machine, as before", () => {
        const local = new Request("http://localhost:4748/settings", {
            headers: { host: "localhost:4748" },
        });
        expect(outsideRefusal(local, "PUT", "/settings/mcp")).toBeNull();
    });

    it("cannot change the settings, test a webhook or touch projects through the tunnel, even with the token", async () => {
        const dir = tmp();
        const hits: string[] = [];
        const target = Bun.serve({
            port: 0,
            fetch(req) {
                hits.push(req.url);
                return new Response("internal");
            },
        });
        try {
            const configFile = join(dir, "notato.config.json");
            writeFileSync(configFile, "{}\n");
            const dev = await runDev({
                port: 0,
                dir: join(dir, "data"),
                version: "test",
                stdio: false,
                log: () => {},
                configFile,
                tunnel: true,
                tunnelDriver: fakeDevtunnel(),
            });
            runtimes.push(dev);
            await dev.tunnel?.ready;
            const { token } = JSON.parse(readFileSync(join(dir, "data", "device.json"), "utf8"));
            const base = `http://127.0.0.1:${dev.port}`;
            /** Through the tunnel with the device token: what an app on a phone sends. */
            const through = (path: string, init: RequestInit = {}) =>
                fetch(`${base}${path}`, {
                    ...init,
                    headers: {
                        host: tunnelHost(dev.port),
                        "x-forwarded-for": "85.255.17.194",
                        authorization: `Bearer ${token}`,
                        ...(init.headers as Record<string, string> | undefined),
                    },
                });
            const sendJson = (method: string, body: unknown) => ({
                method,
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });

            const note = annotationFixture({ projectId: "shop" });
            const posted = await through("/projects/shop/annotations", {
                method: "POST",
                body: multipart(note),
            });
            expect(posted.status).toBe(201);
            expect((await through("/config?project=shop")).status).toBe(200);
            // Android cannot send PATCH, so it says it means one: still what an app does.
            const patched = await through(`/annotations/${note.id}`, {
                method: "POST",
                headers: { "x-http-method-override": "PATCH", "content-type": "application/json" },
                body: JSON.stringify({ status: "acknowledged" }),
            });
            expect(patched.status).toBe(200);

            const webhookTest = await through(
                "/settings/webhooks/test",
                sendJson("POST", {
                    hook: { url: `http://127.0.0.1:${target.port}/admin`, format: "json" },
                })
            );
            expect(webhookTest.status).toBe(403);
            expect(((await webhookTest.json()) as { error: string }).error).toContain("board");
            expect(hits).toEqual([]);
            expect((await through("/settings")).status).toBe(403);
            expect((await through("/settings/mcp", sendJson("PUT", { value: "on" }))).status).toBe(
                403
            );
            expect(
                (
                    await through(
                        "/settings/webhooks",
                        sendJson("POST", {
                            hook: { url: "https://collector.example/x", format: "json" },
                        })
                    )
                ).status
            ).toBe(403);
            expect(readFileSync(configFile, "utf8")).toBe("{}\n");
            expect((await through("/projects", sendJson("POST", { id: "squat" }))).status).toBe(
                403
            );
            expect((await through("/projects/shop", { method: "DELETE" })).status).toBe(403);
            expect(await dev.local?.store.getProject("shop")).toBeTruthy();

            // The same requests from this machine are the person at it.
            expect((await fetch(`${base}/settings`)).status).toBe(200);
        } finally {
            target.stop(true);
        }
    });

    it("keeps a proxy's requests to an app's too, without --tunnel", async () => {
        const ctx = makeApp();
        try {
            const proxied = { "x-forwarded-for": "203.0.113.9" };
            expect((await ctx.call("/settings", { headers: proxied })).status).toBe(403);
            expect((await ctx.call("/config", { headers: proxied })).status).toBe(200);
            // How the server is set up is for the person at this machine, not for an app through a proxy.
            const status = (await (await ctx.call("/status", { headers: proxied })).json()) as {
                config: Record<string, unknown>;
            };
            expect(status.config).not.toHaveProperty("file");
            expect((await ctx.call("/settings")).status).toBe(200);
        } finally {
            ctx.cleanup();
        }
    });
});
