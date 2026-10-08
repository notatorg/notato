import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sampleAnnotation } from "@notato/schema";
import {
    AGENTS,
    type Agent,
    type AgentId,
    isNotatoEntry,
    manualCommand,
    parseAgents,
    readIfExists,
    resolveAgents,
} from "../agents.ts";
import { appMentionsNotato, describeApp, discoverApps, findGitRoot } from "../discover.ts";
import { localServer } from "../options.ts";
import { type RunProgram, runProgram } from "../process.ts";

const HELP = `notato doctor

Checks the whole loop, not just that a port answers: it files a real test annotation with a screenshot, reads
it back, fetches the screenshot and deletes it. It also tells you if the server is healthy but no browser page
is connected to it, which is the failure that "notato dev is running" hides.

On \`notato dev\` the test goes to a notato-doctor project, which is removed again afterwards. A shared server
(\`notato serve\`) only takes notes for projects created on it: pass --project with one of yours, or create a
notato-doctor project there (on the board, or with \`notato project create notato-doctor\`).

Options:
      --server <url>    The server to check (default http://127.0.0.1:4747, or $NOTATO_PORT)
      --token <token>   A token, for a server started with \`notato serve\` ($NOTATO_TOKEN)
      --project <id>    The project to test with (default notato-doctor; use your own if the token is for one project)
  -C, --cwd <path>      The app's directory, to check its setup (default: here)
      --agent <list>    Which agents to check the registration with (default: the ones init would set up)
      --no-agents       Do not check whether the agents have the MCP server registered (--no-claude is an alias)
  -h, --help            Show this help`;

export interface Check {
    name: string;
    status: "ok" | "warn" | "fail";
    detail: string;
    fix?: string;
}

export interface DoctorOptions {
    server: string;
    token?: string;
    project?: string;
    cwd?: string;
    /** Check the registration with each agent. Default true. */
    agents?: boolean;
    /** Which agents; default NOTATO_AGENTS, else the ones found. */
    agentIds?: AgentId[];
    run?: RunProgram;
    which?: (name: string) => string | null;
    fetch?: typeof fetch;
}

/** Where the test annotation goes unless --project says otherwise. */
export const DOCTOR_PROJECT = "notato-doctor";

/** A real 1×1 PNG, so the server's image check sees what the SDK would send. */
const PNG = Uint8Array.from(
    atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ),
    (c) => c.charCodeAt(0)
);
const PNG_ID = "a".repeat(64);

const sha256 = async (bytes: Uint8Array) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) =>
        b.toString(16).padStart(2, "0")
    ).join("");

/** A request to the server being checked, with the token and a timeout. */
type Get = (path: string, init?: RequestInit) => Promise<Response>;

/** Who the server says we are. A token for one project names it. */
interface Identity {
    mode?: string;
    authRequired: boolean;
    authenticated: boolean;
    projectId?: string;
}

/** The server's settings, as `/status` reports them. */
interface ServerConfig {
    screenshots?: "on" | "off";
    mcp?: "on" | "off";
    mcpSource?: string;
    webhooks?: number;
    source?: string;
    file?: string;
    error?: string;
}

/**
 * Runs every check in order. The server's checks stop at the first that fails, since the rest need it; the agents
 * and the app are checked whatever the server says.
 */
export async function runDoctor(options: DoctorOptions): Promise<Check[]> {
    const base = options.server.replace(/\/$/, "");
    const http = options.fetch ?? fetch;
    const auth: Record<string, string> = options.token
        ? { Authorization: `Bearer ${options.token}` }
        : {};
    const get: Get = (path, init = {}) =>
        http(`${base}${path}`, {
            ...init,
            headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
            signal: AbortSignal.timeout(5000),
        });

    const checks: Check[] = [];
    const server = await checkServer(get, base);
    checks.push(server);
    if (server.status === "ok") {
        const access = await checkAccess(get);
        checks.push(access.check);
        if (access.identity) {
            const config = await readConfig(get);
            checks.push(...settingsChecks(config));
            const screenshotsOff = config?.screenshots === "off" || Boolean(config?.error);
            checks.push(await checkEndToEnd(get, access.identity, screenshotsOff, options.project));
            checks.push(await checkBrowser(get));
        }
    }
    if (options.agents !== false) checks.push(...(await checkAgents(options)));
    const app = options.cwd ? checkApp(options.cwd) : undefined;
    if (app) checks.push(app);
    return checks;
}

/** 1. Is there a Notato server there at all? */
async function checkServer(get: Get, base: string): Promise<Check> {
    try {
        const body = (await (await get("/health")).json().catch(() => null)) as {
            service?: string;
        } | null;
        if (body?.service === "notato")
            return { name: "Server", status: "ok", detail: `a Notato server answers at ${base}` };
        return {
            name: "Server",
            status: "fail",
            detail: `${base} answers, but it is not Notato`,
            fix: "set NOTATO_PORT to a free port, or pass --server",
        };
    } catch {
        return {
            name: "Server",
            status: "fail",
            detail: `nothing answers at ${base}`,
            fix: "your agent starts `notato dev` itself once it is registered: run `npx notato init`, or by hand `claude mcp add notato -- npx notato dev` (Claude Code) or `codex mcp add notato -- npx notato dev` (Codex); for a shared server run `npx notato serve`",
        };
    }
}

/** 2. Who are we talking to, and are we let in? `identity` is set when we are. */
async function checkAccess(get: Get): Promise<{ check: Check; identity?: Identity }> {
    try {
        let me: Identity = { authRequired: false, authenticated: true };
        const res = await get("/auth/me");
        // A server older than this CLI has no /auth/me, and no login either, so there is nothing to check.
        if (res.ok) me = (await res.json()) as Identity;
        if (me.authRequired && !me.authenticated) {
            return {
                check: {
                    name: "Access",
                    status: "fail",
                    detail: `this is a ${me.mode} server that needs a token`,
                    fix: 'create a project on the board (Projects) or with `npx notato project create <id>` where the server keeps its data, which prints its token, then pass --token <token> --project <id> (or set NOTATO_TOKEN). A token for every project: `npx notato token create "*"`',
                },
            };
        }
        return {
            identity: me,
            check: {
                name: "Access",
                status: "ok",
                detail: me.authRequired
                    ? "the token is accepted"
                    : `${me.mode ? `${me.mode} mode, ` : ""}no login needed`,
            },
        };
    } catch (error) {
        return {
            check: {
                name: "Access",
                status: "fail",
                detail: error instanceof Error ? error.message : String(error),
            },
        };
    }
}

/** The server's settings; undefined from a server too old to report them, which then has the defaults. */
async function readConfig(get: Get): Promise<ServerConfig | undefined> {
    try {
        return ((await (await get("/status")).json()) as { config?: ServerConfig }).config;
    } catch {
        return undefined;
    }
}

/** 3. The settings: whether screenshots are kept decides what "end to end" has to show. */
function settingsChecks(config: ServerConfig | undefined): Check[] {
    const checks: Check[] = [];
    if (config?.error) {
        checks.push({
            name: "Screenshots",
            status: "warn",
            detail: `${config.file ?? "the config file"} is broken (${config.error}), so screenshots are off, agents are refused and no webhooks are sent until it is fixed`,
            fix: "run `npx notato config` to see it, or fix the file by hand",
        });
    } else if (config?.screenshots === "off") {
        checks.push({
            name: "Screenshots",
            status: "ok",
            detail: `off (${config.source === "env" ? "NOTATO_SCREENSHOTS" : (config.file ?? "config")}); none are captured or stored`,
        });
    } else {
        checks.push({
            name: "Screenshots",
            status: "ok",
            detail: "on (turn them off with `npx notato config set screenshots off`)",
        });
    }
    if (config?.mcp === "off" && !config.error) {
        const source =
            config.mcpSource === "env"
                ? "NOTATO_MCP"
                : config.mcpSource === "flag"
                  ? "--no-mcp"
                  : (config.file ?? "config");
        checks.push({
            name: "Agents",
            status: "warn",
            detail: `MCP is turned off (${source}), so coding agents are refused`,
            fix: "turn it on in the board's Settings › Agents, or run `npx notato config set mcp on`",
        });
    }
    if (config?.webhooks) {
        checks.push({
            name: "Webhooks",
            status: "ok",
            detail: `${config.webhooks} configured (see them with \`npx notato config\`; send a sample with \`npx notato config webhook test <name>\`)`,
        });
    }
    return checks;
}

/** A test annotation with one screenshot, as an SDK would post it. */
function testAnnotation(id: string, project: string, comment: string): FormData {
    const annotation = {
        ...sampleAnnotation,
        id,
        projectId: project,
        bundleId: null,
        comment,
        screenshots: { full: { id: PNG_ID, mime: "image/png", w: 1, h: 1 } },
        // Tells the server this is a check, so it is not sent to webhooks.
        context: { ...sampleAnnotation.context, notatoDiagnostic: true },
    };
    const form = new FormData();
    form.set("annotation", JSON.stringify(annotation));
    form.set(`asset:${PNG_ID}`, new File([PNG as BlobPart], "doctor.png", { type: "image/png" }));
    return form;
}

/** 4. The real thing: annotation in, annotation out, screenshot bytes intact, then deleted again. */
async function checkEndToEnd(
    get: Get,
    me: Identity,
    screenshotsOff: boolean,
    chosenProject: string | undefined
): Promise<Check> {
    const name = "End to end";
    const id = `doctor-${Date.now().toString(36)}`;
    const project = chosenProject ?? DOCTOR_PROJECT;
    const shared = me.authRequired;
    // On `notato dev` the test note creates its project. Doctor's own one goes again afterwards, so the board is
    // left as it was; a project that was already there (or the person's own, with --project) is never touched.
    const cleanUp =
        !shared &&
        chosenProject === undefined &&
        (await get(`/projects/${DOCTOR_PROJECT}`).then(
            (res) => res.status === 404,
            () => false
        ));
    const comment = "notato doctor test annotation (safe to ignore; deleted right away)";
    try {
        const posted = await get(`/projects/${encodeURIComponent(project)}/annotations`, {
            method: "POST",
            body: testAnnotation(id, project, comment),
        });
        const tokenProject = me.projectId && me.projectId !== "*" ? me.projectId : undefined;
        if (
            !posted.ok &&
            shared &&
            chosenProject === undefined &&
            (posted.status === 403 || posted.status === 404)
        ) {
            // Not a fault: a shared server only takes notes for its own projects, and there is no doctor's one.
            return {
                name,
                status: "warn",
                detail: `not tried: a shared server only takes notes for projects created on it, and ${tokenProject ? `this token is for project ${tokenProject}` : `it has no ${DOCTOR_PROJECT} project`}`,
                fix: tokenProject
                    ? `pass --project ${tokenProject} to test with it (the test note is deleted right away)`
                    : `pass --project <id> to test with one of your projects, or create one for doctor on the board (Projects) or with \`npx notato project create ${DOCTOR_PROJECT}\` where the server keeps its data`,
            };
        }
        if (!posted.ok) {
            const detail =
                ((await posted.json().catch(() => null)) as { error?: string } | null)?.error ??
                `status ${posted.status}`;
            return {
                name,
                status: "fail",
                detail: `the server refused a test annotation: ${detail}`,
                fix:
                    posted.status === 403
                        ? tokenProject
                            ? `this token is for project ${tokenProject}; pass --project ${tokenProject}`
                            : "the token may be for another project; pass --project"
                        : undefined,
            };
        }

        const stored = (await posted.json()) as {
            annotation: { screenshots?: { full: { id: string } } };
        };
        const back = await get(`/annotations/${id}`);
        const readBack = back.ok
            ? ((await back.json()) as { annotation: { comment: string } }).annotation
            : null;
        const shot = stored.annotation.screenshots;
        let check: Check;
        if (screenshotsOff) {
            // The test annotation carried a screenshot; a server with them off must have dropped it.
            check =
                !shot && readBack?.comment === comment
                    ? {
                          name,
                          status: "ok",
                          detail: "filed a test annotation with a screenshot, and the server kept the note but not the screenshot, as configured",
                      }
                    : {
                          name,
                          status: "fail",
                          detail: shot
                              ? "screenshots are off, but the server stored one"
                              : "stored, but not read back intact (annotation missing)",
                      };
        } else {
            const asset = shot ? await get(`/assets/${shot.full.id}`) : null;
            const bytes = asset?.ok ? new Uint8Array(await asset.arrayBuffer()) : null;
            const intact = bytes !== null && (await sha256(bytes)) === (await sha256(PNG));
            check =
                readBack?.comment === comment && intact
                    ? {
                          name,
                          status: "ok",
                          detail: "filed a test annotation with a screenshot, read it back, and the screenshot bytes matched",
                      }
                    : {
                          name,
                          status: "fail",
                          detail: `stored, but not read back intact (${readBack ? "annotation ok" : "annotation missing"}, ${intact ? "screenshot ok" : "screenshot differs"})`,
                      };
        }
        await get(`/annotations/${id}`, { method: "DELETE" }).catch(() => {});
        if (cleanUp) await removeEmptyProject(get, DOCTOR_PROJECT);
        return check;
    } catch (error) {
        return {
            name,
            status: "fail",
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Deletes a project doctor's test note created, once it is empty again; never one with anything left in it. */
async function removeEmptyProject(get: Get, project: string) {
    try {
        const res = await get(`/projects/${project}`);
        if (!res.ok) return;
        const summary = (await res.json()) as { annotations?: number };
        if (summary.annotations === 0) await get(`/projects/${project}`, { method: "DELETE" });
    } catch {
        // Left on the board, empty: harmless, and the next doctor run uses it.
    }
}

/** 5. Healthy server, but is any page talking to it? */
async function checkBrowser(get: Get): Promise<Check> {
    try {
        const status = (await (await get("/status")).json()) as {
            pages?: number;
            agentProjects?: string[];
        };
        if (typeof status.pages !== "number") {
            return {
                name: "Browser",
                status: "warn",
                detail: "this server does not report connected pages, so a browser could not be checked",
                fix: "it is older than this CLI: restart it (your agent starts `notato dev` again with its next session)",
            };
        }
        if (status.pages > 0) {
            const { pages } = status;
            return {
                name: "Browser",
                status: "ok",
                detail: `${pages} page${pages === 1 ? " is" : "s are"} connected${status.agentProjects?.length ? ` (agent pages: ${status.agentProjects.join(", ")})` : ""}`,
            };
        }
        return {
            name: "Browser",
            status: "warn",
            detail: "the server is healthy, but no page is connected to it",
            fix: 'open your app in a browser with <Notato server="…" /> rendered (is it behind an enabled/dev-only guard? does server= match this address?). A page blocked by CORS or mixed content also looks like this',
        };
    } catch {
        return { name: "Browser", status: "warn", detail: "could not read the server status" };
    }
}

/** 6. Do the agents know about it? */
async function checkAgents(options: DoctorOptions): Promise<Check[]> {
    const which = options.which ?? ((name: string) => Bun.which(name));
    const here = options.cwd;
    // Where init registers the server: the app's folder and the repository root.
    const dirs = here ? [...new Set([here, findGitRoot(here) ?? here])] : [];
    const checks: Check[] = [];
    for (const id of resolveAgents(options.agentIds, dirs, which)) {
        const agent = AGENTS[id];
        if (agent.register.kind === "file") {
            // Registered in a project file: only checkable from the project.
            if (dirs.length) checks.push(checkAgentFile(agent, agent.register, dirs));
            continue;
        }
        const program = agent.register.program;
        if (!which(program)) {
            checks.push({
                name: agent.name,
                status: "warn",
                detail: `the ${program} command is not on PATH, so registration was not checked`,
                fix: manualCommand(agent),
            });
            continue;
        }
        // Claude Code keeps a server registered for a project with that project's folder: ask from the app's
        // folder and the repository root, where init registers it, not from wherever doctor was started.
        let registered = false;
        for (const dir of dirs.length ? dirs : [undefined]) {
            const listed = await (options.run ?? runProgram)([program, "mcp", "list"], dir);
            registered = /\bnotato\b/.test(listed.output);
            if (registered) break;
        }
        checks.push(
            registered
                ? {
                      name: agent.name,
                      status: "ok",
                      detail: "the notato MCP server is registered",
                  }
                : {
                      name: agent.name,
                      status: "warn",
                      detail: "the notato MCP server is not registered",
                      fix: `${manualCommand(agent)}   (or run \`npx notato init --agent ${agent.id}\`)`,
                  }
        );
    }
    return checks;
}

/** Whether an agent's project file, in any of `dirs`, starts Notato's server. */
function checkAgentFile(
    agent: Agent,
    { path, key }: { path: string; key: string },
    dirs: string[]
): Check {
    const found = dirs
        .map((dir) => readIfExists(join(dir, path)))
        .some((text) => {
            try {
                return (
                    text !== null &&
                    isNotatoEntry(
                        (JSON.parse(text) as Record<string, Record<string, unknown>>)[key]?.notato
                    )
                );
            } catch {
                return false;
            }
        });
    return found
        ? { name: agent.name, status: "ok", detail: `${path} starts the notato MCP server` }
        : {
              name: agent.name,
              status: "warn",
              detail: `${path} does not have the notato MCP server`,
              fix: `npx notato init --agent ${agent.id}`,
          };
}

/**
 * 7. Is the app wired up? In a repo of several apps, one wired host is enough: the modules it loads inherit it.
 * Undefined where there is no app to check.
 */
function checkApp(cwd: string): Check | undefined {
    const self = describeApp(cwd, cwd);
    const apps = self ? [self] : discoverApps(cwd);
    // A repo root often has no package.json of its own, so apps found below it count too.
    if (!existsSync(join(cwd, "package.json")) && apps.length === 0) return undefined;
    if (apps.length === 0) {
        return appMentionsNotato(cwd)
            ? { name: "App", status: "ok", detail: "your source renders <Notato />" }
            : {
                  name: "App",
                  status: "warn",
                  detail: "no <Notato /> found in your source",
                  fix: "run `npx notato init`",
              };
    }
    const wired = apps.filter((a) => a.hasNotato);
    if (wired.length > 0) {
        const hosts = wired.filter((a) => a.role === "host");
        const modules = apps.filter((a) => a.role === "remote");
        const inherited =
            hosts.length && modules.length
                ? `; the ${modules.length} federated module${modules.length === 1 ? "" : "s"} it loads ${modules.length === 1 ? "inherits" : "inherit"} it`
                : "";
        return {
            name: "App",
            status: "ok",
            detail: `${wired.map((a) => a.rel).join(", ")} renders <Notato />${inherited}`,
        };
    }
    const host = apps.find((a) => a.role === "host");
    return {
        name: "App",
        status: "warn",
        detail: `no <Notato /> found in ${apps.length === 1 ? apps[0]?.rel : `any of ${apps.length} apps`}`,
        fix: host
            ? `run \`npx notato init\` in ${host.rel}, the federation host`
            : "run `npx notato init`",
    };
}

const ICON = { ok: "✓", warn: "!", fail: "✗" } as const;

export function formatChecks(checks: Check[]): string {
    const lines: string[] = [];
    for (const c of checks) {
        lines.push(`${ICON[c.status]} ${c.name}: ${c.detail}`);
        if (c.fix && c.status !== "ok") lines.push(`    → ${c.fix}`);
    }
    const failed = checks.filter((c) => c.status === "fail").length;
    const warned = checks.filter((c) => c.status === "warn").length;
    lines.push(
        "",
        failed
            ? `${failed} problem${failed === 1 ? "" : "s"} found.`
            : warned
              ? "Working, with a warning above."
              : "Everything works."
    );
    return lines.join("\n");
}

export async function runDoctorCommand(argv: string[]): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            server: { type: "string" },
            token: { type: "string" },
            project: { type: "string" },
            cwd: { type: "string", short: "C" },
            agent: { type: "string", multiple: true },
            agents: { type: "boolean", default: true },
            claude: { type: "boolean", default: true },
            help: { type: "boolean", short: "h" },
        },
        allowNegative: true,
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    const checks = await runDoctor({
        server: values.server ?? localServer(),
        token: values.token ?? process.env.NOTATO_TOKEN,
        project: values.project,
        cwd: values.cwd ?? process.cwd(),
        agents: values.agents && values.claude,
        agentIds: parseAgents(values.agent),
    });
    console.log(formatChecks(checks));
    return checks.some((c) => c.status === "fail") ? 1 : 0;
}
