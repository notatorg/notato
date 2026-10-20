import { useState } from "react";
import type { Me, ProjectSummary } from "./api.ts";
import { accountNameOf, useBoardExtension } from "./extension.tsx";
import { type LiveState, useLiveState, useSeenVersion } from "./live.ts";
import { initial } from "./model.ts";
import { ProjectNav } from "./ProjectNav.tsx";
import { href, type Route } from "./route.ts";
import { setBoardName, useBoardName } from "./storage.ts";
import { Icon, Logo } from "./ui.tsx";

interface Props {
    me: Me;
    route: Route;
    /** The project its Inbox, Activity and Overview lead to. */
    current: string | null;
    projects: ProjectSummary[] | null;
    /** Opens the new-project dialog; absent for anyone who cannot make one. */
    onNewProject?: () => void;
    onSignOut?: () => Promise<void>;
}

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
    const extension = useBoardExtension();
    const localName = useBoardName();
    // On a service that knows who is signed in the name is theirs, not something typed into this browser.
    const accountName = accountNameOf(me, extension);
    const name = accountName ?? localName;
    const [draft, setDraft] = useState<string | null>(null);
    const links = extension?.nav?.filter((item) => item.show?.(me) !== false) ?? [];
    const renderLink = (item: (typeof links)[number]) => {
        const on = route.page === "ext" && route.name === item.page;
        return (
            <a
                key={item.page}
                className={on ? "side-link active" : "side-link"}
                href={href({ page: "ext", name: item.page, rest: "" })}
                aria-current={on ? "page" : undefined}
            >
                {item.icon ? <Icon name={item.icon} /> : null}
                {item.label}
            </a>
        );
    };

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

            {extension?.SidebarTop ? <extension.SidebarTop me={me} /> : null}
            {links.some((item) => item.placement === "workspace") ? (
                <section className="workspace-links" aria-label="Workspace tools">
                    {links.filter((item) => item.placement === "workspace").map(renderLink)}
                </section>
            ) : null}

            {(() => {
                const Nav = extension?.ProjectNav ?? ProjectNav;
                return (
                    <Nav
                        me={me}
                        route={route}
                        current={current}
                        projects={projects}
                        onNewProject={onNewProject}
                    />
                );
            })()}

            <div className="side-foot">
                {links.filter((item) => item.placement !== "workspace").map(renderLink)}
                {extension?.AccountMenu ? (
                    <extension.AccountMenu me={me} onSignOut={onSignOut} />
                ) : (
                    <>
                        <a
                            className={route.page === "settings" ? "side-link active" : "side-link"}
                            href={href({ page: "settings" })}
                        >
                            <Icon name="gear" />
                            Settings
                        </a>
                        <div className="name-card">
                            <span className="name-initial" aria-hidden="true">
                                {initial(name)}
                            </span>
                            {draft === null ? (
                                <div className="name-text">
                                    <span className="name-value">{name || "Anonymous"}</span>
                                    {accountName === undefined ? (
                                        <button
                                            type="button"
                                            className="name-change"
                                            onClick={() => setDraft(name)}
                                        >
                                            {name ? "Change name" : "Add your name"}
                                        </button>
                                    ) : null}
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
                    </>
                )}
            </div>
        </nav>
    );
}
