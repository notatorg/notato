import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigSource, json, signature } from "../src/index.ts";
import { maskUrl, type SettingsView, settingsRoute, type TestResult } from "../src/settings.ts";
import { makeApp } from "./helpers.ts";

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX";

let dir: string;
let file: string;
let env: Record<string, string | undefined>;
let ctx: ReturnType<typeof makeApp>;
let receiver: ReturnType<typeof Bun.serve> | undefined;
let received: Array<{ headers: Headers; body: string }>;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notato-settings-"));
    file = join(dir, "notato.config.json");
    env = {};
    ctx = makeApp({}, createConfigSource({ file, env }));
    received = [];
});
afterEach(() => {
    ctx.cleanup();
    receiver?.stop(true);
    receiver = undefined;
    rmSync(dir, { recursive: true, force: true });
    delete process.env.NOTATO_HOOK_SECRET;
    delete process.env.HOOK_SECRET;
});

/** A webhook endpoint on loopback that answers with `status` and records what it was sent. */
function listen(status = 200, reply = "ok") {
    receiver = Bun.serve({
        port: 0,
        async fetch(req) {
            received.push({ headers: req.headers, body: await req.text() });
            return new Response(reply, { status });
        },
    });
    return `http://127.0.0.1:${receiver.port}/hook/abc123`;
}

/** A request from the board: same origin as the server. */
const board = (path: string, method = "GET", body?: unknown) =>
    ctx.call(path, {
        method,
        headers: {
            origin: "http://localhost:4747",
            ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
const view = async (res: Response) => {
    const data = (await res.json()) as SettingsView & { error?: string };
    return data;
};

describe("reading the settings", () => {
    it("shows the file it would write, the defaults, and no webhooks", async () => {
        const res = await board("/settings");
        expect(res.status).toBe(200);
        const data = await view(res);
        expect(data.file).toBe(file);
        expect(data.exists).toBe(false);
        expect(data.error).toBeNull();
        expect(data.settings).toEqual([
            expect.objectContaining({ name: "screenshots", value: "on", source: "default" }),
            expect.objectContaining({ name: "mcp", value: "on", source: "default" }),
        ]);
        expect(data.webhooks).toEqual([]);
        expect(data.formats).toEqual(["json", "slack", "discord", "teams"]);
    });

    it("never shows a webhook's URL or a secret kept in the file", async () => {
        writeFileSync(
            file,
            JSON.stringify({
                webhooks: [
                    { url: SLACK, format: "slack", name: "Team" },
                    { url: "https://example.com/hook?key=abc", secret: "s3cret-in-file" },
                    { url: "https://example.com/signed", secret: "env:NOTATO_HOOK_SECRET" },
                ],
            })
        );
        // Secrets are read where the server runs, like the webhooks that send with them.
        process.env.NOTATO_HOOK_SECRET = "from-env";
        const res = await board("/settings");
        const text = await res.text();
        expect(text).not.toContain("XXXXSECRETXXXX");
        expect(text).not.toContain("key=abc");
        expect(text).not.toContain("s3cret-in-file");
        expect(text).not.toContain("from-env");
        const data = JSON.parse(text) as SettingsView;
        expect(data.webhooks.map((w) => [w.url, w.secret])).toEqual([
            ["https://hooks.slack.com/services/••••", { kind: "none" }],
            ["https://example.com/hook/••••", { kind: "file" }],
            ["https://example.com/signed", { kind: "env", name: "NOTATO_HOOK_SECRET", set: true }],
        ]);
    });

    it("says what is wrong with a broken file, and refuses to change it", async () => {
        writeFileSync(file, "{ nope");
        const data = await view(await board("/settings"));
        expect(data.error).toContain("not valid JSON");
        const res = await board("/settings/screenshots", "PUT", { value: "off" });
        expect(res.status).toBe(409);
        expect(readFileSync(file, "utf8")).toBe("{ nope");
    });
});

describe("who may use it", () => {
    it("refuses a request from another origin, such as an app's page", async () => {
        const res = await ctx.call("/settings", { headers: { origin: "http://localhost:5173" } });
        expect(res.status).toBe(403);
        const write = await ctx.call("/settings/screenshots", {
            method: "PUT",
            headers: { origin: "http://localhost:5173", "content-type": "application/json" },
            body: JSON.stringify({ value: "off" }),
        });
        expect(write.status).toBe(403);
        expect(createConfigSource({ file })().screenshots).toBe(true);
    });

    it("lets a tool with no Origin in, like curl or the CLI", async () => {
        expect((await ctx.call("/settings")).status).toBe(200);
    });

    it("refuses anyone but an admin", async () => {
        const req = new Request("http://localhost:4747/settings", {
            headers: { host: "localhost:4747" },
        });
        await expect(
            settingsRoute(
                req,
                "/settings",
                { kind: "token", tokenId: "t", projectId: "*" },
                { backend: ctx.backend, json }
            )
        ).rejects.toThrow("only an admin");
    });
});

describe("changing a setting", () => {
    it("writes the file, applies at once, and can go back to the default", async () => {
        const data = await view(await board("/settings/screenshots", "PUT", { value: "off" }));
        expect(data.settings[0]).toMatchObject({ value: "off", source: "file" });
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ screenshots: "off" });
        expect(ctx.backend.config().screenshots).toBe(false);

        const back = await view(await board("/settings/screenshots", "PUT", { value: null }));
        expect(back.settings[0]).toMatchObject({ value: "on", source: "default" });
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
    });

    it("says when the environment overrides the file", async () => {
        env.NOTATO_SCREENSHOTS = "off";
        const data = await view(await board("/settings/screenshots", "PUT", { value: "on" }));
        expect(data.settings[0]).toMatchObject({ value: "off", source: "env" });
    });

    it("keeps what else is in the file", async () => {
        writeFileSync(file, JSON.stringify({ webhooks: [{ url: SLACK, format: "slack" }] }));
        await board("/settings/screenshots", "PUT", { value: "off" });
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
            webhooks: [{ url: SLACK, format: "slack" }],
            screenshots: "off",
        });
    });
});

describe("webhooks", () => {
    it("adds one, refusing a second with the same URL", async () => {
        const data = await view(
            await board("/settings/webhooks", "POST", {
                hook: {
                    name: "Team",
                    url: SLACK,
                    format: "slack",
                    events: ["annotation.created"],
                    project: "",
                },
            })
        );
        expect(data.webhooks).toEqual([
            expect.objectContaining({
                name: "Team",
                format: "slack",
                events: ["annotation.created"],
                project: null,
            }),
        ]);
        expect(ctx.backend.config().webhooks).toEqual([
            { url: SLACK, format: "slack", name: "Team", events: ["annotation.created"] },
        ]);
        const again = await board("/settings/webhooks", "POST", {
            hook: { url: SLACK, format: "slack" },
        });
        expect(again.status).toBe(409);
    });

    it("explains a bad webhook in the words of the file's rules", async () => {
        const res = await board("/settings/webhooks", "POST", {
            hook: { url: "ftp://x", format: "json" },
        });
        expect(res.status).toBe(400);
        expect((await view(res)).error).toBe("url must be http or https");
        const events = await board("/settings/webhooks", "POST", {
            hook: { url: "https://x.test/h", format: "json", events: ["annotation.exploded"] },
        });
        expect((await view(events)).error).toContain("unknown event");
    });

    it("edits one, keeping the URL and secret it was not given, and refuses an edit to a stale copy", async () => {
        writeFileSync(
            file,
            JSON.stringify({
                webhooks: [{ url: "https://example.com/h", secret: "env:HOOK", name: "Mine" }],
            })
        );
        const before = (await view(await board("/settings"))).webhooks[0];
        if (!before) throw new Error("no webhook");
        const edited = await view(
            await board("/settings/webhooks/0", "PUT", {
                fingerprint: before.fingerprint,
                hook: { name: "Renamed", format: "json", events: ["annotation.resolved"] },
            })
        );
        expect(ctx.backend.config().webhooks).toEqual([
            {
                url: "https://example.com/h",
                format: "json",
                name: "Renamed",
                secret: "env:HOOK",
                events: ["annotation.resolved"],
            },
        ]);
        // The copy the page had is now out of date.
        const stale = await board("/settings/webhooks/0", "PUT", {
            fingerprint: before.fingerprint,
            hook: { format: "json" },
        });
        expect(stale.status).toBe(409);

        const now = edited.webhooks[0];
        if (!now) throw new Error("no webhook");
        await board("/settings/webhooks/0", "PUT", {
            fingerprint: now.fingerprint,
            hook: { format: "json", secret: null },
        });
        expect(ctx.backend.config().webhooks[0]?.secret).toBeUndefined();
    });

    it("deletes one only when the page saw the same one", async () => {
        writeFileSync(
            file,
            JSON.stringify({ webhooks: [{ url: "https://a.test/1" }, { url: "https://b.test/2" }] })
        );
        const [first] = (await view(await board("/settings"))).webhooks;
        expect((await board("/settings/webhooks/1?fingerprint=nope", "DELETE")).status).toBe(409);
        const data = await view(
            await board(`/settings/webhooks/0?fingerprint=${first?.fingerprint}`, "DELETE")
        );
        expect(data.webhooks.map((w) => w.host)).toEqual(["b.test"]);
        // The last one going takes the key with it.
        const [last] = data.webhooks;
        await board(`/settings/webhooks/0?fingerprint=${last?.fingerprint}`, "DELETE");
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
    });
});

describe("testing a webhook", () => {
    it("sends a signed sample from a form that has not been saved, and says what came back", async () => {
        const url = listen(200, "thanks");
        const res = await board("/settings/webhooks/test", "POST", {
            hook: { url, format: "json", secret: "shh" },
        });
        const result = (await res.json()) as TestResult;
        expect(result).toMatchObject({ ok: true, status: 200, response: "thanks" });
        expect(result.ms).toBeGreaterThanOrEqual(0);
        const [got] = received;
        expect(got?.headers.get("x-notato-event")).toBe("annotation.created");
        expect(got?.headers.get("x-notato-signature")).toBe(signature("shh", got?.body ?? ""));
        expect(JSON.parse(got?.body ?? "{}").annotation.comment).toContain("test event");
        // Testing writes nothing.
        expect(() => readFileSync(file)).toThrow();
    });

    it("tests a saved webhook with the URL and secret only the server knows", async () => {
        const url = listen(200);
        writeFileSync(file, JSON.stringify({ webhooks: [{ url, secret: "env:HOOK_SECRET" }] }));
        process.env.HOOK_SECRET = "from-env";
        const [hook] = (await view(await board("/settings"))).webhooks;
        const result = (await (
            await board("/settings/webhooks/test", "POST", {
                existing: { index: 0, fingerprint: hook?.fingerprint },
                hook: { format: "json" },
            })
        ).json()) as TestResult;
        expect(result.ok).toBe(true);
        expect(received[0]?.headers.get("x-notato-signature")).toBe(
            signature("from-env", received[0]?.body ?? "")
        );
    });

    it("explains a refusal, with what the other end said", async () => {
        const url = listen(404, "no_service");
        const result = (await (
            await board("/settings/webhooks/test", "POST", { hook: { url, format: "slack" } })
        ).json()) as TestResult;
        expect(result).toMatchObject({ ok: false, status: 404, response: "no_service" });
        expect(result.detail).toContain("404");
        expect(JSON.parse(received[0]?.body ?? "{}").text).toContain("Notato");
    });

    it("explains an endpoint that is not there, and a secret that is not set", async () => {
        const down = (await (
            await board("/settings/webhooks/test", "POST", {
                hook: { url: "http://127.0.0.1:9/x", format: "json" },
            })
        ).json()) as TestResult;
        expect(down.ok).toBe(false);
        expect(down.status).toBeUndefined();
        expect(down.detail).toContain("Could not reach it");

        const unsigned = (await (
            await board("/settings/webhooks/test", "POST", {
                hook: {
                    url: "https://example.com/h",
                    format: "json",
                    secret: "env:NOT_SET_ANYWHERE",
                },
            })
        ).json()) as TestResult;
        expect(unsigned).toMatchObject({ ok: false });
        expect(unsigned.detail).toContain("NOT_SET_ANYWHERE is not set");
    });
});

describe("masking a URL", () => {
    it("keeps the host and the first part of the path", () => {
        expect(maskUrl(SLACK)).toBe("https://hooks.slack.com/services/••••");
        expect(maskUrl("https://discord.com/api/webhooks/123/abc")).toBe(
            "https://discord.com/api/••••"
        );
        expect(maskUrl("https://example.com/")).toBe("https://example.com");
        expect(maskUrl("https://example.com/hook")).toBe("https://example.com/hook");
        expect(maskUrl("https://example.com/?token=1")).toBe("https://example.com/••••");
    });
});
