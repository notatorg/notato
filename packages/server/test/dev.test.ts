import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DevRuntime, RemoteBackend, runDev } from "../src/index.ts";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    ingest,
    makeApp,
    multipart,
} from "./helpers.ts";

const defer = cleanupAfterEach();

const dirs: string[] = [];
const runtimes: DevRuntime[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "notato-dev-"));
    dirs.push(dir);
    return dir;
};
afterEach(async () => {
    for (const r of runtimes.splice(0)) await r.close();
    for (const s of servers.splice(0)) s.stop(true);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const start = async (port: number) => {
    const runtime = await runDev({
        port,
        dir: tmp(),
        version: "test",
        stdio: false,
        log: () => {},
    });
    runtimes.push(runtime);
    return runtime;
};

async function post(port: number, over: Parameters<typeof annotationFixture>[0] = {}) {
    const a = annotationFixture(over);
    const res = await fetch(`http://127.0.0.1:${port}/projects/${a.projectId}/annotations`, {
        method: "POST",
        body: multipart(a),
    });
    expect(res.status).toBe(201);
    return a;
}

describe("runDev", () => {
    it("starts the HTTP server on loopback with its own database", async () => {
        const dev = await start(0);
        expect(dev.role).toBe("primary");
        const res = await fetch(`http://127.0.0.1:${dev.port}/status`);
        expect(((await res.json()) as { mode: string }).mode).toBe("dev");
    });

    it("attaches to a running server as an MCP-only client, and sees its annotations", async () => {
        const first = await start(0);
        const second = await start(first.port);
        expect(second.role).toBe("client");
        expect(second.local).toBeUndefined();

        const a = await post(first.port, { comment: "posted to the first process" });
        const seen = await second.backend.list({ status: "open" });
        expect(seen.map((s) => s.annotation.id)).toEqual([a.id]);

        // The whole MCP path works through the attached process, including images and status changes.
        const { call } = await connectMcp(second.mcp, defer, { client: "t" });
        const watched = await call("notato_watch", { timeoutSeconds: 5, windowMs: 0 });
        expect(watched.content.some((x) => x.type === "image")).toBe(true);
        await call("notato_resolve", { id: a.id, summary: "done" });
        expect((await first.local?.get(a.id))?.annotation.status).toBe("resolved");
    });

    it("a client blocked in notato_watch is woken by an annotation posted to the primary", async () => {
        const first = await start(0);
        const second = await start(first.port);
        const waiting = second.backend.waitForNew({ status: "open", afterSeq: 0 }, 10_000);
        await new Promise((r) => setTimeout(r, 100));
        await post(first.port);
        expect(await waiting).toBe(true);
    });

    it("takes over as the server when the one it attached to goes away", async () => {
        const first = await start(0);
        const port = first.port;
        const second = await start(port);
        expect(second.role).toBe("client");

        await first.close();
        // The next call notices, binds the freed port, and carries on.
        expect(await second.backend.list()).toEqual([]);
        expect(second.role).toBe("primary");
        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
        await post(port);
        expect(await second.backend.list()).toHaveLength(1);
    });

    it("refuses a port held by something that is not notato", async () => {
        const other = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => new Response("hello"),
        });
        servers.push(other);
        await expect(
            runDev({ port: other.port, dir: tmp(), version: "test", stdio: false, log: () => {} })
        ).rejects.toThrow(/not notato.*NOTATO_PORT/);
    });

    it("keeps data between restarts", async () => {
        const dir = tmp();
        const a = annotationFixture();
        const one = await runDev({ port: 0, dir, version: "t", stdio: false, log: () => {} });
        const res = await fetch(
            `http://127.0.0.1:${one.port}/projects/${a.projectId}/annotations`,
            {
                method: "POST",
                body: multipart(a),
            }
        );
        expect(res.status).toBe(201);
        await one.close();
        const two = await runDev({ port: 0, dir, version: "t", stdio: false, log: () => {} });
        runtimes.push(two);
        expect((await two.backend.list()).map((s) => s.annotation.id)).toEqual([a.id]);
        const asset = await fetch(
            `http://127.0.0.1:${two.port}/assets/${(await two.backend.list())[0]?.annotation.screenshots?.full.id}`
        );
        expect(asset.status).toBe(200);
    });
});

describe("an attached notato dev", () => {
    it("sends no empty note, which the HTTP API would refuse", async () => {
        const ctx = makeApp();
        try {
            const { annotation } = await ingest(ctx.call);
            const server = Bun.serve({
                port: 0,
                hostname: "127.0.0.1",
                fetch: (req) => ctx.app(req),
            });
            servers.push(server);
            const remote = new RemoteBackend(`http://127.0.0.1:${server.port}`);
            const updated = await remote.setStatus(annotation.id, "acknowledged", "");
            expect(updated?.annotation.status).toBe("acknowledged");
        } finally {
            ctx.cleanup();
        }
    });
});
