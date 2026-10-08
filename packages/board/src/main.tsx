import type { Status } from "@notato/schema";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
    type CreatedProject,
    getMe,
    isAdmin,
    listProjects,
    logout,
    type Me,
    type ProjectSummary,
    setUnauthorizedHandler,
} from "./api.ts";
import { Home } from "./Home.tsx";
import { Login } from "./Login.tsx";
import { markSeen, onLive } from "./live.ts";
import { byActivity, countsMayChange, lastActivity, projectName, withActivity } from "./model.ts";
import { NewProject } from "./NewProject.tsx";
import { Project } from "./Project.tsx";
import { go, projectHref, type Route, useRoute } from "./route.ts";
import { Settings } from "./Settings.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { KEYS, keepFreshToken, remember, remembered } from "./storage.ts";
import { Tokens } from "./Tokens.tsx";
import { Icon, Logo } from "./ui.tsx";

/** Signs in first when the server asks for it, then shows the board. */
function App() {
    const [me, setMe] = useState<Me | null>(null);
    const [error, setError] = useState<string | null>(null);
    const route = useRoute();

    const refresh = useCallback(() => {
        getMe().then(setMe, (e: Error) => setError(e.message));
    }, []);
    useEffect(() => {
        setUnauthorizedHandler(() => setMe((m) => (m ? { ...m, authenticated: false } : m)));
        refresh();
    }, [refresh]);

    if (error) return <p className="center error">Could not reach the server: {error}</p>;
    if (!me) return <p className="center muted">Loading…</p>;
    if (me.authRequired && !me.authenticated) return <Login onDone={refresh} />;
    return (
        <Shell me={me} onSignedOut={() => setMe({ ...me, authenticated: false })} route={route} />
    );
}

/** A burst of changes (an import, an agent working through a list) reloads the counts once it settles, or every 2 s. */
const SETTLE_MS = 400;
const MAX_WAIT_MS = 2000;

/**
 * The board around whichever page is open: the project list, loaded here and kept up to date from the live stream,
 * the sidebar, and the new-project dialog.
 */
function Shell({ me, route, onSignedOut }: { me: Me; route: Route; onSignedOut(): void }) {
    const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
    const listed = useRef(projects);
    listed.current = projects;
    const [error, setError] = useState<string | null>(null);
    const [drawer, setDrawer] = useState(false);
    /** The new-project dialog, with the id to start from when one is known. */
    const [creating, setCreating] = useState<{ id?: string } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const firstAsked = useRef<number | null>(null);
    const loads = useRef(0);
    /** Each note's status as of the last change heard, so a change can tell whether it moved one. */
    const statuses = useRef(new Map<string, Status>());
    const [lastProject, setLastProject] = useState(() =>
        remembered<string>(KEYS.project, null, "")
    );

    const loadProjects = useCallback(() => {
        clearTimeout(timer.current);
        firstAsked.current = null;
        // Only the latest answer counts: an earlier one can arrive after it.
        const load = ++loads.current;
        listProjects().then(
            (items) => {
                if (load !== loads.current) return;
                setProjects(items);
                setError(null);
            },
            (e: Error) => {
                if (load === loads.current) setError(e.message);
            }
        );
    }, []);
    /** Reload the counts once changes settle, but never wait more than MAX_WAIT_MS for a busy stream to pause. */
    const reloadSoon = useCallback(() => {
        clearTimeout(timer.current);
        const now = Date.now();
        firstAsked.current ??= now;
        const wait = Math.max(0, Math.min(SETTLE_MS, firstAsked.current + MAX_WAIT_MS - now));
        timer.current = setTimeout(loadProjects, wait);
    }, [loadProjects]);

    useEffect(() => {
        loadProjects();
        const off = onLive((e) => {
            const before = e.previous?.status ?? statuses.current.get(e.id);
            if (e.type === "deleted") statuses.current.delete(e.id);
            else if (e.annotation) statuses.current.set(e.id, e.annotation.status);
            // Most changes (a reply, a severity) leave the counts as they are: only the activity time moves.
            const a = e.annotation;
            if (!a || countsMayChange(e, before)) return reloadSoon();
            const at = lastActivity(a);
            const list = listed.current;
            if (!list || !withActivity(list, e.projectId, at)) return reloadSoon();
            setProjects((cur) => (cur && withActivity(cur, e.projectId, at)) ?? cur);
        }, loadProjects);
        return () => {
            off();
            clearTimeout(timer.current);
        };
    }, [loadProjects, reloadSoon]);

    // On a phone the sidebar is a drawer: following any link in it closes it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new route is the trigger, not an input
    useEffect(() => setDrawer(false), [route]);

    const open = route.page === "project" ? route.project : null;
    const openSummary = open ? projects?.find((p) => p.id === open) : undefined;
    const openName = open ? projectName(openSummary, open) : null;
    useEffect(() => {
        document.title = openName ? `${openName} · Notato` : "Notato";
        if (open) {
            setLastProject(open);
            remember(KEYS.project, open);
        }
    }, [open, openName]);
    // Looking at a project is seeing what the server says happened in it last.
    useEffect(() => {
        if (open) markSeen(open, openSummary?.lastActivityAt);
    }, [open, openSummary?.lastActivityAt]);

    /** The project the sidebar's Inbox, Activity and Overview lead to: the open one, else the last one looked at. */
    const current =
        open ??
        (projects === null || projects.some((p) => p.id === lastProject)
            ? lastProject || null
            : ([...projects].sort(byActivity)[0]?.id ?? null));

    const admin = isAdmin(me);
    const newProject = admin ? (id?: string) => setCreating({ id }) : undefined;

    const created = (made: CreatedProject) => {
        setCreating(null);
        if (made.token) keepFreshToken(made.project.id, made.token.token);
        setProjects((cur) =>
            cur && !cur.some((p) => p.id === made.project.id) ? [...cur, made.project] : cur
        );
        loadProjects();
        go(projectHref(made.project.id, "connect"));
    };

    return (
        <div className={drawer ? "app drawer-open" : "app"}>
            <header className="mobile-bar">
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Menu"
                    onClick={() => setDrawer(true)}
                >
                    <Icon name="menu" />
                </button>
                <a className="brand" href="#/">
                    <Logo size={30} tilt={-8} />
                    <span className="wordmark">notato</span>
                </a>
            </header>
            <button
                type="button"
                className="drawer-shade"
                aria-label="Close"
                onClick={() => setDrawer(false)}
            />
            <Sidebar
                me={me}
                route={route}
                current={current}
                projects={projects}
                onNewProject={newProject}
                onSignOut={() => logout().then(onSignedOut)}
            />
            <main className="content">
                {route.page === "tokens" && admin && me.authRequired ? (
                    <div className="sheet">
                        <div className="sheet-inner">
                            <Tokens projects={projects} />
                        </div>
                    </div>
                ) : route.page === "settings" && admin ? (
                    <Settings projects={projects} />
                ) : route.page === "project" ? (
                    <Project
                        key={route.project}
                        me={me}
                        project={route.project}
                        projects={projects}
                        summary={openSummary}
                        known={projects ? Boolean(openSummary) : null}
                        tab={route.tab}
                        selected={route.selected}
                        onNewProject={newProject}
                        onProjectsChanged={reloadSoon}
                        onRenamed={loadProjects}
                        onDeleted={() => {
                            loadProjects();
                            go("#/", true);
                        }}
                    />
                ) : (
                    <Home projects={projects} error={error} me={me} onNewProject={newProject} />
                )}
            </main>
            {creating ? (
                <NewProject
                    me={me}
                    projects={projects ?? []}
                    initialId={creating.id}
                    onClose={() => setCreating(null)}
                    onCreated={created}
                    onTaken={loadProjects}
                />
            ) : null}
        </div>
    );
}

createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
        <App />
    </StrictMode>
);
