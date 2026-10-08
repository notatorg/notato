/** What a Vite config's `federation({ ... })` call says about how the app takes part in Module Federation. */
export interface FederationInfo {
    /** The config calls `federation(`. */
    present: boolean;
    /** `remotes` is computed (an identifier, a call, shorthand), not written out: the shape of a shell that loads a module list. */
    dynamicRemotes: boolean;
    /** Names of the remotes written out literally. */
    remoteKeys: string[];
    /** Names of what this app exposes to others. */
    exposes: string[];
    /** The federation name, which other apps use as the key of their `remotes` entry. */
    name?: string;
}

export type FederationRole = "host" | "remote" | "standalone";

const NONE: FederationInfo = { present: false, dynamicRemotes: false, remoteKeys: [], exposes: [] };

/** Index just past a `//` or block comment starting at `i`, or `i` if there is none. */
function skipComment(s: string, i: number): number {
    if (s[i] === "/" && s[i + 1] === "/") {
        const end = s.indexOf("\n", i);
        return end < 0 ? s.length : end;
    }
    if (s[i] === "/" && s[i + 1] === "*") {
        const end = s.indexOf("*/", i + 2);
        return end < 0 ? s.length : end + 2;
    }
    return i;
}

/** Index just past the string literal starting at `i`, or `i` if there is none. */
function skipString(s: string, i: number): number {
    const q = s[i];
    if (q !== '"' && q !== "'" && q !== "`") return i;
    for (let j = i + 1; j < s.length; j++) {
        if (s[j] === "\\") j += 1;
        else if (s[j] === q) return j + 1;
    }
    return s.length;
}

/** The text between the braces that open at `open`, balanced, ignoring braces in strings and comments. */
function braceBody(s: string, open: number): string | null {
    let depth = 0;
    for (let i = open; i < s.length; ) {
        const afterComment = skipComment(s, i);
        if (afterComment !== i) {
            i = afterComment;
            continue;
        }
        const afterString = skipString(s, i);
        if (afterString !== i) {
            i = afterString;
            continue;
        }
        if (s[i] === "{" || s[i] === "[" || s[i] === "(") depth += 1;
        else if (s[i] === "}" || s[i] === "]" || s[i] === ")") {
            depth -= 1;
            if (depth === 0) return s.slice(open + 1, i);
        }
        i += 1;
    }
    return null;
}

/** The keys of an object literal body, ignoring nested values, strings and comments. */
function topLevelKeys(body: string): string[] {
    const keys: string[] = [];
    let i = 0;
    while (i < body.length) {
        // skip to the start of a key
        for (;;) {
            const c = skipComment(body, i);
            if (c !== i) i = c;
            else if (/[\s,]/.test(body[i] ?? "x")) i += 1;
            else break;
            if (i >= body.length) break;
        }
        if (i >= body.length) break;
        let key = "";
        if (body[i] === '"' || body[i] === "'" || body[i] === "`") {
            const end = skipString(body, i);
            key = body.slice(i + 1, end - 1);
            i = end;
        } else {
            const m = /^[\w$]+/.exec(body.slice(i));
            if (!m) {
                i += 1;
                continue;
            }
            key = m[0];
            i += m[0].length;
        }
        keys.push(key);
        // skip the value up to the next top-level comma
        let depth = 0;
        while (i < body.length) {
            const c = skipComment(body, i);
            if (c !== i) {
                i = c;
                continue;
            }
            const s = skipString(body, i);
            if (s !== i) {
                i = s;
                continue;
            }
            const ch = body[i];
            if (ch === "{" || ch === "[" || ch === "(") depth += 1;
            else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
            else if (ch === "," && depth === 0) break;
            i += 1;
        }
    }
    return keys;
}

/** Reads the object-literal value of `key:` inside the `federation(` call: its keys, or null if it is not a literal. */
function literalKeys(
    call: string,
    key: string
): { kind: "absent" } | { kind: "dynamic" } | { kind: "literal"; keys: string[] } {
    // `key:` or shorthand `key,` / `key }`, at the top level of the call's options object.
    const at = new RegExp(`(?:^|[\\s{,])${key}\\s*(:|,|\\})`).exec(call);
    if (!at) return { kind: "absent" };
    if (at[1] !== ":") return { kind: "dynamic" };
    let i = at.index + at[0].length;
    while (/\s/.test(call[i] ?? "")) i += 1;
    if (call[i] === "{") {
        const body = braceBody(call, i);
        return { kind: "literal", keys: body === null ? [] : topLevelKeys(body) };
    }
    if (call[i] === "[") {
        const body = braceBody(call, i);
        return {
            kind: "literal",
            keys:
                body === null ? [] : [...body.matchAll(/\bname\s*:/g)].map((_, n) => `remote${n}`),
        };
    }
    return { kind: "dynamic" };
}

export function analyzeFederation(config: string): FederationInfo {
    const start = /federation\s*\(/.exec(config);
    if (!start) return NONE;
    const open = start.index + start[0].length - 1;
    const call = braceBody(config, open) ?? config.slice(open);
    const remotes = literalKeys(call, "remotes");
    const exposes = literalKeys(call, "exposes");
    return {
        present: true,
        dynamicRemotes: remotes.kind === "dynamic",
        remoteKeys: remotes.kind === "literal" ? remotes.keys : [],
        exposes: exposes.kind === "literal" ? exposes.keys : [],
        name: /(?:^|[\s{,])name\s*:\s*["']([^"']+)["']/.exec(call)?.[1],
    };
}

/**
 * What one app's own config suggests, with no knowledge of its neighbours: a computed `remotes` is the shell that
 * loads a module list; exposing routes makes a module; a consumer that exposes nothing is a shell too.
 */
export function federationRole(info: FederationInfo): FederationRole {
    if (!info.present) return "standalone";
    if (info.dynamicRemotes) return "host";
    if (info.exposes.length > 0) return "remote";
    return info.remoteKeys.length > 0 ? "host" : "standalone";
}

export interface FederatedApp {
    /** Anything unique, e.g. the directory. */
    id: string;
    /** The folder name, which `remotes` keys usually echo (`app-shell` for `appShell`). */
    dirName: string;
    info: FederationInfo;
}

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Roles across a set of apps that may load each other. A config where every module declares the shell as its
 * remote and exposes its own routes looks, per app, just like the shell does, so the keyword `remotes` cannot
 * decide. The host is the app with the most links to others: modules point at it (or it loads them), and an app
 * that loads a computed module list counts as linked to all the others. A tie is not guessed: every app then
 * gets what its own config suggests, and the caller asks.
 */
export function classifyFederation(apps: FederatedApp[]): Map<string, FederationRole> {
    const roles = new Map<string, FederationRole>();
    const federated = apps.filter((a) => a.info.present);
    for (const a of apps) roles.set(a.id, a.info.present ? federationRole(a.info) : "standalone");
    if (federated.length < 2) return roles;

    const names = (a: FederatedApp) =>
        new Set([norm(a.dirName), a.info.name ? norm(a.info.name) : ""].filter(Boolean));
    const degree = new Map(federated.map((a) => [a.id, 0]));
    const bump = (id: string, by = 1) => degree.set(id, (degree.get(id) ?? 0) + by);
    for (const a of federated) {
        if (a.info.dynamicRemotes) bump(a.id, federated.length - 1);
        for (const key of a.info.remoteKeys) {
            const target = federated.find((b) => b.id !== a.id && names(b).has(norm(key)));
            if (target) {
                bump(a.id);
                bump(target.id);
            }
        }
    }
    const top = Math.max(...degree.values());
    const leaders = federated.filter((a) => degree.get(a.id) === top);
    if (top < 1 || leaders.length !== 1) return roles;
    for (const a of federated) roles.set(a.id, a.id === leaders[0]?.id ? "host" : "remote");
    return roles;
}
