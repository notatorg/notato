import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
    addToAgentConfig,
    detectAgents,
    entryProjects,
    isNotatoEntry,
    parseAgents,
    removeFromAgentConfig,
} from "../src/agents.ts";
import { runInit } from "../src/init/init.ts";
import { formatReport, formatRevertReport } from "../src/init/report.ts";
import { runRevert } from "../src/init/revert.ts";
import { renderSkill } from "../src/skill.ts";
import { fakeCommands, read, removeTempDirs, tempDir, writeFiles } from "./helpers.ts";

afterEach(removeTempDirs);

function app(extra: Record<string, string> = {}): string {
    return tempDir("notato-agents-", {
        "package.json": JSON.stringify({
            name: "shop",
            dependencies: { react: "^19" },
            devDependencies: { vite: "^8", "@notato/react": "^0.1.0" },
        }),
        "index.html": '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
        "src/main.tsx": `import { createRoot } from "react-dom/client"\nimport App from "./App"\n\ncreateRoot(document.getElementById("root")!).render(<App />)\n`,
        ".gitignore": "node_modules\n",
        ...extra,
    });
}

const json = (dir: string, file: string) => JSON.parse(read(dir, file));

/** The app's own files again in `sub`, a folder below `root`, as in a repository of several apps. */
function appBelow(root: string, sub: string, files: Record<string, string> = {}): string {
    const dir = join(root, sub);
    const app = ["package.json", "index.html", "src/main.tsx"].map((f) => [f, read(root, f)]);
    writeFiles(dir, { ...Object.fromEntries(app), ...files });
    return dir;
}

describe("choosing agents", () => {
    it("reads --agent as a list, repeated or comma-separated, or all", () => {
        expect(parseAgents(undefined)).toBeUndefined();
        expect(parseAgents(["codex,Cursor", "codex"])).toEqual(["codex", "cursor"]);
        expect(parseAgents(["all"])).toEqual(["claude", "codex", "cursor", "gemini", "copilot"]);
        expect(() => parseAgents(["claude,windsurf"])).toThrow("unknown windsurf");
    });

    it("ignores the empty names a trailing comma or a blank variable leaves", () => {
        expect(parseAgents(["codex,"])).toEqual(["codex"]);
        expect(parseAgents(["codex, ,cursor,"])).toEqual(["codex", "cursor"]);
        expect(parseAgents([""])).toBeUndefined();
        expect(parseAgents([","])).toBeUndefined();
    });

    it("finds the agents a project uses from their commands and folders, and falls back to Claude Code", () => {
        const dir = app({
            ".cursor/rules/style.mdc": "x",
            ".github/copilot-instructions.md": "Be nice",
        });
        expect(detectAgents([dir], (name) => (name === "codex" ? "/bin/codex" : null))).toEqual([
            "codex",
            "cursor",
            "copilot",
        ]);
        expect(detectAgents([app()], () => null)).toEqual(["claude"]);
    });
});

describe("agent config files", () => {
    const entry = { command: "npx", args: ["notato", "dev"] };

    it("adds the server, keeps everything else, and is 'already' the second time", () => {
        const first = addToAgentConfig(
            '{ "mcpServers": { "other": { "command": "x" } }, "theme": "dark" }',
            "mcpServers",
            entry
        );
        expect(first.state).toBe("added");
        if (first.state === "unreadable") throw new Error("unreadable");
        expect(JSON.parse(first.source)).toEqual({
            mcpServers: { other: { command: "x" }, notato: entry },
            theme: "dark",
        });
        expect(addToAgentConfig(first.source, "mcpServers", entry)).toMatchObject({
            state: "already",
            changed: false,
        });
        expect(addToAgentConfig(null, "servers", entry)).toMatchObject({ state: "added" });
    });

    it("leaves a file with comments, or its own notato server, alone", () => {
        expect(addToAgentConfig("// mine\n{}", "servers", entry)).toMatchObject({
            state: "unreadable",
        });
        const own = JSON.stringify({
            servers: { notato: { command: "node", args: ["custom.js"] } },
        });
        expect(addToAgentConfig(own, "servers", entry)).toMatchObject({
            state: "already",
            note: "already has a notato server, kept as it is",
        });
    });

    it("keeps a server init wrote to the project, adding another app's beside it", () => {
        const scoped = (args: string[]) =>
            JSON.stringify({ mcpServers: { notato: { command: "npx", args } } });
        const wanted = { command: "npx", args: ["notato", "dev", "--project", "shop"] };
        // From before projects could be named: it was handed every project's notes.
        const older = addToAgentConfig(scoped(["notato", "dev"]), "mcpServers", wanted, "shop");
        expect(older).toMatchObject({
            state: "already",
            changed: true,
            note: "the notato server is now kept to shop",
        });
        if (older.state === "unreadable") throw new Error("unreadable");
        expect(JSON.parse(older.source).mcpServers.notato.args).toEqual([
            "notato",
            "dev",
            "--project",
            "shop",
        ]);
        // A second app in the same repository: both, so the agent works on each.
        const second = addToAgentConfig(
            older.source,
            "mcpServers",
            { command: "npx", args: ["notato", "dev", "--project", "admin"] },
            "admin"
        );
        expect(second).toMatchObject({
            changed: true,
            note: "the notato server now works on admin too",
        });
        if (second.state === "unreadable") throw new Error("unreadable");
        expect(entryProjects(JSON.parse(second.source).mcpServers.notato)).toEqual([
            "shop",
            "admin",
        ]);
        // Already kept to it, however it was written: nothing to do.
        for (const args of [
            ["notato", "dev", "--project", "shop"],
            ["notato", "dev", "-P", "admin,shop"],
            ["notato", "dev", "--project=shop"],
        ])
            expect(addToAgentConfig(scoped(args), "mcpServers", wanted, "shop")).toMatchObject({
                state: "already",
                changed: false,
            });
        // Someone's own server is theirs: say what to add instead.
        const own = JSON.stringify({ mcpServers: { notato: { command: "node", args: ["x.js"] } } });
        expect(addToAgentConfig(own, "mcpServers", wanted, "shop")).toMatchObject({
            changed: false,
            note: 'already has a notato server, kept as it is; add "--project", "shop" to its args to keep it to this project',
        });
    });

    it("takes out only a server init wrote, and says when the file is then empty", () => {
        const both = JSON.stringify({ mcpServers: { notato: entry, other: { command: "x" } } });
        expect(JSON.parse(removeFromAgentConfig(both, "mcpServers").source)).toEqual({
            mcpServers: { other: { command: "x" } },
        });
        expect(
            removeFromAgentConfig(JSON.stringify({ mcpServers: { notato: entry } }), "mcpServers")
        ).toMatchObject({
            changed: true,
            empty: true,
        });
        const custom = JSON.stringify({
            mcpServers: { notato: { command: "node", args: ["custom.js"] } },
        });
        expect(removeFromAgentConfig(custom, "mcpServers").changed).toBe(false);
        expect(isNotatoEntry({ command: "./app/node_modules/.bin/notato", args: ["dev"] })).toBe(
            true
        );
        expect(isNotatoEntry({ command: "cmd", args: ["/c", "npx", "notato", "dev"] })).toBe(true);
        expect(isNotatoEntry({ command: "npx", args: ["notato-other", "dev"] })).toBe(false);
    });
});

describe("init for every agent", () => {
    it("registers Codex with its command and the others in their project files, with skills where each reads them", async () => {
        const dir = app();
        const { commands, opts } = fakeCommands();
        const report = await runInit({
            cwd: dir,
            agents: ["claude", "codex", "cursor", "gemini", "copilot"],
            ...opts,
        });

        expect(commands).toEqual([
            // Codex keeps one list for every folder, so it has no one project to be kept to.
            ["claude", "mcp", "add", "notato", "--", "npx", "notato", "dev", "--project", "shop"],
            ["codex", "mcp", "add", "notato", "--", "npx", "notato", "dev"],
        ]);
        const server = { command: "npx", args: ["notato", "dev", "--project", "shop"] };
        expect(json(dir, ".cursor/mcp.json")).toEqual({ mcpServers: { notato: server } });
        expect(json(dir, ".gemini/settings.json")).toEqual({ mcpServers: { notato: server } });
        expect(json(dir, ".vscode/mcp.json")).toEqual({
            // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code's variable, written as it is
            servers: { notato: { type: "stdio", ...server, cwd: "${workspaceFolder}" } },
        });
        for (const folder of [".claude/skills", ".agents/skills", ".github/skills"]) {
            expect(read(dir, `${folder}/notato/SKILL.md`)).toBe(renderSkill());
            expect(read(dir, `${folder}/notato-critique/SKILL.md`)).toBe(
                renderSkill("notato-critique")
            );
        }
        expect(report.agents.map((a) => [a.id, a.status])).toEqual([
            ["claude", "added"],
            ["codex", "added"],
            ["cursor", "added"],
            ["gemini", "added"],
            ["copilot", "added"],
        ]);
        expect(report.mcp).toBe("added");
        const shared = report.changes.find((c) => c.file === ".agents/skills/notato/SKILL.md");
        expect(shared?.note).toContain("read by Codex and Cursor and Gemini CLI");
        const text = formatReport(report, false);
        expect(text).toContain("registered the MCP server with Codex (codex mcp add notato)");
        expect(text).toContain(".cursor/mcp.json  (the MCP server for Cursor)");
        expect(text).toContain(
            "Set up for Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot."
        );

        const again = await runInit({
            cwd: dir,
            agents: ["cursor", "gemini", "copilot"],
            ...fakeCommands().opts,
        });
        expect(again.changes.every((c) => c.action === "unchanged")).toBe(true);
        expect(again.mcp).toBe("already");
    });

    it("points the project files at the app's binary from the agent's folder", async () => {
        const root = app();
        const appDir = appBelow(root, "web", { "node_modules/.bin/notato": "#!/bin/sh\n" });
        const { opts } = fakeCommands();
        await runInit({ cwd: appDir, agentDir: "..", agents: ["cursor", "codex"], ...opts });
        expect(json(root, ".cursor/mcp.json").mcpServers.notato).toEqual({
            command: "./web/node_modules/.bin/notato",
            args: ["dev", "--project", "shop"],
        });
    });

    it("on Windows, starts the binary's .cmd shim through cmd, with a path cmd can read", async () => {
        const root = app();
        const appDir = appBelow(root, "web", { "node_modules/.bin/notato.cmd": "@echo off\n" });
        const { opts } = fakeCommands();
        await runInit({
            cwd: appDir,
            agentDir: "..",
            agents: ["cursor"],
            platform: "win32",
            ...opts,
        });
        // `./web/…` would be read by cmd.exe as the command `.`; a .cmd shim cannot be spawned without cmd.
        expect(json(root, ".cursor/mcp.json").mcpServers.notato).toEqual({
            command: "cmd",
            args: ["/c", ".\\web\\node_modules\\.bin\\notato.cmd", "dev", "--project", "shop"],
        });
        // And init --revert still knows it as Notato's.
        expect(isNotatoEntry(json(root, ".cursor/mcp.json").mcpServers.notato)).toBe(true);
    });

    it("finds a binary hoisted to the workspace root, without a false warning", async () => {
        const root = app({ ".git/HEAD": "ref: refs/heads/main\n" });
        const appDir = appBelow(root, "packages/board");
        writeFiles(root, { "node_modules/.bin/notato": "#!/bin/sh\n" });
        const { opts } = fakeCommands();
        const report = await runInit({
            cwd: appDir,
            agentDir: "../..",
            agents: ["cursor"],
            ...opts,
        });
        expect(report.warnings.join()).not.toContain("not installed");
        expect(json(root, ".cursor/mcp.json").mcpServers.notato).toEqual({
            command: "./node_modules/.bin/notato",
            args: ["dev", "--project", "shop"],
        });
    });

    it("leaves a config with comments alone and says what to add", async () => {
        const dir = app({ ".vscode/mcp.json": '// my servers\n{ "servers": {} }\n' });
        const report = await runInit({ cwd: dir, agents: ["copilot"], ...fakeCommands().opts });
        expect(read(dir, ".vscode/mcp.json")).toBe('// my servers\n{ "servers": {} }\n');
        expect(report.mcp).toBe("failed");
        expect(report.warnings.join()).toContain(
            '.vscode/mcp.json is not plain JSON (comments?), so it was left alone; add "notato"'
        );
    });

    it("writes nothing on a dry run, but shows the files it would write", async () => {
        const dir = app();
        const { commands, opts } = fakeCommands();
        const report = await runInit({
            cwd: dir,
            dryRun: true,
            agents: ["codex", "cursor"],
            ...opts,
        });
        expect(commands).toEqual([]);
        expect(existsSync(join(dir, ".cursor"))).toBe(false);
        expect(report.changes.find((c) => c.file === ".cursor/mcp.json")).toMatchObject({
            action: "created",
        });
        expect(report.agents.find((a) => a.id === "codex")?.status).toBe("skipped");
    });

    it("says how to register by hand when an agent's command is missing", async () => {
        const report = await runInit({ cwd: app(), agents: ["codex"], which: () => null });
        expect(report.mcp).toBe("unavailable");
        expect(formatReport(report, false)).toContain("codex mcp add notato -- npx notato dev");
    });
});

describe("revert for every agent", () => {
    it("takes the server out of each project file and the skills out of each folder, and leaves Codex's shared list", async () => {
        const dir = app({
            ".vscode/mcp.json": JSON.stringify({ servers: { other: { command: "x" } } }),
        });
        await runInit({
            cwd: dir,
            agents: ["claude", "codex", "cursor", "gemini", "copilot"],
            ...fakeCommands().opts,
        });

        const { commands, opts } = fakeCommands({ code: 0, output: "Removed" });
        const report = await runRevert({ cwd: dir, ...opts });
        expect(commands).toEqual([["claude", "mcp", "remove", "notato"]]);
        expect(existsSync(join(dir, ".cursor"))).toBe(false);
        expect(existsSync(join(dir, ".gemini"))).toBe(false);
        expect(json(dir, ".vscode/mcp.json")).toEqual({ servers: { other: { command: "x" } } });
        for (const folder of [".claude", ".agents", ".github"])
            expect(existsSync(join(dir, folder))).toBe(false);
        expect(report.notes.join()).toContain("codex mcp remove notato");
        expect(formatRevertReport(report, false)).toContain(
            "removed the MCP server from Claude Code"
        );

        const codex = fakeCommands({ code: 0, output: "Removed" });
        await runRevert({ cwd: dir, agents: ["codex"], ...codex.opts });
        expect(codex.commands).toEqual([["codex", "mcp", "remove", "notato"]]);
    });

    it("reverting one agent leaves the others' skills, and a shared folder another agent still uses", async () => {
        const dir = app();
        const none = { which: () => null, run: async () => ({ code: 0, output: "" }) };
        await runInit({ cwd: dir, agents: ["claude", "cursor", "gemini"], ...none });
        const shared = join(dir, ".agents/skills/notato/SKILL.md");
        expect(existsSync(shared)).toBe(true);

        const report = await runRevert({ cwd: dir, agents: ["cursor"], ...none });
        expect(existsSync(join(dir, ".cursor"))).toBe(false);
        // Claude Code's own folder is not Cursor's to take.
        expect(existsSync(join(dir, ".claude/skills/notato/SKILL.md"))).toBe(true);
        // Gemini CLI reads .agents/skills too, and still has the server.
        expect(existsSync(shared)).toBe(true);
        expect(report.notes.join()).toContain("Gemini CLI reads them too");

        // Once nothing else that reads it is set up, it goes.
        await runRevert({ cwd: dir, agents: ["gemini"], ...none });
        expect(existsSync(shared)).toBe(false);
        expect(existsSync(join(dir, ".claude/skills/notato/SKILL.md"))).toBe(true);
    });
});
