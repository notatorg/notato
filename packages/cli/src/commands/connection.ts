import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type CheckoutConnection, parseCheckoutConnection } from "@notato/core";
import { DEFAULT_PORT } from "@notato/server";
import {
    checkName,
    connectionRoot,
    readConnections,
    verifyConnection,
    writeConnections,
} from "../connection.ts";
import { type CommandOutput, collectOutput, print } from "../output.ts";

const HELP = `notato connection

One private profile per checkout configures both the app and coding agent.

  notato connection import <download.json> --name cloud  Verify and select a downloaded checkout connection
  notato connection local [--project <id>] [--port <n>]  Configure and select the local destination
  notato connection use <name>                          Select a saved destination
  notato connection                                    Show destinations without printing keys
  notato run -- npm run dev                            Launch your app with the selected connection

Options: --cwd <path>, --name <name>, --project <id>, --port <n>, --help

Profiles live in the Git-ignored .notato.connection.json with owner-only permissions.
Download a connection from Team and checkouts → Set up app and agent.
Keep your agent registered with notato dev; it reads the same checkout profile.
Switching restarts an app launched by notato run and disconnects old MCP sessions;
reconnect/restart the agent's Notato MCP connection before continuing. Existing history stays at its destination.`;
export async function runConnection(
    argv: string[],
    cwd = process.cwd(),
    request: import("../connection.ts").ConnectionFetch = fetch
): Promise<CommandOutput> {
    const { out, err, done } = collectOutput();
    try {
        const { values, positionals } = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                cwd: { type: "string" },
                name: { type: "string" },
                project: { type: "string" },
                port: { type: "string" },
                help: { type: "boolean", short: "h" },
            },
        });
        if (values.help) {
            out.push(HELP);
            return done(0);
        }
        const root = connectionRoot(resolve(cwd, values.cwd ?? "."));
        const saved = readConnections(root),
            original = JSON.stringify(saved);
        const data = saved ?? {
            version: 1 as const,
            active: "local",
            profiles: {
                local: parseCheckoutConnection({
                    version: 1 as const,
                    name: "Local",
                    mode: "local" as const,
                    server: `http://127.0.0.1:${process.env.NOTATO_PORT ?? DEFAULT_PORT}`,
                }),
            },
        };
        const [action = "show", argument] = positionals;
        if (action === "show" || action === "list") {
            for (const [id, c] of Object.entries(data.profiles))
                out.push(
                    `${id === data.active ? "*" : " "} ${id}: ${c.mode === "local" ? "Local" : c.name} · ${c.server}${c.project ? ` · ${c.project}` : ""}${c.context ? ` · ${c.context.name}` : ""}`
                );
            out.push("App and agent use the selected profile. Keys are never printed.");
            return done(0);
        }
        let name: string, c: CheckoutConnection;
        if (action === "import") {
            if (!argument) throw new Error("Supply the downloaded connection JSON file.");
            name = values.name ?? "cloud";
            checkName(name);
            if (name === "local")
                throw new Error(
                    "Keep local for the local connection; choose another profile name."
                );
            const file = resolve(cwd, values.cwd ?? ".", argument);
            const raw = readFileSync(file, "utf8");
            if (raw.length > 16384) throw new Error("Connection download is too large.");
            try {
                c = parseCheckoutConnection(JSON.parse(raw));
            } catch {
                throw new Error(
                    "Invalid checkout connection download. Download a fresh connection from the board."
                );
            }
            if (c.mode !== "remote")
                throw new Error(
                    "Import a remote checkout connection; use connection local for local setup."
                );
        } else if (action === "local") {
            name = "local";
            c = parseCheckoutConnection({
                version: 1,
                name: "Local",
                mode: "local",
                server: `http://127.0.0.1:${values.port ?? new URL(data.profiles.local?.server ?? `http://127.0.0.1:${DEFAULT_PORT}`).port}`,
                ...((values.project ?? data.profiles.local?.project)
                    ? { project: values.project ?? data.profiles.local?.project }
                    : {}),
            });
        } else if (action === "use") {
            if (!argument) throw new Error("Choose a saved connection name.");
            checkName(argument);
            name = argument;
            const found = data.profiles[name];
            if (!found)
                throw new Error(
                    "Connection not found. List saved profiles with notato connection."
                );
            c = found;
        } else throw new Error("Use connection import, local, use or show.");
        await verifyConnection(c, request);
        if (JSON.stringify(readConnections(root)) !== original)
            throw new Error(
                "Connection selection changed during verification. Retry with the current profiles."
            );
        data.profiles[name] = c;
        data.active = name;
        writeConnections(root, data);
        out.push(
            `Selected ${name}: ${c.name} · ${c.server}${c.context ? ` · ${c.context.name}` : ""}.`
        );
        out.push("Run your app with: npx notato run -- npm run dev");
        out.push(
            "Your notato dev MCP entry follows this checkout. Reconnect it after switching; stop the previous agent's edits before resuming work."
        );
        if (action === "import")
            out.push(
                "The download contains both keys. Remove your downloaded copy after importing; keep the private profile out of Git."
            );
        return done(0);
    } catch (e) {
        err.push(`notato connection: ${(e as Error).message}`);
        return done(1);
    }
}
export const runConnectionCommand = async (argv: string[]) => print(await runConnection(argv));
