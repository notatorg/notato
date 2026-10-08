import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mentionsIn } from "@notato/core";
import type { Annotation } from "@notato/schema";
import {
    AGENT_HEADER,
    AGENT_NAME_HEADER,
    AgentPresence,
    agentName,
    type Backend,
    buildDelivery,
    cleanAgentName,
    createMcpServer,
    type DevRuntime,
    type Mention,
    MentionRegistry,
    runDev,
    waitsLong,
} from "../src/index.ts";
import { annotationFixture, filesFor, makeApp, makeBackend } from "./helpers.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
});

async function setup() {
    const ctx = makeBackend();
    cleanups.push(ctx.cleanup);
    const add = async (over: Partial<Annotation> = {}) =>
        (await ctx.backend.ingest(annotationFixture(over), filesFor())).stored;
    return { ...ctx, add };
}

async function mcp(backend: Backend) {
    const server = createMcpServer({ backend, version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })) as unknown as {
            content: Array<{ type: string; text?: string }>;
        };
    const text = (r: Awaited<ReturnType<typeof call>>) =>
        r.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
    return { call, text };
}

const watch = { timeoutSeconds: 2, windowMs: 0, screenshots: "none" };

describe("agent names", () => {
    it("names the coding agents people know from what their MCP clients call themselves", () => {
        const names: Array<[string, string]> = [
            ["claude-code", "Claude"],
            ["codex-mcp-client", "Codex"],
            ["cursor-vscode", "Cursor"],
            ["gemini-cli-mcp-client", "Gemini"],
            ["Visual Studio Code", "Copilot"],
            ["github-copilot-cli", "Copilot"],
            ["windsurf-client", "Windsurf"],
            ["opencode", "opencode"],
        ];
        for (const [client, name] of names) expect(agentName(client), client).toBe(name);
    });

    it("names an unknown client after itself, without the MCP noise, and nothing after nothing", () => {
        expect(agentName("my-agent-mcp-client")).toBe("My agent");
        expect(agentName("mcp-client")).toBeUndefined();
        expect(agentName(undefined)).toBeUndefined();
        expect(agentName("")).toBeUndefined();
    });

    it("keeps the long wait for Claude Code only, so other clients never hit their tool timeout", () => {
        expect(waitsLong("claude-code")).toBe(true);
        for (const client of [
            "codex-mcp-client",
            "cursor-vscode",
            "gemini-cli-mcp-client",
            "x",
            undefined,
        ])
            expect(waitsLong(client)).toBe(false);
    });

    it("keeps a name a request gives short and printable", () => {
        expect(cleanAgentName(" Codex\u0007 ")).toBe("Codex");
        expect(cleanAgentName("x".repeat(80))).toHaveLength(40);
        expect(cleanAgentName("")).toBeUndefined();
        expect(cleanAgentName(null)).toBeUndefined();
    });
});

describe("agent presence", () => {
    it("counts an attached agent while it keeps checking in, and drops it after", () => {
        let now = 1_000;
        const presence = new AgentPresence(10_000, () => now);
        cleanups.push(() => presence.stop());
        const seen: boolean[] = [];
        presence.subscribe((s) => seen.push(s.connected));
        expect(presence.state).toEqual({
            connected: false,
            sessions: 0,
            watching: false,
            names: [],
        });
        presence.touch("pfa_one");
        expect(presence.state.connected).toBe(true);
        now += 9_000;
        presence.touch("pfa_one");
        now += 9_000;
        expect(presence.state.connected).toBe(true);
        now += 2_000;
        expect(presence.state.connected).toBe(false);
        expect(seen).toEqual([true]);
    });

    it("counts an MCP held open in this process, and one watching", () => {
        const presence = new AgentPresence();
        cleanups.push(() => presence.stop());
        const release = presence.hold("pfa_here");
        expect(presence.state).toMatchObject({ connected: true, sessions: 1, watching: false });
        const done = presence.waitStarted();
        expect(presence.state.watching).toBe(true);
        done();
        expect(presence.state.watching).toBe(false);
        release();
        expect(presence.state.connected).toBe(false);
    });

    it("knows the connected agents by name, each once, held here or attached", () => {
        const presence = new AgentPresence();
        cleanups.push(() => presence.stop());
        const states: string[][] = [];
        presence.subscribe((s) => states.push(s.names));
        const release = presence.hold("pfa_here");
        presence.rename("pfa_here", "Codex");
        presence.touch("pfa_there", "Claude");
        presence.touch("pfa_again", "Codex");
        expect(presence.state).toMatchObject({ sessions: 3, names: ["Claude", "Codex"] });
        // A heartbeat without a name keeps the one it gave before.
        presence.touch("pfa_there");
        expect(presence.state.names).toEqual(["Claude", "Codex"]);
        release();
        expect(states.at(-1)).toEqual(["Claude", "Codex"]);
        expect(states).toContainEqual(["Codex"]);
    });

    it("counts a watch as an agent there, even from an attached notato too old to name itself", () => {
        const presence = new AgentPresence();
        cleanups.push(() => presence.stop());
        const done = presence.waitStarted();
        expect(presence.state).toEqual({ connected: true, sessions: 0, watching: true, names: [] });
        done();
        expect(presence.state).toEqual({
            connected: false,
            sessions: 0,
            watching: false,
            names: [],
        });
    });

    it("is in /config and /status, and a request naming an agent is its heartbeat", async () => {
        const ctx = makeApp();
        cleanups.push(ctx.cleanup);
        expect(await (await ctx.call("/config")).json()).toMatchObject({
            agent: { connected: false },
        });
        await ctx.call("/health", { headers: { [AGENT_HEADER]: "pfa_test" } });
        expect(await (await ctx.call("/config")).json()).toMatchObject({
            agent: { connected: true, sessions: 1 },
        });
        expect(await (await ctx.call("/status")).json()).toMatchObject({
            agents: { connected: true },
        });
        await ctx.call("/health", {
            headers: { [AGENT_HEADER]: "pfa_codex", [AGENT_NAME_HEADER]: "Codex" },
        });
        expect(await (await ctx.call("/config")).json()).toMatchObject({
            agent: { connected: true, sessions: 2, names: ["Codex"] },
        });
    });

    it("is told to a page as it changes, from the first event on", async () => {
        const ctx = makeApp();
        cleanups.push(ctx.cleanup);
        const ac = new AbortController();
        cleanups.push(() => ac.abort());
        const res = await ctx.call("/projects/demo/events", { signal: ac.signal });
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let received = "";
        const until = async (needle: string) => {
            while (!received.includes(needle))
                received += decoder.decode((await reader.read()).value);
        };
        await until("event: hello");
        expect(received).toContain('"agent":{"connected":false');
        const release = ctx.backend.agents.hold("pfa_test");
        await until("event: agent");
        expect(received).toContain(
            'event: agent\ndata: {"connected":true,"sessions":1,"watching":false,"names":[]}'
        );
        release();
    });

    it("is known from an attached notato dev, which checks in every few seconds", async () => {
        const dirs = [
            mkdtempSync(join(tmpdir(), "notato-agent-")),
            mkdtempSync(join(tmpdir(), "notato-agent-")),
        ];
        const runtimes: DevRuntime[] = [];
        cleanups.push(async () => {
            for (const r of runtimes) await r.close();
            for (const d of dirs) rmSync(d, { recursive: true, force: true });
        });
        const server = await runDev({
            port: 0,
            dir: dirs[0],
            version: "test",
            stdio: false,
            log: () => {},
        });
        runtimes.push(server);
        expect(server.local?.agents.state.connected).toBe(false);
        const session = await runDev({
            port: server.port,
            dir: dirs[1],
            version: "test",
            stdio: false,
            log: () => {},
        });
        runtimes.push(session);
        expect(session.role).toBe("client");
        await Bun.sleep(3500);
        expect(server.local?.agents.state.connected).toBe(true);
    });
});

describe("notato_watch without @agent", () => {
    it("delivers a note that says @agent like any other, in order, with nothing special about it", async () => {
        const t = await setup();
        await t.add({ id: "01TEST0000000000000000AAA1", comment: "The button is misaligned" });
        await t.add({
            id: "01TEST0000000000000000AAA2",
            comment: "@agent what does this page do when offline?",
        });
        const { call, text } = await mcp(t.backend);
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("2 new annotations.");
        expect(out.indexOf("The button is misaligned")).toBeLessThan(
            out.indexOf("what does this page do")
        );
        expect(out).not.toContain("ADDRESSED TO YOU");
        expect(text(await call("notato_list_open"))).not.toContain("✉");
    });

    it("delivers any reply on a resolved annotation, and leaves it resolved for the agent to reopen", async () => {
        const t = await setup();
        const resolved = await t.add({ id: "01TEST0000000000000000BBB1", comment: "Make it blue" });
        await t.backend.setStatus(resolved.annotation.id, "resolved", "Made it blue.", {
            kind: "agent",
            name: "Claude",
        });
        const { call, text } = await mcp(t.backend);
        text(await call("notato_watch", watch)); // the backlog

        await t.backend.reply(resolved.annotation.id, "can you make the border blue too?");
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("1 reply from the person.");
        expect(out).toContain("↩ FOLLOW-UP.");
        expect(out).toContain("reopen it with notato_acknowledge");
        expect(out).toContain("border blue too");
        expect((await t.backend.get(resolved.annotation.id))?.annotation.status).toBe("resolved");
        expect(text(await call("notato_watch", { ...watch, timeoutSeconds: 1 }))).toContain(
            "No new annotations"
        );

        // Reopening is the agent's call: acknowledge does it.
        await call("notato_acknowledge", { id: resolved.annotation.id });
        expect((await t.backend.get(resolved.annotation.id))?.annotation.status).toBe(
            "acknowledged"
        );
    });
});

describe("mention plugins", () => {
    it("finds every @name once, lowercased", () => {
        expect(mentionsIn("@Design and @jira, then @design again (@qa-team)")).toEqual([
            "design",
            "jira",
            "qa-team",
        ]);
        expect(mentionsIn("mail me@jira.dev")).toEqual([]);
    });

    it("offers what is registered, says when that changes, and only then", () => {
        let open = false;
        let tell = () => {};
        const registry = new MentionRegistry([]);
        const lists: string[][] = [];
        registry.subscribe((list) =>
            lists.push(list.filter((m) => m.available).map((m) => m.name))
        );
        registry.register({ name: "design", description: "Ask the design team" });
        registry.register({
            name: "jira",
            description: "File it in Jira",
            available: () => open,
            watch: (changed) => {
                tell = changed;
                return () => {};
            },
        });
        expect(registry.list()).toEqual([
            { name: "design", description: "Ask the design team", available: true },
            { name: "jira", description: "File it in Jira", available: false },
        ]);
        tell();
        expect(lists).toHaveLength(2);
        open = true;
        tell();
        expect(lists.at(-1)).toEqual(["design", "jira"]);
        expect(registry.mentioned("@design and @nobody")).toEqual(["design"]);
        expect(() => registry.register({ name: "no spaces", description: "" })).toThrow();
    });

    it("calls a plugin for a note or a reply that mentions it, never for an automatic reply, and survives one that fails", async () => {
        const t = await setup();
        const heard: Mention[] = [];
        const logs: string[] = [];
        const registry = t.backend.mentions;
        registry.register({
            name: "design",
            description: "Ask the design team",
            onMention: (m) => void heard.push(m),
        });
        registry.register({
            name: "broken",
            description: "Always fails",
            onMention: () => {
                throw new Error("boom");
            },
        });
        (registry as unknown as { log: (m: string) => void }).log = (m) => logs.push(m);
        const { annotation } = await t.add({ comment: "@design is this the right shade? @broken" });
        await t.backend.reply(annotation.id, "@Design also the hover state");
        await t.backend.setStatus(annotation.id, "resolved", "Done. @design was asked.", {
            kind: "agent",
            name: "Claude",
        });
        await Bun.sleep(10);
        expect(heard.map((m) => [m.name, m.reply ? "reply" : "note", m.text])).toEqual([
            ["design", "note", "@design is this the right shade? @broken"],
            ["design", "reply", "@Design also the hover state"],
        ]);
        expect(logs).toEqual(["@broken failed: boom"]);
    });

    it("offers no plugin of its own, and tells pages when one is registered", async () => {
        const ctx = makeApp();
        cleanups.push(ctx.cleanup);
        expect((await (await ctx.call("/config")).json()).mentions).toEqual([]);
        const ac = new AbortController();
        cleanups.push(() => ac.abort());
        const reader = (
            (await ctx.call("/projects/demo/events", { signal: ac.signal }))
                .body as ReadableStream<Uint8Array>
        ).getReader();
        const decoder = new TextDecoder();
        let received = "";
        const until = async (needle: string) => {
            while (!received.includes(needle))
                received += decoder.decode((await reader.read()).value);
        };
        await until("event: hello");
        const unregister = ctx.backend.mentions.register({
            name: "jira",
            description: "File it in Jira",
        });
        await until("event: mentions");
        expect(received.slice(received.indexOf("event: mentions"))).toContain('"name":"jira"');
        unregister();
    });

    it("puts the @names someone just wrote in a webhook's payload", () => {
        const hook = { url: "https://example.com/hook", format: "json" as const };
        const note = annotationFixture({ comment: "@jira why is this here? cc @design" });
        expect(JSON.parse(buildDelivery(hook, "annotation.created", note).body).mentions).toEqual([
            "jira",
            "design",
        ]);
        const replied = {
            ...note,
            thread: [
                {
                    id: "r1",
                    author: { kind: "human" as const, name: "Dom" },
                    body: "@qa can you check",
                    createdAt: note.createdAt,
                },
            ],
        };
        expect(
            JSON.parse(buildDelivery(hook, "annotation.replied", replied).body).mentions
        ).toEqual(["qa"]);
        expect(
            JSON.parse(buildDelivery(hook, "annotation.resolved", replied).body).mentions
        ).toEqual([]);
    });
});
