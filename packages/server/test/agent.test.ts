import { describe, expect, it } from "bun:test";
import {
    AGENT_HEADER,
    AGENT_NAME_HEADER,
    AgentPresence,
    agentName,
    cleanAgentName,
    runDev,
    waitsLong,
} from "../src/index.ts";
import { cleanupAfterEach, makeApp, tempDir, waitFor } from "./helpers.ts";

// Which agent is there: the names its MCP client gives, and whether one is connected or watching, as pages are told.

const defer = cleanupAfterEach();

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
        defer(() => presence.stop());
        const seen: boolean[] = [];
        presence.subscribe((s) => seen.push(s.connected));
        expect(presence.state).toEqual({
            connected: false,
            sessions: 0,
            watching: false,
            names: [],
        });
        presence.touch("agent_one");
        expect(presence.state.connected).toBe(true);
        now += 9_000;
        presence.touch("agent_one");
        now += 9_000;
        expect(presence.state.connected).toBe(true);
        now += 2_000;
        expect(presence.state.connected).toBe(false);
        expect(seen).toEqual([true]);
    });

    it("counts an MCP held open in this process, and one watching", () => {
        const presence = new AgentPresence();
        defer(() => presence.stop());
        const release = presence.hold("agent_here");
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
        defer(() => presence.stop());
        const states: string[][] = [];
        presence.subscribe((s) => states.push(s.names));
        const release = presence.hold("agent_here");
        presence.rename("agent_here", "Codex");
        presence.touch("agent_there", "Claude");
        presence.touch("agent_again", "Codex");
        expect(presence.state).toMatchObject({ sessions: 3, names: ["Claude", "Codex"] });
        // A heartbeat without a name keeps the one it gave before.
        presence.touch("agent_there");
        expect(presence.state.names).toEqual(["Claude", "Codex"]);
        release();
        expect(states.at(-1)).toEqual(["Claude", "Codex"]);
        expect(states).toContainEqual(["Codex"]);
    });

    it("counts a watch as an agent there, even from an attached notato too old to name itself", () => {
        const presence = new AgentPresence();
        defer(() => presence.stop());
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
        defer(ctx.cleanup);
        expect(await (await ctx.call("/config")).json()).toMatchObject({
            agent: { connected: false },
        });
        await ctx.call("/health", { headers: { [AGENT_HEADER]: "agent_test" } });
        expect(await (await ctx.call("/config")).json()).toMatchObject({
            agent: { connected: true, sessions: 1 },
        });
        expect(await (await ctx.call("/status")).json()).toMatchObject({
            agents: { connected: true },
        });
        await ctx.call("/health", {
            headers: { [AGENT_HEADER]: "agent_codex", [AGENT_NAME_HEADER]: "Codex" },
        });
        expect(await (await ctx.call("/config")).json()).toMatchObject({
            agent: { connected: true, sessions: 2, names: ["Codex"] },
        });
    });

    it("is told to a page as it changes, from the first event on", async () => {
        const ctx = makeApp();
        defer(ctx.cleanup);
        const ac = new AbortController();
        defer(() => ac.abort());
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
        const release = ctx.backend.agents.hold("agent_test");
        await until("event: agent");
        expect(received).toContain(
            'event: agent\ndata: {"connected":true,"sessions":1,"watching":false,"names":[]}'
        );
        release();
    });

    it("is known from an attached notato dev, which checks in every few seconds", async () => {
        const dev = async (port: number) => {
            const rt = await runDev({
                port,
                dir: tempDir(defer, "notato-agent-"),
                version: "test",
                stdio: false,
                log: () => {},
            });
            defer(() => rt.close());
            return rt;
        };
        const server = await dev(0);
        expect(server.local?.agents.state.connected).toBe(false);
        const session = await dev(server.port);
        expect(session.role).toBe("client");
        // Its health check, every few seconds, is its heartbeat.
        expect(await waitFor(() => server.local?.agents.state.connected === true, 5000)).toBe(true);
    });
});
