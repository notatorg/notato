import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLoopbackName } from "./cors.ts";

/**
 * How a phone reaches `notato dev`. A phone cannot reach the development machine's loopback, so `notato dev --tunnel`
 * puts the server behind a Microsoft dev tunnel (a public https URL that forwards to it) and requires a device token
 * from anything that comes through it. This is written to `<data dir>/device.json`, where an app's debug build picks it
 * up (the .NET MAUI package does this on its own).
 */
export interface DeviceAccess {
    /** The tunnel's public https URL, once it has been hosted. */
    server?: string;
    /** What a device sends as `Authorization: Bearer …`. */
    token: string;
    /** This server as the development machine itself sees it, for simulators. */
    local: string;
    /** The dev tunnel, reused so the URL stays the same between runs. */
    tunnelId?: string;
}

export const DEVICE_FILE = "device.json";

const newToken = () => `notato_device_${randomBytes(32).toString("base64url")}`;

/** The device access in `dir`, made (with a fresh token) when there is none. The token stays the same from run to run. */
export function loadDeviceAccess(dir: string, port: number): DeviceAccess {
    const file = join(dir, DEVICE_FILE);
    let saved: Partial<DeviceAccess> = {};
    if (existsSync(file)) {
        try {
            saved = JSON.parse(readFileSync(file, "utf8")) as Partial<DeviceAccess>;
        } catch {
            // a damaged file is replaced
        }
    }
    return {
        server: typeof saved.server === "string" ? saved.server : undefined,
        token:
            typeof saved.token === "string" && saved.token.length >= 20 ? saved.token : newToken(),
        local: `http://localhost:${port}`,
        tunnelId: typeof saved.tunnelId === "string" ? saved.tunnelId : undefined,
    };
}

export function saveDeviceAccess(dir: string, access: DeviceAccess): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DEVICE_FILE), `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Whether a request came from outside this machine: through a tunnel or a proxy. A dev tunnel forwards from loopback,
 * so the address says nothing; the Host it was sent to and the `X-Forwarded-*` headers a proxy adds do.
 */
export function fromOutside(req: Request): boolean {
    const host = (req.headers.get("host") ?? new URL(req.url).host).replace(/:\d+$/, "");
    return (
        !isLoopbackName(host) ||
        req.headers.has("x-forwarded-for") ||
        req.headers.has("x-forwarded-host")
    );
}

function sameToken(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export interface TunnelGate {
    /** The tunnel's host name once known, for the server's Host check (loopback names are always allowed). */
    hosts: string[];
    /** Lets local requests through as before, and requires the device token from anything that came from outside. */
    authorize(req: Request): Promise<Response | null>;
}

export function createTunnelGate(token: string): TunnelGate {
    return {
        hosts: [],
        async authorize(req) {
            if (!fromOutside(req)) return null;
            // The same places a token is read from as on a server with logins: an event stream (EventSource) cannot set
            // headers, so a GET may carry it in the query string.
            const header = req.headers.get("authorization") ?? "";
            const given =
                /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ??
                req.headers.get("x-notato-token")?.trim() ??
                (req.method === "GET" ? new URL(req.url).searchParams.get("token") : null) ??
                "";
            if (given && sameToken(given, token)) return null;
            return Response.json(
                {
                    error: "this server is reached through a dev tunnel: send its device token (.notato/device.json)",
                },
                { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
            );
        },
    };
}

/** The public URL in a line of `devtunnel host` output ("Connect via browser: https://…"), not the inspect one. */
export function tunnelUrlIn(line: string, port: number): string | null {
    for (const match of line.matchAll(/https:\/\/[^\s,]+/g)) {
        const url = match[0].replace(/\/+$/, "");
        if (url.includes("-inspect")) continue;
        if (new URL(url).hostname.includes(`-${port}.`)) return url;
    }
    return null;
}

export interface CommandResult {
    code: number;
    output: string;
}

export interface HostedProcess {
    /** Each line it writes, stdout and stderr together. */
    lines: AsyncIterable<string>;
    exited: Promise<number>;
    kill(): void;
}

export interface TunnelOptions {
    dir: string;
    port: number;
    access: DeviceAccess;
    log: (message: string) => void;
    /** Called with the public URL each time the tunnel is hosted. */
    onUrl?: (url: string) => void;
    /** Runs a `devtunnel` command to completion. Replaced in tests. */
    run?: (args: string[]) => Promise<CommandResult>;
    /** Starts `devtunnel host`, which runs until stopped. Replaced in tests. */
    host?: (args: string[]) => HostedProcess;
    /** Whether the devtunnel CLI is installed. Replaced in tests. */
    installed?: () => boolean;
    /** How long to wait before trying again (sign-in, a dropped host). Shortened in tests. */
    retryMs?: number;
}

export interface Tunnel {
    /** Resolves when the tunnel first has a URL, or with null if it gave up (no devtunnel CLI). */
    ready: Promise<string | null>;
    stop(): void;
}

async function defaultRun(args: string[]): Promise<CommandResult> {
    const proc = Bun.spawn(["devtunnel", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
    });
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { code, output: `${out}${err}` };
}

function defaultHost(args: string[]): HostedProcess {
    const proc = Bun.spawn(["devtunnel", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
    });
    // Both streams are read as they come, so neither pipe fills up while the host runs.
    const queue: string[] = [];
    let open = 2;
    let notify: (() => void) | undefined;
    const pump = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of stream) {
            buffer += decoder.decode(chunk, { stream: true });
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
                queue.push(buffer.slice(0, newline).trimEnd());
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf("\n");
            }
            notify?.();
        }
        if (buffer.trim()) queue.push(buffer.trim());
        open--;
        notify?.();
    };
    void pump(proc.stdout);
    void pump(proc.stderr);
    async function* lines(): AsyncIterable<string> {
        while (true) {
            const next = queue.shift();
            if (next !== undefined) {
                yield next;
                continue;
            }
            if (open === 0) return;
            await new Promise<void>((resolve) => {
                notify = resolve;
                if (queue.length > 0 || open === 0) resolve();
            });
            notify = undefined;
        }
    }
    return { lines: lines(), exited: proc.exited, kill: () => proc.kill() };
}

const loggedIn = (output: string) =>
    /logged in as/i.test(output) && !/expired|required/i.test(output);

const parseJson = <T>(output: string): T | null => {
    const start = output.indexOf("{");
    if (start < 0) return null;
    try {
        return JSON.parse(output.slice(start)) as T;
    } catch {
        return null;
    }
};

interface ShownTunnel {
    tunnel?: { tunnelId?: string; ports?: Array<{ portNumber?: number }> | number[] };
}

/**
 * Creates (once) and hosts a dev tunnel to `port`: anonymous access, so a phone needs no Microsoft sign-in, which is why
 * the server behind it requires the device token; and the Host header kept, so the server can tell tunnelled requests
 * from local ones. Waits for `devtunnel user login` if the CLI is not signed in, and hosts again if the host process
 * stops. The tunnel's id is kept in device.json, so its URL survives restarts.
 */
export function startTunnel(options: TunnelOptions): Tunnel {
    const run = options.run ?? defaultRun;
    const host = options.host ?? defaultHost;
    const installed = options.installed ?? (() => Bun.which("devtunnel") !== null);
    const retryMs = options.retryMs ?? 30_000;
    const { access, port, log } = options;
    let stopped = false;
    let current: HostedProcess | undefined;
    let wake: (() => void) | undefined;
    const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            wake = () => {
                clearTimeout(timer);
                resolve();
            };
        });

    let settle: (url: string | null) => void = () => {};
    const ready = new Promise<string | null>((resolve) => {
        settle = resolve;
    });

    /** The tunnel to host: the saved one if it still exists and has the port, else a new one. */
    async function ensureTunnel(): Promise<string | null> {
        if (access.tunnelId) {
            const shown = await run(["show", access.tunnelId, "--json"]);
            const tunnel =
                shown.code === 0 ? parseJson<ShownTunnel>(shown.output)?.tunnel : undefined;
            if (tunnel) {
                const ports = (tunnel.ports ?? []).map((p) =>
                    typeof p === "number" ? p : p.portNumber
                );
                if (!ports.includes(port)) {
                    const added = await run([
                        "port",
                        "create",
                        access.tunnelId,
                        "-p",
                        String(port),
                        "--protocol",
                        "http",
                        "--host-header",
                        "unchanged",
                    ]);
                    if (added.code !== 0 && !/already exists|conflict/i.test(added.output)) {
                        log(`dev tunnel: could not add port ${port}: ${added.output.trim()}`);
                        return null;
                    }
                }
                return access.tunnelId;
            }
            log(
                `dev tunnel ${access.tunnelId} is gone (they expire after 30 days unused); making a new one, with a new URL`
            );
            access.tunnelId = undefined;
            access.server = undefined;
        }
        const created = await run([
            "create",
            "--allow-anonymous",
            "--host-header",
            "unchanged",
            "--description",
            `notato dev on port ${port}`,
            "--json",
        ]);
        const id =
            created.code === 0
                ? parseJson<ShownTunnel>(created.output)?.tunnel?.tunnelId
                : undefined;
        if (!id) {
            log(`dev tunnel: could not create one: ${created.output.trim()}`);
            return null;
        }
        const added = await run([
            "port",
            "create",
            id,
            "-p",
            String(port),
            "--protocol",
            "http",
            "--host-header",
            "unchanged",
        ]);
        if (added.code !== 0) {
            log(`dev tunnel: could not add port ${port} to ${id}: ${added.output.trim()}`);
            return null;
        }
        access.tunnelId = id;
        saveDeviceAccess(options.dir, access);
        return id;
    }

    async function loop() {
        if (!installed()) {
            log(
                "dev tunnel not started: install the devtunnel CLI (brew install --cask devtunnel), sign in once, then restart"
            );
            settle(null);
            return;
        }
        let waitingForLogin = false;
        while (!stopped) {
            const who = await run(["user", "show"]);
            if (!loggedIn(who.output)) {
                if (!waitingForLogin)
                    log(
                        "dev tunnel waiting: run `devtunnel user login` once (it opens a browser); it starts by itself after"
                    );
                waitingForLogin = true;
                await sleep(retryMs);
                continue;
            }
            waitingForLogin = false;
            const id = await ensureTunnel();
            if (stopped) break;
            if (!id) {
                await sleep(retryMs);
                continue;
            }
            const hosted = host(["host", id]);
            current = hosted;
            let announced = false;
            for await (const line of hosted.lines) {
                if (announced) continue;
                const url = tunnelUrlIn(line, port);
                if (!url) continue;
                announced = true;
                access.server = url;
                saveDeviceAccess(options.dir, access);
                options.onUrl?.(url);
                log(
                    `phones reach this server at ${url} (dev tunnel ${id}; device token in ${join(options.dir, DEVICE_FILE)})`
                );
                settle(url);
            }
            const code = await hosted.exited;
            current = undefined;
            if (stopped) break;
            log(`dev tunnel host stopped (exit ${code}); trying again`);
            await sleep(Math.min(retryMs, 10_000));
        }
    }

    void loop().catch((error) => {
        log(`dev tunnel failed: ${error instanceof Error ? error.message : String(error)}`);
        settle(null);
    });

    return {
        ready,
        stop() {
            stopped = true;
            current?.kill();
            wake?.();
            settle(null);
        },
    };
}
