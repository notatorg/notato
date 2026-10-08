import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Authenticator, FileBlobStore, LocalBackend, SqliteStore } from "@notato/server";

const HELP = `notato project

Manage projects directly in the data directory, for setting up a server without a browser. A shared server
(\`notato serve\`) only takes notes, bundles and tokens for projects created on it; \`notato dev\` creates a
project on its first note.

  notato project create <id> [--name <name>]   Create a project and print its first app token (shown once)
  notato project list                          List the projects, with their notes
  notato project rename <id> <name>            Change what a project is called (its id stays)
  notato project delete <id> [--yes]           Delete a project with its notes, bundles and screenshots,
                                               and stop its tokens working

An app's SDK uses the token printed by create (pass it as the SDK's token). More tokens: \`notato token\`.

Options:
  -n, --name <name>   What people call the project (default: its id)
  -y, --yes           Delete without asking
  -d, --dir <path>    Data directory (default ./.notato, or $NOTATO_DIR)
  -h, --help          Show this help`;

/** What the server accepts: letters, digits and `_ . @ -`, but never only dots. */
const PROJECT_ID = /^(?!\.+$)[\w.@-]{1,128}$/;

export interface ProjectCommandOptions {
    /** Asks the person to confirm. Absent when there is no terminal to ask in. */
    confirm?: (question: string) => Promise<boolean>;
}

async function terminalConfirm(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
        rl.close();
    }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function runProjectCommand(
    argv: string[],
    options: ProjectCommandOptions = {}
): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            name: { type: "string", short: "n" },
            yes: { type: "boolean", short: "y" },
            dir: { type: "string", short: "d" },
            help: { type: "boolean", short: "h" },
        },
    });
    const [action, id, ...rest] = positionals;
    if (values.help || !action) {
        console.log(HELP);
        return values.help ? 0 : 1;
    }
    if (!["create", "list", "rename", "delete"].includes(action))
        throw new Error(`unknown project command "${action}"\n\n${HELP}`);
    if (action !== "list" && (!id || !PROJECT_ID.test(id)))
        throw new Error("give a project id: letters, digits and _ . @ - (not only dots)");
    const project = id as string;

    const dir = resolve(values.dir ?? process.env.NOTATO_DIR ?? join(process.cwd(), ".notato"));
    mkdirSync(dir, { recursive: true });
    const store = new SqliteStore(join(dir, "notato.db"));
    const backend = new LocalBackend(store, new FileBlobStore(join(dir, "assets")));
    const auth = new Authenticator(store);
    try {
        if (action === "create") {
            const created = await backend.createProject(project, values.name);
            if (!created)
                throw new Error(
                    `a project with id "${project}" already exists in ${dir} (another token for it: notato token create ${project})`
                );
            // An app on a shared server cannot send without a token, so the first one comes with the project.
            const { token, record } = await auth.issueToken(project, `${created.name} app`);
            console.log(token);
            console.error(
                `created project ${project}${created.name === project ? "" : ` ("${created.name}")`} in ${dir}, with its first app token (id ${record.id}); the token is shown once`
            );
            return 0;
        }
        if (action === "list") {
            const projects = await store.listProjects();
            if (projects.length === 0) console.log("no projects");
            for (const p of projects) {
                console.log(
                    [
                        p.id,
                        JSON.stringify(p.name),
                        `${plural(p.annotations, "note")} (${p.open} open)`,
                        `created ${p.createdAt}`,
                        `last activity ${p.lastActivityAt}`,
                    ].join("\t")
                );
            }
            return 0;
        }
        if (action === "rename") {
            const name = rest.join(" ") || values.name;
            if (!name?.trim())
                throw new Error("give the new name: notato project rename <id> <name>");
            const renamed = await backend.renameProject(project, name);
            if (!renamed) throw new Error(`no project "${project}" in ${dir}`);
            console.error(`renamed project ${project} to "${renamed.name}"`);
            return 0;
        }

        // delete
        const found = (await store.listProjects()).find((p) => p.id === project);
        if (!found) throw new Error(`no project "${project}" in ${dir}`);
        const bundles = (await store.listBundles(project)).length;
        const tokens = (await auth.listTokens()).filter(
            (t) => t.projectId === project && !t.revokedAt
        ).length;
        const what = [
            `${plural(found.annotations, "note")} (${found.open} open) and their screenshots`,
            ...(bundles ? [plural(bundles, "imported bundle")] : []),
        ].join(", ");
        const goes = `project ${project}${found.name === project ? "" : ` ("${found.name}")`} with ${what}`;
        const stops = (done: boolean) =>
            tokens === 0
                ? ""
                : `; ${tokens === 1 ? "its token" : `its ${tokens} tokens`} ${done ? `no longer work${tokens === 1 ? "s" : ""}` : "will stop working"}`;
        if (!values.yes) {
            const confirm =
                options.confirm ??
                (process.stdin.isTTY && process.stdout.isTTY ? terminalConfirm : undefined);
            if (!confirm)
                throw new Error(
                    `this deletes ${goes}${stops(false)}. There is no terminal to ask in: pass --yes to delete it`
                );
            if (!(await confirm(`Delete ${goes}${stops(false)}? This cannot be undone.`))) {
                console.error("nothing was deleted");
                return 1;
            }
        }
        await backend.deleteProject(project);
        await store.revokeProjectTokens(project, new Date().toISOString());
        console.error(`deleted ${goes}${stops(true)}`);
        return 0;
    } finally {
        store.close();
    }
}
