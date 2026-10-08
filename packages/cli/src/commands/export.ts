import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DETAILS } from "@notato/core";
import { Intent, Status } from "@notato/schema";
import { localServer } from "../options.ts";

const HELP = `notato export

Prints annotations as Markdown, to paste into an agent, an issue or a pull request. It reads from a running
Notato server, so start one first (\`notato dev\` or \`notato serve\`).

Options:
  -p, --project <id>    Which project (default: the only one the server has)
  -d, --detail <level>  ${DETAILS.join(", ")} (default standard)
  -s, --status <list>   Only these statuses, comma separated: ${Status.options.join(",")}
  -i, --intent <list>   Only these intents: ${Intent.options.join(",")}
  -b, --by <name>       Only what this person wrote (the name on their notes)
      --route <path>    Only annotations on this route
  -o, --out <file>      Write to a file instead of printing
      --server <url>    The server (default http://127.0.0.1:4747, or $NOTATO_PORT)
      --token <token>   A project token, for a server started with \`notato serve\` ($NOTATO_TOKEN)
  -h, --help            Show this help

Detail levels:
  compact    A line each, to scan many
  standard   What it takes to find and fix the thing
  detailed   Adds how it looks (computed styles), where it sits, animations, the environment
  forensic   Everything captured: the full console and network, and the identity as recorded`;

export interface ExportOptions {
    server: string;
    token?: string;
    project?: string;
    detail?: string;
    status?: string;
    intent?: string;
    by?: string;
    route?: string;
    fetch?: typeof fetch;
}

/** The Markdown for a project. Throws a message when the server cannot give it. */
export async function exportMarkdown(options: ExportOptions): Promise<string> {
    const base = options.server.replace(/\/$/, "");
    const http = options.fetch ?? fetch;
    const headers: Record<string, string> = options.token
        ? { Authorization: `Bearer ${options.token}` }
        : {};
    const get = async (path: string) => {
        let res: Response;
        try {
            res = await http(`${base}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
        } catch {
            throw new Error(
                `cannot reach a Notato server at ${base}. Start one with \`notato dev\`, or pass --server.`
            );
        }
        if (res.status === 401 || res.status === 403)
            throw new Error(
                `the server at ${base} refused this (${res.status}). Pass a project token with --token.`
            );
        if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? `the server answered ${res.status}`);
        }
        return res;
    };

    let project = options.project;
    if (!project) {
        const { items } = (await (await get("/projects")).json()) as {
            items: Array<{ id: string }>;
        };
        if (items.length === 0) throw new Error("the server has no annotations yet");
        if (items.length > 1)
            throw new Error(
                `which project? The server has: ${items.map((p) => p.id).join(", ")}. Pass --project.`
            );
        project = items[0]?.id;
    }
    if (options.detail && !(DETAILS as readonly string[]).includes(options.detail))
        throw new Error(`--detail must be one of ${DETAILS.join(", ")}`);

    const query = new URLSearchParams();
    if (options.detail) query.set("detail", options.detail);
    if (options.status) query.set("status", options.status);
    if (options.intent) query.set("intent", options.intent);
    if (options.by) query.set("by", options.by);
    if (options.route) query.set("route", options.route);
    return await (
        await get(`/projects/${encodeURIComponent(project ?? "")}/markdown?${query}`)
    ).text();
}

export async function runExportCommand(argv: string[]): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            project: { type: "string", short: "p" },
            detail: { type: "string", short: "d" },
            status: { type: "string", short: "s" },
            intent: { type: "string", short: "i" },
            by: { type: "string", short: "b" },
            route: { type: "string" },
            out: { type: "string", short: "o" },
            server: { type: "string" },
            token: { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    try {
        const markdown = await exportMarkdown({
            server: values.server ?? localServer(),
            token: values.token ?? process.env.NOTATO_TOKEN,
            project: values.project,
            detail: values.detail,
            status: values.status,
            intent: values.intent,
            by: values.by,
            route: values.route,
        });
        if (values.out) {
            writeFileSync(resolve(values.out), `${markdown}\n`);
            console.error(`Wrote ${resolve(values.out)}`);
        } else console.log(markdown);
        return 0;
    } catch (error) {
        console.error(`notato export: ${error instanceof Error ? error.message : error}`);
        return 1;
    }
}
