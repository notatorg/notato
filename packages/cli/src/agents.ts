import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The coding agents `init` can set Notato up for. Every one of them speaks MCP and reads Agent Skills (a folder with
 * a SKILL.md); what differs is where the MCP server is registered and which folder its skills are read from.
 */
export const AGENT_IDS = ["claude", "codex", "cursor", "gemini", "copilot"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface Agent {
    id: AgentId;
    /** As people call it. */
    name: string;
    /** Where its project skills live, relative to the folder it starts in. */
    skillsDir: string;
    /**
     * How the MCP server is registered: through the agent's own command (`claude mcp add`, `codex mcp add`), or by
     * writing its project config file.
     */
    register:
        | { kind: "command"; program: string }
        | {
              kind: "file";
              path: string;
              key: "mcpServers" | "servers";
              entry: (server: string[]) => McpEntry;
          };
}

export type McpEntry = Record<string, unknown> & { command: string; args: string[] };

const plain = (server: string[]): McpEntry => ({
    command: server[0] ?? "npx",
    args: server.slice(1),
});

export const AGENTS: Record<AgentId, Agent> = {
    claude: {
        id: "claude",
        name: "Claude Code",
        skillsDir: ".claude/skills",
        register: { kind: "command", program: "claude" },
    },
    codex: {
        id: "codex",
        name: "Codex",
        // Codex, Gemini CLI, Cursor and opencode all read the shared .agents/skills.
        skillsDir: ".agents/skills",
        register: { kind: "command", program: "codex" },
    },
    cursor: {
        id: "cursor",
        name: "Cursor",
        skillsDir: ".agents/skills",
        register: { kind: "file", path: ".cursor/mcp.json", key: "mcpServers", entry: plain },
    },
    gemini: {
        id: "gemini",
        name: "Gemini CLI",
        skillsDir: ".agents/skills",
        register: { kind: "file", path: ".gemini/settings.json", key: "mcpServers", entry: plain },
    },
    copilot: {
        id: "copilot",
        name: "GitHub Copilot",
        skillsDir: ".github/skills",
        register: {
            kind: "file",
            path: ".vscode/mcp.json",
            key: "servers",
            // VS Code starts a server in its own folder unless told otherwise; `${workspaceFolder}` is VS Code's variable.
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a VS Code variable, not a template
            entry: (server) => ({ type: "stdio", ...plain(server), cwd: "${workspaceFolder}" }),
        },
    },
};

/** Every folder `init` may have written skills to, for `--revert` to look in. */
export const SKILL_DIRS = [...new Set(Object.values(AGENTS).map((a) => a.skillsDir))];

/** Reads `--agent claude,codex` (repeatable, or `all`) into agent ids. */
export function parseAgents(values: string[] | undefined): AgentId[] | undefined {
    if (!values?.length) return undefined;
    // `codex,` or `codex, cursor` from an environment variable: the empty names are not agents.
    const ids = values
        .flatMap((v) => v.split(","))
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    if (ids.length === 0) return undefined;
    if (ids.includes("all")) return [...AGENT_IDS];
    const unknown = ids.filter((id) => !(AGENT_IDS as readonly string[]).includes(id));
    if (unknown.length)
        throw new Error(
            `--agent: unknown ${unknown.join(", ")}; choose from ${AGENT_IDS.join(", ")} or all`
        );
    return [...new Set(ids)] as AgentId[];
}

/**
 * The agents this project looks set up for: their command is installed, or their folder is in the project. Claude
 * Code when there is no sign of any, as before there was a choice.
 */
export function detectAgents(dirs: string[], which: (name: string) => string | null): AgentId[] {
    const has = (path: string) => dirs.some((d) => existsSync(join(d, path)));
    const signs: Record<AgentId, () => boolean> = {
        claude: () => Boolean(which("claude")) || has(".claude"),
        codex: () => Boolean(which("codex")) || has(".codex"),
        cursor: () => Boolean(which("cursor-agent")) || has(".cursor"),
        gemini: () => Boolean(which("gemini")) || has(".gemini"),
        copilot: () =>
            has(".vscode/mcp.json") ||
            has(".github/copilot-instructions.md") ||
            has(".github/skills"),
    };
    const found = AGENT_IDS.filter((id) => signs[id]());
    return found.length ? found : ["claude"];
}

/** The one-line command to register Notato by hand with an agent that has a command for it. */
export function manualCommand(agent: Agent, server: string[] = ["npx", "notato", "dev"]): string {
    if (agent.register.kind === "command")
        return `${agent.register.program} mcp add notato -- ${server.join(" ")}`;
    return `add "notato": ${JSON.stringify(agent.register.entry(server))} under "${agent.register.key}" in ${agent.register.path}`;
}

/** Whether a config entry is one Notato wrote: it starts `notato dev`, however it finds the binary. */
export function isNotatoEntry(entry: unknown): boolean {
    if (!entry || typeof entry !== "object") return false;
    const { command, args } = entry as { command?: unknown; args?: unknown };
    const words = [command, ...(Array.isArray(args) ? args : [])].filter(
        (w): w is string => typeof w === "string"
    );
    return words.some((w) => /(^|[/\\])notato(\.cmd)?$/.test(w)) && words.includes("dev");
}

/** The projects an entry's `notato dev` is kept to (`--project`, `-P`, repeated or comma-separated); none when empty. */
export function entryProjects(entry: McpEntry): string[] {
    const projects: string[] = [];
    entry.args.forEach((arg, i) => {
        const value =
            arg === "--project" || arg === "-P"
                ? entry.args[i + 1]
                : arg.startsWith("--project=")
                  ? arg.slice("--project=".length)
                  : undefined;
        if (value) projects.push(...value.split(",").map((p) => p.trim()));
    });
    return projects.filter(Boolean);
}

export type FileResult =
    | { state: "added" | "already"; changed: boolean; source: string; note?: string }
    | { state: "unreadable"; changed: false; reason: string };

/**
 * Adds Notato's server to an agent's JSON config, keeping everything else in it. With `project`, a server init wrote
 * before is kept to that project too: another app in the same repository adds its own, and one from before projects
 * could be named (handed every project's notes) is kept to this one.
 */
export function addToAgentConfig(
    existing: string | null,
    key: string,
    entry: McpEntry,
    project?: string
): FileResult {
    let config: Record<string, unknown> = {};
    if (existing?.trim()) {
        try {
            config = JSON.parse(existing) as Record<string, unknown>;
        } catch {
            return {
                state: "unreadable",
                changed: false,
                reason: "is not plain JSON (comments?), so it was left alone",
            };
        }
        if (!config || typeof config !== "object" || Array.isArray(config))
            return {
                state: "unreadable",
                changed: false,
                reason: "is not a JSON object, so it was left alone",
            };
    }
    const servers = (config[key] ?? {}) as Record<string, unknown>;
    if (typeof servers !== "object" || Array.isArray(servers))
        return {
            state: "unreadable",
            changed: false,
            reason: `its "${key}" is not an object, so it was left alone`,
        };
    const current = servers.notato;
    if (current !== undefined) {
        const same = JSON.stringify(current) === JSON.stringify(entry);
        if (!same && project && isNotatoEntry(current)) {
            const ours = current as McpEntry;
            const before = entryProjects(ours);
            if (before.includes(project))
                return { state: "already", changed: false, source: existing ?? "" };
            const next = {
                ...config,
                [key]: {
                    ...servers,
                    notato: { ...ours, args: [...ours.args, "--project", project] },
                },
            };
            return {
                state: "already",
                changed: true,
                source: `${JSON.stringify(next, null, 2)}\n`,
                note: before.length
                    ? `the notato server now works on ${project} too`
                    : `the notato server is now kept to ${project}`,
            };
        }
        return {
            state: "already",
            changed: false,
            source: existing ?? "",
            note: same
                ? undefined
                : `already has a notato server, kept as it is${project ? `; add "--project", "${project}" to its args to keep it to this project` : ""}`,
        };
    }
    const next = { ...config, [key]: { ...servers, notato: entry } };
    return { state: "added", changed: true, source: `${JSON.stringify(next, null, 2)}\n` };
}

/** Takes Notato's server back out of an agent's JSON config, if it is the one Notato wrote. */
export function removeFromAgentConfig(
    existing: string,
    key: string
): { changed: boolean; source: string; empty: boolean; reason?: string } {
    let config: Record<string, unknown>;
    try {
        config = JSON.parse(existing) as Record<string, unknown>;
    } catch {
        return {
            changed: false,
            source: existing,
            empty: false,
            reason: "is not plain JSON, so it was left alone",
        };
    }
    const servers = config?.[key] as Record<string, unknown> | undefined;
    if (!servers || typeof servers !== "object" || servers.notato === undefined)
        return { changed: false, source: existing, empty: false, reason: "not set up" };
    if (!isNotatoEntry(servers.notato))
        return {
            changed: false,
            source: existing,
            empty: false,
            reason: "its notato server is not one init wrote, so it was left alone",
        };
    const { notato: _gone, ...rest } = servers;
    const next: Record<string, unknown> = { ...config, [key]: rest };
    if (Object.keys(rest).length === 0) delete next[key];
    return {
        changed: true,
        source: `${JSON.stringify(next, null, 2)}\n`,
        empty: Object.keys(next).length === 0,
    };
}

/** What happened to one agent's MCP registration. */
export interface AgentRegistration {
    id: AgentId;
    name: string;
    status: "added" | "already" | "removed" | "skipped" | "unavailable" | "failed";
    /** The config file, for the agents registered by file, relative to where the command ran. */
    file?: string;
    detail?: string;
}

/** Writes or rewrites a config file, making its folder if needed. */
export function writeConfig(path: string, source: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
}

/** Deletes a config file that is now empty, and its folder when nothing else is in it. */
export function deleteConfig(path: string) {
    rmSync(path);
    try {
        rmdirSync(dirname(path));
    } catch {
        // the folder has other things in it, which are not ours
    }
}

export const readIfExists = (path: string) =>
    existsSync(path) ? readFileSync(path, "utf8") : null;
