import type { Me, ProjectSummary } from "./api.ts";
import { hasUnseen, useSeenVersion } from "./live.ts";
import { ago, byActivity, DONE, plural, projectName, todoOf } from "./model.ts";
import { projectHref } from "./route.ts";
import { Empty, Icon, ProjectMark, When } from "./ui.tsx";

/** Every project on the server, the ones with the most to do first. */
export function Home({
    projects,
    error,
    me,
    onNewProject,
}: {
    projects: ProjectSummary[] | null;
    error: string | null;
    me: Me;
    /** Opens the new-project dialog; absent for anyone who cannot make one. */
    onNewProject?: () => void;
}) {
    useSeenVersion();
    const todo = (projects ?? []).reduce((n, p) => n + todoOf(p), 0);
    return (
        <div className="sheet">
            <div className="sheet-inner wide">
                <header className="sheet-head">
                    <div>
                        <h1>All projects</h1>
                        {projects?.length ? (
                            <p>
                                {plural(todo, "note")} waiting across{" "}
                                {plural(projects.length, "project")}
                            </p>
                        ) : null}
                    </div>
                    {onNewProject ? (
                        <div className="sheet-tools">
                            <button
                                type="button"
                                className="primary"
                                onClick={() => onNewProject()}
                            >
                                <Icon name="plus" size={14} />
                                New project
                            </button>
                        </div>
                    ) : null}
                </header>
                {error ? (
                    <p className="error">{error}</p>
                ) : !projects ? (
                    <p className="muted">Loading…</p>
                ) : projects.length === 0 ? (
                    <Empty title="No projects yet">
                        <p>
                            {me.mode === "serve"
                                ? "Make a project, then connect an app to it with the token it comes with. Apps can only send notes to a project that exists here."
                                : "Make one, or just send a note: a project appears here as soon as an app running a Notato SDK pins one. Each app's project setting is the project it files under."}
                        </p>
                        {onNewProject ? (
                            <div className="empty-actions">
                                <button
                                    type="button"
                                    className="primary"
                                    onClick={() => onNewProject()}
                                >
                                    <Icon name="plus" size={14} />
                                    New project
                                </button>
                            </div>
                        ) : null}
                    </Empty>
                ) : (
                    <ul className="project-cards">
                        {[...projects]
                            .sort((x, y) => todoOf(y) - todoOf(x) || byActivity(x, y))
                            .map((p) => (
                                <ProjectCard key={p.id} project={p} />
                            ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

/** A project's card: its name, what is to do, a bar of where its notes stand, and when it was last active. */
function ProjectCard({ project: p }: { project: ProjectSummary }) {
    const todo = todoOf(p);
    const st = p.statuses;
    const done = st ? DONE.reduce((n, s) => n + (st[s] ?? 0), 0) : null;
    const unseen = hasUnseen(p.id, p.lastActivityAt);
    const name = projectName(p, p.id);
    /** In the order work moves; the rarer states sit with the ones they are closest to. */
    const parts = st
        ? [
              { key: "open", value: st.open ?? 0 },
              {
                  key: "acknowledged",
                  value:
                      (st.acknowledged ?? 0) +
                      (st.variant_chosen ?? 0) +
                      (st.revert_requested ?? 0),
              },
              { key: "resolved", value: done ?? 0 },
              { key: "dismissed", value: st.dismissed ?? 0 },
          ]
        : null;
    return (
        <li>
            <a className="project-card" href={projectHref(p.id)}>
                <span className="pc-head">
                    <ProjectMark name={name} size={30} />
                    <span className="pc-title">
                        <strong className="pc-name">{name}</strong>
                        {name !== p.id ? <span className="pc-id">{p.id}</span> : null}
                    </span>
                    {unseen ? (
                        <span className="unseen" title="New activity since you last looked" />
                    ) : null}
                </span>
                <span className="pc-figure">
                    <span className={todo ? "pc-value" : "pc-value none"}>{todo}</span>
                    <span className="muted">to do</span>
                </span>
                {parts && p.annotations > 0 ? (
                    <span
                        className="pc-bar"
                        role="img"
                        aria-label={`${todo} to do, ${done} done, ${st?.dismissed ?? 0} dismissed`}
                    >
                        {parts.map((part) =>
                            part.value ? (
                                <span
                                    key={part.key}
                                    className={`seg s-${part.key}`}
                                    style={{ flexGrow: part.value }}
                                />
                            ) : null
                        )}
                    </span>
                ) : null}
                <span className="pc-meta">
                    <span>
                        {plural(p.annotations, "note")}
                        {done !== null ? ` · ${done} done` : ""}
                    </span>
                    {p.lastActivityAt ? (
                        <When iso={p.lastActivityAt}>{ago(p.lastActivityAt)}</When>
                    ) : null}
                </span>
            </a>
        </li>
    );
}
