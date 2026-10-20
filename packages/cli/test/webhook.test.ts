import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runConfig } from "../src/commands/config.ts";
import { runWebhook } from "../src/commands/webhook.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
    removeTempDirs();
});
const tmp = () => tempDir("notato-wh-");
const fileOf = (dir: string) => join(dir, "notato.config.json");
const run = (dir: string, args: string[], env: Record<string, string | undefined> = {}) =>
    runWebhook(args, env, dir);
const hooksIn = (dir: string) => JSON.parse(readFileSync(fileOf(dir), "utf8")).webhooks;

describe("notato config webhook", () => {
    it("lists nothing, then what was added, in a line each", async () => {
        const dir = tmp();
        expect((await run(dir, [])).stdout).toContain("No webhooks");
        await run(dir, ["add", "https://hooks.example.com/in", "--name", "team", "-e", "resolved"]);
        const listed = (await run(dir, ["list"])).stdout;
        expect(listed).toContain("team  https://hooks.example.com/••••");
        expect(listed).toContain("resolved");
        expect(listed).toContain("unsigned");
    });

    it("add writes the file; events can be written short; the result is what a server reads", async () => {
        const dir = tmp();
        const added = await run(dir, [
            "add",
            "https://hooks.example.com/in",
            "-e",
            "resolved",
            "-e",
            "annotation.revert_requested",
            "-F",
            "slack",
            "-s",
            "env:HOOK_SECRET",
            "-p",
            "shop",
        ]);
        expect(added.code).toBe(0);
        expect(hooksIn(dir)).toEqual([
            {
                url: "https://hooks.example.com/in",
                format: "slack",
                events: ["annotation.resolved", "annotation.revert_requested"],
                secret: "env:HOOK_SECRET",
                project: "shop",
            },
        ]);
        // The variable is not set in this shell, which matters: the server would send nothing.
        expect(added.stdout).toContain("$HOOK_SECRET is not set here");
    });

    it("refuses a secret written as it is, unless told to keep it in the file", async () => {
        const dir = tmp();
        const refused = await run(dir, ["add", "https://hooks.example.com/in", "-s", "hunter2"]);
        expect(refused.code).toBe(2);
        expect(refused.stderr).toContain("meant to be committed");
        expect(refused.stderr).toContain("env:NAME");
        expect(existsSync(fileOf(dir))).toBe(false);
        const kept = await run(dir, [
            "add",
            "https://hooks.example.com/in",
            "-s",
            "hunter2",
            "--secret-in-file",
        ]);
        expect(kept.code).toBe(0);
        expect(hooksIn(dir)[0].secret).toBe("hunter2");
        // Shown as being in the file, never the secret itself.
        const listed = (await run(dir, ["list"])).stdout;
        expect(listed).toContain("the secret in the file");
        expect(listed).not.toContain("hunter2");
    });

    it("takes the URL from an environment variable, so it is never in the file", async () => {
        const dir = tmp();
        const slack = "https://hooks.slack.com/services/T000/B000/XXXX";
        const added = await run(dir, ["add", "env:SLACK_WEBHOOK_URL", "-F", "slack"]);
        expect(added.code).toBe(0);
        expect(hooksIn(dir)).toEqual([{ url: "env:SLACK_WEBHOOK_URL", format: "slack" }]);
        expect(added.stdout).toContain("$SLACK_WEBHOOK_URL is not set here");
        expect(added.stdout).toContain("test env:SLACK_WEBHOOK_URL");
        const listed = (await run(dir, ["list"], { SLACK_WEBHOOK_URL: slack })).stdout;
        expect(listed).toContain("env:SLACK_WEBHOOK_URL");
        expect(listed).not.toContain("XXXX");
        expect((await run(dir, ["add", "env:not a name"])).stderr).toContain(
            "name of an environment variable"
        );
    });

    it("shows only the host of a URL in the file, wherever it prints one", async () => {
        const dir = tmp();
        const slack = "https://hooks.slack.com/services/T000/B000/XXXX";
        const added = await run(dir, ["add", slack, "-F", "slack"]);
        // It says the URL is a credential in a file that may be committed, and how not to put it there.
        expect(added.stdout).toContain("anyone who has it can post to it");
        expect(added.stdout).toContain("test hooks.slack.com");
        await run(dir, ["add", "https://teams.example.com/flow?sig=SIG", "-F", "teams"]);
        const shown = [
            added.stdout,
            (await run(dir, ["list"])).stdout,
            runConfig([], {}, dir).stdout,
            (await run(dir, ["remove", "hooks.slack.com"])).stdout,
        ].join("\n");
        expect(shown).toContain("https://hooks.slack.com/••••");
        expect(shown).toContain("https://teams.example.com/••••");
        for (const secret of ["T000", "XXXX", "SIG", "flow"]) expect(shown).not.toContain(secret);
    });

    it("adding the same URL again updates it, rather than sending everything twice", async () => {
        const dir = tmp();
        await run(dir, ["add", "https://hooks.example.com/in"]);
        const again = await run(dir, ["add", "https://hooks.example.com/in", "-F", "discord"]);
        expect(again.stdout).toContain("Updated");
        expect(hooksIn(dir)).toHaveLength(1);
        expect(hooksIn(dir)[0].format).toBe("discord");
    });

    it("is not fooled into writing a webhook the server would refuse", async () => {
        const dir = tmp();
        for (const [args, expected] of [
            [["add", "not a url"], "not a URL"],
            [["add", "https://x.test/", "-F", "xml"], "format must be one of"],
            [["add", "https://x.test/", "-e", "exploded"], "unknown event"],
            [["add"], "Give the URL"],
        ] as const) {
            const r = await run(dir, [...args]);
            expect(r.code).toBe(2);
            expect(r.stderr).toContain(expected);
        }
        expect(existsSync(fileOf(dir))).toBe(false);
    });

    it("warns about an unsigned plain-http URL, but not about localhost", async () => {
        const dir = tmp();
        expect((await run(dir, ["add", "http://example.com/in"])).stdout).toContain("plain http");
        expect((await run(dir, ["add", "http://localhost:9000/in"])).stdout).not.toContain(
            "plain http"
        );
    });

    it("remove takes the URL, the name or the host, and says when nothing matches", async () => {
        const dir = tmp();
        await run(dir, ["add", "https://a.example.com/in", "-n", "alpha"]);
        await run(dir, ["add", "https://b.example.com/in"]);
        expect((await run(dir, ["remove", "alpha"])).stdout).toContain("Removed alpha");
        expect((await run(dir, ["remove", "b.example.com"])).code).toBe(0);
        expect(existsSync(fileOf(dir))).toBe(true);
        expect(JSON.parse(readFileSync(fileOf(dir), "utf8"))).toEqual({});
        const miss = await run(dir, ["remove", "alpha"]);
        expect(miss.code).toBe(2);
        expect(miss.stderr).toContain('no webhook matches "alpha"');
    });

    it("keeps the other settings in the file when it changes the webhooks", async () => {
        const dir = tmp();
        runConfig(["set", "screenshots", "off"], {}, dir);
        await run(dir, ["add", "https://a.example.com/in"]);
        expect(JSON.parse(readFileSync(fileOf(dir), "utf8")).screenshots).toBe("off");
    });

    it("refuses to touch a file it cannot read", async () => {
        const dir = tmp();
        writeFileSync(fileOf(dir), "{ nope");
        const r = await run(dir, ["add", "https://a.example.com/in"]);
        expect(r.code).toBe(1);
        expect(readFileSync(fileOf(dir), "utf8")).toBe("{ nope");
    });

    it("notato config shows them, and says plainly when a broken file means none are sent", async () => {
        const dir = tmp();
        await run(dir, ["add", "https://a.example.com/in", "-n", "alpha"]);
        expect(runConfig([], {}, dir).stdout).toContain("alpha  https://a.example.com/••••");
        writeFileSync(fileOf(dir), '{ "webhooks": [{}] }');
        const broken = runConfig([], {}, dir);
        expect(broken.code).toBe(1);
        expect(broken.stderr).toContain("sends no webhooks");
    });
});

describe("notato config webhook test", () => {
    function receiver(status = 200) {
        const got: Array<{ headers: Headers; body: string }> = [];
        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                got.push({ headers: req.headers, body: await req.text() });
                return new Response("ok", { status });
            },
        });
        servers.push(server);
        return { url: `http://127.0.0.1:${server.port}/in`, got };
    }

    it("sends a sample, signed, and reports that it got through", async () => {
        const dir = tmp();
        const r = receiver();
        await run(dir, ["add", r.url, "-n", "local", "-s", "env:HOOK_SECRET"], {
            HOOK_SECRET: "k",
        });
        const test = await run(dir, ["test", "local"], { HOOK_SECRET: "k" });
        expect(test.code).toBe(0);
        expect(test.stdout).toContain("it answered with success");
        expect(r.got).toHaveLength(1);
        const body = r.got[0]?.body ?? "";
        expect(JSON.parse(body).annotation.comment).toContain("test event");
        expect(r.got[0]?.headers.get("x-notato-signature")).toBe(
            `sha256=${createHmac("sha256", "k").update(body).digest("hex")}`
        );
    });

    it("says what the other end said when it refuses, without retrying", async () => {
        const dir = tmp();
        const r = receiver(403);
        await run(dir, ["add", r.url, "-n", "local"]);
        const test = await run(dir, ["test", "local"]);
        expect(test.code).toBe(1);
        expect(test.stderr).toContain("did not get through");
        expect(test.stderr).toContain("status 403");
        expect(r.got).toHaveLength(1);
    });

    it("sends to a URL read from the environment, and says so when it is not set", async () => {
        const dir = tmp();
        const r = receiver();
        await run(dir, ["add", "env:HOOK_URL", "-n", "local"]);
        const missing = await run(dir, ["test", "local"]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain("$HOOK_URL is not set");
        const test = await run(dir, ["test", "local"], { HOOK_URL: r.url });
        expect(test.code).toBe(0);
        expect(r.got).toHaveLength(1);
    });

    it("does not send an unsigned test to a webhook that is meant to be signed", async () => {
        const dir = tmp();
        const r = receiver();
        await run(dir, ["add", r.url, "-n", "local", "-s", "env:HOOK_SECRET"]);
        const test = await run(dir, ["test", "local"]);
        expect(test.code).toBe(1);
        expect(test.stderr).toContain("HOOK_SECRET is not set");
        expect(r.got).toHaveLength(0);
    });
});
