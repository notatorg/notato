import { renderAnnotations } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity } from "./Activity.tsx";
import {
    type BundleRecord,
    copyText,
    exportHref,
    listAnnotations,
    listBundles,
    type Me,
    type ProjectSummary,
    projectName,
    remember,
    remembered,
    uploadBundle,
} from "./api.ts";
import { ConnectPage } from "./Connect.tsx";
import { Inbox } from "./Inbox.tsx";
import { lastSeen, markSeen, onLive } from "./live.ts";
import {
    applyChange,
    type Filters,
    GROUPS,
    type Group,
    lastActivity,
    matches,
    matchesSearch,
    mergeSnapshot,
    NO_FILTERS,
    newestActivity,
    SORTS,
    type Sort,
    sortAnnotations,
} from "./model.ts";
import { Overview } from "./Overview.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { go, projectHref, type Tab } from "./route.ts";
import { Empty, Icon } from "./ui.tsx";

export const DETAILS = ["compact", "standard", "detailed", "forensic"] as const;
export type Detail = (typeof DETAILS)[number];

/** How the inbox is cut: kept per project for as long as the project is open, so tabs do not reset it. */
export interface InboxState {
    filters: Filters;
    search: string;
    sort: Sort;
    group: Group;
}

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

export function Project(props: Props) {
    const { me, project, summary, tab, selected, onProjectsChanged } = props;
    const admin = me.mode === "dev" || Boolean(me.username);
    const name = projectName(summary, project);
    const [all, setAll] = useState<Annotation[] | null>(null);
    const [bundles, setBundles] = useState<BundleRecord[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [menuOpen, setMenu] = useState(false);
    const [state, setState] = useState<InboxState>(() => ({
        filters: NO_FILTERS,
        search: "",
        sort: remembered(
            "notato.sort",
            SORTS.map((s) => s.id),
            "activity"
        ),
        group: remembered(
            "notato.group",
            GROUPS.map((g) => g.id),
            "none"
        ),
    }));
    const [detail, setDetail] = useState<Detail>(() =>
        remembered("notato.detail", DETAILS, "standard")
    );
    /** When this browser last looked, as of opening the project: anything newer is marked new. */
    const [since] = useState(() => lastSeen(project));
    const [read, setRead] = useState<Set<string>>(() => new Set());
    const fileInput = useRef<HTMLInputElement>(null);

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
        listBundles(project).then(setBundles, () => {});
    }, [project]);

    useEffect(() => {
        load();
        const off = onLive((e) => {
            if (e.projectId !== project) return;
            if (e.type === "deleted") heard.current?.set(e.id, null);
            else if (e.annotation) {
                heard.current?.set(e.id, e.annotation);
                markSeen(project, lastActivity(e.annotation));
            }
            setAll((cur) => (cur ? applyChange(cur, e) : cur));
        }, load);
        return off;
    }, [project, load]);

    // A notice is a toast: it goes on its own after a while.
    useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(null), 6000);
        return () => clearTimeout(t);
    }, [notice]);

    const patch = useCallback((next: Partial<InboxState>) => {
        setState((s) => ({ ...s, ...next }));
        if (next.sort) remember("notato.sort", next.sort);
        if (next.group) remember("notato.group", next.group);
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

    const chooseDetail = (next: Detail) => {
        setDetail(next);
        remember("notato.detail", next);
    };

    /** Exactly what the inbox shows, in its order, as the same Markdown `notato export` writes. */
    const copyShown = async () => {
        setMenu(false);
        try {
            await copyText(renderAnnotations(shown, { detail, title: `Feedback for ${project}` }));
            setNotice(
                `Copied ${shown.length} annotation${shown.length === 1 ? "" : "s"} as Markdown (${detail}).`
            );
        } catch (e) {
            setNotice(e instanceof Error ? e.message : "Could not copy.");
        }
    };

    const onFile = async (file: File | undefined) => {
        if (!file) return;
        setNotice(null);
        try {
            const result = await uploadBundle(project, file);
            setNotice(
                `Imported ${result.imported} annotation${result.imported === 1 ? "" : "s"}${result.skipped ? `, ${result.skipped} already present` : ""}.`
            );
            load();
            onProjectsChanged();
        } catch (e) {
            setNotice(e instanceof Error ? e.message : "Could not import that file.");
        }
        if (fileInput.current) fileInput.current.value = "";
    };

    /** Opening an annotation from Overview or Activity: show it in the inbox, whatever the inbox was showing. */
    const showInInbox = (filters: Partial<Filters>) => {
        patch({ filters: { ...NO_FILTERS, status: [], ...filters }, search: "" });
        go(projectHref(project));
    };

    const menu = (
        <div className="menu-wrap">
            <button
                type="button"
                className="icon-button"
                aria-label="Project actions"
                title={admin ? "Copy, export, import, settings" : "Copy, export, import"}
                aria-expanded={menuOpen}
                onClick={() => setMenu(!menuOpen)}
            >
                <Icon name="more" />
            </button>
            {menuOpen ? (
                <>
                    <button
                        type="button"
                        className="menu-shade"
                        aria-label="Close menu"
                        onClick={() => setMenu(false)}
                    />
                    <div className="menu" role="menu">
                        <button
                            type="button"
                            role="menuitem"
                            onClick={copyShown}
                            disabled={shown.length === 0}
                        >
                            <Icon name="copy" />
                            Copy {shown.length} shown as Markdown
                        </button>
                        <label className="menu-row">
                            Detail
                            <select
                                value={detail}
                                onChange={(e) => chooseDetail(e.target.value as Detail)}
                            >
                                {DETAILS.map((d) => (
                                    <option key={d}>{d}</option>
                                ))}
                            </select>
                        </label>
                        <hr />
                        <a
                            role="menuitem"
                            href={exportHref(project, state.filters)}
                            download
                            onClick={() => setMenu(false)}
                            title="A bundle of the annotations matching the filters (search is not applied)"
                        >
                            <Icon name="download" />
                            Export zip
                        </a>
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                setMenu(false);
                                fileInput.current?.click();
                            }}
                        >
                            <Icon name="upload" />
                            Import zip…
                        </button>
                        {admin ? (
                            <>
                                <hr />
                                <a
                                    role="menuitem"
                                    href={projectHref(project, "connect")}
                                    onClick={() => setMenu(false)}
                                >
                                    <Icon name="plug" />
                                    Connect an app…
                                </a>
                                <a
                                    role="menuitem"
                                    href={projectHref(project, "settings")}
                                    onClick={() => setMenu(false)}
                                >
                                    <Icon name="sliders" />
                                    Project settings…
                                </a>
                            </>
                        ) : null}
                    </div>
                </>
            ) : null}
            <input
                ref={fileInput}
                type="file"
                accept=".zip,application/zip"
                hidden
                onChange={(e) => onFile(e.target.files?.[0])}
            />
        </div>
    );

    /** On a shared server a project has to be made before anything can be sent to it. */
    const missing = props.known === false && me.mode === "serve";

    return (
        <>
            {missing ? (
                <div className="sheet">
                    <div className="sheet-inner">
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
                    </div>
                </div>
            ) : tab === "connect" && admin ? (
                <ConnectPage me={me} project={project} name={name} menu={menu} />
            ) : tab === "settings" && admin ? (
                <ProjectSettings
                    me={me}
                    project={project}
                    summary={summary}
                    projects={props.projects}
                    menu={menu}
                    onRenamed={props.onRenamed}
                    onDeleted={props.onDeleted}
                />
            ) : error ? (
                <div className="sheet">
                    <div className="sheet-inner">
                        <p className="error">{error}</p>
                    </div>
                </div>
            ) : !all ? (
                <div className="sheet">
                    <div className="sheet-inner">
                        <p className="muted">Loading…</p>
                    </div>
                </div>
            ) : tab !== "activity" && tab !== "overview" && all.length === 0 && admin ? (
                // Nothing has arrived yet: what to do about that is the useful thing to show.
                <ConnectPage me={me} project={project} name={name} menu={menu} empty />
            ) : tab !== "activity" && tab !== "overview" ? (
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
            ) : tab === "activity" ? (
                <Activity project={project} name={name} all={all} since={since} menu={menu} />
            ) : (
                <Overview name={name} all={all} onShow={showInInbox} menu={menu} />
            )}
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
