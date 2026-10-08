import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
    AGENTS,
    type Agent,
    type AgentId,
    type AgentRegistration,
    addToAgentConfig,
    type McpScope,
    manualCommand,
    readIfExists,
    resolveAgents,
    scopeArgs,
    writeConfig,
} from "../agents.ts";
import {
    type AppInfo,
    dependsOn,
    findGitRoot,
    nextComponentFile,
    nextRoot,
    notatoRenderedIn,
    readJson,
    viteEntry,
} from "../discover.ts";
import { type RunProgram, runProgram } from "../process.ts";
import { renderSkill, SKILLS, skillState } from "../skill.ts";
import { resolveStyle, type Style } from "../style.ts";
import type { Prompt } from "../terminal.ts";
import { chooseApp } from "./choose-app.ts";
import { pluginTargets, wirePlugin } from "./plugin.ts";
import { type InitReport, overall } from "./report.ts";
import {
    addToGitignore,
    addToNextLayout,
    addToNextPagesApp,
    addToViteEntry,
    type Edit,
    nextClientComponent,
    projectIdFromPackage,
    type SetupOptions,
} from "./transforms.ts";

export interface InitOptions {
    cwd: string;
    /** The app to set up, relative to `cwd`. Default: `cwd`, or the one init works out below it. */
    app?: string;
    /** Where the agent starts, relative to `cwd`, if not there. The MCP server is registered for it. */
    agentDir?: string;
    /** The agents to set up. Default: NOTATO_AGENTS, else the ones found (see `detectAgents`). */
    agents?: AgentId[];
    yes?: boolean;
    force?: boolean;
    server?: string;
    project?: string;
    dryRun?: boolean;
    /** Register the MCP server with the agents. Default true. */
    mcp?: boolean;
    /** Write the skills. Default true. */
    skill?: boolean;
    /** Also wire `notatoSource()` into the Vite config(s). */
    plugin?: boolean;
    /** Only wire the plugin. */
    pluginOnly?: boolean;
    mcpScope?: McpScope;
    /** `dev`, or `env` to also render in a build made with VITE_NOTATO=true. Default: `env` when the app is built and previewed. */
    guard?: "dev" | "env";
    /** Asks the person to choose. Absent when there is no terminal: then ambiguity is an error. */
    prompt?: Prompt;
    run?: RunProgram;
    /** Resolves a program on PATH. Injectable for tests. */
    which?: (name: string) => string | null;
    platform?: NodeJS.Platform;
}

export const DEFAULT_SERVER = "http://localhost:4747";

/** Everything the steps of one run share. */
interface Run {
    options: InitOptions;
    report: InitReport;
    /** Where init was run. */
    root: string;
    app: AppInfo;
    /** Where the agent starts: the MCP server is registered for it, and keeps its data there. */
    agentDir: string;
    gitRoot: string | null;
    /** A file in the app, as the report shows it: relative to where init was run. */
    where: (file: string) => string;
    which: (name: string) => string | null;
}

const notatoTag = (setup: Pick<SetupOptions, "project" | "server">) =>
    `<Notato mode="dev" project=${JSON.stringify(setup.project)} server=${JSON.stringify(setup.server)} />`;

/**
 * Sets Notato up: the toolbar in the app's code, `.notato/` in .gitignore, the skills, and the MCP server in each
 * agent. Safe to run twice; `runRevert` undoes it.
 */
export async function runInit(options: InitOptions): Promise<InitReport> {
    const root = resolve(options.cwd);
    const dryRun = Boolean(options.dryRun);
    const server = options.server ?? DEFAULT_SERVER;
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
        wirePlugin(pluginTargets(options.app, root), root, dryRun, report);
        report.notes.push(
            "It records source positions only when VITE_NOTATO=true is set where the build runs; otherwise a build is unchanged."
        );
        return report;
    }

    const chosen = await chooseApp(options, root);
    if (!chosen) {
        // React, but not a bundler init can edit: say what to add rather than guess.
        const pkg = readJson(join(root, "package.json")) ?? {};
        report.project = options.project ?? projectIdFromPackage(pkg.name as string | undefined);
        report.warnings.push("neither Vite nor Next.js found; add the component by hand");
        report.manual = `import { Notato } from "@notato/react"\n\n${notatoTag({ project: report.project, server })}`;
        return report;
    }
    const { app } = chosen;
    report.app = { dir: relative(root, app.dir) || ".", role: app.role, reason: chosen.reason };
    report.framework = app.framework === "next" ? "next-app" : "vite";
    if (chosen.done) {
        report.notes.push(chosen.done);
        if (options.plugin) wirePlugin(pluginTargets(options.app, root), root, dryRun, report);
        return report;
    }

    const pkg = readJson(join(app.dir, "package.json")) ?? {};
    const agentDir = resolve(root, options.agentDir ?? ".");
    const gitRoot = findGitRoot(agentDir);
    const run: Run = {
        options,
        report,
        root,
        app,
        agentDir,
        gitRoot,
        where: (file) => relative(root, join(app.dir, file)) || file,
        which: options.which ?? ((name) => Bun.which(name)),
    };

    // The project is the product, not the module: a host's id is the repo's, so one project covers every module.
    report.project =
        options.project ??
        projectIdFromPackage(
            app.role === "host" ? basename(gitRoot ?? agentDir) : (pkg.name as string | undefined)
        );
    const setup: SetupOptions = { project: report.project, server, guard: chooseGuard(run, pkg) };

    if (!dependsOn(pkg, "@notato/react")) {
        report.warnings.push(
            `@notato/react is not in ${run.where("package.json")}; install it there with: npm i -D notato @notato/react`
        );
    }
    addToolbar(run, setup);
    if (options.plugin) wirePlugin(pluginTargets(options.app, root), root, dryRun, report);
    else if (setup.guard === "env" && app.framework === "vite") {
        report.notes.push(
            "A built app has no React dev build to say which file an element came from. For the exact file and line, also run: npx notato init --plugin"
        );
    }
    ignoreDataFolder(run);

    const agents = resolveAgents(
        options.agents,
        [...new Set([agentDir, gitRoot ?? agentDir])],
        run.which
    ).map((id) => AGENTS[id]);
    if (options.skill !== false) writeSkills(run, agents);

    if (
        !options.agentDir &&
        gitRoot &&
        resolve(gitRoot) !== agentDir &&
        app.role !== "standalone"
    ) {
        const repo = relative(root, gitRoot) || ".";
        report.notes.push(
            `If you start your agent from the repo root (${repo}), add --agent-dir ${repo} so the server is registered and keeps its data there.`
        );
    }
    if (agentDir !== resolve(app.dir)) report.agentDir = relative(root, agentDir) || ".";

    await registerAgents(run, agents);
    return report;
}

/**
 * The guard around the toolbar. Apps built and previewed during development (`vite build --watch` + `vite preview`)
 * never see import.meta.env.DEV, so for them it is `env`: also render in a build made with VITE_NOTATO=true.
 */
function chooseGuard(run: Run, pkg: Record<string, unknown>): "dev" | "env" {
    const scripts = Object.entries((pkg.scripts as Record<string, string> | undefined) ?? {});
    const watched = scripts.find(([, command]) =>
        /\bvite\s+build\b[^&|;]*(?:--watch|\s-w\b)/.test(command)
    )?.[0];
    const vite = run.app.framework === "vite";
    const guard = run.options.guard ?? (vite && watched ? "env" : "dev");
    if (guard === "env" && vite) {
        run.report.notes.push(
            `${watched ? `This app is built and previewed (the "${watched}" script), where import.meta.env.DEV is false, so ` : ""}the toolbar also renders in a build made with VITE_NOTATO=true. Set that where the build runs, for example in ${run.where(".env.local")}; leave it unset for anything shared and the build ships nothing.`
        );
    }
    return guard;
}

/** Writes a file in the app, unless this is a dry run. */
function writeInApp(run: Run, file: string, content: string) {
    if (run.options.dryRun) return;
    mkdirSync(dirname(join(run.app.dir, file)), { recursive: true });
    writeFileSync(join(run.app.dir, file), content);
}

/** Applies a transform's edit to a file in the app, and records it. */
function applyEdit(run: Run, file: string, edit: Edit): Edit {
    if (edit.changed) writeInApp(run, file, edit.source);
    run.report.changes.push({
        file: run.where(file),
        action: edit.changed ? "edited" : "unchanged",
        note: edit.reason ?? edit.note,
    });
    return edit;
}

const styleOf = (run: Run, file: string): Style =>
    resolveStyle(readFileSync(join(run.app.dir, file), "utf8"), join(run.app.dir, dirname(file)));

/**
 * Renders the toolbar: next to `<App />` in a Vite entry, or through a client component in a Next.js root. Where the
 * code is not in a shape init can edit safely, it leaves it alone and says what to add by hand.
 */
function addToolbar(run: Run, setup: SetupOptions) {
    const { app, report, where } = run;
    // Already rendered somewhere other than where init puts it (App.tsx, a providers file): a second toolbar would be
    // one too many. A Vite entry init edited says so itself ("already set up"); for Next.js, init's own component
    // does not count and the layout renders <NotatoDev />, so any <Notato /> found is the person's own.
    const renderedIn = notatoRenderedIn(app.dir);
    if (renderedIn && (app.framework === "next" || renderedIn !== viteEntry(app.dir))) {
        report.changes.push({
            file: where(renderedIn),
            action: "unchanged",
            note: "already renders <Notato />, so no second one was added",
        });
        return;
    }

    if (app.framework === "vite") {
        const entry = viteEntry(app.dir);
        const manual = `Render ${notatoTag(setup)} next to <App />, guarded by import.meta.env.DEV.`;
        if (!entry) {
            report.warnings.push(
                "could not find the app's entry file (looked at index.html and src/main.*)"
            );
            report.manual = manual;
            return;
        }
        const source = readFileSync(join(app.dir, entry), "utf8");
        const edit = applyEdit(run, entry, addToViteEntry(source, setup, styleOf(run, entry)));
        if (!edit.changed && edit.reason !== "already set up") {
            report.warnings.push(`${where(entry)}: ${edit.reason}`);
            report.manual = manual;
        }
        return;
    }

    const next = nextRoot(app.dir);
    if (!next) {
        report.framework = "unknown";
        report.manual =
            'Add <Notato mode="dev" … /> to a client component rendered in your root layout.';
        report.warnings.push("could not find app/layout or pages/_app");
        return;
    }
    report.framework = next.router === "app" ? "next-app" : "next-pages";
    const style = styleOf(run, next.file);
    const extension = next.file.endsWith("x")
        ? next.file.slice(next.file.lastIndexOf("."))
        : ".jsx";
    const componentFile = nextComponentFile(next, extension);
    const importPath =
        next.router === "app"
            ? "./notato-dev"
            : relative(dirname(next.file), componentFile.replace(/\.\w+$/, ""))
                  .split("\\")
                  .join("/");
    const spec = importPath.startsWith(".") ? importPath : `./${importPath}`;
    if (existsSync(join(app.dir, componentFile))) {
        report.changes.push({
            file: where(componentFile),
            action: "unchanged",
            note: "already exists",
        });
    } else {
        writeInApp(run, componentFile, nextClientComponent(setup, style));
        report.changes.push({ file: where(componentFile), action: "created" });
    }
    const source = readFileSync(join(app.dir, next.file), "utf8");
    const edit = applyEdit(
        run,
        next.file,
        next.router === "app"
            ? addToNextLayout(source, spec, style)
            : addToNextPagesApp(source, spec, style)
    );
    if (!edit.changed && edit.reason !== "already set up") {
        report.manual = `Render <NotatoDev /> (from ${spec}) inside ${where(next.file)}.`;
        report.warnings.push(`${where(next.file)}: ${edit.reason}`);
    }
}

/** `.notato/` in the .gitignore where the server will run (where the agent starts), or else the repo's own. */
function ignoreDataFolder({ agentDir, gitRoot, root, options, report }: Run) {
    const ignorePath = [
        join(agentDir, ".gitignore"),
        gitRoot ? join(gitRoot, ".gitignore") : "",
    ].find((p) => p && existsSync(p));
    if (!ignorePath) {
        report.warnings.push(
            `no .gitignore found from ${relative(root, agentDir) || "."} up to the repo root; add .notato/ to it yourself`
        );
        return;
    }
    const edit = addToGitignore(readFileSync(ignorePath, "utf8"));
    if (edit.changed && !options.dryRun) writeFileSync(ignorePath, edit.source);
    report.changes.push({
        file: relative(root, ignorePath),
        action: edit.changed ? "edited" : "unchanged",
        note: edit.reason,
    });
}

/** The skills, in each agent's skills folder where the agent starts, so it finds them. */
function writeSkills({ agentDir, root, options, report }: Run, agents: Agent[]) {
    for (const skillsDir of [...new Set(agents.map((a) => a.skillsDir))]) {
        const readers = agents.filter((a) => a.skillsDir === skillsDir).map((a) => a.name);
        for (const skill of SKILLS) {
            const skillFile = join(agentDir, skillsDir, skill.file);
            const shown = relative(root, skillFile) || join(skillsDir, skill.file);
            const existing = existsSync(skillFile) ? readFileSync(skillFile, "utf8") : null;
            const state = existing === null ? null : skillState(existing, skill.name);
            if (state === "edited") {
                report.changes.push({
                    file: shown,
                    action: "unchanged",
                    note: "has been edited, so it was left as it is",
                });
                continue;
            }
            if (state === "current") {
                report.changes.push({ file: shown, action: "unchanged" });
                continue;
            }
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

/**
 * The notato binary an app can run: in its own node_modules, or hoisted to a workspace root above it (npm, Yarn and
 * Bun workspaces), up to the repository root.
 */
function findBin(appDir: string, gitRoot: string | null, name: string): string | undefined {
    for (let dir = resolve(appDir); ; dir = dirname(dir)) {
        const candidate = join(dir, "node_modules", ".bin", name);
        if (existsSync(candidate)) return candidate;
        if ((gitRoot && dir === resolve(gitRoot)) || dirname(dir) === dir) return undefined;
    }
}

/** The MCP server, registered with each agent: by the agent's own command, or in its project file. */
async function registerAgents(run: Run, agents: Agent[]) {
    const { options, report, root, agentDir, gitRoot } = run;
    const windows = (options.platform ?? process.platform) === "win32";
    const register = options.mcp !== false;
    // npx only finds notato inside the app that installed it, so from another directory point at the binary.
    let bin: string | undefined;
    if (register && resolve(run.app.dir) !== agentDir) {
        bin = findBin(run.app.dir, gitRoot, windows ? "notato.cmd" : "notato");
        if (!bin)
            report.warnings.push(
                `notato is not installed in ${run.where(".")}, so your agent could not start it from ${relative(root, agentDir) || "."}: run npm i -D notato @notato/react there, then init again`
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
        if (!run.which(program)) {
            done("unavailable");
            continue;
        }
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
        const runCommand = options.run ?? runProgram;
        const result = await runCommand(
            [
                program,
                "mcp",
                "add",
                ...scopeArgs(agent, options.mcpScope),
                "notato",
                "--",
                ...server,
            ],
            agentDir
        );
        if (result.code === 0) done("added");
        else if (/already exists/i.test(result.output)) {
            done("already");
            // Registered before: say how to keep it to this project, unless it already is.
            if (scoped) {
                const words = (await runCommand([program, "mcp", "get", "notato"], agentDir)).output
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
    report.mcp = overall(report.agents, ["failed", "added", "already", "unavailable"] as const);
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
}
