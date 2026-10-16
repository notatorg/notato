import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Status } from "@notato/schema";
import { runDev } from "../src/index.ts";
import { cleanupAfterEach, tempDir } from "./helpers.ts";
import { adminCookie, bearer, issue, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();

interface StatusBody {
    watchers?: number;
    agents: { connected: boolean };
    projects: Array<{ id: string }>;
    config: Record<string, unknown>;
}

/** A shared server whose settings file has a webhook, with an agent at work on `beta` only. */
async function server() {
    const dir = tempDir(defer, "notato-status-");
    const configFile = join(dir, "notato.config.json");
    writeFileSync(
        configFile,
        JSON.stringify({ webhooks: [{ url: "https://hooks.example.com/in", format: "json" }] })
    );
    const s = await startServe(defer, { configFile });
    const alpha = await issue(s, "alpha", "alpha app");
    await issue(s, "beta", "beta app");
    defer(s.rt.backend.agents.hold("agent_beta", "Codex", ["beta"]));
    return { s, alpha, configFile };
}

describe("/status and /config", () => {
    it("advertises list statuses that its annotations endpoint accepts", async () => {
        const { s, alpha } = await server();
        const config = await (
            await s.call("/config?project=alpha", { headers: bearer(alpha) })
        ).json();
        expect(config.annotationStatuses).toEqual(Status.options);
        const query = new URLSearchParams({ status: config.annotationStatuses.join(",") });
        expect(
            (await s.call(`/projects/alpha/annotations?${query}`, { headers: bearer(alpha) }))
                .status
        ).toBe(200);
    });

    it("show a project token only its own project's agent, and nothing of how the server is set up", async () => {
        const { s, alpha } = await server();
        const status = (await (
            await s.call("/status", { headers: bearer(alpha) })
        ).json()) as StatusBody;
        expect(status.projects.map((p) => p.id)).toEqual(["alpha"]);
        expect(status.agents.connected).toBe(false);
        expect(status).not.toHaveProperty("watchers");
        // The board and the SDKs still read what the settings are.
        expect(status.config).toEqual({ screenshots: "on", mcp: "on", webhooks: 0 });

        const config = (await (await s.call("/config", { headers: bearer(alpha) })).json()) as {
            agent: { connected: boolean };
            screenshots: boolean;
        };
        expect(config.agent.connected).toBe(false);
        expect(config.screenshots).toBe(true);
        expect((await s.call("/config?project=alpha", { headers: bearer(alpha) })).status).toBe(
            200
        );
        // Another project's agent is not this token's to know about.
        expect((await s.call("/config?project=beta", { headers: bearer(alpha) })).status).toBe(403);
    });

    it("show the admin every project's agent, and where the settings come from", async () => {
        const { s, configFile } = await server();
        const cookie = await adminCookie(s);
        const status = (await (
            await s.call("/status", { headers: { cookie } })
        ).json()) as StatusBody;
        expect(status.projects.map((p) => p.id).sort()).toEqual(["alpha", "beta"]);
        expect(status.agents.connected).toBe(true);
        expect(status.watchers).toBeNumber();
        expect(status.config).toMatchObject({ file: configFile, webhooks: 1, source: "default" });
        const config = (await (
            await s.call("/config?project=beta", { headers: { cookie } })
        ).json()) as { agent: { connected: boolean } };
        expect(config.agent.connected).toBe(true);
    });

    it("keep a broken settings file's path and error to the admin", async () => {
        const { s, alpha, configFile } = await server();
        writeFileSync(configFile, "{ not json");
        s.rt.backend.config.invalidate?.();
        const asToken = (await (
            await s.call("/status", { headers: bearer(alpha) })
        ).json()) as StatusBody;
        expect(asToken.config).not.toHaveProperty("error");
        expect(asToken.config).not.toHaveProperty("file");
        // What a broken file means for screenshots is still said: they are off.
        expect(asToken.config.screenshots).toBe("off");
        const cookie = await adminCookie(s);
        const asAdmin = (await (
            await s.call("/status", { headers: { cookie } })
        ).json()) as StatusBody;
        expect(asAdmin.config.error).toBeString();
        expect(asAdmin.config.file).toBe(configFile);
    });
});

describe("POST /webhooks/test", () => {
    it("is refused to a page, which could otherwise make the server send requests", async () => {
        const got: string[] = [];
        const receiver = Bun.serve({
            port: 0,
            fetch(req) {
                got.push(req.url);
                return new Response("ok");
            },
        });
        defer(() => receiver.stop(true));
        const dir = tempDir(defer, "notato-status-");
        const configFile = join(dir, "notato.config.json");
        writeFileSync(
            configFile,
            JSON.stringify({ webhooks: [{ url: `http://127.0.0.1:${receiver.port}/in` }] })
        );
        const dev = await runDev({
            port: 0,
            dir: join(dir, "data"),
            version: "t",
            stdio: false,
            log: () => {},
            configFile,
        });
        defer(() => dev.close());
        const test = (headers: Record<string, string> = {}) =>
            fetch(`http://127.0.0.1:${dev.port}/webhooks/test`, {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify({ index: 0 }),
            });
        // A page on this machine is trusted to read and write notes, not to send the server's requests.
        expect((await test({ origin: "http://localhost:5173" })).status).toBe(403);
        expect(got).toEqual([]);
        // The CLI sends no Origin.
        expect((await test()).status).toBe(200);
        expect(got).toHaveLength(1);
    });
});
