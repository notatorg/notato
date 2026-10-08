import { describe, expect, it } from "vitest";
import { agentLogoSvg, KNOWN_AGENTS, knownAgent } from "../src/index.ts";

describe("known agents", () => {
    it("knows an agent by what its MCP client calls itself and by the name its replies are signed with", () => {
        const cases: Array<[string, string]> = [
            ["claude-code", "claude"],
            ["Claude", "claude"],
            ["codex-mcp-client", "codex"],
            ["Codex", "codex"],
            ["cursor-vscode", "cursor"],
            ["gemini-cli-mcp-client", "gemini"],
            ["Visual Studio Code", "copilot"],
            ["GitHub Copilot", "copilot"],
            ["windsurf-client", "windsurf"],
            ["opencode", "opencode"],
            ["Zed", "zed"],
            ["Amp", "amp"],
        ];
        for (const [name, id] of cases) expect(knownAgent(name)?.id, name).toBe(id);
    });

    it("knows nothing else, words that only contain a short name included", () => {
        for (const name of ["Agent", "My agent", "Zedd", "Amplify", "", undefined, null]) {
            expect(knownAgent(name), String(name)).toBeUndefined();
        }
    });

    it("finds every agent again by its own name, so a signed reply always gets its logo", () => {
        for (const agent of KNOWN_AGENTS) expect(knownAgent(agent.name)).toBe(agent);
    });

    it("has a logo and a badge for every agent, each under its own id", () => {
        expect(new Set(KNOWN_AGENTS.map((a) => a.id)).size).toBe(KNOWN_AGENTS.length);
        for (const agent of KNOWN_AGENTS) {
            expect(agent.paths.length, agent.id).toBeGreaterThan(0);
            for (const d of agent.paths) expect(d, agent.id).toMatch(/^M[\d\s.,\-a-zA-Z]+$/);
            if (agent.background !== "ink") expect(agent.color, agent.id).toBeTruthy();
        }
    });

    it("draws the logo as SVG in the current colour, at the size asked for", () => {
        const claude = knownAgent("Claude");
        if (!claude) throw new Error("Claude is not known");
        const svg = agentLogoSvg(claude, 13);
        expect(svg).toMatch(/^<svg [^>]*width="13" height="13"[^>]*fill="currentColor"/);
        expect(svg).toContain(`<path d="${claude.paths[0]}"/>`);
        expect(svg).toContain('aria-hidden="true"');
    });
});
