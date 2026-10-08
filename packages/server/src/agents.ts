import { knownAgent } from "@notato/core";

/** Whether an agent has Notato's MCP open, and whether it is waiting in `notato_watch` right now. */
export interface AgentState {
    connected: boolean;
    /** Agent sessions (Claude Code, Codex, Cursor…) with Notato's MCP open. */
    sessions: number;
    /** One of them is in `notato_watch`, so a note reaches it within seconds. */
    watching: boolean;
    /** What the connected agents are called ("Claude", "Codex"), each once, from what their MCP clients say they are. */
    names: string[];
}

/** The header an attached `notato dev` (an MCP session on another process) sends with every request, its heartbeat. */
export const AGENT_HEADER = "x-notato-agent";
/** Sent beside {@link AGENT_HEADER} once the attached process knows which agent it serves. */
export const AGENT_NAME_HEADER = "x-notato-agent-name";
/** Sent beside {@link AGENT_HEADER} by an agent kept to some projects (`notato dev --project`): their ids, encoded, comma-separated. */
export const AGENT_PROJECTS_HEADER = "x-notato-agent-projects";

/** The projects an agent is kept to, for {@link AGENT_PROJECTS_HEADER}. */
export function encodeAgentProjects(projects: string[]): string {
    return projects.map(encodeURIComponent).join(",");
}

/**
 * `--project shop --project admin`, `--project shop,admin` or `NOTATO_PROJECT=shop,admin`: the projects, each once;
 * undefined when none is named.
 */
export function parseProjects(values: string | string[] | undefined): string[] | undefined {
    const projects = [
        ...new Set(
            [values ?? []]
                .flat()
                .flatMap((v) => v.split(","))
                .map((v) => v.trim())
                .filter(Boolean)
        ),
    ];
    return projects.length ? projects : undefined;
}

/** The projects a request says its agent is kept to; undefined for every project (no header, or nothing usable). */
export function decodeAgentProjects(raw: string | null | undefined): string[] | undefined {
    if (!raw) return undefined;
    const projects = raw
        .split(",")
        .slice(0, 50)
        .map((p) => {
            try {
                return decodeURIComponent(p).trim().slice(0, 128);
            } catch {
                return "";
            }
        })
        .filter(Boolean);
    return projects.length ? projects : undefined;
}

/**
 * The name to show for an MCP client: "claude-code" is Claude, "codex-mcp-client" is Codex. An unknown client is
 * named after itself, without the "mcp client" noise; undefined when there is nothing usable.
 */
export function agentName(client: string | undefined): string | undefined {
    if (!client) return undefined;
    const known = knownAgent(client);
    if (known) return known.name;
    const words = client
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(" ")
        .filter((w) => w && !/^(mcp|client|cli|server|ai)$/i.test(w));
    const name = words.join(" ").slice(0, 32).trim();
    return name ? name[0]?.toUpperCase() + name.slice(1) : undefined;
}

/**
 * Whether a client is known to wait for a long tool call. Most clients give up on one after about a minute (Codex
 * after 60 seconds unless configured otherwise), so `notato_watch` returns before then for them and is called again.
 */
export function waitsLong(client: string | undefined): boolean {
    return Boolean(client && /claude/i.test(client));
}

/** A name a request gave for itself, made safe to keep and show. */
export function cleanAgentName(raw: string | null | undefined): string | undefined {
    const name = raw
        ?.replace(/\p{Cc}/gu, "")
        .trim()
        .slice(0, 40);
    return name || undefined;
}

/** Who is there: a name once its client has said, and the projects it is kept to (undefined: every project). */
interface Presence {
    name?: string;
    projects?: string[];
}

/** Whether an agent kept to `projects` counts for a page of `projectId` (`*` or none: the board, which shows everyone). */
const servesProject = (projects: string[] | undefined, projectId: string | undefined) =>
    !projectId || projectId === "*" || !projects || projects.includes(projectId);

const sameState = (a: AgentState, b: AgentState) =>
    a.connected === b.connected &&
    a.sessions === b.sessions &&
    a.watching === b.watching &&
    a.names.join("\n") === b.names.join("\n");

/**
 * Which agents are there. An agent session (Claude Code, Codex, Cursor…) reaches Notato through its own `notato dev`:
 * either this process (its MCP is held open here) or another one attached over HTTP, which checks on the server every
 * few seconds and names itself in {@link AGENT_HEADER}. Pages are told when this changes, so they can say whether an
 * agent is there, and call it by its name. An agent kept to some projects counts only on their pages: one app must not
 * say an agent is watching when that agent works on another app.
 */
export class AgentPresence {
    private seen = new Map<string, Presence & { at: number }>();
    private held = new Map<string, Presence>();
    private waits = new Map<number, string[] | undefined>();
    private nextWait = 0;
    private listeners = new Map<
        (state: AgentState) => void,
        { projectId?: string; last: AgentState }
    >();
    private sweep: ReturnType<typeof setInterval>;
    /** Whether agents may connect at all (the `mcp` setting). While not, none counts as there, and pages say so. */
    allowed: () => boolean = () => true;

    constructor(
        /** How long an attached agent counts as there after its last request; they check every 3 seconds. */
        private ttlMs = 10_000,
        private now: () => number = Date.now
    ) {
        this.sweep = setInterval(() => this.changed(), Math.max(1000, Math.floor(ttlMs / 2)));
        this.sweep.unref?.();
    }

    /** Every agent, whatever it works on. */
    get state(): AgentState {
        return this.compute();
    }

    /** The agents that work on this project. */
    stateFor(projectId: string | undefined): AgentState {
        return this.compute(projectId);
    }

    /** An attached agent was heard from, with its name once it knows it, and the projects it is kept to. */
    touch(id: string, name?: string, projects?: string[]) {
        const before = this.seen.get(id);
        const next = { at: this.now(), name: name ?? before?.name, projects };
        this.seen.set(id, next);
        if (
            !before ||
            before.name !== next.name ||
            before.projects?.join("\n") !== projects?.join("\n")
        )
            this.changed();
    }

    /** An agent whose MCP is open in this process, until the returned function is called. */
    hold(id: string, name?: string, projects?: string[]): () => void {
        this.held.set(id, { name, projects });
        this.changed();
        return () => {
            this.held.delete(id);
            this.changed();
        };
    }

    /** Names an agent held here once its MCP client has said what it is. */
    rename(id: string, name: string | undefined) {
        const held = this.held.get(id);
        if (!held || held.name === name) return;
        this.held.set(id, { ...held, name });
        this.changed();
    }

    /**
     * A `notato_watch` (or another long wait for annotations) has started, for these projects (undefined: any); call
     * the result when it ends.
     */
    waitStarted(projects?: string[]): () => void {
        const id = this.nextWait++;
        this.waits.set(id, projects);
        this.changed();
        let done = false;
        return () => {
            if (done) return;
            done = true;
            this.waits.delete(id);
            // A watch that ends is usually followed at once by the next one: do not flicker in between.
            setTimeout(() => this.changed(), 1500).unref?.();
        };
    }

    /** Called with the state for `projectId` (every agent when absent or `*`) each time it changes. */
    subscribe(listener: (state: AgentState) => void, projectId?: string): () => void {
        this.listeners.set(listener, { projectId, last: this.compute(projectId) });
        return () => this.listeners.delete(listener);
    }

    /** Tells subscribers now, rather than at the next sweep, after something {@link allowed} reads has changed. */
    refresh() {
        this.changed();
    }

    stop() {
        clearInterval(this.sweep);
        this.listeners.clear();
    }

    private compute(projectId?: string): AgentState {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, entry] of this.seen) if (entry.at < cutoff) this.seen.delete(id);
        if (!this.allowed()) return { connected: false, sessions: 0, watching: false, names: [] };
        const here = [...this.seen.values(), ...this.held.values()].filter((e) =>
            servesProject(e.projects, projectId)
        );
        const watching = [...this.waits.values()].some((p) => servesProject(p, projectId));
        const names = [...new Set(here.map((e) => e.name))]
            .filter((n): n is string => Boolean(n))
            .sort();
        // A watch is an agent there, even one attached through an older notato that does not name itself.
        return {
            connected: here.length > 0 || watching,
            sessions: here.length,
            watching,
            names,
        };
    }

    private changed() {
        for (const [listener, entry] of [...this.listeners]) {
            const next = this.compute(entry.projectId);
            if (sameState(next, entry.last)) continue;
            entry.last = next;
            try {
                listener(next);
            } catch {
                // one broken subscriber must not stop the others
            }
        }
    }
}
