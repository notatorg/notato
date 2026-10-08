import { useState } from "react";
import { isAdmin, type Me, type ProjectSummary } from "./api.ts";
import { hasUnseen, type LiveState, useLiveState, useSeenVersion } from "./live.ts";
import { initial, projectName, todoOf } from "./model.ts";
import { href, projectHref, type Route, type Tab } from "./route.ts";
import { setBoardName, useBoardName } from "./storage.ts";
import { Icon, type IconName, Logo, ProjectMark, ThemeSwitch } from "./ui.tsx";

interface Props {
    me: Me;
    route: Route;
    /** The project its Inbox, Activity and Overview lead to. */
    current: string | null;
    projects: ProjectSummary[] | null;
    /** Opens the new-project dialog; absent for anyone who cannot make one. */
    onNewProject?: () => void;
    onSignOut(): void;
}

/** A project's pages, under its name at the top of the sidebar. */
const VIEWS: Array<{ tab: Tab; label: string; icon: IconName; admin?: boolean }> = [
    { tab: "inbox", label: "Inbox", icon: "inbox" },
    { tab: "activity", label: "Activity", icon: "activity" },
    { tab: "overview", label: "Overview", icon: "chart" },
    { tab: "settings", label: "Project settings", icon: "sliders", admin: true },
];

/** Past this many projects, the sidebar offers a box to find one. */
const FIND_FROM = 8;

/** The dot by the logo, as it reads to a screen reader and on hover. */
const LIVE_TEXT: Record<LiveState, { label: string; title: string }> = {
    live: { label: "Live", title: "Connected: changes appear as they happen" },
    offline: { label: "Offline", title: "Lost the connection to the server; retrying" },
    connecting: { label: "Connecting", title: "Connecting…" },
};

/**
 * The sidebar (a drawer on a phone): the open project's pages, every project with what it has to do, and at the
 * bottom the server's pages, the name on replies and the theme.
 */
export function Sidebar({ me, route, current, projects, onNewProject, onSignOut }: Props) {
    const live = useLiveState();
    useSeenVersion();
    const name = useBoardName();
    const [query, setQuery] = useState("");
    const [draft, setDraft] = useState<string | null>(null);
    const admin = isAdmin(me);
    const open = route.page === "project" ? route.project : null;
    const summary = projects?.find((p) => p.id === current);

    const q = query.trim().toLowerCase();
    const shown = (projects ?? []).filter(
        (p) => p.id.toLowerCase().includes(q) || projectName(p, p.id).toLowerCase().includes(q)
    );

    return (
        <nav className="sidebar" aria-label="Notato">
            <div className="side-head">
                <a className="brand" href="#/">
                    <Logo size={36} tilt={-8} />
                    <span className="wordmark">notato</span>
                </a>
                <span
                    className={`live ${live}`}
                    role="img"
                    aria-label={LIVE_TEXT[live].label}
                    title={LIVE_TEXT[live].title}
                />
            </div>

            {current ? (
                <>
                    <div className="side-label side-project-name" title={current}>
                        {projectName(summary, current)}
                    </div>
                    {VIEWS.filter((v) => admin || !v.admin).map((v) => {
                        const on =
                            open === current && route.page === "project" && route.tab === v.tab;
                        const todo = v.tab === "inbox" && summary ? todoOf(summary) : 0;
                        return (
                            <a
                                key={v.tab}
                                className={on ? "side-link active" : "side-link"}
                                href={projectHref(current, v.tab)}
                                aria-current={on ? "page" : undefined}
                            >
                                <Icon name={v.icon} />
                                {v.label}
                                {todo ? (
                                    <span className="badge" title={`${todo} to do`}>
                                        {todo}
                                    </span>
                                ) : null}
                            </a>
                        );
                    })}
                </>
            ) : null}

            <div className="side-label side-section">
                Projects
                <a className={route.page === "home" ? "see-all active" : "see-all"} href="#/">
                    See all
                </a>
                {onNewProject ? (
                    <button
                        type="button"
                        className="icon-button side-add"
                        aria-label="New project"
                        title="New project"
                        onClick={() => onNewProject()}
                    >
                        <Icon name="plus" size={15} />
                    </button>
                ) : null}
            </div>
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
            <ul className="side-projects">
                {projects === null ? <li className="muted side-note">Loading…</li> : null}
                {projects?.length === 0 ? (
                    <li className="side-note">
                        <span className="muted">No projects yet</span>
                        {onNewProject ? (
                            <button type="button" className="link" onClick={() => onNewProject()}>
                                Make one
                            </button>
                        ) : null}
                    </li>
                ) : null}
                {shown.map((p) => {
                    const on = p.id === open;
                    const unseen = !on && hasUnseen(p.id, p.lastActivityAt);
                    const todo = todoOf(p);
                    const label = projectName(p, p.id);
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
                                aria-current={on ? "page" : undefined}
                                title={label === p.id ? p.id : `${label} (${p.id})`}
                            >
                                <ProjectMark name={label} active={on} />
                                <span className="side-name">{label}</span>
                                {unseen ? (
                                    <span
                                        className="unseen"
                                        title="New activity since you last looked"
                                    />
                                ) : null}
                                {todo ? (
                                    <span className="side-count" title={`${todo} to do`}>
                                        {todo}
                                    </span>
                                ) : null}
                            </a>
                        </li>
                    );
                })}
            </ul>

            <div className="side-foot">
                {me.authRequired && admin ? (
                    <a
                        className={route.page === "tokens" ? "side-link active" : "side-link"}
                        href={href({ page: "tokens" })}
                    >
                        <Icon name="key" />
                        Tokens
                    </a>
                ) : null}
                {admin ? (
                    <a
                        className={route.page === "settings" ? "side-link active" : "side-link"}
                        href={href({ page: "settings" })}
                    >
                        <Icon name="gear" />
                        Settings
                    </a>
                ) : null}
                <div className="name-card">
                    <span className="name-initial" aria-hidden="true">
                        {initial(name)}
                    </span>
                    {draft === null ? (
                        <div className="name-text">
                            <span className="name-value">{name || "Anonymous"}</span>
                            <button
                                type="button"
                                className="name-change"
                                onClick={() => setDraft(name)}
                            >
                                {name ? "Change name" : "Add your name"}
                            </button>
                        </div>
                    ) : (
                        <form
                            className="name-form"
                            onSubmit={(e) => {
                                e.preventDefault();
                                setBoardName(draft);
                                setDraft(null);
                            }}
                        >
                            <input
                                // biome-ignore lint/a11y/noAutofocus: the person just asked to type here
                                autoFocus
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape") setDraft(null);
                                }}
                                placeholder="Your name"
                                aria-label="Your name on replies"
                                maxLength={80}
                            />
                            <button type="submit" className="small primary">
                                Save
                            </button>
                        </form>
                    )}
                </div>
                <ThemeSwitch icons />
                {me.username && me.mode === "serve" ? (
                    <button type="button" className="link sign-out" onClick={onSignOut}>
                        Sign out {me.username}
                    </button>
                ) : null}
            </div>
        </nav>
    );
}
