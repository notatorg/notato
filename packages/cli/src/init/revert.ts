import {
    type Dirent,
    existsSync,
    readdirSync,
    readFileSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
    AGENTS,
    type Agent,
    type AgentRegistration,
    deleteConfig,
    isNotatoEntry,
    readIfExists,
    removeFromAgentConfig,
    SKILL_DIRS,
    scopeArgs,
    writeConfig,
} from "../agents.ts";
import {
    type AppInfo,
    dependsOn,
    describeApp,
    discoverApps,
    findGitRoot,
    findHostAbove,
    nextComponentFile,
    nextRoot,
    readJson,
    viteConfigFile,
    viteEntry,
} from "../discover.ts";
import { runProgram } from "../process.ts";
import { SKILLS, skillState } from "../skill.ts";
import { AmbiguousAppError, appLabel } from "./choose-app.ts";
import type { InitOptions } from "./init.ts";
import { pluginTargets } from "./plugin.ts";
import { overall, type RevertReport } from "./report.ts";
import {
    type Edit,
    isGeneratedNotatoComponent,
    removeFromGitignore,
    removeFromNextLayout,
    removeFromNextPagesApp,
    removeFromViteConfig,
    removeFromViteEntry,
} from "./transforms.ts";

export type RevertOptions = Pick<
    InitOptions,
    | "cwd"
    | "app"
    | "agentDir"
    | "agents"
    | "dryRun"
    | "mcp"
    | "mcpScope"
    | "prompt"
    | "run"
    | "which"
>;

/** Everything the steps of one revert share. */
interface Revert {
    options: RevertOptions;
    report: RevertReport;
    /** Where it was run. */
    root: string;
    agentDir: string;
    gitRoot: string | null;
    /** A path as the report shows it: relative to where it was run. */
    rel: (path: string) => string;
    which: (name: string) => string | null;
    /** Applies a transform's edit to a file and records it, warning when it could not undo what init did. */
    apply: (path: string, change: Edit) => void;
}

/**
 * Undoes `runInit`: the toolbar in the app's code, the Vite plugin, the `.gitignore` line, the skills, and the MCP
 * server in each agent's settings. The recorded annotations are kept.
 */
export async function runRevert(options: RevertOptions): Promise<RevertReport> {
    const root = resolve(options.cwd);
    const report: RevertReport = {
        changes: [],
        warnings: [],
        notes: [],
        mcp: "skipped",
        agents: [],
    };
    const agentDir = resolve(root, options.agentDir ?? ".");
    const rel = (path: string) => relative(root, path) || path;
    const revert: Revert = {
        options,
        report,
        root,
        agentDir,
        gitRoot: findGitRoot(agentDir),
        rel,
        which: options.which ?? ((name) => Bun.which(name)),
        apply(path, change) {
            if (change.changed && !options.dryRun) writeFileSync(path, change.source);
            report.changes.push({
                file: rel(path),
                action: change.changed ? "edited" : "unchanged",
                note: change.reason ?? change.note,
            });
            const expected =
                change.reason === "not set up" || /left as it is/.test(change.reason ?? "");
            if (!change.changed && change.reason && !expected)
                report.warnings.push(`${rel(path)}: ${change.reason}`);
        },
    };

    const app = await chooseApp(revert);
    if (app) removeToolbar(revert, app);
    unwirePlugin(revert);
    unignoreDataFolder(revert);
    removeSkills(revert);
    await unregisterAgents(revert);
    return report;
}

/** The app that renders the toolbar: `--app`, this directory, or the one app below that has it. */
async function chooseApp({ options, root, report }: Revert): Promise<AppInfo | null> {
    if (options.app) {
        const app = describeApp(resolve(root, options.app), root);
        if (!app) throw new Error(`${options.app} is not a React app`);
        return app;
    }
    const self = describeApp(root, root);
    if (self?.hasNotato) return self;
    if (self) {
        const host = findHostAbove(self.dir);
        report.notes.push(
            host?.hasNotato
                ? `${self.rel === "." ? "This app" : self.rel} does not render <Notato />. Its federation host ${relative(root, host.dir)} does: run this there (or with --app ${relative(root, host.dir)}).`
                : "This app does not render <Notato />, so there is nothing to take out of its code."
        );
        return null;
    }
    const found = discoverApps(root).filter((a) => a.hasNotato);
    if (found.length === 0) {
        report.notes.push(
            "No app here renders <Notato />, so there is nothing to take out of any code."
        );
        return null;
    }
    if (found.length === 1) return found[0] as AppInfo;
    if (options.prompt) {
        const choice = await options.prompt(
            `${found.length} apps render <Notato />. Which one do you want to revert?`,
            found.map((a) => appLabel(a, false)),
            0
        );
        return found[choice] as AppInfo;
    }
    throw new AmbiguousAppError(
        `${found.length} apps render <Notato /> and no terminal to ask in:\n${found.map((a) => `  ${a.rel}`).join("\n")}\n\nPick one with --app <dir>.`
    );
}

/** The toolbar out of the app's code: the Vite entry, or the Next.js root and the component init wrote. */
function removeToolbar({ options, report, root, rel, apply }: Revert, app: AppInfo) {
    report.app = { dir: relative(root, app.dir) || ".", reason: "it renders <Notato />" };
    if (app.framework === "next") {
        const next = nextRoot(app.dir);
        if (next) {
            const path = join(app.dir, next.file);
            const source = readFileSync(path, "utf8");
            apply(
                path,
                next.router === "app"
                    ? removeFromNextLayout(source)
                    : removeFromNextPagesApp(source)
            );
            // The client component init wrote next to it, if it is still the one init wrote.
            const component = [".tsx", ".jsx", ".js"]
                .map((extension) => join(app.dir, nextComponentFile(next, extension)))
                .find((file) => existsSync(file));
            if (component) {
                if (isGeneratedNotatoComponent(readFileSync(component, "utf8"))) {
                    if (!options.dryRun) rmSync(component);
                    report.changes.push({ file: rel(component), action: "deleted" });
                } else {
                    report.warnings.push(
                        `${rel(component)} is not the file init wrote, so it was left alone`
                    );
                }
            }
        } else {
            report.warnings.push(
                "could not find app/layout or pages/_app to take the toolbar out of"
            );
        }
    } else {
        const entry = viteEntry(app.dir);
        if (entry) {
            const path = join(app.dir, entry);
            apply(path, removeFromViteEntry(readFileSync(path, "utf8")));
        } else {
            report.warnings.push(
                "could not find the app's entry file (looked at index.html and src/main.*)"
            );
        }
    }

    const env = join(app.dir, ".env.local");
    if (existsSync(env) && /^\s*VITE_NOTATO\s*=/m.test(readFileSync(env, "utf8"))) {
        report.notes.push(
            `${rel(env)} still sets VITE_NOTATO. It does nothing now; remove the line when you like.`
        );
    }
    if (dependsOn(readJson(join(app.dir, "package.json")) ?? {}, "@notato/react")) {
        report.notes.push(
            `The packages are still installed. To remove them: npm rm notato @notato/react (in ${rel(app.dir)})`
        );
    }
}

/** The Vite plugin, wherever it was wired: every module is built on its own, so each has its own config. */
function unwirePlugin({ options, report, root, rel, apply }: Revert) {
    for (const target of pluginTargets(options.app, root)) {
        const configName = viteConfigFile(target.dir);
        if (!configName) continue;
        const path = join(target.dir, configName);
        const change = removeFromViteConfig(readFileSync(path, "utf8"));
        if (change.reason === "not set up") continue;
        apply(path, change);
        if (dependsOn(readJson(join(target.dir, "package.json")) ?? {}, "@notato/vite")) {
            report.notes.push(
                `@notato/vite is still installed in ${rel(target.dir)}. To remove it: npm rm @notato/vite`
            );
        }
    }
}

/**
 * The `.notato` folders a `.notato/` line in `base`'s .gitignore keeps out of git: where the agent starts (the server's
 * data folder) and any a few levels below `base`, outside node_modules and hidden folders.
 */
function notatoFolders(base: string, agentDir: string): string[] {
    const found = new Set<string>();
    const own = join(agentDir, ".notato");
    const fromBase = relative(base, own);
    if (!fromBase.startsWith("..") && !isAbsolute(fromBase) && existsSync(own)) found.add(own);
    const walk = (dir: string, depth: number) => {
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (e.name === ".notato") found.add(join(dir, e.name));
            else if (depth > 0 && !e.name.startsWith(".") && e.name !== "node_modules")
                walk(join(dir, e.name), depth - 1);
        }
    };
    walk(base, 3);
    return [...found];
}

/** The .gitignore line goes only once there is no .notato folder left for it to keep out of git. */
function unignoreDataFolder({ report, agentDir, gitRoot, rel, apply }: Revert) {
    const ignores = [
        ...new Set([join(agentDir, ".gitignore"), gitRoot ? join(gitRoot, ".gitignore") : ""]),
    ];
    let keptIgnore = false;
    for (const path of ignores) {
        if (!path || !existsSync(path)) continue;
        const change = removeFromGitignore(readFileSync(path, "utf8"));
        if (change.changed && notatoFolders(dirname(path), agentDir).length > 0) {
            // A .notato folder holds the database and the server's secrets (device.json's token): ignored it stays.
            keptIgnore = true;
            report.changes.push({
                file: rel(path),
                action: "unchanged",
                note: "kept .notato/, so the data and tokens in it stay out of git",
            });
        } else if (change.changed || change.reason !== "not set up") apply(path, change);
    }
    const data = notatoFolders(gitRoot ?? agentDir, agentDir);
    if (data.length) {
        const one = data.length === 1;
        report.notes.push(
            `${data.map(rel).join(", ")} (your annotations, screenshots and the server's tokens) ${one ? "was" : "were"} left in place${keptIgnore ? ", and so was the .notato/ line in .gitignore that keeps it out of git" : ""}. Delete ${one ? "it" : "them"} if you no longer need ${one ? "it" : "them"}${keptIgnore ? ", then run `npx notato init --revert` again to take the line out" : ""}.`
        );
    }
}

/** Whether `--agent` (or its absence, which means all of them) includes this agent. */
const isChosen = (options: RevertOptions, agent: Agent) =>
    !options.agents || options.agents.includes(agent.id);

/** The skills, from the skills folder of each agent being reverted: each removed only if nobody has edited it. */
function removeSkills({ options, report, agentDir, rel, which }: Revert) {
    /** Whether an agent that is not being reverted may still use Notato, and so read its skills. */
    const stillSetUp = (agent: Agent) => {
        if (agent.register.kind === "command") return Boolean(which(agent.register.program));
        try {
            const text = readIfExists(join(agentDir, agent.register.path));
            const config = text === null ? null : (JSON.parse(text) as Record<string, unknown>);
            return isNotatoEntry(
                (config?.[agent.register.key] as Record<string, unknown> | undefined)?.notato
            );
        } catch {
            return false;
        }
    };
    for (const skillsDir of SKILL_DIRS) {
        const readers = Object.values(AGENTS).filter((a) => a.skillsDir === skillsDir);
        if (!readers.some((a) => isChosen(options, a))) continue;
        // A folder several agents read (.agents/skills) stays while one that is not being reverted uses it.
        const others = readers.filter((a) => !isChosen(options, a) && stillSetUp(a));
        if (others.length) {
            if (SKILLS.some((skill) => existsSync(join(agentDir, skillsDir, skill.file))))
                report.notes.push(
                    `The skills in ${rel(join(agentDir, skillsDir))} were kept: ${others.map((a) => a.name).join(" and ")} ${others.length === 1 ? "reads" : "read"} them too. Add ${others.map((a) => a.id).join(",")} to --agent to remove them.`
                );
            continue;
        }
        for (const skill of SKILLS) {
            const skillFile = join(agentDir, skillsDir, skill.file);
            if (!existsSync(skillFile)) continue;
            if (skillState(readFileSync(skillFile, "utf8"), skill.name) === "edited") {
                report.notes.push(`${rel(skillFile)} has been edited, so it was left in place.`);
                continue;
            }
            if (!options.dryRun) {
                rmSync(skillFile);
                // The folders init made go with it, once they are empty; anything else in them is not ours.
                for (const dir of [
                    dirname(skillFile),
                    dirname(dirname(skillFile)),
                    dirname(dirname(dirname(skillFile))),
                ]) {
                    try {
                        rmdirSync(dir);
                    } catch {
                        break;
                    }
                }
            }
            report.changes.push({ file: rel(skillFile), action: "deleted" });
        }
    }
}

/** The MCP server, out of each agent's settings. */
async function unregisterAgents({ options, report, agentDir, rel, which }: Revert) {
    for (const agent of Object.values(AGENTS)) {
        if (!isChosen(options, agent)) continue;
        const done = (
            status: AgentRegistration["status"],
            extra: Partial<AgentRegistration> = {}
        ) => report.agents.push({ id: agent.id, name: agent.name, status, ...extra });
        if (agent.register.kind === "file") {
            // A project file init wrote to: only Notato's own entry comes out, and the file only if nothing else is left.
            const path = join(agentDir, agent.register.path);
            if (!existsSync(path)) continue;
            if (options.mcp === false) {
                done("skipped", { file: rel(path) });
                continue;
            }
            const change = removeFromAgentConfig(readFileSync(path, "utf8"), agent.register.key);
            if (!change.changed) {
                if (change.reason !== "not set up")
                    report.notes.push(`${rel(path)} ${change.reason}.`);
                continue;
            }
            if (!options.dryRun) {
                if (change.empty) deleteConfig(path);
                else writeConfig(path, change.source);
            }
            report.changes.push({ file: rel(path), action: change.empty ? "deleted" : "edited" });
            done("removed", { file: rel(path) });
            continue;
        }
        const program = agent.register.program;
        // Codex keeps one list of MCP servers for every project: take Notato out of it only when asked by name.
        if (agent.id === "codex" && !options.agents?.includes("codex")) {
            if (which(program))
                report.notes.push(
                    "Codex's MCP servers are shared by every project, so notato was left there. If you no longer use it anywhere: codex mcp remove notato"
                );
            continue;
        }
        if (options.mcp === false || options.dryRun) {
            done("skipped");
            continue;
        }
        if (!which(program)) {
            done("unavailable");
            continue;
        }
        const result = await (options.run ?? runProgram)(
            [program, "mcp", "remove", ...scopeArgs(agent, options.mcpScope), "notato"],
            agentDir
        );
        if (result.code === 0) done("removed");
        else if (/no mcp server found|not found|no such|does not exist/i.test(result.output))
            done("already");
        else {
            done("failed");
            report.warnings.push(
                `${program} mcp remove failed: ${result.output || `exit ${result.code}`}`
            );
        }
    }
    report.mcp = overall(report.agents, ["failed", "removed", "already", "unavailable"] as const);
}
