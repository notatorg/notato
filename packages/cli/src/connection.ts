import {
    existsSync,
    lstatSync,
    readFileSync,
    renameSync,
    unlinkSync,
    unwatchFile,
    watchFile,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { browserConnection, type CheckoutConnection, parseCheckoutConnection } from "@notato/core";

export const CONNECTION_FILE = ".notato.connection.json";
export interface Connections {
    version: 1;
    active: string;
    profiles: Record<string, CheckoutConnection>;
}
export function connectionRoot(cwd: string): string {
    for (let d = resolve(cwd); ; d = dirname(d)) {
        if (existsSync(join(d, CONNECTION_FILE))) return d;
        if (existsSync(join(d, ".git"))) return d;
        if (dirname(d) === d) return resolve(cwd);
    }
}
export function readConnections(root: string): Connections | null {
    const path = join(root, CONNECTION_FILE);
    if (!existsSync(path)) return null;
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        throw new Error("Connection profiles must be a regular private file.");
    if (lstatSync(path).size > 131072) throw new Error("Connection file is too large.");
    let data: Connections;
    try {
        data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new Error(
            "Cannot read connection profiles. Fix the file; no local fallback was selected."
        );
    }
    if (
        data?.version !== 1 ||
        typeof data.active !== "string" ||
        !data.profiles ||
        typeof data.profiles !== "object" ||
        Array.isArray(data.profiles) ||
        Object.keys(data.profiles).length > 50
    )
        throw new Error("Invalid connection collection. No local fallback was selected.");
    const profiles: Record<string, CheckoutConnection> = Object.create(null);
    for (const [name, p] of Object.entries(data.profiles)) {
        checkName(name);
        profiles[name] = parseCheckoutConnection(p);
    }
    if (!Object.hasOwn(profiles, data.active))
        throw new Error("The active connection is missing. Select a valid profile.");
    return { version: 1, active: data.active, profiles };
}
export function checkName(name: string) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name))
        throw new Error(
            "Profile names use lowercase letters, digits, underscores or hyphens (start with a letter)."
        );
}
export function writeConnections(root: string, c: Connections) {
    const path = join(root, CONNECTION_FILE);
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
        throw new Error("Refusing to replace a linked connection file.");
    const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", CONNECTION_FILE], {
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
    });
    if (tracked.exitCode === 0)
        throw new Error(
            "The connection file is tracked by Git. Remove it from Git before storing credentials."
        );
    const ignore = join(root, ".gitignore");
    if (existsSync(ignore) && (!lstatSync(ignore).isFile() || lstatSync(ignore).isSymbolicLink()))
        throw new Error("Refusing to edit a linked .gitignore.");
    const before = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
    const patterns = `/${CONNECTION_FILE}\n/${CONNECTION_FILE}.*.tmp\n`;
    if (!before.endsWith(patterns))
        writeFileSync(
            ignore,
            `${before}${before && !before.endsWith("\n") ? "\n" : ""}${patterns}`
        );
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
        writeFileSync(temp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        renameSync(temp, path);
    } finally {
        if (existsSync(temp)) unlinkSync(temp);
    }
}
export function selectedConnection(root: string) {
    const c = readConnections(root);
    return c ? c.profiles[c.active]! : null;
}
export type ConnectionFetch = (url: string, init?: RequestInit) => Promise<Response>;
export async function verifyConnection(c: CheckoutConnection, request: ConnectionFetch = fetch) {
    if (c.mode === "local") return;
    for (const [purpose, token] of [
        ["app", c.appToken],
        ["agent", c.agentToken],
    ] as const) {
        let r: Response;
        try {
            r = await request(`${c.server}/connection`, {
                headers: { Authorization: `Bearer ${token}` },
                redirect: "error",
                signal: AbortSignal.timeout(8000),
            });
        } catch {
            throw new Error(
                "Cannot verify the selected server. The previous profile is unchanged; no local fallback was selected."
            );
        }
        if (!r.ok)
            throw new Error(
                "Checkout authorization failed. Download fresh app and agent keys from the server."
            );
        let info: {
            purpose?: string;
            project?: string;
            context?: { id: string };
        };
        try {
            info = await r.json();
        } catch {
            throw new Error("The selected server returned invalid connection metadata.");
        }
        if (
            info.purpose !== purpose ||
            info.project !== c.project ||
            info.context?.id !== c.context?.id
        )
            throw new Error(
                "The app and agent keys must belong to this same checkout and project."
            );
    }
}
export function appEnvironment(
    c: CheckoutConnection,
    source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
    const env = { ...source };
    for (const key of [
        "NOTATO_AGENT_TOKEN",
        "NOTATO_PROJECT",
        "NOTATO_SERVER",
        "NOTATO_TOKEN",
        "NOTATO_TUNNEL",
        "VITE_NOTATO_SERVER",
        "NEXT_PUBLIC_NOTATO_SERVER",
        "VITE_NOTATO_PROJECT",
        "VITE_NOTATO_TOKEN",
        "NEXT_PUBLIC_NOTATO_PROJECT",
        "NEXT_PUBLIC_NOTATO_TOKEN",
    ])
        delete env[key];
    const browser = JSON.stringify(browserConnection(c));
    return {
        ...env,
        VITE_NOTATO: "true",
        NEXT_PUBLIC_NOTATO: "true",
        VITE_NOTATO_CONNECTION: browser,
        NEXT_PUBLIC_NOTATO_CONNECTION: browser,
    };
}
/** Atomic file replacement is watched by pathname. The old session stops, rather than retaining its old authority. */
export function watchConnection(root: string, changed: () => void): () => void {
    const path = join(root, CONNECTION_FILE);
    const original = existsSync(path) ? readFileSync(path, "utf8") : null;
    const check = () => {
        let current: string | null;
        try {
            current = readFileSync(path, "utf8");
        } catch {
            current = null;
        }
        if (current !== original) changed();
    };
    watchFile(path, { interval: 300, persistent: false }, check);
    return () => unwatchFile(path, check);
}
