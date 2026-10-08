import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
    AGENT_IDS,
    AGENTS,
    type AgentId,
    type AgentRegistration,
    addToAgentConfig,
    detectAgents,
    manualCommand,
    parseAgents,
    readIfExists,
    writeConfig,
} from "../agents.ts";
import {
    type AppInfo,
    describeApp,
    discoverApps,
    findGitRoot,
    findHostAbove,
    notatoRenderedIn,
    refineRole,
    viteConfigFile,
} from "../discover.ts";
import {
    addToGitignore,
    addToNextLayout,
    addToNextPagesApp,
    addToViteConfig,
    addToViteEntry,
    type Edit,
    nextClientComponent,
    projectIdFromPackage,
    type SetupOptions,
} from "../init-transforms.ts";
import { renderSkill, SKILLS, skillState } from "../skill.ts";
import { resolveStyle, type Style } from "../style.ts";
import { formatRevertReport, runRevert } from "./revert.ts";

const HELP = `notato init

Sets up Notato in a React app: adds <Notato /> behind a development-only guard (Vite or Next.js), ignores
.notato/ in git, and sets up your coding agents: registers the MCP server and writes the skills that teach the
loop. Works with Claude Code, Codex, Cursor, Gemini CLI and GitHub Copilot, and finds the ones you use (their
command is installed, or their folder is in the project). Safe to run twice.

Run it after: npm i -D notato @notato/react   (in the app you are setting up)

In a repo with several React apps it works out which one to use: a Module Federation host (the app that loads
the others) wins, since every module it loads inherits the toolbar. If it cannot tell, it asks; with no terminal
it stops and lists the choices.

Options:
      --app <dir>         The app to set up, relative to here (default: here, or the one it works out)
      --agent <list>      Which agents to set up: claude, codex, cursor, gemini, copilot, or all (comma-separated
                          or repeated; default: the ones it finds). Also NOTATO_AGENTS=codex,cursor
      --agent-dir <dir>   Where you start your agent, if not here (default: here). The MCP server is registered
                          for that directory and keeps its data there (--claude-dir is the old name)
  -y, --yes               Take the recommended choice instead of asking
      --force             Set up an app even if its federation host should have the toolbar
      --server <url>      Where the dev server listens (default http://localhost:4747)
      --project <id>      Project id (default: the package name, or the repo name for a federation host)
      --guard <g>         dev: render only under \`vite dev\`. env: also in a build made with VITE_NOTATO=true
                          (the default for apps that run \`vite build --watch\` + \`vite preview\`)
      --revert            Undo init instead: take the toolbar out of the app's code, remove the .gitignore lines
                          and the skills it added, and the MCP server from the agents' project settings and
                          Claude Code. Your recorded annotations are kept. Works with --dry-run, --app,
                          --agent, --agent-dir, --no-mcp and --mcp-scope
      --plugin            Also wire the Vite plugin (@notato/vite) into the Vite config, so the exact file and line
                          of an element is recorded even in a built app. In a repo of several apps it goes into
                          every Vite app, since each module is built separately. Only active when VITE_NOTATO=true
      --plugin-only       Just the Vite plugin, nothing else: for a module that gets its toolbar from its host
                          (--app <dir> for one app)
      --no-mcp            Do not register the MCP server with any agent
      --no-skill          Do not write the skills (notato and notato-critique) that teach the agent the loop
      --mcp-scope <s>     For Claude Code: local (default), project (writes .mcp.json for the team), or user
      --dry-run           Show what would change without writing anything
  -C, --cwd <path>        Treat this as the current directory
  -h, --help              Show this help`;

export type Framework = "vite" | "next-app" | "next-pages" | "unknown";

export interface Change {
    file: string;
    action: "edited" | "created" | "unchanged" | "skipped";
    note?: string;
}

export interface InitReport {
    framework: Framework;
    project: string;
    /** The app that was set up, relative to where init ran, and why that one. */
    app?: { dir: string; role: AppInfo["role"]; reason: string };
    /** Where the MCP server was registered, when that is not the app's own directory. */
    agentDir?: string;
    changes: Change[];
    warnings: string[];
    /** Facts worth printing that are not problems. */
    notes: string[];
    /** Overall: failed if any agent failed, else added if any was added, and so on. Each agent is in `agents`. */
    mcp: "added" | "already" | "skipped" | "unavailable" | "failed";
    /** The MCP registration with each agent set up, in order. */
    agents: AgentRegistration[];
    /** What to paste by hand when the edit could not be made safely. */
    manual?: string;
    /** This run only wired the Vite plugin. */
    pluginOnly?: boolean;
}

export type Prompt = (question: string, choices: string[], defaultIndex: number) => Promise<number>;

export interface InitOptions {
    cwd: string;
    app?: string;
    /** Where the agent starts. `claudeDir` is the old name. */
    agentDir?: string;
    claudeDir?: string;
    /** The agents to set up. Default: NOTATO_AGENTS, else the ones found (see `detectAgents`). */
    agents?: AgentId[];
    yes?: boolean;
    force?: boolean;
    server?: string;
    project?: string;
    dryRun?: boolean;
    mcp?: boolean;
    /** Write the skills. Default true. */
    skill?: boolean;
    /** Also wire `notatoSource()` into the Vite config(s). */
    plugin?: boolean;
    /** Only wire the plugin. */
    pluginOnly?: boolean;
    mcpScope?: "local" | "project" | "user";
    /** `dev`, or `env` to also render in a build made with VITE_NOTATO=true. Default: `env` when the app is built and previewed. */
    guard?: "dev" | "env";
    /** Asks the person to choose. Absent when there is no terminal: then ambiguity is an error. */
    prompt?: Prompt;
    /** Runs an agent's command (`claude`, `codex`); injectable so tests never touch a real install. */
    run?: (command: string[], cwd: string) => Promise<{ code: number; output: string }>;
    /** Resolves a program on PATH. Injectable for tests. */
    which?: (name: string) => string | null;
    platform?: NodeJS.Platform;
}

/** Raised when several apps are plausible and nobody can be asked. The message lists the exact commands. */
export class AmbiguousAppError extends Error {}

const DEFAULT_SERVER = "http://localhost:4747";

export async function defaultRun(command: string[], cwd: string) {
    const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, output: `${out}${err}`.trim() };
}

/** A numbered question on the terminal. Enter takes the default. */
export const terminalPrompt: Prompt = async (question, choices, defaultIndex) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        console.log(`\n${question}`);
        for (const [i, c] of choices.entries())
            console.log(`  ${i + 1}) ${c}${i === defaultIndex ? "  (default)" : ""}`);
        for (;;) {
            const answer = (await rl.question(`Choose [${defaultIndex + 1}]: `)).trim();
            if (answer === "") return defaultIndex;
            const n = Number(answer);
            if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
            console.log(`Enter a number from 1 to ${choices.length}.`);
        }
    } finally {
        rl.close();
    }
};

export function readJson(path: string): Record<string, unknown> | null {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
        return null;
    }
}

const has = (pkg: Record<string, unknown>, name: string) =>
    Boolean(
        (pkg.dependencies as Record<string, string> | undefined)?.[name] ??
            (pkg.devDependencies as Record<string, string> | undefined)?.[name]
    );

export function firstExisting(cwd: string, candidates: string[]): string | null {
    return candidates.find((c) => existsSync(join(cwd, c))) ?? null;
}

/** The module script `index.html` points at, which is where a Vite app mounts React. */
export function viteEntry(cwd: string): string | null {
    const html = existsSync(join(cwd, "index.html"))
        ? readFileSync(join(cwd, "index.html"), "utf8")
        : "";
    const src =
        /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i.exec(html)?.[1] ??
        /<script[^>]*src=["']([^"']+)["'][^>]*type=["']module["']/i.exec(html)?.[1];
    const fromHtml = src && !/^https?:/.test(src) ? src.replace(/^\//, "") : null;
    if (fromHtml && existsSync(join(cwd, fromHtml))) return fromHtml;
    return firstExisting(cwd, [
        "src/main.tsx",
        "src/main.jsx",
        "src/index.tsx",
        "src/index.jsx",
        "main.tsx",
        "main.jsx",
    ]);
}

// ---- which app ------------------------------------------------------------------------------------------

interface Chosen {
    app: AppInfo;
    reason: string;
    /** Nothing to do: the toolbar is already reachable. */
    done?: string;
}

const label = (a: AppInfo) =>
    `${a.rel}  (${a.framework}${a.role === "standalone" ? "" : `, federation ${a.role}`}${a.hasNotato ? ", already has Notato" : ""})`;

/** The app to set up, or null when there is a package.json with React but no Vite or Next.js to edit. */
async function chooseApp(options: InitOptions, root: string): Promise<Chosen | null> {
    if (options.app) {
        const described = describeApp(resolve(root, options.app), root);
        const app = described && refineRole(described);
        if (!app)
            throw new Error(
                `${options.app} is not a React app: it needs a package.json with react, and Vite's index.html or Next.js`
            );
        return remoteCheck(options, { app, reason: "chosen with --app" }, root, true);
    }

    const described = describeApp(root, root);
    const self = described && refineRole(described);
    if (self) return remoteCheck(options, { app: self, reason: "this directory" }, root, false);

    const found = discoverApps(root);
    if (found.length === 0) {
        const pkg = readJson(join(root, "package.json"));
        if (pkg && has(pkg, "react")) return null;
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
            ordered.map(label),
            0
        );
        return { app: ordered[choice] as AppInfo, reason: "chosen by you" };
    }
    throw new AmbiguousAppError(
        `${found.length} React apps here and no terminal to ask in:\n${ordered.map((a) => `  ${a.rel}`).join("\n")}\n\nPick one with --app <dir> (or --yes to take ${ordered[0]?.rel}).`
    );
}

/** A federated module should not get its own toolbar when the host that loads it can have the one. */
async function remoteCheck(
    options: InitOptions,
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

// ---- the Vite plugin ------------------------------------------------------------------------------------

/** The apps the plugin goes into: the one named, this one, or every Vite app below (each module is built on its own). */
function pluginTargets(options: InitOptions, root: string): AppInfo[] {
    if (options.app) {
        const app = describeApp(resolve(root, options.app), root);
        if (!app) throw new Error(`${options.app} is not a React app`);
        return [app];
    }
    const self = describeApp(root, root);
    if (self) return [self];
    return discoverApps(root).filter((a) => a.framework === "vite");
}

/** Adds `notatoSource()` to each app's Vite config, and says what it could not do. */
function wirePlugin(apps: AppInfo[], root: string, options: InitOptions, report: InitReport) {
    if (apps.length === 0) report.warnings.push("no Vite app found to wire the plugin into");
    for (const app of apps) {
        const shown = (file: string) => relative(root, join(app.dir, file)) || file;
        if (app.framework !== "vite") {
            report.notes.push(`${app.rel}: the Vite plugin is for Vite apps, so it was skipped`);
            continue;
        }
        const configName = viteConfigFile(app.dir);
        if (!configName) {
            report.warnings.push(
                `${app.rel}: no vite.config found; add notatoSource() from @notato/vite to its plugins yourself`
            );
            continue;
        }
        const path = join(app.dir, configName);
        const source = readFileSync(path, "utf8");
        const edit = addToViteConfig(source, resolveStyle(source, app.dir));
        if (edit.changed && !options.dryRun) writeFileSync(path, edit.source);
        report.changes.push({
            file: shown(configName),
            action: edit.changed ? "edited" : "unchanged",
            note: edit.reason ?? edit.note ?? (edit.changed ? "adds notatoSource()" : undefined),
        });
        if (!edit.changed && edit.reason && edit.reason !== "already set up") {
            report.warnings.push(`${shown(configName)}: ${edit.reason}`);
        }
        const pkg = readJson(join(app.dir, "package.json"));
        if (pkg && !has(pkg, "@notato/vite")) {
            report.warnings.push(
                `@notato/vite is not in ${shown("package.json")}; install it there with: npm i -D @notato/vite`
            );
        }
    }
}

/**
 * The notato binary an app can run: in its own node_modules, or hoisted to a workspace root above it (npm, Yarn and
 * Bun workspaces), up to the repository root.
 */
function findBin(appDir: string, gitRoot: string | null, name: string): string | undefined {
    for (let dir = resolve(appDir); ; dir = dirname(dir)) {
        const candidate = join(dir, "node_modules", ".bin", name);
        if (existsSync(candidate)) return candidate;
        if ((gitRoot && resolve(dir) === resolve(gitRoot)) || dirname(dir) === dir)
            return undefined;
    }
}

// ---- the run --------------------------------------------------------------------------------------------

export async function runInit(options: InitOptions): Promise<InitReport> {
    const root = resolve(options.cwd);
    const report: InitReport = {
        framework: "unknown",
        project: "app",
        changes: [],
        warnings: [],
        notes: [],
        mcp: "skipped",
        agents: [],
    };

    if (options.pluginOnly) {
        report.pluginOnly = true;
        report.framework = "vite";
        report.project = "the Vite plugin";
        wirePlugin(pluginTargets(options, root), root, options, report);
        report.notes.push(
            "It records source positions only when VITE_NOTATO=true is set where the build runs; otherwise a build is unchanged."
        );
        return report;
    }

    const chosen = await chooseApp(options, root);
    if (!chosen) {
        // React, but not a bundler we can edit: say what to add rather than guess.
        const pkg = readJson(join(root, "package.json")) as Record<string, unknown>;
        report.project = options.project ?? projectIdFromPackage(pkg.name as string | undefined);
        report.warnings.push("neither Vite nor Next.js found; add the component by hand");
        report.manual = `import { Notato } from "@notato/react"\n\n<Notato mode="dev" project=${JSON.stringify(report.project)} server=${JSON.stringify(options.server ?? DEFAULT_SERVER)} />`;
        return report;
    }
    const app = chosen.app;
    report.app = {
        dir: app.rel === "." ? "." : relative(root, app.dir) || ".",
        role: app.role,
        reason: chosen.reason,
    };
    report.framework = app.framework === "next" ? "next-app" : "vite";
    if (chosen.done) {
        report.notes.push(chosen.done);
        if (options.plugin) wirePlugin(pluginTargets(options, root), root, options, report);
        return report;
    }

    const appDir = app.dir;
    const pkg = readJson(join(appDir, "package.json")) as Record<string, unknown>;
    const agentDir = resolve(root, options.agentDir ?? options.claudeDir ?? ".");
    const gitRoot = findGitRoot(agentDir);
    const where = (file: string) => relative(root, join(appDir, file)) || file;

    // The project is the product, not the module: a host's id is the repo's, so one project covers every module.
    report.project =
        options.project ??
        (app.role === "host"
            ? projectIdFromPackage(basename(gitRoot ?? agentDir))
            : projectIdFromPackage(pkg.name as string | undefined));
    // Apps built and previewed during development (`vite build --watch` + `vite preview`) never see import.meta.env.DEV.
    const scripts = Object.entries((pkg.scripts as Record<string, string> | undefined) ?? {});
    const watchedBuild = scripts.find(([, command]) =>
        /\bvite\s+build\b[^&|;]*(?:--watch|\s-w\b)/.test(command)
    );
    const guard = options.guard ?? (app.framework === "vite" && watchedBuild ? "env" : "dev");
    const setup: SetupOptions = {
        project: report.project,
        server: options.server ?? DEFAULT_SERVER,
        guard,
    };
    if (guard === "env" && app.framework === "vite") {
        report.notes.push(
            `${watchedBuild ? `This app is built and previewed (the "${watchedBuild[0]}" script), where import.meta.env.DEV is false, so ` : ""}the toolbar also renders in a build made with VITE_NOTATO=true. Set that where the build runs, for example in ${where(".env.local")}; leave it unset for anything shared and the build ships nothing.`
        );
    }

    const write = (file: string, content: string) => {
        if (options.dryRun) return;
        mkdirSync(dirname(join(appDir, file)), { recursive: true });
        writeFileSync(join(appDir, file), content);
    };
    const apply = (file: string, edit: Edit) => {
        if (edit.changed) write(file, edit.source);
        report.changes.push({
            file: where(file),
            action: edit.changed ? "edited" : "unchanged",
            note: edit.reason ?? edit.note,
        });
        return edit;
    };
    const styleOf = (file: string): Style =>
        resolveStyle(readFileSync(join(appDir, file), "utf8"), join(appDir, dirname(file)));

    if (!has(pkg, "@notato/react")) {
        report.warnings.push(
            `@notato/react is not in ${where("package.json")}; install it there with: npm i -D notato @notato/react`
        );
    }

    // ---- the component --------------------------------------------------------------------------------
    // Already rendered somewhere other than where init puts it (App.tsx, a providers file): a second toolbar would be
    // one too many. A Vite entry init edited says so itself ("already set up"); for Next.js, init's own component
    // does not count and the layout renders <NotatoDev />, so any <Notato /> found is the person's own.
    const renderedIn = notatoRenderedIn(appDir);
    if (renderedIn && (app.framework === "next" || renderedIn !== viteEntry(appDir))) {
        report.changes.push({
            file: where(renderedIn),
            action: "unchanged",
            note: "already renders <Notato />, so no second one was added",
        });
    } else if (app.framework === "next") {
        const appLayout = firstExisting(appDir, [
            "app/layout.tsx",
            "app/layout.jsx",
            "app/layout.js",
            "src/app/layout.tsx",
            "src/app/layout.jsx",
            "src/app/layout.js",
        ]);
        const pagesApp = firstExisting(appDir, [
            "pages/_app.tsx",
            "pages/_app.jsx",
            "pages/_app.js",
            "src/pages/_app.tsx",
            "src/pages/_app.jsx",
            "src/pages/_app.js",
        ]);
        const target = appLayout ?? pagesApp;
        if (!target) {
            report.framework = "unknown";
            report.manual =
                'Add <Notato mode="dev" … /> to a client component rendered in your root layout.';
            report.warnings.push("could not find app/layout or pages/_app");
        } else {
            report.framework = appLayout ? "next-app" : "next-pages";
            const style = styleOf(target);
            const ext = target.endsWith("x") ? target.slice(target.lastIndexOf(".")) : ".jsx";
            const componentFile = appLayout
                ? join(dirname(target), `notato-dev${ext}`)
                : join(target.startsWith("src/") ? "src" : ".", "components", `notato-dev${ext}`);
            const importPath = appLayout
                ? "./notato-dev"
                : relative(dirname(target), componentFile.replace(/\.\w+$/, ""))
                      .split("\\")
                      .join("/");
            const spec = importPath.startsWith(".") ? importPath : `./${importPath}`;
            if (existsSync(join(appDir, componentFile))) {
                report.changes.push({
                    file: where(componentFile),
                    action: "unchanged",
                    note: "already exists",
                });
            } else {
                write(componentFile, nextClientComponent(setup, style));
                report.changes.push({ file: where(componentFile), action: "created" });
            }
            const source = readFileSync(join(appDir, target), "utf8");
            const edit = apply(
                target,
                appLayout
                    ? addToNextLayout(source, spec, style)
                    : addToNextPagesApp(source, spec, style)
            );
            if (!edit.changed && edit.reason !== "already set up") {
                report.manual = `Render <NotatoDev /> (from ${spec}) inside ${where(target)}.`;
                report.warnings.push(`${where(target)}: ${edit.reason}`);
            }
        }
    } else {
        const entry = viteEntry(appDir);
        const manual = `Render <Notato mode="dev" project=${JSON.stringify(setup.project)} server=${JSON.stringify(setup.server)} /> next to <App />, guarded by import.meta.env.DEV.`;
        if (!entry) {
            report.warnings.push(
                "could not find the app's entry file (looked at index.html and src/main.*)"
            );
            report.manual = manual;
        } else {
            const source = readFileSync(join(appDir, entry), "utf8");
            const edit = apply(entry, addToViteEntry(source, setup, styleOf(entry)));
            if (!edit.changed && edit.reason !== "already set up") {
                report.warnings.push(`${where(entry)}: ${edit.reason}`);
                report.manual = manual;
            }
        }
    }

    // ---- the Vite plugin, for the exact file and line in a built app ---------------------------------------
    if (options.plugin) wirePlugin(pluginTargets(options, root), root, options, report);
    else if (guard === "env" && app.framework === "vite") {
        report.notes.push(
            "A built app has no React dev build to say which file an element came from. For the exact file and line, also run: npx notato init --plugin"
        );
    }

    // ---- .gitignore: where the server will run (where the agent starts), or the repo's own -----------------
    const ignorePath = [
        join(agentDir, ".gitignore"),
        gitRoot ? join(gitRoot, ".gitignore") : "",
    ].find((p) => p && existsSync(p));
    if (ignorePath) {
        const edit = addToGitignore(readFileSync(ignorePath, "utf8"));
        if (edit.changed && !options.dryRun) writeFileSync(ignorePath, edit.source);
        report.changes.push({
            file: relative(root, ignorePath),
            action: edit.changed ? "edited" : "unchanged",
            note: edit.reason,
        });
    } else {
        report.warnings.push(
            `no .gitignore found from ${relative(root, agentDir) || "."} up to the repo root; add .notato/ to it yourself`
        );
    }

    // ---- which agents ---------------------------------------------------------------------------------------
    const which = options.which ?? ((name: string) => Bun.which(name));
    const agents = (
        options.agents ??
        parseAgents(process.env.NOTATO_AGENTS ? [process.env.NOTATO_AGENTS] : undefined) ??
        detectAgents([...new Set([agentDir, gitRoot ?? agentDir])], which)
    ).map((id) => AGENTS[id]);

    // ---- the skills: in each agent's skills folder, where the agent starts, so it finds them --------------------
    if (options.skill !== false) {
        for (const skillsDir of [...new Set(agents.map((a) => a.skillsDir))]) {
            const readers = agents.filter((a) => a.skillsDir === skillsDir).map((a) => a.name);
            for (const skill of SKILLS) {
                const skillFile = join(agentDir, skillsDir, skill.file);
                const existing = existsSync(skillFile) ? readFileSync(skillFile, "utf8") : null;
                const state = existing === null ? null : skillState(existing, skill.name);
                const shown = relative(root, skillFile) || join(skillsDir, skill.file);
                if (state === "edited") {
                    report.changes.push({
                        file: shown,
                        action: "unchanged",
                        note: "has been edited, so it was left as it is",
                    });
                } else if (state === "current") {
                    report.changes.push({ file: shown, action: "unchanged" });
                } else {
                    if (!options.dryRun) {
                        mkdirSync(dirname(skillFile), { recursive: true });
                        writeFileSync(skillFile, renderSkill(skill.name));
                    }
                    report.changes.push({
                        file: shown,
                        action: state === null ? "created" : "edited",
                        note:
                            state === null
                                ? `${skill.note}${agents.length > 1 ? `; read by ${readers.join(" and ")}` : ""}`
                                : "updated to this version",
                    });
                }
            }
        }
    }

    // ---- where the agent starts ---------------------------------------------------------------------------
    if (
        !options.agentDir &&
        !options.claudeDir &&
        gitRoot &&
        resolve(gitRoot) !== resolve(agentDir) &&
        app.role !== "standalone"
    ) {
        report.notes.push(
            `If you start your agent from the repo root (${relative(root, gitRoot) || "."}), add --agent-dir ${relative(root, gitRoot) || "."} so the server is registered and keeps its data there.`
        );
    }
    if (resolve(agentDir) !== resolve(appDir)) report.agentDir = relative(root, agentDir) || ".";

    // ---- the MCP server, registered with each agent ---------------------------------------------------------
    const windows = (options.platform ?? process.platform) === "win32";
    const register = options.mcp !== false;
    // npx only finds notato inside the app that installed it, so from another directory point at the binary.
    let bin: string | undefined;
    if (register && resolve(appDir) !== resolve(agentDir)) {
        bin = findBin(appDir, gitRoot, windows ? "notato.cmd" : "notato");
        if (!bin)
            report.warnings.push(
                `notato is not installed in ${where(".")}, so your agent could not start it from ${relative(root, agentDir) || "."}: run npm i -D notato @notato/react there, then init again`
            );
    }
    // A path from the agent's folder. On Windows cmd.exe runs it, which reads `./x` as the command `.` with a switch,
    // so it is written `.\x` there.
    const fromAgentDir = (path: string) => {
        const parts = relative(agentDir, path).split(/[\\/]/);
        return windows ? `.\\${parts.join("\\")}` : `./${parts.join("/")}`;
    };
    /** The command an agent runs: Windows needs cmd to start npx or a .cmd shim, which cannot be spawned directly. */
    const commandLine = (path?: string) => {
        const words = path ? [path, "dev"] : ["npx", "notato", "dev"];
        return windows ? ["cmd", "/c", ...words] : words;
    };
    // Several repositories can share one server (the first `notato dev` runs it, the rest attach): an agent registered
    // for this repository is kept to its project, so it is never handed another app's notes as work.
    const scope = ["--project", report.project];

    for (const agent of agents) {
        const done = (
            status: AgentRegistration["status"],
            extra: Partial<AgentRegistration> = {}
        ) => report.agents.push({ id: agent.id, name: agent.name, status, ...extra });
        if (!register) {
            done("skipped");
            continue;
        }
        if (agent.register.kind === "file") {
            // A project file, so a path to the binary is written from the agent's folder: it works for everyone.
            const path = join(agentDir, agent.register.path);
            const shown = relative(root, path) || agent.register.path;
            const existing = readIfExists(path);
            const server = [
                ...(bin ? commandLine(fromAgentDir(bin)) : ["npx", "notato", "dev"]),
                ...scope,
            ];
            const result = addToAgentConfig(
                existing,
                agent.register.key,
                agent.register.entry(server),
                report.project
            );
            if (result.state === "unreadable") {
                report.warnings.push(`${shown} ${result.reason}; ${manualCommand(agent, server)}`);
                done("failed", { file: shown });
                continue;
            }
            if (result.changed && !options.dryRun) writeConfig(path, result.source);
            report.changes.push({
                file: shown,
                action: !result.changed ? "unchanged" : existing === null ? "created" : "edited",
                note: result.note ?? `the MCP server for ${agent.name}`,
            });
            done(result.state, { file: shown });
            continue;
        }
        // An agent with a command of its own for this: claude mcp add, codex mcp add.
        if (options.dryRun) {
            done("skipped");
            continue;
        }
        const program = agent.register.program;
        if (!which(program)) {
            done("unavailable");
            continue;
        }
        const mcpScope =
            agent.id === "claude" && options.mcpScope && options.mcpScope !== "local"
                ? ["--scope", options.mcpScope]
                : [];
        // Codex keeps one list for every folder, and so does Claude Code's user scope: no one project to keep it to.
        const scoped = agent.id === "claude" && options.mcpScope !== "user";
        const server = [
            ...commandLine(
                bin && agent.id === "claude" && options.mcpScope === "project"
                    ? fromAgentDir(bin)
                    : bin
            ),
            ...(scoped ? scope : []),
        ];
        const run = options.run ?? defaultRun;
        const result = await run(
            [program, "mcp", "add", ...mcpScope, "notato", "--", ...server],
            agentDir
        );
        if (result.code === 0) done("added");
        else if (/already exists/i.test(result.output)) {
            done("already");
            // Registered before: say how to keep it to this project, unless it already is.
            if (scoped) {
                const words = (await run([program, "mcp", "get", "notato"], agentDir)).output
                    .split(/[\s,=]+/)
                    .filter(Boolean);
                if (
                    !(words.includes("--project") || words.includes("-P")) ||
                    !words.includes(report.project)
                )
                    report.notes.push(
                        `${agent.name} already had a notato server, kept as it is. If several repositories share one Notato server, keep this one to ${report.project}: ${program} mcp remove notato, then ${program} mcp add notato -- ${server.join(" ")}`
                    );
            }
        } else {
            done("failed");
            report.warnings.push(
                `${program} mcp add failed: ${result.output || `exit ${result.code}`}`
            );
        }
    }
    const statuses = report.agents.map((a) => a.status);
    report.mcp =
        (["failed", "added", "already", "unavailable"] as const).find((s) =>
            statuses.includes(s)
        ) ?? "skipped";
    if (report.agents.some((a) => a.id === "codex" && a.status === "added"))
        report.notes.push(
            "Codex keeps MCP servers for every project in ~/.codex/config.toml, so it starts notato wherever you run it, and is handed every project's notes."
        );
    if (
        options.mcpScope === "user" &&
        report.agents.some((a) => a.id === "claude" && a.status === "added")
    )
        report.notes.push(
            `Claude Code's notato server is registered for every folder (--mcp-scope user), so it is handed every project's notes, not only ${report.project}'s.`
        );
    return report;
}

/** One agent's line in the report. Agents registered by file already have their file's line. */
function agentLine(agent: AgentRegistration, report: InitReport, dryRun: boolean): string | null {
    const spec = AGENTS[agent.id];
    if (spec.register.kind === "file")
        return agent.status === "skipped" ? `  - skipped ${agent.name}` : null;
    const program = spec.register.program;
    switch (agent.status) {
        case "added":
            return `  + registered the MCP server with ${agent.name}${report.agentDir ? ` for ${report.agentDir}` : ""} (${program} mcp add notato)`;
        case "already":
            return `  = the MCP server is already registered with ${agent.name}`;
        case "skipped":
            return dryRun
                ? `  - skipped the ${agent.name} registration (dry run)`
                : `  - skipped the ${agent.name} registration`;
        case "unavailable":
            return `  ! the ${program} command was not found. Register the server yourself:\n      ${manualCommand(spec)}`;
        default:
            return `  ! could not register the MCP server with ${agent.name} (see below)`;
    }
}

export function formatReport(report: InitReport, dryRun: boolean): string {
    const lines = [
        report.pluginOnly
            ? `Notato ${dryRun ? "would wire" : "wired"} its Vite plugin:`
            : `Notato ${dryRun ? "would set up" : "set up"} ${report.project} (${report.framework}):`,
    ];
    if (report.app) {
        lines.push(`  App: ${report.app.dir}: ${report.app.reason}`);
    }
    lines.push("");
    for (const c of report.changes) {
        const mark = c.action === "edited" ? "~" : c.action === "created" ? "+" : "=";
        lines.push(`  ${mark} ${c.file}${c.note ? `  (${c.note})` : ""}`);
    }
    if (!report.pluginOnly && (report.changes.length > 0 || !report.notes.length))
        for (const agent of report.agents) {
            const line = agentLine(agent, report, dryRun);
            if (line) lines.push(line);
        }
    for (const w of report.warnings) lines.push(`  ! ${w}`);
    for (const n of report.notes) lines.push(`  ${report.changes.length ? "i" : "="} ${n}`);
    if (report.manual)
        lines.push(
            "",
            "Add this yourself:",
            "",
            ...report.manual.split("\n").map((l) => `    ${l}`)
        );
    if (!report.pluginOnly && report.agents.length) {
        const others = AGENT_IDS.filter((id) => !report.agents.some((a) => a.id === id));
        lines.push(
            "",
            `Set up for ${report.agents.map((a) => a.name).join(", ")}.${others.length ? ` For others: npx notato init --agent ${others.join(",")}` : ""}`
        );
    }
    if (!report.pluginOnly)
        lines.push(
            "",
            "Next: start your app, run `npx notato doctor` to check the whole loop, then ask your agent to watch Notato."
        );
    if (!dryRun && !report.pluginOnly && report.changes.some((c) => c.action !== "unchanged"))
        lines.push("To undo all of this later: npx notato init --revert");
    return lines.join("\n");
}

export async function runInitCommand(argv: string[]): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            app: { type: "string" },
            agent: { type: "string", multiple: true },
            "agent-dir": { type: "string" },
            "claude-dir": { type: "string" },
            yes: { type: "boolean", short: "y" },
            force: { type: "boolean" },
            server: { type: "string" },
            project: { type: "string" },
            mcp: { type: "boolean", default: true },
            "no-mcp": { type: "boolean" },
            plugin: { type: "boolean" },
            "plugin-only": { type: "boolean" },
            skill: { type: "boolean", default: true },
            "no-skill": { type: "boolean" },
            "mcp-scope": { type: "string" },
            guard: { type: "string" },
            "dry-run": { type: "boolean" },
            revert: { type: "boolean" },
            cwd: { type: "string", short: "C" },
            help: { type: "boolean", short: "h" },
        },
        allowNegative: true,
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    const guard = values.guard;
    if (guard !== undefined && !["dev", "env"].includes(guard))
        throw new Error("--guard must be dev or env");
    const scope = values["mcp-scope"];
    if (scope !== undefined && !["local", "project", "user"].includes(scope))
        throw new Error("--mcp-scope must be local, project or user");
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (values.revert) {
        const reverted = await runRevert({
            cwd: values.cwd ?? process.cwd(),
            app: values.app,
            agentDir: values["agent-dir"] ?? values["claude-dir"],
            agents: parseAgents(values.agent),
            yes: values.yes,
            dryRun: values["dry-run"],
            mcp: values["no-mcp"] ? false : values.mcp,
            mcpScope: scope as "local" | "project" | "user" | undefined,
            prompt: interactive ? terminalPrompt : undefined,
        });
        console.log(formatRevertReport(reverted, Boolean(values["dry-run"])));
        return reverted.warnings.length > 0 || reverted.mcp === "failed" ? 1 : 0;
    }
    const report = await runInit({
        cwd: values.cwd ?? process.cwd(),
        app: values.app,
        agentDir: values["agent-dir"] ?? values["claude-dir"],
        agents: parseAgents(values.agent),
        yes: values.yes,
        force: values.force,
        server: values.server,
        project: values.project,
        dryRun: values["dry-run"],
        mcp: values["no-mcp"] ? false : values.mcp,
        skill: values["no-skill"] ? false : values.skill,
        plugin: values.plugin,
        pluginOnly: values["plugin-only"],
        mcpScope: scope as "local" | "project" | "user" | undefined,
        guard: guard as "dev" | "env" | undefined,
        prompt: interactive ? terminalPrompt : undefined,
    });
    console.log(formatReport(report, Boolean(values["dry-run"])));
    const nothingToDo = report.notes.length > 0 && report.changes.length === 0;
    return (report.framework === "unknown" && !nothingToDo) || report.mcp === "failed" ? 1 : 0;
}
