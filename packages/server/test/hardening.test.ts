import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AGENT_HEADER,
    Authenticator,
    createTunnelGate,
    type EventBus,
    eventFor,
    RemoteBackend,
} from "../src/index.ts";
import { ShareLinks } from "../src/share.ts";
import { annotationFixture, filesFor, ingest, makeApp } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const c of cleanups.splice(0)) c();
});
const app = (options: Parameters<typeof makeApp>[0] = {}) => {
    const ctx = makeApp(options);
    cleanups.push(ctx.cleanup);
    return ctx;
};

describe("the login rate limit behind a proxy", () => {
    it("counts by the address the proxy saw, not the one the client claims", async () => {
        const store = app().store;
        const auth = new Authenticator(store);
        await auth.ensureAdmin("admin", "right");
        const ctx = app({ auth, trustProxy: true });
        let last = 0;
        for (let i = 0; i < 10; i += 1) {
            const res = await ctx.call("/auth/login", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    // The client makes up a new first address each time; the proxy appends the real one.
                    "x-forwarded-for": `10.0.0.${i}, 203.0.113.7`,
                },
                body: JSON.stringify({ username: "admin", password: "wrong" }),
            });
            last = res.status;
        }
        expect(last).toBe(429);
    });
});

describe("agent presence", () => {
    it("is not set by a request the tunnel gate turns away", async () => {
        const gate = createTunnelGate("device-token-xxxxxxxxxxxx");
        const ctx = app({ authorize: gate.authorize, allowedHosts: "any" });
        const res = await ctx.call("/projects", {
            headers: { host: "abc.devtunnels.ms", [AGENT_HEADER]: "spoofed" },
        });
        expect(res.status).toBe(401);
        expect(ctx.backend.agents.state.connected).toBe(false);
    });
});

describe("the dev tunnel's gate", () => {
    it("takes the device token from the query string on a GET, as an event stream sends it", async () => {
        const gate = createTunnelGate("device-token-xxxxxxxxxxxx");
        const outside = (url: string, method = "GET") =>
            new Request(url, { method, headers: { host: "abc.devtunnels.ms" } });
        expect(
            await gate.authorize(
                outside(
                    "https://abc.devtunnels.ms/projects/p/events?token=device-token-xxxxxxxxxxxx"
                )
            )
        ).toBeNull();
        expect(
            (
                await gate.authorize(
                    outside("https://abc.devtunnels.ms/projects/p/events?token=nope")
                )
            )?.status
        ).toBe(401);
        // Never for a write: a token in a URL ends up in logs.
        expect(
            (
                await gate.authorize(
                    outside(
                        "https://abc.devtunnels.ms/projects/p/annotations?token=device-token-xxxxxxxxxxxx",
                        "POST"
                    )
                )
            )?.status
        ).toBe(401);
    });
});

describe("screenshot links", () => {
    it("answer on the public address they were made for, and stop when the note is deleted", async () => {
        const dir = mkdtempSync(join(tmpdir(), "notato-share-"));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const share = new ShareLinks(dir, () => "https://notes.example.ngrok.app");
        const ctx = app({ share });
        const { body } = await ingest(ctx.call);
        const link = share.linksFor(body.annotation)?.full as string;
        const path = link.replace("https://notes.example.ngrok.app", "");
        const fetchIt = () => ctx.call(path, { headers: { host: "notes.example.ngrok.app" } });
        expect((await fetchIt()).status).toBe(200);
        await ctx.call(`/annotations/${body.annotation.id}`, { method: "DELETE" });
        expect((await fetchIt()).status).toBe(404);
        // The bytes went with the note.
        expect(await ctx.backend.asset(body.annotation.screenshots?.full.id as string)).toBeNull();
    });

    it("keep a screenshot another note still shows", async () => {
        const ctx = app();
        const a = (await ctx.backend.ingest(annotationFixture(), filesFor())).stored;
        await ctx.backend.ingest(annotationFixture(), filesFor());
        await ctx.backend.remove(a.annotation.id);
        expect(await ctx.backend.asset(a.annotation.screenshots?.full.id as string)).not.toBeNull();
    });
});

describe("webhook events after a restart", () => {
    it("tell a change from a status change by what the event carries, not by memory", async () => {
        const ctx = app();
        const bus = ctx.backend.bus as EventBus;
        const seen: string[] = [];
        bus.subscribe((event) => {
            const name = eventFor(event, event.previous?.status, event.previous?.offeredAt);
            if (name) seen.push(name);
        });
        const { stored } = await ctx.backend.ingest(annotationFixture(), filesFor());
        await ctx.backend.setStatus(stored.annotation.id, "resolved", "Done.", { kind: "agent" });
        // Changing the severity of a resolved note is an update, not a second "resolved".
        await ctx.backend.patch(stored.annotation.id, { severity: "blocker" });
        expect(seen).toEqual(["annotation.created", "annotation.resolved", "annotation.updated"]);
    });
});

describe("an attached notato dev", () => {
    it("sends no empty note, which the HTTP API would refuse", async () => {
        const ctx = app();
        const { annotation } = await ingest(ctx.call);
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => ctx.app(req) });
        cleanups.push(() => server.stop(true));
        const remote = new RemoteBackend(`http://127.0.0.1:${server.port}`);
        const updated = await remote.setStatus(annotation.id, "acknowledged", "");
        expect(updated?.annotation.status).toBe("acknowledged");
    });
});

describe("limits on what one note can carry", () => {
    it("refuses a note whose comment, url or context is far too large, and a thread past a thousand replies", async () => {
        const ctx = app();
        const big = await ingest(ctx.call, { comment: "x".repeat(10_001) });
        expect(big.res.status).toBe(413);
        const url = await ingest(ctx.call, { url: `https://x/${"y".repeat(5000)}` });
        expect(url.res.status).toBe(413);
        const context = await ingest(ctx.call, {
            context: { console: [{ level: "log", message: "z".repeat(600 * 1024) }] },
        });
        expect(context.res.status).toBe(413);

        const ok = await ingest(ctx.call, { comment: "fine" });
        expect(ok.res.status).toBe(201);
        const id = ok.body.annotation.id;
        const reply = (body: string) => ctx.backend.reply(id, body, { kind: "human", name: "Ada" });
        for (let i = 0; i < 1000; i++) await reply(`reply ${i}`);
        await expect(reply("one too many")).rejects.toThrow(/1000 replies/);
        // The agent can still close it with a note.
        const done = await ctx.backend.setStatus(id, "resolved", "Done.", { kind: "agent" });
        expect(done?.annotation.thread).toHaveLength(1001);
    });
});
