import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parsePort, stopOnSignals } from "@notato/cli";
import { bundledUi, type UiAssets } from "@notato/server";
import { runCloud } from "@notato/service-server";

/** Where `bun run build:board` puts the cloud's board in a source checkout. */
const BOARD_DIST = fileURLToPath(new URL("../../board/dist", import.meta.url));

/**
 * The cloud's board: the folder in NOTATO_WEB_DIST when it is set (the image sets it to the board it carries), or else,
 * run from source, the last `bun run build:board`. It is chosen through the variable so that `/inject.js`, which the
 * open server reads from the same board, comes from that build too. Nothing is built into the binary.
 */
function cloudBoard(): UiAssets | null {
    if (!process.env.NOTATO_WEB_DIST && existsSync(join(BOARD_DIST, "index.html")))
        process.env.NOTATO_WEB_DIST = BOARD_DIST;
    return bundledUi();
}

const HELP = `notato-server serve

Runs Notato: Better Auth sign-in, workspaces and integrations, the HTTP API, MCP over
HTTP at /mcp, and the board at /. Records are kept in Postgres (NOTATO_DATABASE_URL) and screenshots in object
storage. It binds to loopback unless you say otherwise; put a TLS-terminating reverse proxy in front and pass
--trust-proxy. Everything else is configured with environment variables: see deploy/self-hosted/README.md, and check
them with \`notato-server preflight\` first.

Options:
  -H, --host <addr>        Interface to bind (default 127.0.0.1, or $NOTATO_HOST)
  -p, --port <n>           Port (default 4799, or $NOTATO_PORT)
  -d, --dir <path>         Working directory for local files (default ./notato-server-data, or $NOTATO_DIR)
      --admin-user <name>  Operator username (default admin, or $NOTATO_ADMIN_USER)
      --trust-proxy        Believe X-Forwarded-For and X-Forwarded-Proto ($NOTATO_TRUST_PROXY=1)
      --cors-origin <url>  Allow a browser origin to call the API; repeatable ($NOTATO_CORS_ORIGINS)
      --allow-host <name>  Only answer to this Host header; repeatable ($NOTATO_ALLOWED_HOSTS)
  -c, --config <path>      Settings file (default ./notato.config.json, or $NOTATO_CONFIG)
      --no-mcp             Refuse coding agents while this runs
  -h, --help               Show this help`;

export async function runCloudServeCommand(argv: string[], version: string): Promise<number> {
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
    const runtime = await runCloud({
        host: values.host,
        port: parsePort(values.port ?? process.env.NOTATO_PORT) ?? 4799,
        dir: values.dir ?? process.env.NOTATO_DIR ?? "./notato-server-data",
        version,
        adminUser: values["admin-user"],
        trustProxy: values["trust-proxy"] ? true : undefined,
        corsOrigins: values["cors-origin"],
        allowedHosts: values["allow-host"],
        configFile: values.config,
        mcp: values["no-mcp"] ? false : undefined,
        ui: cloudBoard(),
    });
    stopOnSignals(() => runtime.stop());
    return 0;
}
