import { join, resolve } from "node:path";
import { CONFIG_FILE, DEFAULT_PORT } from "@notato/server";

// Options that several commands take, read the same way everywhere.

type Env = Record<string, string | undefined>;

/** A project id as the server accepts it: letters, digits and `_ . @ -`, but never only dots. */
export const PROJECT_ID = /^(?!\.+$)[\w.@-]{1,128}$/;

/** `--port`, as a number; undefined when it is not given, so the server's own default applies. */
export function parsePort(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error(`--port must be a number between 0 and 65535, got "${value}"`);
    return port;
}

/** Whether to open a dev tunnel: `--tunnel`, or NOTATO_TUNNEL set to 1, true, yes or on. */
export function wantsTunnel(flag: boolean | undefined, env: Env = process.env): boolean {
    return flag === true || /^(1|true|yes|on)$/i.test(env.NOTATO_TUNNEL ?? "");
}

/** The Notato server on this machine, for the commands that talk to one: `--server` overrides it. */
export function localServer(env: Env = process.env): string {
    return `http://127.0.0.1:${env.NOTATO_PORT ?? DEFAULT_PORT}`;
}

/** The settings file: `--file`, else NOTATO_CONFIG, else notato.config.json in `cwd`. */
export function configFile(flag: string | undefined, cwd: string, env: Env = process.env): string {
    return resolve(cwd, flag ?? env.NOTATO_CONFIG ?? CONFIG_FILE);
}

/** The data directory: `--dir`, else NOTATO_DIR, else `.notato` in the current directory. */
export function dataDir(flag: string | undefined, env: Env = process.env): string {
    return resolve(flag ?? env.NOTATO_DIR ?? join(process.cwd(), ".notato"));
}
