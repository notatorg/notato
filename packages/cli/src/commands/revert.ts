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
    writeConfig,
} from "../agents.ts";
import {
    type AppInfo,
    describeApp,
    discoverApps,
    findGitRoot,
    findHostAbove,
    viteConfigFile,
} from "../discover.ts";
import {
    type Edit,
    isGeneratedNotatoComponent,
    removeFromGitignore,
    removeFromNextLayout,
    removeFromNextPagesApp,
    removeFromViteConfig,
    removeFromViteEntry,
} from "../init-transforms.ts";
import { SKILLS, skillState } from "../skill.ts";
import {
    AmbiguousAppError,
    defaultRun,
    firstExisting,
    type InitOptions,
    viteEntry,
} from "./init.ts";

export interface RevertChange {
    file: string;
    action: "edited" | "deleted" | "unchanged";
    note?: string;
}

export interface RevertReport {
    /** The app the toolbar was taken out of, relative to where this ran. */
    app?: { dir: string; reason: string };
    changes: RevertChange[];
    warnings: string[];
    notes: string[];
    /** Overall, as in `InitReport`; each agent is in `agents`. */
    mcp: "removed" | "already" | "skipped" | "unavailable" | "failed";
    agents: AgentRegistration[];
}

export type RevertOptions = Pick<
    InitOptions,
    | "cwd"
    | "app"
    | "agentDir"
    | "claudeDir"
    | "agents"
    | "yes"
    | "dryRun"
    | "mcp"
    | "mcpScope"
    | "prompt"
    | "run"
    | "which"
>;

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

const label = (a: AppInfo) =>
    `${a.rel}  (${a.framework}${a.role === "standalone" ? "" : `, federation ${a.role}`})`;

/** The app that renders the toolbar: this directory, `--app`, or the one app below that has it. */
async function chooseApp(
    options: RevertOptions,
    root: string,
    report: RevertReport
): Promise<AppInfo | null> {
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
                : `This app does not render <Notato />, so there is nothing to take out of its code.`
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
            found.map(label),
            0
        );
        return found[choice] as AppInfo;
    }
    throw new AmbiguousAppError(
        `${found.length} apps render <Notato /> and no terminal to ask in:\n${found.map((a) => `  ${a.rel}`).join("\n")}\n\nPick one with --app <dir>.`
    );
}

/**
 * Undoes `runInit`: the toolbar in the app's code, the `.gitignore` block, the skills, and the MCP server in each
 * agent's project settings and in Claude Code.
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
    const agentDir = resolve(root, options.agentDir ?? options.claudeDir ?? ".");
    const gitRoot = findGitRoot(agentDir);
    const rel = (path: string) => relative(root, path) || path;

    const edit = (path: string, change: Edit) => {
        if (change.changed && !options.dryRun) writeFileSync(path, change.source);
        report.changes.push({
            file: rel(path),
            action: change.changed ? "edited" : "unchanged",
            note: change.reason ?? change.note,
        });
        if (
            !change.changed &&
            change.reason &&
            !["not set up"].includes(change.reason) &&
            !/left as it is/.test(change.reason)
        )
            report.warnings.push(`${rel(path)}: ${change.reason}`);
    };

    // ---- the app's code -------------------------------------------------------------------------------
    const app = await chooseApp(options, root, report);
    if (app) {
        report.app = {
            dir: app.rel === "." ? "." : relative(root, app.dir) || ".",
            reason: "it renders <Notato />",
        };
        if (app.framework === "next") {
            const layout = firstExisting(app.dir, [
                "app/layout.tsx",
                "app/layout.jsx",
                "app/layout.js",
                "src/app/layout.tsx",
                "src/app/layout.jsx",
                "src/app/layout.js",
            ]);
            const pagesApp = firstExisting(app.dir, [
                "pages/_app.tsx",
                "pages/_app.jsx",
                "pages/_app.js",
                "src/pages/_app.tsx",
                "src/pages/_app.jsx",
                "src/pages/_app.js",
            ]);
            const target = layout ?? pagesApp;
            if (target) {
                const path = join(app.dir, target);
                const source = readFileSync(path, "utf8");
                edit(path, layout ? removeFromNextLayout(source) : removeFromNextPagesApp(source));
                // The client component init wrote next to it, if it is still the one init wrote.
                const component = firstExisting(app.dir, [
                    layout ? join(target, "..", "notato-dev.tsx") : "components/notato-dev.tsx",
                    layout ? join(target, "..", "notato-dev.jsx") : "components/notato-dev.jsx",
                    layout ? join(target, "..", "notato-dev.js") : "components/notato-dev.js",
                    "src/components/notato-dev.tsx",
                    "src/components/notato-dev.jsx",
                    "src/components/notato-dev.js",
                ]);
                if (component) {
                    const file = join(app.dir, component);
                    if (isGeneratedNotatoComponent(readFileSync(file, "utf8"))) {
                        if (!options.dryRun) rmSync(file);
                        report.changes.push({ file: rel(file), action: "deleted" });
                    } else {
                        report.warnings.push(
                            `${rel(file)} is not the file init wrote, so it was left alone`
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
                edit(path, removeFromViteEntry(readFileSync(path, "utf8")));
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
        const pkg = JSON.parse(readFileSync(join(app.dir, "package.json"), "utf8")) as Record<
            string,
            Record<string, string>
        >;
        if (pkg.dependencies?.["@notato/react"] || pkg.devDependencies?.["@notato/react"]) {
            report.notes.push(
                `The packages are still installed. To remove them: npm rm notato @notato/react (in ${rel(app.dir)})`
            );
        }
    }

    // ---- the Vite plugin, wherever it was wired: every module is built on its own, so each has its own config ----
    const pluginApps = options.app
        ? [describeApp(resolve(root, options.app), root)]
        : describeApp(root, root)
          ? [describeApp(root, root)]
          : discoverApps(root).filter((a) => a.framework === "vite");
    for (const target of pluginApps) {
        const configName = target && viteConfigFile(target.dir);
        if (!target || !configName) continue;
        const path = join(target.dir, configName);
        const change = removeFromViteConfig(readFileSync(path, "utf8"));
        if (change.reason === "not set up") continue;
        edit(path, change);
        const pkg = JSON.parse(readFileSync(join(target.dir, "package.json"), "utf8")) as Record<
            string,
            Record<string, string>
        >;
        if (pkg.dependencies?.["@notato/vite"] || pkg.devDependencies?.["@notato/vite"]) {
            report.notes.push(
                `@notato/vite is still installed in ${rel(target.dir)}. To remove it: npm rm @notato/vite`
            );
        }
    }

    // ---- .gitignore: the line goes only once there is no .notato folder left for it to keep out of git ---------
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
        } else if (change.changed) edit(path, change);
        else if (change.reason !== "not set up") edit(path, change);
    }
    const data = notatoFolders(gitRoot ?? agentDir, agentDir);
    if (data.length) {
        report.notes.push(
            `${data.map(rel).join(", ")} (your annotations, screenshots and the server's tokens) ${data.length === 1 ? "was" : "were"} left in place${keptIgnore ? ", and so was the .notato/ line in .gitignore that keeps it out of git" : ""}. Delete ${data.length === 1 ? "it" : "them"} if you no longer need ${data.length === 1 ? "it" : "them"}${keptIgnore ? ", then run `npx notato init --revert` again to take the line out" : ""}.`
        );
    }

    // ---- the skills, in the skills folder of each agent being reverted: each removed only if nobody has edited it ----
    const chosen = (id: keyof typeof AGENTS) => !options.agents || options.agents.includes(id);
    const which = options.which ?? ((name: string) => Bun.which(name));
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
        if (!readers.some((a) => chosen(a.id))) continue;
        // A folder several agents read (.agents/skills) stays while one that is not being reverted uses it.
        const others = readers.filter((a) => !chosen(a.id) && stillSetUp(a));
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

    // ---- the MCP server, out of each agent's settings ---------------------------------------------------------
    for (const agent of Object.values(AGENTS)) {
        if (!chosen(agent.id)) continue;
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
        const scope =
            agent.id === "claude" && options.mcpScope && options.mcpScope !== "local"
                ? ["--scope", options.mcpScope]
                : [];
        const result = await (options.run ?? defaultRun)(
            [program, "mcp", "remove", ...scope, "notato"],
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
    const statuses = report.agents.map((a) => a.status);
    report.mcp =
        (["failed", "removed", "already", "unavailable"] as const).find((s) =>
            statuses.includes(s)
        ) ?? "skipped";
    return report;
}

export function formatRevertReport(report: RevertReport, dryRun: boolean): string {
    const lines = [
        `Notato ${dryRun ? "would be removed" : "removed"}${report.app ? ` from ${report.app.dir}` : ""}:`,
        "",
    ];
    for (const c of report.changes) {
        const mark = c.action === "edited" ? "~" : c.action === "deleted" ? "-" : "=";
        lines.push(`  ${mark} ${c.file}${c.note ? `  (${c.note})` : ""}`);
    }
    for (const agent of report.agents) {
        const spec = AGENTS[agent.id];
        if (spec.register.kind === "file") continue;
        const program = spec.register.program;
        lines.push(
            {
                removed: `  - removed the MCP server from ${agent.name} (${program} mcp remove notato)`,
                already: `  = the MCP server was not registered with ${agent.name}`,
                skipped: dryRun
                    ? `  - skipped the ${agent.name} removal (dry run)`
                    : `  - skipped the ${agent.name} removal`,
                unavailable: `  ! the ${program} command was not found. Remove the server yourself:\n      ${program} mcp remove notato`,
                failed: `  ! could not remove the MCP server from ${agent.name} (see below)`,
                added: "",
            }[agent.status]
        );
    }
    for (const w of report.warnings) lines.push(`  ! ${w}`);
    for (const n of report.notes) lines.push(`  i ${n}`);
    return lines.join("\n");
}
