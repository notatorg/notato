import { useState } from "react";
import { isAdmin } from "./api.ts";
import type { ProjectNavProps } from "./extension.tsx";
import { hasUnseen } from "./live.ts";
import { projectName, todoOf } from "./model.ts";
import { href, projectHref, type Tab } from "./route.ts";
import { Icon, type IconName, Modal, ProjectMark } from "./ui.tsx";

/** A project's pages, under the project's name at the top of the sidebar. */
const VIEWS: Array<{ tab: Tab; label: string; icon: IconName; admin?: boolean }> = [
    { tab: "inbox", label: "Inbox", icon: "inbox" },
    { tab: "activity", label: "Activity", icon: "activity" },
    { tab: "overview", label: "Overview", icon: "chart" },
    { tab: "settings", label: "Project settings", icon: "sliders", admin: true },
];

/** Past this many projects, the switcher offers a box to find one. */
const FIND_FROM = 8;

/**
 * The open project and its pages, with a switcher to move between projects (and to make one). The project is the
 * context of everything else on screen, so it is the one thing the sidebar names; the rest is a click away.
 */
export function ProjectNav({ me, route, current, projects, onNewProject }: ProjectNavProps) {
    const [query, setQuery] = useState("");
    const [switching, setSwitching] = useState(false);
    const manager = isAdmin(me);
    const open = route.page === "project" ? route.project : null;
    const summary = projects?.find((p) => p.id === current);
    const q = query.trim().toLowerCase();
    const shown = (projects ?? []).filter(
        (p) => p.id.toLowerCase().includes(q) || projectName(p, p.id).toLowerCase().includes(q)
    );

    return (
        <>
            <div className="project-context">
                <button
                    type="button"
                    className="project-current"
                    aria-label="Switch project"
                    aria-haspopup="dialog"
                    onClick={() => {
                        setQuery("");
                        setSwitching(true);
                    }}
                >
                    <ProjectMark
                        name={current ? projectName(summary, current) : "Projects"}
                        active
                    />
                    <span className="project-current-text">
                        <span className="side-name">
                            {current ? projectName(summary, current) : "Choose a project"}
                        </span>
                        <span className="project-current-meta">
                            {summary
                                ? `${todoOf(summary)} to do${summary.unread ? ` · ${summary.unread} unread` : ""}`
                                : "Switch project"}
                        </span>
                    </span>
                    <Icon name="chevrons" size={14} />
                </button>
                {onNewProject ? (
                    <button
                        type="button"
                        className="icon-button side-add"
                        aria-label="New project"
                        title="New project"
                        onClick={() => onNewProject()}
                    >
                        <Icon name="plus" size={16} />
                    </button>
                ) : null}
            </div>
            {current
                ? VIEWS.filter((v) => manager || !v.admin).map((v) => {
                      const on =
                          open === current && route.page === "project" && route.tab === v.tab;
                      const count = summary
                          ? v.tab === "inbox"
                              ? todoOf(summary)
                              : v.tab === "activity"
                                ? (summary.unread ?? 0)
                                : 0
                          : 0;
                      return (
                          <a
                              key={v.tab}
                              className={on ? "side-link active" : "side-link"}
                              href={projectHref(current, v.tab)}
                              aria-current={on ? "page" : undefined}
                          >
                              <Icon name={v.icon} />
                              {v.label}
                              {count ? (
                                  <span
                                      className="badge"
                                      title={`${count} ${v.tab === "activity" ? "unread notes" : "to do"}`}
                                  >
                                      {count}
                                  </span>
                              ) : null}
                          </a>
                      );
                  })
                : null}
            {switching ? (
                <Modal title="Switch project" onClose={() => setSwitching(false)}>
                    <div className="modal-body">
                        {projects && projects.length >= FIND_FROM ? (
                            <input
                                className="side-search"
                                type="search"
                                placeholder="Find a project"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                aria-label="Find a project"
                            />
                        ) : null}
                        <ul className="project-choices">
                            {projects === null ? (
                                <li className="muted side-note">Loading…</li>
                            ) : null}
                            {projects?.length === 0 ? (
                                <li className="muted side-note">No projects yet</li>
                            ) : null}
                            {shown.length === 0 && projects?.length ? (
                                <li className="muted side-note">No matching projects</li>
                            ) : null}
                            {shown.map((p) => {
                                const on = p.id === current;
                                const label = projectName(p, p.id);
                                const unseen =
                                    p.unread !== undefined
                                        ? p.unread > 0
                                        : !on && hasUnseen(p.id, p.lastActivityAt);
                                return (
                                    <li key={p.id}>
                                        <a
                                            className={on ? "side-project active" : "side-project"}
                                            href={projectHref(
                                                p.id,
                                                route.page === "project" && route.tab !== "connect"
                                                    ? route.tab
                                                    : "inbox"
                                            )}
                                            onClick={() => setSwitching(false)}
                                            title={label === p.id ? p.id : `${label} (${p.id})`}
                                        >
                                            <ProjectMark name={label} active={on} />
                                            <span className="project-choice-text">
                                                <span className="side-name">{label}</span>
                                                <span className="project-current-meta">
                                                    {todoOf(p)} to do
                                                    {p.unread ? ` · ${p.unread} unread` : ""}
                                                </span>
                                            </span>
                                            {unseen ? (
                                                <span className="unseen" title="Unread activity" />
                                            ) : null}
                                            {on ? <Icon name="check" size={16} /> : null}
                                        </a>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                    <footer className="modal-foot">
                        <a
                            className="button-link"
                            href={href({ page: "home" })}
                            onClick={() => setSwitching(false)}
                        >
                            All projects
                        </a>
                        <span className="grow" />
                        {onNewProject ? (
                            <button
                                type="button"
                                className="primary"
                                onClick={() => {
                                    setSwitching(false);
                                    onNewProject();
                                }}
                            >
                                <Icon name="plus" size={15} />
                                New project
                            </button>
                        ) : null}
                    </footer>
                </Modal>
            ) : null}
        </>
    );
}
