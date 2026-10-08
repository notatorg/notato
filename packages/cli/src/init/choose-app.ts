import { join, relative, resolve } from "node:path";
import {
    type AppInfo,
    dependsOn,
    describeApp,
    discoverApps,
    findHostAbove,
    readJson,
    refineRole,
} from "../discover.ts";
import type { Prompt } from "../terminal.ts";

/** Raised when several apps are plausible and nobody can be asked. The message lists the exact commands. */
export class AmbiguousAppError extends Error {}

/** What choosing needs from init's options. */
export interface ChooseOptions {
    app?: string;
    yes?: boolean;
    force?: boolean;
    prompt?: Prompt;
}

export interface Chosen {
    app: AppInfo;
    /** Why this app, for the report. */
    reason: string;
    /** Set when there is nothing to do: the toolbar already reaches this app. */
    done?: string;
}

/** An app as a choice in a prompt: its folder, framework and role. */
export const appLabel = (a: AppInfo, showNotato = true) =>
    `${a.rel}  (${a.framework}${a.role === "standalone" ? "" : `, federation ${a.role}`}${showNotato && a.hasNotato ? ", already has Notato" : ""})`;

/**
 * The app init sets up: `--app`, this directory, or the one it works out below. A federation host wins, since every
 * module it loads inherits its toolbar. Null when there is a package.json with React but no Vite or Next.js to edit.
 */
export async function chooseApp(options: ChooseOptions, root: string): Promise<Chosen | null> {
    if (options.app) {
        const described = describeApp(resolve(root, options.app), root);
        const app = described && refineRole(described);
        if (!app)
            throw new Error(
                `${options.app} is not a React app: it needs a package.json with react, and Vite's index.html or Next.js`
            );
        return checkRemote(options, { app, reason: "chosen with --app" }, root, true);
    }

    const described = describeApp(root, root);
    const self = described && refineRole(described);
    if (self) return checkRemote(options, { app: self, reason: "this directory" }, root, false);

    const found = discoverApps(root);
    if (found.length === 0) {
        const pkg = readJson(join(root, "package.json"));
        if (pkg && dependsOn(pkg, "react")) return null;
        throw new Error(
            `no React app found in ${root} or the folders below it (looked for Vite apps with an index.html, and Next.js apps)`
        );
    }
    if (found.length === 1) return { app: found[0] as AppInfo, reason: "the only React app here" };

    const hosts = found.filter((a) => a.role === "host");
    if (hosts.length === 1) {
        const host = hosts[0] as AppInfo;
        const modules = found.filter((a) => a.role === "remote");
        return {
            app: host,
            reason: `it is the federation host${modules.length ? `, and ${modules.map((m) => m.rel).join(", ")} load into it and inherit the toolbar` : ""}`,
        };
    }

    // Hosts first, then the rest: the most likely target is the default.
    const ordered = [...hosts, ...found.filter((a) => a.role !== "host")];
    if (options.yes)
        return {
            app: ordered[0] as AppInfo,
            reason: `the first of ${found.length} React apps (--yes)`,
        };
    if (options.prompt) {
        const choice = await options.prompt(
            `${found.length} React apps here. Which one gets the toolbar?`,
            ordered.map((a) => appLabel(a)),
            0
        );
        return { app: ordered[choice] as AppInfo, reason: "chosen by you" };
    }
    throw new AmbiguousAppError(
        `${found.length} React apps here and no terminal to ask in:\n${ordered.map((a) => `  ${a.rel}`).join("\n")}\n\nPick one with --app <dir> (or --yes to take ${ordered[0]?.rel}).`
    );
}

/** A federated module should not get its own toolbar when the host that loads it can have the one. */
async function checkRemote(
    options: ChooseOptions,
    chosen: Chosen,
    root: string,
    explicit: boolean
): Promise<Chosen> {
    const { app } = chosen;
    if (app.role !== "remote") return chosen;
    const host = findHostAbove(app.dir);
    if (!host) return chosen;

    const hostRel = relative(root, host.dir);
    if (host.hasNotato) {
        if (options.force)
            return {
                ...chosen,
                reason: `${chosen.reason}; its federation host ${hostRel} already renders <Notato />, installing here anyway (--force)`,
            };
        return {
            ...chosen,
            done: `${app.rel} is a federated module of ${hostRel}, and ${hostRel} already renders <Notato />. Modules loaded into it inherit the toolbar, so there is nothing to add here. If ${app.rel} is not loaded into ${hostRel}, pass --force to set it up anyway.`,
        };
    }
    const advice = `${app.rel} is a federated module loaded into ${hostRel}. Put the toolbar in the host so every module gets it: install notato there and run init from ${hostRel} (add --agent-dir to register your agent from the repo root).`;
    if (options.force || explicit)
        return {
            ...chosen,
            reason: `${chosen.reason}; ${advice.split(".")[0]}, installing here anyway`,
        };
    if (options.yes) throw new Error(`${advice} Pass --force to set up ${app.rel} anyway.`);
    if (options.prompt) {
        const choice = await options.prompt(
            advice,
            [`Cancel, and run init in ${hostRel}`, `Set up ${app.rel} anyway`],
            0
        );
        if (choice === 0) throw new Error(`stopped: run \`npx notato init\` from ${hostRel}`);
        return chosen;
    }
    throw new Error(`${advice} Pass --force to set up ${app.rel} anyway.`);
}
