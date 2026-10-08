import { parseArgs } from "node:util";
import { bookmarklet, consoleSnippet, scriptUrl } from "@notato/server";
import { localServer, PROJECT_ID } from "../options.ts";
import { type CommandOutput, print } from "../output.ts";

const HELP = `notato inject

Puts Notato on any page, with no install in the app and nothing to rebuild: a bookmark that loads it into the page you
are looking at, a line to paste into the browser console, or a script tag. It works with any framework, or none.
Start the server first (\`notato dev\`); the page loads its script from there.

Options:
      --server <url>    The server (default http://127.0.0.1:4747, or $NOTATO_PORT)
  -p, --project <id>    The project the notes go to (default: each page's own host and port)
      --token <token>   A project token, for a server started with \`notato serve\` ($NOTATO_TOKEN)
  -h, --help            Show this help`;

/** The command, without touching the process: what it prints comes back as data. */
export function runInject(
    argv: string[],
    env: Record<string, string | undefined> = process.env
): CommandOutput {
    try {
        const { values } = parseArgs({
            args: argv,
            options: {
                server: { type: "string" },
                project: { type: "string", short: "p" },
                token: { type: "string" },
                help: { type: "boolean", short: "h" },
            },
        });
        if (values.help) return { code: 0, stdout: HELP, stderr: "" };
        const server = (values.server ?? localServer(env)).replace(/\/$/, "");
        // A bad address is reported here, rather than by a bookmark that does nothing.
        new URL(server);
        const project = values.project;
        if (project && !PROJECT_ID.test(project))
            return {
                code: 2,
                stdout: "",
                stderr: `notato inject: "${project}" is not a project id (letters, digits and _ . @ -, not only dots)`,
            };
        const options = { project, token: values.token ?? env.NOTATO_TOKEN };
        const page = new URL("/bookmarklet", server);
        if (project) page.searchParams.set("project", project);
        if (options.token) page.searchParams.set("token", options.token);
        return {
            code: 0,
            stderr: "",
            stdout: [
                "Notato on any page. Pick one:",
                "",
                `1. A bookmark. Open this page, drag the button to your bookmarks bar, and click it on the page you want to annotate:`,
                `   ${page}`,
                "",
                "2. Paste into the browser console on the page:",
                `   ${consoleSnippet(server, options)}`,
                "",
                "3. Or add a script tag to the page's HTML while you work on it:",
                `   <script src="${scriptUrl(server, options)}"></script>`,
                "",
                "The bookmark itself, to paste into a bookmark's address field:",
                `   ${bookmarklet(server, options)}`,
                "",
                `Notes go to ${server}${project ? ` as project "${project}"` : ", each page's own host and port as its project"}.`,
                "A page that does not allow scripts from there (a Content-Security-Policy) needs the browser extension instead.",
                "For a site that is not on this machine or your network, start the server with --cors-origin <its origin>.",
            ].join("\n"),
        };
    } catch (error) {
        return {
            code: 2,
            stdout: "",
            stderr: `notato inject: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

export async function runInjectCommand(argv: string[]): Promise<number> {
    return print(runInject(argv));
}
