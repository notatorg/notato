import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const MAIN = join(import.meta.dir, "../src/main.ts");

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

/** `notato start` on `port`, with a data folder of its own. Its stdout is collected as it comes. */
function spawnStart(port: number, ...args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "notato-start-"));
    const proc = Bun.spawn([process.execPath, MAIN, "start", "--port", String(port), ...args], {
        env: { ...process.env, NOTATO_DIR: dir, NOTATO_CONFIG: join(dir, "notato.config.json") },
        stdout: "pipe",
        stderr: "pipe",
    });
    let out = "";
    void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stdout) out += decoder.decode(chunk);
    })();
    cleanups.push(async () => {
        proc.kill();
        await proc.exited;
        rmSync(dir, { recursive: true, force: true });
    });
    return { proc, output: () => out };
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(50);
    }
}

const healthy = (port: number) =>
    fetch(`http://127.0.0.1:${port}/health`)
        .then((res) => res.ok)
        .catch(() => false);

const running = (proc: Subprocess) => proc.exitCode === null && !proc.killed;

describe("notato start", () => {
    it("says where the running one is and exits when the port is taken", async () => {
        const port = await freePort();
        const first = spawnStart(port);
        await until(() => healthy(port));

        const second = spawnStart(port);
        expect(await second.proc.exited).toBe(0);
        expect(second.output()).toContain(`Notato is already running on port ${port}.`);
        expect(second.output()).toContain("give it another --port");
        expect(running(first.proc)).toBe(true);
    });

    it("with --attach, stays up beside the running one and takes the port when it stops", async () => {
        const port = await freePort();
        const first = spawnStart(port);
        await until(() => healthy(port));

        const attached = spawnStart(port, "--attach");
        await until(() => attached.output().includes("stays attached"));
        expect(attached.output()).toContain(`Board  http://localhost:${port}`);
        await Bun.sleep(500);
        expect(running(attached.proc)).toBe(true);

        first.proc.kill();
        await first.proc.exited;
        // Its watch notices within a few seconds, and it serves on the same port.
        await until(() => healthy(port), 12_000);
        expect(running(attached.proc)).toBe(true);

        attached.proc.kill("SIGTERM");
        expect(await attached.proc.exited).toBe(0);
    }, 20_000);
});
