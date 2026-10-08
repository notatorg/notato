import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { annotationFixture, multipart } from "../../server/test/helpers.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");

type Content = Array<{ type: string; text?: string }>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
});

async function freePort(): Promise<number> {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port as number;
    probe.stop(true);
    return port;
}

/** Spawns `notato dev` exactly as Claude Code would, and connects an MCP client to its stdio. */
async function spawnDev(port: number, dir = mkdtempSync(join(tmpdir(), "notato-cli-"))) {
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MAIN, "dev"],
        env: {
            ...(process.env as Record<string, string>),
            NOTATO_PORT: String(port),
            NOTATO_DIR: dir,
        },
        stderr: "pipe",
    });
    const stderr: string[] = [];
    // Any MCP client: this one says it is Codex, and its replies are signed that way.
    const client = new Client({ name: "codex-mcp-client", version: "0" });
    await client.connect(transport);
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await client.close();
    };
    cleanups.push(close);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })) as unknown as {
            content: Content;
            isError?: boolean;
        };
    return { client, call, close, stderr };
}

const post = async (port: number, over: Parameters<typeof annotationFixture>[0] = {}) => {
    const a = annotationFixture(over);
    const res = await fetch(`http://127.0.0.1:${port}/projects/${a.projectId}/annotations`, {
        method: "POST",
        body: multipart(a),
    });
    expect(res.status).toBe(201);
    return a;
};

const waitFor = async (check: () => Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
};

describe("notato dev over real stdio", () => {
    it("serves MCP on stdin/stdout and HTTP on the loopback port, end to end", async () => {
        const port = await freePort();
        const dev = await spawnDev(port);
        expect((await dev.client.listTools()).tools.map((t) => t.name)).toContain("notato_watch");

        // A browser posts an annotation; Claude's watch call receives it with screenshots as image content.
        const watching = dev.call("notato_watch", { timeoutSeconds: 15, windowMs: 0 });
        await new Promise((r) => setTimeout(r, 200));
        const a = await post(port, { comment: "Pay button hidden behind the cookie banner" });
        const result = await watching;
        const text = result.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        expect(text).toContain("Pay button hidden behind the cookie banner");
        expect(result.content.filter((c) => c.type === "image")).toHaveLength(2);

        // Claude resolves it; the browser sees the change over SSE.
        const events = await fetch(`http://127.0.0.1:${port}/projects/${a.projectId}/events`);
        const reader = (events.body as ReadableStream<Uint8Array>).getReader();
        let buffered = "";
        await dev.call("notato_resolve", { id: a.id, summary: "Moved the banner" });
        const sawUpdate = await waitFor(async () => {
            const { value } = await reader.read();
            buffered += new TextDecoder().decode(value);
            return buffered.includes("event: updated") && buffered.includes('"status":"resolved"');
        });
        await reader.cancel();
        expect(sawUpdate).toBe(true);

        const stored = (await (
            await fetch(`http://127.0.0.1:${port}/annotations/${a.id}`)
        ).json()) as {
            annotation: {
                status: string;
                thread: Array<{ body: string; author: { name?: string } }>;
            };
        };
        expect(stored.annotation.status).toBe("resolved");
        expect(stored.annotation.thread[0]).toMatchObject({
            body: "Resolved: Moved the banner",
            author: { name: "Codex" },
        });
    });

    it("writes nothing but protocol to stdout, and logs to stderr", async () => {
        const dev = await spawnDev(await freePort());
        await dev.call("notato_list_open");
        // If anything non-JSON-RPC had reached stdout the client would have failed to parse it above.
        expect(
            await waitFor(async () =>
                dev.stderr.join("").includes("dev server on http://127.0.0.1:")
            )
        ).toBe(true);
    });

    it("a second process attaches, and survives the first one exiting", async () => {
        const port = await freePort();
        const first = await spawnDev(port);
        const second = await spawnDev(port);
        expect(
            await waitFor(async () =>
                second.stderr.join("").includes("attached to the notato server")
            )
        ).toBe(true);

        const a = await post(port, { comment: "seen through the second process" });
        const listed = await second.call("notato_list_open");
        expect(listed.content[0]?.text).toContain("seen through the second process");

        // The first Claude session ends. The second must keep working and take over the port.
        await first.close();
        expect(
            await waitFor(
                async () =>
                    (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.status ===
                    200,
                10_000
            )
        ).toBe(true);
        expect((await second.call("notato_list_open")).content[0]?.text).toBeDefined();
        const b = await post(port, { comment: "posted after the takeover" });
        expect(
            (await second.call("notato_get", { id: b.id, screenshots: "none" })).content[0]?.text
        ).toContain("posted after the takeover");
        expect(a.id).not.toBe(b.id);
    });

    it("exits cleanly with a clear message when the port belongs to something else", async () => {
        const other = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => new Response("hello"),
        });
        cleanups.push(() => other.stop(true));
        const proc = Bun.spawn([process.execPath, MAIN, "dev"], {
            env: {
                ...process.env,
                NOTATO_PORT: String(other.port),
                NOTATO_DIR: mkdtempSync(join(tmpdir(), "notato-cli-")),
            },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "pipe",
        });
        const code = await proc.exited;
        const err = await new Response(proc.stderr).text();
        expect(code).toBe(1);
        expect(err).toContain("not notato");
        expect(err).toContain("NOTATO_PORT");
        expect(await new Response(proc.stdout).text()).toBe("");
    });
});
