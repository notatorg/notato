import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Annotation } from "@notato/schema";
import {
    buildDelivery,
    createConfigSource,
    eventFor,
    type NotatoEvent,
    parseConfig,
    parseWebhooks,
    readWebhooks,
    secretOf,
    sendDelivery,
    signature,
    startWebhooks,
    type Webhook,
    writeSetting,
    writeWebhooks,
} from "../src/index.ts";
import { annotationFixture, filesFor, makeBackend } from "./helpers.ts";

const dirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "notato-hooks-"));
    dirs.push(dir);
    return dir;
};

/** A real HTTP endpoint that records what it is sent. */
function receiver(respond: (n: number) => number = () => 200) {
    const got: Array<{ headers: Headers; body: string; json: Record<string, unknown> | null }> = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const body = await req.text();
            let json: Record<string, unknown> | null = null;
            try {
                json = JSON.parse(body);
            } catch {
                // not JSON
            }
            got.push({ headers: req.headers, body, json });
            return new Response("ok", { status: respond(got.length) });
        },
    });
    servers.push(server);
    return { url: `http://127.0.0.1:${server.port}/hook`, got };
}

const hook = (over: Partial<Webhook> = {}): Webhook => ({
    url: "http://127.0.0.1:1/x",
    format: "json",
    ...over,
});
const fast = { retryDelaysMs: [5, 5, 5] };

describe("parseWebhooks", () => {
    it("reads a list, with defaults", () => {
        expect(parseWebhooks([{ url: "https://example.com/in" }])).toEqual({
            webhooks: [{ url: "https://example.com/in", format: "json" }],
        });
        expect(parseWebhooks(undefined)).toEqual({ webhooks: [] });
    });

    it("keeps the options it understands", () => {
        const { webhooks } = parseWebhooks([
            {
                url: "https://x.test/a",
                events: ["annotation.resolved"],
                format: "slack",
                secret: "env:S",
                name: "team",
                project: "shop",
            },
        ]);
        expect(webhooks[0]).toEqual({
            url: "https://x.test/a",
            events: ["annotation.resolved"],
            format: "slack",
            secret: "env:S",
            name: "team",
            project: "shop",
        });
    });

    it("says exactly what is wrong, with the position", () => {
        const err = (v: unknown) => parseWebhooks(v).error ?? "";
        expect(err({})).toContain("must be a list");
        expect(err([1])).toContain("webhooks[0] must be an object");
        expect(err([{}])).toContain("webhooks[0].url is required");
        expect(err([{ url: "nope" }])).toContain("is not a URL");
        expect(err([{ url: "ftp://x.test/" }])).toContain("must be http or https");
        expect(err([{ url: "https://x.test/", format: "xml" }])).toContain("format must be one of");
        expect(err([{ url: "https://x.test/", events: ["annotation.exploded"] }])).toContain(
            "unknown event"
        );
        expect(err([{ url: "https://x.test/", events: [] }])).toContain("non-empty");
        expect(err([{ url: "https://x.test/", colour: "red" }])).toContain(
            'unknown field "colour"'
        );
        expect(err([{ url: "https://x.test/" }, { url: "https://x.test/", secret: 5 }])).toContain(
            "webhooks[1].secret"
        );
    });
});

describe("the config file", () => {
    it("carries the webhooks, and a broken one breaks the file, so nothing is sent to a half-understood list", () => {
        const text = JSON.stringify({
            screenshots: "off",
            webhooks: [{ url: "https://x.test/in" }],
        });
        expect(parseConfig(text).webhooks).toHaveLength(1);
        const file = join(tmp(), "notato.config.json");
        writeFileSync(file, JSON.stringify({ webhooks: [{ url: "nope" }] }));
        const resolved = createConfigSource({ file, env: {} })();
        expect(resolved.error).toContain("webhooks[0].url");
        expect(resolved.webhooks).toEqual([]);
    });

    it("changing a setting keeps the webhooks, and the other way round", () => {
        const file = join(tmp(), "notato.config.json");
        writeWebhooks(file, () => [hook({ url: "https://x.test/in", name: "a" })]);
        writeSetting(file, "screenshots", false);
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
            webhooks: [{ url: "https://x.test/in", format: "json", name: "a" }],
            screenshots: "off",
        });
        writeWebhooks(file, (list) => [...list, hook({ url: "https://y.test/in" })]);
        expect(JSON.parse(readFileSync(file, "utf8")).screenshots).toBe("off");
        expect(readWebhooks(file)).toHaveLength(2);
    });

    it("removing the last webhook removes the key, and a webhook that is not valid is not written", () => {
        const file = join(tmp(), "notato.config.json");
        writeWebhooks(file, () => [hook({ url: "https://x.test/in" })]);
        writeWebhooks(file, () => []);
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
        expect(() => writeWebhooks(file, () => [hook({ url: "not a url" })])).toThrow("not a URL");
    });

    it("the running server notices a webhook added to the file", () => {
        const file = join(tmp(), "notato.config.json");
        const config = createConfigSource({ file, env: {} });
        expect(config().webhooks).toEqual([]);
        writeWebhooks(file, () => [hook({ url: "https://x.test/in" })]);
        expect(config().webhooks).toHaveLength(1);
    });
});

describe("secrets", () => {
    it("is a literal, or read from the environment with env:NAME", () => {
        expect(secretOf(hook(), {})).toBeUndefined();
        expect(secretOf(hook({ secret: "plain" }), {})).toBe("plain");
        expect(secretOf(hook({ secret: "env:HOOK" }), { HOOK: "from-env" })).toBe("from-env");
        expect(secretOf(hook({ secret: "env:HOOK" }), {})).toBeNull();
    });
});

describe("the payload", () => {
    const annotation = annotationFixture({ comment: "button hidden", severity: "major" });
    const at = new Date("2026-10-05T12:00:00Z");

    it("json carries the event, the annotation and ready-made Markdown", () => {
        const d = buildDelivery(hook(), "annotation.resolved", annotation, undefined, at);
        const body = JSON.parse(d.body);
        expect(body).toMatchObject({
            id: d.id,
            event: "annotation.resolved",
            at: "2026-10-05T12:00:00.000Z",
            project: annotation.projectId,
        });
        expect(body.annotation.id).toBe(annotation.id);
        expect(body.markdown).toContain("Comment: button hidden");
        expect(d.headers["X-Notato-Event"]).toBe("annotation.resolved");
        expect(d.headers["X-Notato-Delivery"]).toBe(d.id);
        expect(d.headers["X-Notato-Signature"]).toBeUndefined();
    });

    it("is signed when there is a secret, so the receiver can tell it came from here", () => {
        const d = buildDelivery(hook(), "annotation.created", annotation, "s3cret");
        const expected = `sha256=${createHmac("sha256", "s3cret").update(d.body).digest("hex")}`;
        expect(d.headers["X-Notato-Signature"]).toBe(expected);
        expect(signature("s3cret", d.body)).toBe(expected);
    });

    it("slack and discord get one line they accept as is", () => {
        const slack = JSON.parse(
            buildDelivery(hook({ format: "slack" }), "annotation.resolved", annotation).body
        );
        expect(Object.keys(slack)).toEqual(["text"]);
        expect(slack.text).toContain("annotation resolved");
        expect(slack.text).toContain("button hidden");
        const discord = JSON.parse(
            buildDelivery(hook({ format: "discord" }), "annotation.revert_requested", annotation)
                .body
        );
        expect(Object.keys(discord)).toEqual(["content", "allowed_mentions"]);
        expect(discord.content).toContain("revert requested");
    });

    it("a note cannot ping a channel or dress up a link in chat", () => {
        const loud = {
            ...annotation,
            comment: "<!channel> look <https://evil.example|your bank> @everyone",
        };
        const slack = JSON.parse(
            buildDelivery(hook({ format: "slack" }), "annotation.created", loud).body
        );
        expect(slack.text).not.toContain("<!channel>");
        expect(slack.text).not.toContain("<https://");
        expect(slack.text).toContain("&lt;!channel&gt;");
        const discord = JSON.parse(
            buildDelivery(hook({ format: "discord" }), "annotation.created", loud).body
        );
        expect(discord.allowed_mentions).toEqual({ parse: [] });
    });
});

describe("sendDelivery", () => {
    const delivery = buildDelivery(hook(), "annotation.created", annotationFixture());

    it("delivers, and posts the body and headers as built", async () => {
        const r = receiver();
        expect(await sendDelivery(hook({ url: r.url }), delivery, fast)).toBe(true);
        expect(r.got).toHaveLength(1);
        expect(r.got[0]?.body).toBe(delivery.body);
        expect(r.got[0]?.headers.get("x-notato-event")).toBe("annotation.created");
    });

    it("retries a server error until it gets through", async () => {
        const r = receiver((n) => (n < 3 ? 503 : 200));
        expect(await sendDelivery(hook({ url: r.url }), delivery, fast)).toBe(true);
        expect(r.got).toHaveLength(3);
    });

    it("does not retry a refusal, which would be refused again, and says so", async () => {
        const r = receiver(() => 401);
        const log: string[] = [];
        expect(
            await sendDelivery(hook({ url: r.url }), delivery, { ...fast, log: (m) => log.push(m) })
        ).toBe(false);
        expect(r.got).toHaveLength(1);
        expect(log.join()).toContain("refused with status 401");
    });

    it("gives up after its retries and says so, rather than trying for ever", async () => {
        const r = receiver(() => 500);
        const log: string[] = [];
        expect(
            await sendDelivery(hook({ url: r.url }), delivery, { ...fast, log: (m) => log.push(m) })
        ).toBe(false);
        expect(r.got).toHaveLength(4);
        expect(log.join()).toContain("gave up after 4 attempts");
    });

    it("treats an unreachable endpoint the same way", async () => {
        const log: string[] = [];
        expect(
            await sendDelivery(hook({ url: "http://127.0.0.1:1/none" }), delivery, {
                retryDelaysMs: [5],
                log: (m) => log.push(m),
            })
        ).toBe(false);
        expect(log.join()).toContain("gave up");
    });

    it("does not follow a redirect to somewhere else", async () => {
        const target = receiver();
        const hop = Bun.serve({ port: 0, fetch: () => Response.redirect(target.url, 302) });
        servers.push(hop);
        expect(
            await sendDelivery(hook({ url: `http://127.0.0.1:${hop.port}/` }), delivery, fast)
        ).toBe(false);
        expect(target.got).toHaveLength(0);
    });
});

describe("eventFor", () => {
    const event = (type: NotatoEvent["type"], status: Annotation["status"]): NotatoEvent => ({
        type,
        projectId: "p",
        id: "a",
        seq: 1,
        annotation: { ...annotationFixture(), status },
    });
    it("names what changed", () => {
        expect(eventFor(event("created", "open"), undefined)).toBe("annotation.created");
        expect(eventFor(event("replied", "open"), "open")).toBe("annotation.replied");
        expect(eventFor(event("deleted", "open"), "open")).toBe("annotation.deleted");
        expect(eventFor(event("updated", "resolved"), "acknowledged")).toBe("annotation.resolved");
        expect(eventFor(event("updated", "revert_requested"), "resolved")).toBe(
            "annotation.revert_requested"
        );
        expect(eventFor(event("updated", "reverted"), "revert_requested")).toBe(
            "annotation.reverted"
        );
        expect(eventFor(event("updated", "dismissed"), "open")).toBe("annotation.dismissed");
    });
    it("tells a reopening from a first opening, and a change of text from a change of status", () => {
        expect(eventFor(event("updated", "open"), "resolved")).toBe("annotation.reopened");
        expect(eventFor(event("updated", "open"), "dismissed")).toBe("annotation.reopened");
        expect(eventFor(event("updated", "open"), "acknowledged")).toBe("annotation.updated");
        expect(eventFor(event("updated", "open"), undefined)).toBe("annotation.updated");
        expect(eventFor(event("updated", "open"), "open")).toBe("annotation.updated");
        expect(eventFor(event("updated", "resolved"), undefined)).toBe("annotation.resolved");
    });
    it("tells a change from a status change by what the event carries, so a restart forgets nothing", async () => {
        const ctx = makeBackend();
        try {
            const seen: string[] = [];
            ctx.backend.bus.subscribe((e) => {
                const name = eventFor(e, e.previous?.status, e.previous?.offeredAt);
                if (name) seen.push(name);
            });
            const { stored } = await ctx.backend.ingest(annotationFixture(), filesFor());
            const id = stored.annotation.id;
            await ctx.backend.setStatus(id, "resolved", "Done.", { kind: "agent" });
            // Changing the severity of a resolved note is an update, not a second "resolved".
            await ctx.backend.update(id, { severity: "blocker" });
            expect(seen).toEqual([
                "annotation.created",
                "annotation.resolved",
                "annotation.updated",
            ]);
        } finally {
            ctx.cleanup();
        }
    });
});

describe("startWebhooks, from the events of a real backend", () => {
    function setup(hooks: () => Webhook[], env: Record<string, string | undefined> = {}) {
        const ctx = makeBackend();
        const log: string[] = [];
        const dispatcher = startWebhooks({
            bus: ctx.backend.bus,
            config: () => ({
                screenshots: true,
                mcp: true,
                source: { screenshots: "default", mcp: "default" },
                webhooks: hooks(),
            }),
            env,
            log: (m) => log.push(m),
            ...fast,
        });
        return {
            ...ctx,
            dispatcher,
            log,
            close: () => {
                dispatcher.stop();
                ctx.cleanup();
            },
        };
    }
    const events = (r: ReturnType<typeof receiver>) =>
        r.got.map((g) => g.headers.get("x-notato-event"));

    it("sends nothing note by note when a whole project is deleted", async () => {
        const r = receiver();
        const t = setup(() => [hook({ url: r.url, secret: "k" })]);
        for (let i = 0; i < 5; i++)
            await t.backend.ingest(annotationFixture({ projectId: "gone" }), filesFor());
        await t.dispatcher.flush();
        expect(events(r)).toHaveLength(5);
        await t.backend.deleteProject("gone");
        await t.dispatcher.flush();
        expect(events(r)).toHaveLength(5);
        t.close();
    });

    it("sends created, then each change of status, in order, with what the receiver needs", async () => {
        const r = receiver();
        const t = setup(() => [hook({ url: r.url, secret: "k" })]);
        const { annotation } = (
            await t.backend.ingest(annotationFixture({ comment: "pay button hidden" }), filesFor())
        ).stored;
        await t.backend.setStatus(annotation.id, "acknowledged", "On it");
        await t.backend.setStatus(annotation.id, "resolved", "Resolved: moved it");
        await t.backend.setStatus(annotation.id, "revert_requested", "Undo it");
        await t.dispatcher.flush();
        expect(events(r)).toEqual([
            "annotation.created",
            "annotation.acknowledged",
            "annotation.resolved",
            "annotation.revert_requested",
        ]);
        const last = r.got[3];
        expect(last?.json?.project).toBe(annotation.projectId);
        expect((last?.json?.annotation as Annotation | undefined)?.status).toBe("revert_requested");
        // Each body is signed with the secret, and verifies.
        for (const g of r.got)
            expect(g.headers.get("x-notato-signature")).toBe(signature("k", g.body));
        t.close();
    });

    it("only sends the events asked for, and only for the project asked for", async () => {
        const r = receiver();
        const t = setup(() => [
            hook({ url: r.url, events: ["annotation.resolved"], project: "mine" }),
        ]);
        const mine = (await t.backend.ingest(annotationFixture({ projectId: "mine" }), filesFor()))
            .stored.annotation;
        const theirs = (
            await t.backend.ingest(annotationFixture({ projectId: "theirs" }), filesFor())
        ).stored.annotation;
        await t.backend.setStatus(mine.id, "resolved", "done");
        await t.backend.setStatus(theirs.id, "resolved", "done");
        await t.dispatcher.flush();
        expect(r.got).toHaveLength(1);
        expect((r.got[0]?.json?.annotation as Annotation | undefined)?.id).toBe(mine.id);
        t.close();
    });

    it("calls a resolved annotation that is opened again a reopening", async () => {
        const r = receiver();
        const t = setup(() => [hook({ url: r.url })]);
        const { annotation } = (await t.backend.ingest(annotationFixture(), filesFor())).stored;
        await t.backend.setStatus(annotation.id, "resolved", "done");
        await t.backend.setStatus(annotation.id, "open", "not fixed");
        await t.dispatcher.flush();
        expect(events(r)).toEqual([
            "annotation.created",
            "annotation.resolved",
            "annotation.reopened",
        ]);
        t.close();
    });

    it("tells of a reply and of a delete", async () => {
        const r = receiver();
        const t = setup(() => [hook({ url: r.url })]);
        const { annotation } = (await t.backend.ingest(annotationFixture(), filesFor())).stored;
        await t.backend.reply(annotation.id, "Which breakpoint?");
        await t.backend.remove(annotation.id);
        await t.dispatcher.flush();
        expect(events(r)).toEqual([
            "annotation.created",
            "annotation.replied",
            "annotation.deleted",
        ]);
        t.close();
    });

    it("sends to every webhook, and a dead one does not hold up the others", async () => {
        const live = receiver();
        const t = setup(() => [hook({ url: "http://127.0.0.1:1/dead" }), hook({ url: live.url })]);
        await t.backend.ingest(annotationFixture(), filesFor());
        await t.dispatcher.flush();
        expect(events(live)).toEqual(["annotation.created"]);
        expect(t.log.join()).toContain("gave up");
        t.close();
    });

    it("does not slow the API down: the change is made before the delivery is even tried", async () => {
        const r = receiver();
        const t = setup(() => [hook({ url: r.url })]);
        const started = Date.now();
        const { annotation } = (await t.backend.ingest(annotationFixture(), filesFor())).stored;
        await t.backend.setStatus(annotation.id, "resolved", "done");
        expect((await t.backend.get(annotation.id))?.annotation.status).toBe("resolved");
        expect(Date.now() - started).toBeLessThan(500);
        await t.dispatcher.flush();
        t.close();
    });

    it("picks up a webhook added while it runs", async () => {
        const r = receiver();
        let list: Webhook[] = [];
        const t = setup(() => list);
        await t.backend.ingest(annotationFixture(), filesFor());
        list = [hook({ url: r.url })];
        await t.backend.ingest(annotationFixture(), filesFor());
        await t.dispatcher.flush();
        expect(r.got).toHaveLength(1);
        t.close();
    });

    it("will not send unsigned when a signature was asked for and its secret is missing, and says so once", async () => {
        const r = receiver();
        const t = setup(() => [hook({ url: r.url, secret: "env:HOOK_SECRET" })]);
        await t.backend.ingest(annotationFixture(), filesFor());
        await t.backend.ingest(annotationFixture(), filesFor());
        await t.dispatcher.flush();
        expect(r.got).toHaveLength(0);
        expect(t.log.filter((m) => m.includes("HOOK_SECRET"))).toHaveLength(1);
        t.close();
    });

    it("says nothing about a diagnostic annotation, which `notato doctor` files and deletes", async () => {
        const r = receiver();
        const t = setup(() => [hook({ url: r.url })]);
        const { annotation } = (
            await t.backend.ingest(
                annotationFixture({ context: { notatoDiagnostic: true } }),
                filesFor()
            )
        ).stored;
        await t.backend.remove(annotation.id);
        await t.backend.ingest(annotationFixture(), filesFor());
        await t.dispatcher.flush();
        expect(r.got).toHaveLength(1);
        t.close();
    });

    it("stops sending once stopped", async () => {
        const r = receiver();
        const t = setup(() => [hook({ url: r.url })]);
        t.dispatcher.stop();
        await t.backend.ingest(annotationFixture(), filesFor());
        await t.dispatcher.flush();
        expect(r.got).toHaveLength(0);
        t.cleanup();
    });
});
