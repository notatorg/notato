import { AGENT_IDS, AGENTS, type AgentRegistration, manualCommand } from "../agents.ts";
import type { AppInfo } from "../discover.ts";

// What `init` and `init --revert` did, and how it is printed.

export type Framework = "vite" | "next-app" | "next-pages" | "unknown";

export interface Change {
    file: string;
    action: "edited" | "created" | "unchanged" | "skipped";
    note?: string;
}

/** What a run says besides the files: problems to look at, and facts worth knowing. */
export interface Messages {
    warnings: string[];
    /** Facts worth printing that are not problems. */
    notes: string[];
}

export interface InitReport extends Messages {
    framework: Framework;
    project: string;
    /** The app that was set up, relative to where init ran, and why that one. */
    app?: { dir: string; role: AppInfo["role"]; reason: string };
    /** Where the MCP server was registered, when that is not the app's own directory. */
    agentDir?: string;
    changes: Change[];
    /** Overall: failed if any agent failed, else added if any was added, and so on. Each agent is in `agents`. */
    mcp: "added" | "already" | "skipped" | "unavailable" | "failed";
    /** The MCP registration with each agent set up, in order. */
    agents: AgentRegistration[];
    /** What to paste by hand when the edit could not be made safely. */
    manual?: string;
    /** This run only wired the Vite plugin. */
    pluginOnly?: boolean;
}

export interface RevertChange {
    file: string;
    action: "edited" | "deleted" | "unchanged";
    note?: string;
}

export interface RevertReport extends Messages {
    /** The app the toolbar was taken out of, relative to where this ran. */
    app?: { dir: string; reason: string };
    changes: RevertChange[];
    /** Overall, as in `InitReport`; each agent is in `agents`. */
    mcp: "removed" | "already" | "skipped" | "unavailable" | "failed";
    agents: AgentRegistration[];
}

/** The overall MCP status: the first of `order` that any agent has, so one failure is never hidden by a success. */
export function overall<S extends string>(
    agents: AgentRegistration[],
    order: readonly S[]
): S | "skipped" {
    const statuses: string[] = agents.map((a) => a.status);
    return order.find((s) => statuses.includes(s)) ?? "skipped";
}

const MARK = { edited: "~", created: "+", deleted: "-", unchanged: "=", skipped: "=" } as const;

const changeLine = (c: Change | RevertChange) =>
    `  ${MARK[c.action]} ${c.file}${c.note ? `  (${c.note})` : ""}`;

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
    if (report.app) lines.push(`  App: ${report.app.dir}: ${report.app.reason}`);
    lines.push("");
    lines.push(...report.changes.map(changeLine));
    // A run with nothing to do (the host already has the toolbar) says why in its notes, and registered nothing.
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

export function formatRevertReport(report: RevertReport, dryRun: boolean): string {
    const lines = [
        `Notato ${dryRun ? "would be removed" : "removed"}${report.app ? ` from ${report.app.dir}` : ""}:`,
        "",
        ...report.changes.map(changeLine),
    ];
    for (const agent of report.agents) {
        const spec = AGENTS[agent.id];
        // Agents registered by file already have their file's line.
        if (spec.register.kind === "file") continue;
        const program = spec.register.program;
        switch (agent.status) {
            case "removed":
                lines.push(
                    `  - removed the MCP server from ${agent.name} (${program} mcp remove notato)`
                );
                break;
            case "already":
                lines.push(`  = the MCP server was not registered with ${agent.name}`);
                break;
            case "skipped":
                lines.push(
                    dryRun
                        ? `  - skipped the ${agent.name} removal (dry run)`
                        : `  - skipped the ${agent.name} removal`
                );
                break;
            case "unavailable":
                lines.push(
                    `  ! the ${program} command was not found. Remove the server yourself:\n      ${program} mcp remove notato`
                );
                break;
            case "failed":
                lines.push(`  ! could not remove the MCP server from ${agent.name} (see below)`);
                break;
        }
    }
    for (const w of report.warnings) lines.push(`  ! ${w}`);
    for (const n of report.notes) lines.push(`  i ${n}`);
    return lines.join("\n");
}
