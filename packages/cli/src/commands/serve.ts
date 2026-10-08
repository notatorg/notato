import { parseArgs } from "node:util";
import { bundledUi, DEFAULT_PORT, runServe } from "@notato/server";

const HELP = `notato serve

Runs the shared Notato server: login, per-project tokens, the HTTP API, MCP over streamable HTTP at /mcp,
and the board UI at /. It binds to loopback unless you say otherwise; to expose it, put a TLS-terminating
reverse proxy in front and pass --trust-proxy.

Options:
  -H, --host <addr>        Interface to bind (default 127.0.0.1, or $NOTATO_HOST)
  -p, --port <n>           Port (default ${DEFAULT_PORT}, or $NOTATO_PORT)
  -d, --dir <path>         Data directory (default ./.notato, or $NOTATO_DIR)
      --admin-user <name>  Admin username (default admin, or $NOTATO_ADMIN_USER)
      --trust-proxy        Believe X-Forwarded-For and X-Forwarded-Proto ($NOTATO_TRUST_PROXY=1)
      --cors-origin <url>  Allow a browser origin to call the API; repeatable ($NOTATO_CORS_ORIGINS)
      --allow-host <name>  Only answer to this Host header; repeatable ($NOTATO_ALLOWED_HOSTS)
  -c, --config <path>      Settings file (default ./notato.config.json, or $NOTATO_CONFIG); see \`notato config\`
      --no-mcp             Refuse coding agents while this runs: /mcp and the agent tokens (for *), whatever the
                           settings say. To switch them off and on as you go, use the board (Settings › Agents)
  -h, --help               Show this help

The admin password comes from $NOTATO_ADMIN_PASSWORD. If it is not set, one is generated and printed once.

Apps can only send notes to projects created on this server. Create a project on the board (Projects) or with
\`notato project create <id>\` (with the same --dir), which prints its token for the app. More tokens:
\`notato token create <project>\`, and \`notato token create "*"\` for your agent over MCP.`;

export async function runServeCommand(argv: string[], version: string): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            host: { type: "string", short: "H" },
            port: { type: "string", short: "p" },
            dir: { type: "string", short: "d" },
            "admin-user": { type: "string" },
            "trust-proxy": { type: "boolean" },
            "cors-origin": { type: "string", multiple: true },
            "allow-host": { type: "string", multiple: true },
            config: { type: "string", short: "c" },
            "no-mcp": { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        throw new Error(`--port must be a number between 0 and 65535, got "${values.port}"`);
    }

    const runtime = await runServe({
        host: values.host,
        port,
        dir: values.dir,
        version,
        adminUser: values["admin-user"],
        trustProxy: values["trust-proxy"] ? true : undefined,
        corsOrigins: values["cors-origin"],
        allowedHosts: values["allow-host"],
        configFile: values.config,
        mcp: values["no-mcp"] ? false : undefined,
        ui: bundledUi(),
    });
    const stop = () => void runtime.stop().finally(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // The server keeps the process alive.
    return 0;
}
