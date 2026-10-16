import type { Status } from "@notato/schema";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
    type CreatedProject,
    canManageTokens,
    getMe,
    isAdmin,
    isServerAdmin,
    listProjects,
    logout,
    type Me,
    type ProjectSummary,
    setManagePolicy,
    setServerAdminPolicy,
    setTokenPolicy,
    setUnauthorizedHandler,
} from "./api.ts";
import {
    accountNameOf,
    type BoardExtension,
    BoardExtensionProvider,
    useBoardExtension,
} from "./extension.tsx";
import { Home } from "./Home.tsx";
import { Login } from "./Login.tsx";
import { markSeen, onLive, setSeenAccount } from "./live.ts";
import { byActivity, countsMayChange, lastActivity, projectName, withActivity } from "./model.ts";
import { NewProject } from "./NewProject.tsx";
import { NotFound } from "./NotFound.tsx";
import { Project } from "./Project.tsx";
import { go, projectHref, type Route, useRoute } from "./route.ts";
import { Settings } from "./Settings.tsx";
import { Sidebar } from "./Sidebar.tsx";
import {
    clearAccountMemory,
    KEYS,
    keepFreshAgentToken,
    keepFreshToken,
    remember,
    remembered,
    setAccountName,
} from "./storage.ts";
import { Tokens } from "./Tokens.tsx";
import { Icon, Logo } from "./ui.tsx";

/** Signs in first when the server asks for it, then shows the board. */
function App() {
    const [me, setMe] = useState<Me | null>(null);
    const [error, setError] = useState<string | null>(null);
    const route = useRoute();
    const extension = useBoardExtension();

    const account = useRef<string | undefined>(undefined);
    const refreshes = useRef(0);
    const refresh = useCallback(() => {
        const load = ++refreshes.current;
        getMe().then(
            (next) => {
                // Only the latest answer counts: an earlier one can arrive after it.
                if (load !== refreshes.current) return;
                const key = next.authenticated ? (next.username ?? "local") : undefined;
                // Another person on this browser starts from nothing: no old tokens, no old read markers.
                if (account.current !== key) clearAccountMemory();
                account.current = key;
                setAccountName(accountNameOf(next, extensionRef.current));
                setSeenAccount(
                    next.authRequired ? next.username : undefined,
                    extensionRef.current?.accountScope?.(next)
                );
                setError(null);
                setMe(next);
            },
            (e: Error) => {
                if (load === refreshes.current) setError(e.message);
            }
        );
    }, []);
    const extensionRef = useRef(extension);
    extensionRef.current = extension;
    useEffect(() => {
        setUnauthorizedHandler(() => {
            account.current = undefined;
            clearAccountMemory();
            setMe((m) => (m ? { ...m, authenticated: false } : m));
        });
        refresh();
    }, [refresh]);

    if (error) return <p className="center error">Could not reach the server: {error}</p>;
    if (!me) return <p className="center muted">Loading…</p>;
    const missing =
        route.page === "not-found" || (route.page === "ext" && !extension?.pages?.[route.name]);
    if (missing && me.authRequired && !me.authenticated) return <NotFound standalone />;
    if (me.authRequired && !me.authenticated) {
        const SignIn = extension?.Login ?? Login;
        return <SignIn onDone={refresh} />;
    }
    const shell = (
        <Shell
            me={me}
            onSignedOut={() => {
                clearAccountMemory();
                account.current = undefined;
                setMe({ ...me, authenticated: false });
            }}
            route={route}
        />
    );
    return extension?.Frame ? (
        <extension.Frame me={me} refresh={refresh}>
            {shell}
        </extension.Frame>
    ) : (
        shell
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
    const extension = useBoardExtension();
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
    const missing =
        route.page === "not-found" || (route.page === "ext" && !extension?.pages?.[route.name]);
    useEffect(() => {
        document.title = missing
            ? "Page not found · Notato"
            : openName
              ? `${openName} · Notato`
              : "Notato";
        if (open) {
            setLastProject(open);
            remember(KEYS.project, open);
        }
    }, [open, openName, missing]);
    const readState = extension?.readState;
    const reading = useRef(new Map<string, string>());
    const active = useRef(true);
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
        };
    }, []);
    // Looking at a project is seeing what the server says happened in it last: kept in this browser, or (where the
    // server keeps read state per account) saved to the server once what was loaded has been on screen a moment.
    useEffect(() => {
        if (open && !readState) markSeen(open, openSummary?.lastActivityAt);
    }, [open, openSummary?.lastActivityAt, readState]);
    const viewed = useCallback(
        (id: string, at: string) => {
            if (!readState) return;
            const before = reading.current.get(id);
            if (before && Date.parse(before) >= Date.parse(at)) return;
            reading.current.set(id, at);
            readState.markRead(id, at).then(
                (summary) => {
                    if (!active.current) return;
                    markSeen(id, summary.readAt);
                    // A newer request can answer first; never replace it with an older read marker.
                    setProjects(
                        (items) =>
                            items?.map((p) =>
                                p.id === id &&
                                (!p.readAt ||
                                    Date.parse(p.readAt) <= Date.parse(summary.readAt ?? ""))
                                    ? { ...p, readAt: summary.readAt }
                                    : p
                            ) ?? items
                    );
                    reloadSoon();
                },
                (e: Error) => {
                    if (!active.current) return;
                    if (reading.current.get(id) === at) reading.current.delete(id);
                    setError(`Could not save read state: ${e.message}`);
                }
            );
        },
        [readState, reloadSoon]
    );

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
        if (made.agentToken) keepFreshAgentToken(made.project.id, made.agentToken.token);
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
            />
            <main className="content">
                {route.page === "tokens" && canManageTokens(me) && me.authRequired ? (
                    <div className="sheet">
                        <div className="sheet-inner">
                            <Tokens me={me} projects={projects} />
                        </div>
                    </div>
                ) : route.page === "settings" ? (
                    <Settings
                        projects={projects}
                        manageServer={isServerAdmin(me)}
                        accountName={accountNameOf(me, extension)}
                        onSignOut={
                            me.authRequired
                                ? () => (extension?.signOut ?? logout)().then(onSignedOut)
                                : undefined
                        }
                    />
                ) : route.page === "ext" && extension?.pages?.[route.name] ? (
                    (() => {
                        const Page = extension.pages[route.name] as NonNullable<
                            BoardExtension["pages"]
                        >[string];
                        return <Page me={me} rest={route.rest} projects={projects} />;
                    })()
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
                        onViewed={viewed}
                        onRenamed={loadProjects}
                        onDeleted={() => {
                            loadProjects();
                            go("#/", true);
                        }}
                    />
                ) : route.page === "home" ? (
                    <Home projects={projects} error={error} me={me} onNewProject={newProject} />
                ) : (
                    <NotFound />
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

export interface BoardOptions {
    extension?: BoardExtension;
    /** Where to draw the board. Default: the element with id `root`. */
    root?: HTMLElement;
}

/** Draws the board. The page's own script calls it with nothing; a hosted board passes its extension. */
export function mountBoard(options: BoardOptions = {}) {
    setManagePolicy(options.extension?.canManage);
    setTokenPolicy(options.extension?.canManageTokens);
    setServerAdminPolicy(options.extension?.canAdminServer);
    const root = options.root ?? (document.getElementById("root") as HTMLElement);
    createRoot(root).render(
        <StrictMode>
            <BoardExtensionProvider value={options.extension}>
                <App />
            </BoardExtensionProvider>
        </StrictMode>
    );
}
