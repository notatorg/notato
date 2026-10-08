import { parseArgs } from "node:util";
import { type McpScope, parseAgents } from "../agents.ts";
import { runInit } from "../init/init.ts";
import { formatReport, formatRevertReport } from "../init/report.ts";
import { runRevert } from "../init/revert.ts";
import { isInteractive, terminalPrompt } from "../terminal.ts";

const HELP = `notato init

Sets up Notato in a React app: adds <Notato /> behind a development-only guard (Vite or Next.js), ignores
.notato/ in git, and sets up your coding agents: registers the MCP server and writes the skills that teach the
loop. Works with Claude Code, Codex, Cursor, Gemini CLI and GitHub Copilot, and finds the ones you use (their
command is installed, or their folder is in the project). Safe to run twice.

Run it after: npm i -D notato @notato/react   (in the app you are setting up)

In a repo with several React apps it works out which one to use: a Module Federation host (the app that loads
the others) wins, since every module it loads inherits the toolbar. If it cannot tell, it asks; with no terminal
it stops and lists the choices.

Options:
      --app <dir>         The app to set up, relative to here (default: here, or the one it works out)
      --agent <list>      Which agents to set up: claude, codex, cursor, gemini, copilot, or all (comma-separated
                          or repeated; default: the ones it finds). Also NOTATO_AGENTS=codex,cursor
      --agent-dir <dir>   Where you start your agent, if not here (default: here). The MCP server is registered
                          for that directory and keeps its data there (--claude-dir is an alias)
  -y, --yes               Take the recommended choice instead of asking
      --force             Set up an app even if its federation host should have the toolbar
      --server <url>      Where the dev server listens (default http://localhost:4747)
      --project <id>      Project id (default: the package name, or the repo name for a federation host)
      --guard <g>         dev: render only under \`vite dev\`. env: also in a build made with VITE_NOTATO=true
                          (the default for apps that run \`vite build --watch\` + \`vite preview\`)
      --revert            Undo init instead: take the toolbar out of the app's code, remove the .gitignore lines
                          and the skills it added, and the MCP server from the agents' project settings and
                          Claude Code. Your recorded annotations are kept. Works with --dry-run, --app,
                          --agent, --agent-dir, --no-mcp and --mcp-scope
      --plugin            Also wire the Vite plugin (@notato/vite) into the Vite config, so the exact file and line
                          of an element is recorded even in a built app. In a repo of several apps it goes into
                          every Vite app, since each module is built separately. Only active when VITE_NOTATO=true
      --plugin-only       Just the Vite plugin, nothing else: for a module that gets its toolbar from its host
                          (--app <dir> for one app)
      --no-mcp            Do not register the MCP server with any agent
      --no-skill          Do not write the skills (notato and notato-critique) that teach the agent the loop
      --mcp-scope <s>     For Claude Code: local (default), project (writes .mcp.json for the team), or user
      --dry-run           Show what would change without writing anything
  -C, --cwd <path>        Treat this as the current directory
  -h, --help              Show this help`;

export async function runInitCommand(argv: string[]): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            app: { type: "string" },
            agent: { type: "string", multiple: true },
            "agent-dir": { type: "string" },
            "claude-dir": { type: "string" },
            yes: { type: "boolean", short: "y" },
            force: { type: "boolean" },
            server: { type: "string" },
            project: { type: "string" },
            mcp: { type: "boolean", default: true },
            "no-mcp": { type: "boolean" },
            plugin: { type: "boolean" },
            "plugin-only": { type: "boolean" },
            skill: { type: "boolean", default: true },
            "no-skill": { type: "boolean" },
            "mcp-scope": { type: "string" },
            guard: { type: "string" },
            "dry-run": { type: "boolean" },
            revert: { type: "boolean" },
            cwd: { type: "string", short: "C" },
            help: { type: "boolean", short: "h" },
        },
        allowNegative: true,
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    const guard = values.guard;
    if (guard !== undefined && !["dev", "env"].includes(guard))
        throw new Error("--guard must be dev or env");
    const scope = values["mcp-scope"];
    if (scope !== undefined && !["local", "project", "user"].includes(scope))
        throw new Error("--mcp-scope must be local, project or user");
    const dryRun = Boolean(values["dry-run"]);
    const common = {
        cwd: values.cwd ?? process.cwd(),
        app: values.app,
        agentDir: values["agent-dir"] ?? values["claude-dir"],
        agents: parseAgents(values.agent),
        dryRun,
        mcp: values["no-mcp"] ? false : values.mcp,
        mcpScope: scope as McpScope | undefined,
        prompt: isInteractive() ? terminalPrompt : undefined,
    };
    if (values.revert) {
        const reverted = await runRevert(common);
        console.log(formatRevertReport(reverted, dryRun));
        return reverted.warnings.length > 0 || reverted.mcp === "failed" ? 1 : 0;
    }
    const report = await runInit({
        ...common,
        yes: values.yes,
        force: values.force,
        server: values.server,
        project: values.project,
        skill: values["no-skill"] ? false : values.skill,
        plugin: values.plugin,
        pluginOnly: values["plugin-only"],
        guard: guard as "dev" | "env" | undefined,
    });
    console.log(formatReport(report, dryRun));
    // Nothing to do (the host already has the toolbar) is a success, said in the notes.
    const nothingToDo = report.notes.length > 0 && report.changes.length === 0;
    return (report.framework === "unknown" && !nothingToDo) || report.mcp === "failed" ? 1 : 0;
}
