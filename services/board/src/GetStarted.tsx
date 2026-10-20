import { type ReactNode, useEffect, useState } from "react";
import { getStatus, type Me, type ProjectSummary, projectHref, request } from "./api.ts";
import { whoIs } from "./Role.tsx";

interface Step {
    id: string;
    title: string;
    hint: ReactNode;
    done: boolean;
    /** Not counted towards "set up": things to do once the basics work. */
    optional?: boolean;
    action?: { label: string; href?: string; onClick?: () => void };
}

const key = (workspace: string) => `notato.getStarted.${workspace}`;
const remembered = (workspace: string) => {
    try {
        return window.localStorage.getItem(key(workspace)) === "hidden";
    } catch {
        return false;
    }
};

/** What the steps are for this person, from what is already true. Pure, so it can be tested. */
export function stepsFor(input: {
    me: Me;
    projects: ProjectSummary[];
    agentSeen: boolean;
    toolsConnected: boolean | null;
    onNewProject?: () => void;
}): Step[] {
    const { me, projects, agentSeen, toolsConnected, onNewProject } = input;
    const who = whoIs(me);
    const first = projects[0];
    const connect = first ? projectHref(first.id, "connect") : undefined;
    const notes = projects.reduce((n, p) => n + p.annotations, 0);
    const worked = projects.some(
        (p) => (p.statuses?.acknowledged ?? 0) + (p.statuses?.resolved ?? 0) > 0
    );
    const steps: Step[] = [
        who.manager
            ? {
                  id: "project",
                  title: "Create a project",
                  hint: "A project is one app you want feedback on. Everything else hangs off it.",
                  done: projects.length > 0,
                  action: onNewProject
                      ? { label: "New project", onClick: onNewProject }
                      : undefined,
              }
            : {
                  id: "project",
                  title: "Open your project",
                  hint: "The projects you were given access to are listed below. If there are none, ask an owner or admin to add you to one.",
                  done: projects.length > 0,
              },
        {
            id: "app",
            title: "Connect your app",
            hint: "Add the Notato toolbar to your app with the snippet and token on the project's Connect page, then pin a note.",
            done: notes > 0,
            action: connect ? { label: "Show how", href: connect } : undefined,
        },
        {
            id: "agent",
            title: "Connect your coding agent",
            hint: "On the project's Connect page make an agent token, add the command it shows to Claude Code, Codex or Cursor, then ask it to watch Notato.",
            done: agentSeen || worked,
            action: connect ? { label: "Show how", href: connect } : undefined,
        },
    ];
    if (who.manager && toolsConnected !== null)
        steps.push({
            id: "tools",
            title: "Send feedback to your tools",
            hint: "Connect GitHub, Slack or another tool and notes can become issues or messages with one click.",
            done: toolsConnected,
            optional: true,
            action: { label: "Open Integrations", href: "#/x/plugins" },
        });
    if (who.manager && who.solo)
        steps.push({
            id: "team",
            title: "Working with others? Invite them",
            hint: "Teammates and testers can share the project.",
            done: false,
            optional: true,
            action: { label: "Open Workspace", href: "#/x/workspace" },
        });
    else if (!who.solo && !who.guest)
        steps.push({
            id: "share",
            title: "Know what is shared",
            hint: "What you capture while building is only yours until you choose Share with project. Testers' notes arrive in shared review sessions.",
            done: false,
            optional: true,
            action: first
                ? { label: "Open Review sessions", href: projectHref(first.id, "sessions") }
                : undefined,
        });
    return steps;
}

/**
 * Home's guide: the few things to do, in order, for the person looking. A solo builder sees three steps and an
 * invitation to invite others later; a team member is not asked to create projects or invite people; it steps aside
 * once the basics are done.
 */
export function GetStarted({
    me,
    projects,
    onNewProject,
}: {
    me: Me;
    projects: ProjectSummary[] | null;
    onNewProject?: () => void;
}) {
    const workspace = me.workspace?.id ?? "";
    const who = whoIs(me);
    const [hidden, setHidden] = useState(() => remembered(workspace));
    const [agentSeen, setAgentSeen] = useState(false);
    const [toolsConnected, setToolsConnected] = useState<boolean | null>(null);
    useEffect(() => {
        let stopped = false;
        getStatus().then(
            (s) => !stopped && setAgentSeen(Boolean(s.agents?.connected)),
            () => {}
        );
        if (who.manager)
            request<{ configured: boolean; connections: Array<{ revoked?: boolean }> }>(
                "/plugins"
            ).then(
                (p) =>
                    !stopped &&
                    setToolsConnected(p.configured ? p.connections.some((c) => !c.revoked) : null),
                () => {}
            );
        return () => {
            stopped = true;
        };
    }, [who.manager]);
    if (!me.workspace || !projects || hidden) return null;
    const steps = stepsFor({ me, projects, agentSeen, toolsConnected, onNewProject });
    const required = steps.filter((s) => !s.optional);
    const finished = required.every((s) => s.done);
    const optionalLeft = steps.filter((s) => s.optional && !s.done);
    // Set up and nothing else to suggest: step aside.
    if (finished && !optionalLeft.length) return null;
    const next = steps.find((s) => !s.done);
    const hide = () => {
        setHidden(true);
        try {
            window.localStorage.setItem(key(workspace), "hidden");
        } catch {
            // Hiding lasts for this visit only.
        }
    };
    return (
        <section className="card get-started" aria-labelledby="get-started-title">
            <header>
                <div>
                    <h2 id="get-started-title">
                        {finished
                            ? "You're set up"
                            : who.solo
                              ? "Get set up in three steps"
                              : "Get started"}
                    </h2>
                    <p className="muted">
                        {finished
                            ? "The basics work. When you are ready:"
                            : `${required.filter((s) => s.done).length} of ${required.length} done`}
                    </p>
                </div>
                <button type="button" className="link" onClick={hide}>
                    Hide
                </button>
            </header>
            <ol className="plugin-steps">
                {steps
                    .filter((s) => !finished || s.optional)
                    .map((s) => (
                        <li
                            key={s.id}
                            className={s.done ? "done" : s === next ? "next" : undefined}
                        >
                            <span aria-hidden="true">{s.done ? "✓" : s === next ? "→" : "·"}</span>{" "}
                            <strong>{s.title}</strong>
                            {s.optional && !s.done ? (
                                <span className="muted"> · optional</span>
                            ) : null}
                            {s.done ? <span className="muted"> — done</span> : null}
                            {!s.done && (s === next || finished) ? (
                                <>
                                    <br />
                                    <span className="muted">{s.hint}</span>{" "}
                                    {s.action?.href ? (
                                        <a className="button" href={s.action.href}>
                                            {s.action.label}
                                        </a>
                                    ) : s.action?.onClick ? (
                                        <button type="button" onClick={s.action.onClick}>
                                            {s.action.label}
                                        </button>
                                    ) : null}
                                </>
                            ) : null}
                        </li>
                    ))}
            </ol>
        </section>
    );
}
