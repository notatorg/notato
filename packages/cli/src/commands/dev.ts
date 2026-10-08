import { parseArgs } from "node:util";
import { DEFAULT_PORT, parseProjects, runDev } from "@notato/server";
import { parsePort, wantsTunnel } from "../options.ts";
import { stopOnSignals } from "../process.ts";

const HELP = `notato dev

Runs the Notato server on loopback and speaks MCP over stdio, for any coding agent that speaks MCP.
\`npx notato init\` registers it with the agents you use; by hand it is, for example:

  claude mcp add notato -- npx notato dev     (Claude Code)
  codex mcp add notato -- npx notato dev      (Codex)
  { "mcpServers": { "notato": { "command": "npx", "args": ["notato", "dev"] } } }
                                              (.cursor/mcp.json, .gemini/settings.json, and most others)

If another \`notato dev\` already holds the port, this one attaches to it as an MCP-only client.

Several repositories can share one server. Give each repository's agent its own projects with --project, so it is
handed only their notes and never works on another app's (\`npx notato init\` writes it for you).

Options:
  -p, --port <n>        Port to bind (default ${DEFAULT_PORT}, or $NOTATO_PORT)
  -d, --dir <path>      Data directory (default ./.notato, or $NOTATO_DIR)
  -c, --config <path>   Settings file (default ./notato.config.json, or $NOTATO_CONFIG); see \`notato config\`
  -P, --project <id>    The project this agent works on; repeat it, or separate ids with commas, for several
                        ($NOTATO_PROJECT). Default: every project.
  -t, --tunnel          Also put the server behind a Microsoft dev tunnel, so a phone can reach it
                        ($NOTATO_TUNNEL=1). Needs the devtunnel CLI, signed in once (\`devtunnel user login\`).
                        The same tunnel and URL are reused every run; anything that comes through it needs the
                        device token. Both are written to <data dir>/device.json, where an app's debug build
                        picks them up.
      --standalone      Run only the server (and its tunnel), with no MCP on stdio, until stopped: one server
                        that outlives agent sessions, whose own \`notato dev\` attaches to it on the same port.
                        Agents can also connect to its /mcp. \`notato start\` (or just \`npx notato\`) is the
                        same, and says more.
      --no-mcp          With --standalone: refuse coding agents while it runs, whatever the settings say.
  -h, --help            Show this help`;

export async function runDevCommand(argv: string[], version: string): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            port: { type: "string", short: "p" },
            dir: { type: "string", short: "d" },
            config: { type: "string", short: "c" },
            tunnel: { type: "boolean", short: "t" },
            standalone: { type: "boolean" },
            "no-mcp": { type: "boolean" },
            project: { type: "string", short: "P", multiple: true },
            help: { type: "boolean", short: "h" },
        },
    });
    if (values.help) {
        console.error(HELP);
        return 0;
    }
    const projects = parseProjects(values.project);
    if (projects && values.standalone) {
        throw new Error(
            "--project keeps one agent's MCP to some projects, and --standalone has none: point each agent at /mcp?project=<id> instead"
        );
    }
    const port = parsePort(values.port);
    const standalone = values.standalone === true;
    if (values["no-mcp"] && !standalone) {
        throw new Error(
            "notato dev is the MCP server an agent starts, so --no-mcp only goes with --standalone (or use `notato start --no-mcp`)"
        );
    }
    const dev = await runDev({
        port,
        dir: values.dir,
        configFile: values.config,
        version,
        tunnel: wantsTunnel(values.tunnel),
        stdio: !standalone,
        mcp: values["no-mcp"] ? false : undefined,
        projects,
    });
    if (standalone) {
        if (dev.role !== "primary") {
            await dev.close();
            throw new Error(
                `port ${dev.port} already has a notato server: stop it first, or give this one another --port`
            );
        }
        // Closing takes the tunnel host with it.
        stopOnSignals(() => dev.close());
    }
    // The process stays alive on the HTTP server (and the stdio transport, when there is one).
    return 0;
}
