import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseWebhooks, type Webhook } from "./webhooks.ts";

/** Looked for in the directory `notato dev` or `notato serve` starts in, and meant to be committed with the project. */
export const CONFIG_FILE = "notato.config.json";

export interface Settings {
    screenshots: boolean;
    mcp: boolean;
}
export type SettingName = keyof Settings;

/** Everything that can be set, with what it does. `notato config` and its errors are written from this. */
export const SETTINGS: Record<SettingName, { default: "on" | "off"; about: string; env: string }> =
    {
        screenshots: {
            default: "on",
            about: "Take a screenshot with each annotation. Off means none is captured, and the server drops any it is sent, so none is ever stored.",
            env: "NOTATO_SCREENSHOTS",
        },
        mcp: {
            default: "on",
            about: "Let coding agents connect over MCP: at /mcp on the server, and through `notato dev` over stdio. Off refuses them, and on a shared server also the agent tokens (for *).",
            env: "NOTATO_MCP",
        },
    };

/** `flag` is a command-line option given when the server was started (`--no-mcp`), which wins over everything. */
export type SettingSource = "default" | "file" | "env" | "flag";

export interface ResolvedConfig extends Settings {
    /** Where each setting's value came from. */
    source: Record<SettingName, SettingSource>;
    /** The config file that was read, when there is one. */
    file?: string;
    /** Why the file could not be used. Every setting falls back to the safe side (off) while it is broken. */
    error?: string;
    /** Where to send annotation events. None while the file is broken. */
    webhooks: Webhook[];
}

export type ConfigSource = (() => ResolvedConfig) & {
    /** The file it reads, so the board can change it. Absent for a source with no file behind it. */
    readonly file?: string;
    /** Forgets what was read, so the next call reads the file again (after the board writes it). */
    readonly invalidate?: () => void;
};

const DEFAULTS: ResolvedConfig = {
    screenshots: true,
    mcp: true,
    source: { screenshots: "default", mcp: "default" },
    webhooks: [],
};

const NAMES = Object.keys(SETTINGS) as SettingName[];

/** A source with nothing configured: every default. For tests and for servers started without a file. */
export const defaultConfig: ConfigSource = () => DEFAULTS;

/** `on`/`off`, and the spellings people reach for. Null when it is none of them. */
export function parseOnOff(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
    if (typeof value !== "string") return null;
    const v = value.trim().toLowerCase();
    if (["on", "true", "yes", "1", "enabled"].includes(v)) return true;
    if (["off", "false", "no", "0", "disabled"].includes(v)) return false;
    return null;
}

/** Reads a config file's text into settings, or says what is wrong with it. Unknown keys are errors: a typo must not silently do nothing. */
export function parseConfig(text: string): {
    values: Partial<Settings>;
    webhooks: Webhook[];
    error?: string;
} {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return {
            values: {},
            webhooks: [],
            error: `not valid JSON (${error instanceof Error ? error.message : error})`,
        };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return { values: {}, webhooks: [], error: "must be a JSON object" };
    const values: Partial<Settings> = {};
    let webhooks: Webhook[] = [];
    for (const [key, value] of Object.entries(raw)) {
        if (key === "webhooks") {
            const parsed = parseWebhooks(value);
            if (parsed.error) return { values: {}, webhooks: [], error: parsed.error };
            webhooks = parsed.webhooks;
            continue;
        }
        if (!(key in SETTINGS)) {
            return {
                values: {},
                webhooks: [],
                error: `unknown setting "${key}" (known: ${[...Object.keys(SETTINGS), "webhooks"].join(", ")})`,
            };
        }
        const parsed = parseOnOff(value);
        if (parsed === null)
            return {
                values: {},
                webhooks: [],
                error: `"${key}" must be "on" or "off", not ${JSON.stringify(value)}`,
            };
        values[key as SettingName] = parsed;
    }
    return { values, webhooks };
}

export interface ConfigSourceOptions {
    /** Path to the config file. It does not have to exist. */
    file: string;
    env?: Record<string, string | undefined>;
    /** Set on the command line when the server started (`--no-mcp`): fixed for the life of the process. */
    flags?: Partial<Settings>;
}

/**
 * The effective settings: a command-line flag, then the environment, then the file, then the defaults. The file is read again whenever it
 * changes, so `notato config set` takes effect on a running server without a restart.
 */
export function createConfigSource(options: ConfigSourceOptions): ConfigSource {
    const file = resolve(options.file);
    let cached: { stamp: string; result: ResolvedConfig } | undefined;

    const source = () => {
        const env = options.env ?? process.env;
        let stamp = "absent";
        try {
            const info = statSync(file);
            stamp = `${info.mtimeMs}:${info.size}`;
        } catch {
            // no file: the defaults
        }
        // The environment is part of the answer, so it is part of what the cache is keyed on.
        const key = `${stamp}|${NAMES.map((name) => env[SETTINGS[name].env] ?? "").join("|")}`;
        if (cached?.stamp === key) return cached.result;

        const result: ResolvedConfig = { ...DEFAULTS, source: { ...DEFAULTS.source } };
        if (stamp !== "absent") {
            result.file = file;
            const parsed = parseConfig(readFileSync(file, "utf8"));
            if (parsed.error) {
                result.error = parsed.error;
                // Fail closed: a broken file must not mean "capture everything" or "let any agent in".
                for (const name of NAMES) {
                    result[name] = false;
                    result.source[name] = "file";
                }
            } else {
                for (const name of NAMES) {
                    const value = parsed.values[name];
                    if (value === undefined) continue;
                    result[name] = value;
                    result.source[name] = "file";
                }
                result.webhooks = parsed.webhooks;
            }
        }
        for (const name of NAMES) {
            const fromEnv = parseOnOff(env[SETTINGS[name].env]);
            if (fromEnv === null) continue;
            result[name] = fromEnv;
            result.source[name] = "env";
        }
        for (const name of NAMES) {
            const fromFlag = options.flags?.[name];
            if (fromFlag === undefined) continue;
            result[name] = fromFlag;
            result.source[name] = "flag";
        }
        cached = { stamp: key, result };
        return result;
    };
    return Object.assign(source, {
        file,
        invalidate: () => {
            cached = undefined;
        },
    });
}

/**
 * Why an agent may not connect right now, in words it can pass on, or null when MCP is on. Agents get this from
 * every tool and from `/mcp`, so it says how to turn MCP back on.
 */
export function mcpRefusal(config: ResolvedConfig): string | null {
    if (config.mcp) return null;
    if (config.error)
        return `Notato's settings file ${config.file ?? ""} cannot be read (${config.error}), so agents are refused until it is fixed.`;
    if (config.source.mcp === "flag")
        return "MCP is turned off on this Notato server: it was started with --no-mcp.";
    if (config.source.mcp === "env")
        return `MCP is turned off on this Notato server by $${SETTINGS.mcp.env} where it runs.`;
    return "MCP is turned off on this Notato server. Turn it on in the Notato board (Settings › Agents) or with `npx notato config set mcp on`.";
}

/** Reads the settings written in a file, for `notato config`. Throws a message when the file is unusable. */
export function readConfigFile(file: string): Partial<Settings> {
    if (!existsSync(file)) return {};
    const parsed = parseConfig(readFileSync(file, "utf8"));
    if (parsed.error) throw new Error(`${file}: ${parsed.error}`);
    return parsed.values;
}

/** The webhooks written in a file. Throws a message when the file is unusable. */
export function readWebhooks(file: string): Webhook[] {
    if (!existsSync(file)) return [];
    const parsed = parseConfig(readFileSync(file, "utf8"));
    if (parsed.error) throw new Error(`${file}: ${parsed.error}`);
    return parsed.webhooks;
}

/** The whole file as it is, so that what is changed is all that changes. Refuses a file it cannot read. */
function readRaw(file: string): Record<string, unknown> {
    if (!existsSync(file)) return {};
    const text = readFileSync(file, "utf8");
    const parsed = parseConfig(text);
    if (parsed.error) throw new Error(`${file}: ${parsed.error}`);
    return JSON.parse(text) as Record<string, unknown>;
}

const writeRaw = (file: string, raw: Record<string, unknown>) =>
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

/** Sets or removes one setting in the file, keeping everything else, and creates the file if it is not there. */
export function writeSetting(file: string, name: SettingName, value: boolean | null): void {
    const raw = readRaw(file);
    if (value === null) delete raw[name];
    else raw[name] = value ? "on" : "off";
    writeRaw(file, raw);
}

/** Changes the list of webhooks in the file, keeping everything else. Removes the key when the list ends up empty. */
export function writeWebhooks(file: string, change: (current: Webhook[]) => Webhook[]): Webhook[] {
    const raw = readRaw(file);
    const next = change(parseWebhooks(raw.webhooks).webhooks);
    const check = parseWebhooks(next);
    if (check.error) throw new Error(check.error);
    if (next.length === 0) delete raw.webhooks;
    else raw.webhooks = next;
    writeRaw(file, raw);
    return next;
}
