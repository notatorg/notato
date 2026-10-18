import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    createMcpServer,
    DEFAULT_PORT,
    parseProjects,
    RemoteBackend,
    runDev,
} from "@notato/server";
import {
    connectionRoot,
    selectedConnection,
    verifyConnection,
    watchConnection,
} from "../connection.ts";
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
      --server <url>    Connect this local agent to an existing server over HTTPS; no local fallback
      --token <token>   Agent credential (prefer $NOTATO_AGENT_TOKEN)
      --connection-root <path>  Read this checkout's private connection profile (default current checkout)
  -p, --port <n>        Port to bind (default ${DEFAULT_PORT}, or $NOTATO_PORT)
  -d, --dir <path>      Data directory (default ./.notato, or $NOTATO_DIR)
  -c, --config <path>   Settings file (default ./notato.config.json, or $NOTATO_CONFIG); see \`notato config\`
  -P, --project <id>    The project this agent works on; repeat it, or separate ids with commas, for several
                        ($NOTATO_PROJECT). Default: every project.
  -t, --tunnel          Also put the server behind a Microsoft dev tunnel, so a phone can reach it
                        ($NOTATO_TUNNEL=1). Needs the devtunnel CLI, signed in once (\`devtunnel user login\`).
                        The same tunnel and URL are reused every run; anything that comes through it needs the
                        device token. Both are written to <data dir>/device.json, where an app's debug build
                        picks them up. The token reaches only what an app does: never the settings, webhooks,
                        projects or tokens, which are changed on this machine.
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
            server: { type: "string" },
            token: { type: "string" },
            "connection-root": { type: "string" },
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
    const root = connectionRoot(resolve(values["connection-root"] ?? process.cwd()));
    const profile = selectedConnection(root);
    if (
        profile &&
        (values.server ||
            values.token ||
            values.tunnel ||
            values.standalone ||
            values["no-mcp"] ||
            values.dir ||
            values.config)
    )
        throw new Error(
            "This checkout has a connection profile. Use notato dev without manual server, credential or local-runtime overrides; select the destination with notato connection use."
        );
    if (
        profile &&
        values.port &&
        Number(values.port) !== Number(new URL(profile.server).port || 80)
    )
        throw new Error(
            "The port differs from the checkout profile. Update the local connection profile."
        );
    if (profile) {
        await verifyConnection(profile);
        if (JSON.stringify(selectedConnection(root)) !== JSON.stringify(profile))
            throw new Error("Connection changed during verification. Restart the MCP connection.");
        console.error(
            `[notato] ${profile.name} · ${profile.server}${profile.context ? ` · ${profile.context.name}` : ""}`
        );
        if (profile.mode === "remote") {
            values.server = profile.server;
            values.token = profile.agentToken;
        }
    }
    const projects = profile?.project ? [profile.project] : parseProjects(values.project);
    const followProfile = (close: () => Promise<void>) => {
        let stopping = false;
        const off = watchConnection(root, () => {
            if (stopping) return;
            stopping = true;
            off();
            console.error(
                "[notato] Checkout connection changed. Stop previous edits and reconnect Notato MCP before continuing."
            );
            void close().finally(() => process.exit(0));
        });
    };
    if (values.server) {
        const url = new URL(values.server);
        if (
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (url.protocol !== "https:" &&
                !(
                    url.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
                ))
        )
            throw new Error("Use an HTTPS server origin (HTTP is allowed on loopback). ");
        if (values.standalone || values.tunnel || values["no-mcp"])
            throw new Error("Remote agent mode cannot start a local server or tunnel.");
        const backend = new RemoteBackend(
            url.href.replace(/\/$/, ""),
            values.token ?? process.env.NOTATO_AGENT_TOKEN
        );
        backend.agentProjects = projects;
        const mcp = createMcpServer({
            backend,
            version,
            projects,
            allowImportPaths: false,
            onClient: (name) => {
                backend.agentName = name;
            },
        });
        await mcp.connect(new StdioServerTransport());
        followProfile(() => mcp.close());
        stopOnSignals(() => mcp.close());
        return 0;
    }

    if (projects && values.standalone) {
        throw new Error(
            "--project keeps one agent's MCP to some projects, and --standalone has none: point each agent at /mcp?project=<id> instead"
        );
    }
    const port = profile ? Number(new URL(profile.server).port || 80) : parsePort(values.port);
    const standalone = values.standalone === true;
    if (values["no-mcp"] && !standalone) {
        throw new Error(
            "notato dev is the MCP server an agent starts, so --no-mcp only goes with --standalone (or use `notato start --no-mcp`)"
        );
    }
    const dev = await runDev({
        port,
        dir: values.dir ?? (profile ? resolve(root, ".notato") : undefined),
        configFile: values.config ?? (profile ? resolve(root, "notato.config.json") : undefined),
        version,
        tunnel: profile ? false : wantsTunnel(values.tunnel),
        stdio: !standalone,
        mcp: values["no-mcp"] ? false : undefined,
        projects,
    });
    followProfile(() => dev.close());
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
