import { DETAILS, renderAnnotations } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity } from "./Activity.tsx";
import {
    type BundleRecord,
    exportHref,
    isAdmin,
    listAnnotations,
    listBundles,
    type Me,
    type ProjectSummary,
    uploadBundle,
} from "./api.ts";
import { ConnectPage } from "./Connect.tsx";
import { Inbox } from "./Inbox.tsx";
import { lastSeen, markSeen, onLive } from "./live.ts";
import {
    applyChange,
    type Filters,
    GROUPS,
    type InboxState,
    lastActivity,
    matches,
    matchesSearch,
    mergeSnapshot,
    NO_FILTERS,
    newestActivity,
    plural,
    projectName,
    SORTS,
    sortAnnotations,
} from "./model.ts";
import { Overview } from "./Overview.tsx";
import { ProjectMenu } from "./ProjectMenu.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { go, projectHref, type Tab } from "./route.ts";
import { KEYS, remember, remembered, useRemembered } from "./storage.ts";
import { copyText, Empty, Icon } from "./ui.tsx";

interface Props {
    me: Me;
    project: string;
    /** Every project, as far as it has loaded. */
    projects: ProjectSummary[] | null;
    /** The project as the server's list has it; undefined while the list loads, or when it has no such project. */
    summary: ProjectSummary | undefined;
    /** Whether the server has the project: null until its list has loaded. */
    known: boolean | null;
    tab: Tab;
    selected?: string;
    /** Opens the new-project dialog (admins only). */
    onNewProject?: (id?: string) => void;
    /** The project list should refresh: something here changed it. */
    onProjectsChanged(): void;
    onRenamed(): void;
    onDeleted(): void;
}

/** How long a notice stays before it goes on its own. */
const NOTICE_MS = 6000;

/**
 * One project, on whichever tab is open. Its notes are loaded here, once, and kept up to date from the live stream,
 * so the inbox, Activity and Overview all show the same list.
 */
export function Project(props: Props) {
    const { me, project, summary, tab, selected, onProjectsChanged } = props;
    const admin = isAdmin(me);
    const name = projectName(summary, project);
    const [all, setAll] = useState<Annotation[] | null>(null);
    const [bundles, setBundles] = useState<BundleRecord[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [state, setState] = useState<InboxState>(() => ({
        filters: NO_FILTERS,
        search: "",
        sort: remembered(
            KEYS.sort,
            SORTS.map((s) => s.id),
            "activity"
        ),
        group: remembered(
            KEYS.group,
            GROUPS.map((g) => g.id),
            "none"
        ),
    }));
    const [detail, setDetail] = useRemembered(KEYS.detail, DETAILS, "standard");
    /** When this browser last looked, as of opening the project: anything newer is marked new. */
    const [since] = useState(() => lastSeen(project));
    const [read, setRead] = useState<Set<string>>(() => new Set());

    /**
     * The last change heard for each note while a load is on its way (null when none is): the load may have been read
     * before them, so they are laid over it. Also holds what arrives before the first load does.
     */
    const heard = useRef<Map<string, Annotation | null> | null>(null);
    const loads = useRef(0);
    const loaded = useRef(false);
    loaded.current = all !== null;

    const load = useCallback(() => {
        const n = ++loads.current;
        heard.current ??= new Map();
        listAnnotations(project).then(
            (items) => {
                // An earlier load answering late is older than the one still to come.
                if (n !== loads.current) return;
                const changes = heard.current ?? new Map();
                heard.current = null;
                const merged = mergeSnapshot(items, changes);
                setAll(merged);
                setError(null);
                // Looking at the project is seeing what happened in it, as the server tells it.
                markSeen(project, newestActivity(merged));
            },
            (e: Error) => {
                if (n !== loads.current) return;
                heard.current = null;
                // A list already on screen stays: a failed reload removes nothing from it.
                if (loaded.current) setNotice(`Could not reload the notes: ${e.message}`);
                else setError(e.message);
            }
        );
        // The bundles only fill the Source filter, which is left out while they cannot be had.
        listBundles(project).then(setBundles, () => {});
    }, [project]);

    useEffect(() => {
        load();
        return onLive((e) => {
            if (e.projectId !== project) return;
            if (e.type === "deleted") heard.current?.set(e.id, null);
            else if (e.annotation) {
                heard.current?.set(e.id, e.annotation);
                markSeen(project, lastActivity(e.annotation));
            }
            setAll((cur) => (cur ? applyChange(cur, e) : cur));
        }, load);
    }, [project, load]);

    // A notice is a toast: it goes on its own after a while.
    useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(null), NOTICE_MS);
        return () => clearTimeout(t);
    }, [notice]);

    const patch = useCallback((next: Partial<InboxState>) => {
        setState((s) => ({ ...s, ...next }));
        if (next.sort) remember(KEYS.sort, next.sort);
        if (next.group) remember(KEYS.group, next.group);
    }, []);

    const shown = useMemo(
        () =>
            sortAnnotations(
                (all ?? []).filter(
                    (a) => matches(a, state.filters) && matchesSearch(a, state.search)
                ),
                state.sort
            ),
        [all, state]
    );

    const replace = useCallback(
        (next: Annotation) => {
            heard.current?.set(next.id, next);
            setAll((cur) => cur?.map((x) => (x.id === next.id ? next : x)) ?? cur);
            onProjectsChanged();
        },
        [onProjectsChanged]
    );
    const removed = useCallback(
        (id: string) => {
            heard.current?.set(id, null);
            setAll((cur) => cur?.filter((x) => x.id !== id) ?? cur);
            onProjectsChanged();
        },
        [onProjectsChanged]
    );

    const markRead = useCallback(
        (id: string) => setRead((r) => (r.has(id) ? r : new Set(r).add(id))),
        []
    );

    /** Exactly what the inbox shows, in its order, as the same Markdown `notato export` writes. */
    const copyShown = async () => {
        try {
            await copyText(renderAnnotations(shown, { detail, title: `Feedback for ${project}` }));
            setNotice(`Copied ${plural(shown.length, "annotation")} as Markdown (${detail}).`);
        } catch (e) {
            setNotice(e instanceof Error ? e.message : "Could not copy.");
        }
    };

    const importBundle = async (file: File) => {
        setNotice(null);
        try {
            const result = await uploadBundle(project, file);
            setNotice(
                `Imported ${plural(result.imported, "annotation")}${result.skipped ? `, ${result.skipped} already present` : ""}.`
            );
            load();
            onProjectsChanged();
        } catch (e) {
            setNotice(e instanceof Error ? e.message : "Could not import that file.");
        }
    };

    /** Opening an annotation from Overview or Activity: show it in the inbox, whatever the inbox was showing. */
    const showInInbox = (filters: Partial<Filters>) => {
        patch({ filters: { ...NO_FILTERS, status: [], ...filters }, search: "" });
        go(projectHref(project));
    };

    const menu = (
        <ProjectMenu
            project={project}
            admin={admin}
            shown={shown.length}
            detail={detail}
            onDetail={setDetail}
            onCopy={copyShown}
            exportHref={exportHref(project, state.filters)}
            onImport={importBundle}
        />
    );

    /** The page for the tab, or what stands in for it while the notes load or when they cannot. */
    const page = (): ReactNode => {
        // On a shared server a project has to be made before anything can be sent to it.
        if (props.known === false && me.mode === "serve") {
            return (
                <Sheet>
                    <Empty title={`There is no project “${project}” here`}>
                        <p>Apps can only send notes to a project that exists on this server.</p>
                        <div className="empty-actions">
                            {props.onNewProject ? (
                                <button
                                    type="button"
                                    className="primary"
                                    onClick={() => props.onNewProject?.(project)}
                                >
                                    <Icon name="plus" size={14} />
                                    Create it
                                </button>
                            ) : null}
                            <a className="button-link" href="#/">
                                All projects
                            </a>
                        </div>
                    </Empty>
                </Sheet>
            );
        }
        if (tab === "connect" && admin)
            return <ConnectPage me={me} project={project} name={name} menu={menu} />;
        if (tab === "settings" && admin) {
            return (
                <ProjectSettings
                    me={me}
                    project={project}
                    summary={summary}
                    projects={props.projects}
                    menu={menu}
                    onRenamed={props.onRenamed}
                    onDeleted={props.onDeleted}
                />
            );
        }
        if (error) {
            return (
                <Sheet>
                    <p className="error">{error}</p>
                </Sheet>
            );
        }
        if (!all) {
            return (
                <Sheet>
                    <p className="muted">Loading…</p>
                </Sheet>
            );
        }
        if (tab === "activity")
            return <Activity project={project} name={name} all={all} since={since} menu={menu} />;
        if (tab === "overview")
            return <Overview name={name} all={all} onShow={showInInbox} menu={menu} />;
        // Nothing has arrived yet: what to do about that is the useful thing to show.
        if (all.length === 0 && admin)
            return <ConnectPage me={me} project={project} name={name} menu={menu} empty />;
        return (
            <Inbox
                project={project}
                name={name}
                all={all}
                shown={shown}
                bundles={bundles}
                state={state}
                onState={patch}
                selected={selected}
                since={since}
                read={read}
                onRead={markRead}
                detail={detail}
                onChange={replace}
                onDeleted={removed}
                menu={menu}
            />
        );
    };

    return (
        <>
            {page()}
            {notice ? (
                <div className="toast" role="status">
                    <span>{notice}</span>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Dismiss"
                        onClick={() => setNotice(null)}
                    >
                        <Icon name="close" size={14} />
                    </button>
                </div>
            ) : null}
        </>
    );
}

/** A page of its own, for a short message. */
function Sheet({ children }: { children: ReactNode }) {
    return (
        <div className="sheet">
            <div className="sheet-inner">{children}</div>
        </div>
    );
}
