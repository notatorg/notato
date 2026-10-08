import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Authenticator, SqliteStore, UnknownProjectError } from "@notato/server";

const HELP = `notato token

Manage project tokens directly in the data directory, for setting up a server without a browser.

  notato token create <project|*> [--name <label>]   Print a new token (shown once)
  notato token list                                  List tokens, without their secrets
  notato token revoke <id>                           Stop a token working

A token for one project lets an app's SDK use that project; a token for * is for your agent over MCP. A project
must exist first: \`notato project create <id>\` creates one and prints its first token.

Options:
  -n, --name <label>   A name to recognise the token by
  -d, --dir <path>     Data directory (default ./.notato, or $NOTATO_DIR)
  -h, --help           Show this help`;

/** A project id as the server takes it (never only dots), or `*`. */
const PROJECT = /^(\*|(?!\.+$)[\w.@-]{1,128})$/;

export async function runTokenCommand(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            name: { type: "string", short: "n" },
            dir: { type: "string", short: "d" },
            help: { type: "boolean", short: "h" },
        },
    });
    const [action, arg] = positionals;
    if (values.help || !action) {
        console.log(HELP);
        return values.help ? 0 : 1;
    }

    const dir = resolve(values.dir ?? process.env.NOTATO_DIR ?? join(process.cwd(), ".notato"));
    mkdirSync(dir, { recursive: true });
    const store = new SqliteStore(join(dir, "notato.db"));
    const auth = new Authenticator(store);
    try {
        if (action === "create") {
            if (!arg || !PROJECT.test(arg))
                throw new Error(
                    "give a project id (letters, digits, . _ @ -) or * for all projects"
                );
            const name = values.name?.trim() || `cli ${new Date().toISOString().slice(0, 10)}`;
            const { token, record } = await auth.issueToken(arg, name).catch((error) => {
                if (!(error instanceof UnknownProjectError)) throw error;
                throw new Error(
                    `there is no project "${arg}" in ${dir}: create it first with \`notato project create ${arg}\`, which also prints its first token`
                );
            });
            console.log(token);
            console.error(
                `created token "${name}" for ${arg === "*" ? "all projects" : `project ${arg}`} (id ${record.id}); it is shown once`
            );
            return 0;
        }
        if (action === "list") {
            const tokens = await auth.listTokens();
            if (tokens.length === 0) console.log("no tokens");
            for (const t of tokens) {
                console.log(
                    [
                        t.id,
                        t.projectId,
                        JSON.stringify(t.name),
                        t.createdAt,
                        t.lastUsedAt ? `used ${t.lastUsedAt}` : "never used",
                        t.revokedAt ? "REVOKED" : "",
                    ]
                        .filter(Boolean)
                        .join("\t")
                );
            }
            return 0;
        }
        if (action === "revoke") {
            if (!arg) throw new Error("give the token id from `notato token list`");
            if (!(await auth.revokeToken(arg))) throw new Error(`no active token with id ${arg}`);
            console.error(`revoked ${arg}`);
            return 0;
        }
        throw new Error(`unknown token command "${action}"\n\n${HELP}`);
    } finally {
        store.close();
    }
}
