import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
    CONFIG_FILE,
    createConfigSource,
    parseOnOff,
    readConfigFile,
    SETTINGS,
    type SettingName,
    writeSetting,
} from "@notato/server";
import { describeWebhook, runWebhook } from "./webhook.ts";

const HELP = `notato config

Shows and changes Notato's settings. They live in ${CONFIG_FILE}, in the folder you start Notato from,
so they can be committed and shared with the project. A running server picks a change up on its own.

Usage:
  notato config                      Show every setting, what it is, and where the value comes from
  notato config get <name>           Print one value (on or off)
  notato config set <name> <on|off>  Change one
  notato config unset <name>         Remove it from the file, so the default applies
  notato config webhook ...          Send events to Slack, Discord or your own URL (see: notato config webhook --help)

Settings:
${Object.entries(SETTINGS)
    .map(
        ([name, s]) =>
            `  ${name.padEnd(12)}${s.about} (default ${s.default}; $${s.env} overrides the file)`
    )
    .join("\n")}

Options:
  -f, --file <path>   The config file (default $NOTATO_CONFIG, or ./${CONFIG_FILE})
  -C, --cwd <path>    Treat this as the current directory
  -h, --help          Show this help

A page can also turn screenshots off for itself with <Notato screenshots={false} />. The server's setting wins:
a page cannot turn them on if the server has them off.`;

export interface ConfigResult {
    code: number;
    stdout: string;
    stderr: string;
}

const names = Object.keys(SETTINGS).join(", ");

function settingName(raw: string | undefined): SettingName {
    if (!raw) throw new UsageError(`which setting? One of: ${names}`);
    if (!(raw in SETTINGS))
        throw new UsageError(`unknown setting "${raw}". The settings are: ${names}`);
    return raw as SettingName;
}

class UsageError extends Error {}

/** The command, without touching the process: what it prints and the exit code come back as data. */
export function runConfig(
    argv: string[],
    env: Record<string, string | undefined> = process.env,
    defaultCwd: string = process.cwd()
): ConfigResult {
    const out: string[] = [];
    const err: string[] = [];
    const result = (code: number): ConfigResult => ({
        code,
        stdout: out.join("\n"),
        stderr: err.join("\n"),
    });
    try {
        const { values, positionals } = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                file: { type: "string", short: "f" },
                cwd: { type: "string", short: "C" },
                help: { type: "boolean", short: "h" },
            },
        });
        if (values.help) {
            out.push(HELP);
            return result(0);
        }
        const cwd = resolve(values.cwd ?? defaultCwd);
        const file = resolve(cwd, values.file ?? env.NOTATO_CONFIG ?? join(cwd, CONFIG_FILE));
        const [action = "show", ...rest] = positionals;
        const source = createConfigSource({ file, env });

        if (action === "show" || action === "list") {
            const now = source();
            out.push(`Settings (${now.file ?? `${file}, not created yet`}):`);
            for (const [name, info] of Object.entries(SETTINGS)) {
                const value = now[name as SettingName] ? "on" : "off";
                const from = now.source[name as SettingName];
                out.push(
                    `  ${name.padEnd(12)}${value.padEnd(5)}(${from === "default" ? "default" : from === "env" ? `$${info.env}` : "file"})`
                );
                out.push(`  ${" ".repeat(12)}${info.about}`);
            }
            if (now.error) {
                err.push(
                    `\n${file}: ${now.error}.\nUntil it is fixed the server treats every setting as off, to be safe (no screenshots, no agents), and sends no webhooks.`
                );
                return result(1);
            }
            out.push(
                now.webhooks.length
                    ? `\nWebhooks:\n${now.webhooks.map((w) => `  ${describeWebhook(w)}`).join("\n")}`
                    : "\nWebhooks: none (notato config webhook add <url>)"
            );
            return result(0);
        }

        if (action === "get") {
            const name = settingName(rest[0]);
            const now = source();
            if (now.error) throw new Error(`${file}: ${now.error}`);
            out.push(now[name] ? "on" : "off");
            return result(0);
        }

        if (action === "set") {
            const name = settingName(rest[0]);
            const value = parseOnOff(rest[1]);
            if (value === null)
                throw new UsageError(
                    `${name} must be "on" or "off", not ${JSON.stringify(rest[1] ?? "")}`
                );
            writeSetting(file, name, value);
            out.push(`${name} is now ${value ? "on" : "off"} in ${file}.`);
            const override = parseOnOff(env[SETTINGS[name].env]);
            if (override !== null && override !== value) {
                out.push(
                    `Note: $${SETTINGS[name].env} is set to ${override ? "on" : "off"} here and takes priority over the file.`
                );
            }
            out.push(
                name === "mcp"
                    ? value
                        ? "A running server lets agents in again at once."
                        : "A running server refuses agents from their next call, and tells them why."
                    : "A running server applies this on its next request; pages ask the server before each screenshot."
            );
            return result(0);
        }

        if (action === "unset") {
            const name = settingName(rest[0]);
            if (name in readConfigFile(file)) {
                writeSetting(file, name, null);
                out.push(
                    `${name} removed from ${file}; the default (${SETTINGS[name].default}) applies.`
                );
            } else {
                out.push(
                    `${name} was not set in ${file}; the default (${SETTINGS[name].default}) applies.`
                );
            }
            return result(0);
        }

        throw new UsageError(`unknown action "${action}". Use show, get, set or unset`);
    } catch (error) {
        err.push(`notato config: ${error instanceof Error ? error.message : String(error)}`);
        return result(error instanceof UsageError ? 2 : 1);
    }
}

/** The first word that is not an option or an option's value, and where it sits in the arguments. */
function subcommand(argv: string[]): { word: string; index: number } | undefined {
    const { tokens } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: false,
        tokens: true,
        options: {
            file: { type: "string", short: "f" },
            cwd: { type: "string", short: "C" },
            event: { type: "string", short: "e", multiple: true },
            format: { type: "string", short: "F" },
            secret: { type: "string", short: "s" },
            name: { type: "string", short: "n" },
            project: { type: "string", short: "p" },
        },
    });
    const first = tokens?.find((t) => t.kind === "positional");
    return first?.kind === "positional" ? { word: first.value, index: first.index } : undefined;
}

export async function runConfigCommand(argv: string[]): Promise<number> {
    // `webhook` can send a request, so it is the one part that is not synchronous.
    const sub = subcommand(argv);
    const { code, stdout, stderr } =
        sub?.word === "webhook"
            ? await runWebhook(argv.filter((_, i) => i !== sub.index))
            : runConfig(argv);
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    return code;
}
