import { parseArgs } from "node:util";
import { DEFAULT_PORT, localUrl, mcpRefusal, runDev } from "@notato/server";
import { parsePort, wantsTunnel } from "../options.ts";
import { stopOnSignals } from "../process.ts";

const HELP = `notato start

Runs Notato on this machine until you stop it: the server, the board, and MCP for your coding agents.
\`npx notato\` with no command does the same.

Point any coding agent at the MCP address it prints. On this machine it needs no token, for example:

  claude mcp add --transport http notato http://localhost:${DEFAULT_PORT}/mcp

The board's Settings › Agents has the line for Codex, Cursor, Gemini CLI and VS Code. Only programs on this
machine can use the MCP: never a web page, and never through the dev tunnel.

Options:
  -p, --port <n>       Port to bind (default ${DEFAULT_PORT}, or $NOTATO_PORT)
  -d, --dir <path>     Data directory (default ./.notato, or $NOTATO_DIR)
  -c, --config <path>  Settings file (default ./notato.config.json, or $NOTATO_CONFIG); see \`notato config\`
  -t, --tunnel         Also put it behind a Microsoft dev tunnel, so a phone can reach it ($NOTATO_TUNNEL=1).
                       Needs the devtunnel CLI, signed in once (\`devtunnel user login\`).
      --no-mcp         Refuse coding agents while this runs, whatever the settings say. To switch them off
                       and on as you go, use the board (Settings › Agents) or \`notato config set mcp off\`.
  -h, --help           Show this help`;

/** What `/mcp` on an already running server says about itself, to tell an old server from one with MCP off. */
async function probeMcp(base: string): Promise<"on" | "off" | "missing" | "unknown"> {
    try {
        const res = await fetch(`${base}/mcp`, { signal: AbortSignal.timeout(1500) });
        // No session: "send an initialize request first". The endpoint is there and open.
        if (res.status === 400 || res.status === 405) return "on";
        if (res.status === 403) return "off";
        if (res.status === 404) return "missing";
    } catch {
        // fall through
    }
    return "unknown";
}

export async function runStartCommand(argv: string[], version: string): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            port: { type: "string", short: "p" },
            dir: { type: "string", short: "d" },
            config: { type: "string", short: "c" },
            tunnel: { type: "boolean", short: "t" },
            "no-mcp": { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    // Its own lines go to stdout below; the server's log stays on stderr.
    const dev = await runDev({
        port: parsePort(values.port),
        dir: values.dir,
        configFile: values.config,
        version,
        tunnel: wantsTunnel(values.tunnel),
        stdio: false,
        mcp: values["no-mcp"] ? false : undefined,
    });
    const base = localUrl(dev.port);

    if (dev.role !== "primary") {
        // Another notato already serves this port (another `npx notato`, or an agent's own `notato dev`): use that one.
        const mcp = await probeMcp(base);
        await dev.close();
        console.log(`Notato is already running on port ${dev.port}.\n`);
        console.log(`  Board  ${base}`);
        if (mcp === "on") console.log(`  MCP    ${base}/mcp`);
        else if (mcp === "off") console.log("  MCP    turned off (Settings › Agents on the board)");
        else if (mcp === "missing")
            console.log(
                "  MCP    not served: that server is an older Notato. Stop it and run this again."
            );
        console.log(`\nTo run a second one, give it another --port.`);
        return 0;
    }

    const settings = dev.local?.config();
    const refusal = settings ? mcpRefusal(settings) : null;
    const lines = [
        "Notato is running.",
        "",
        `  Board  ${base}`,
        refusal ? `  MCP    off. ${refusal}` : `  MCP    ${base}/mcp`,
        `  Data   ${dev.dir}`,
    ];
    if (!refusal) {
        lines.push(
            "",
            "Connect your coding agent to the MCP address. On this machine it needs no token:",
            `  claude mcp add --transport http notato ${base}/mcp`,
            "Codex, Cursor, Gemini CLI and VS Code: Settings › Agents on the board."
        );
    }
    lines.push("", "Press Ctrl+C to stop.");
    console.log(lines.join("\n"));

    if (dev.tunnel) {
        void dev.tunnel.ready.then((url) => {
            if (url)
                console.log(`\n  Phones ${url} (the device token is in ${dev.dir}/device.json)`);
        });
    }

    // Closing takes the tunnel host with it.
    stopOnSignals(() => dev.close());
    return 0;
}
