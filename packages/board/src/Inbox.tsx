import type { Detail as DetailLevel } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { assetHref, type BundleRecord, setStatus } from "./api.ts";
import { Detail } from "./Detail.tsx";
import { FilterBar } from "./FilterBar.tsx";
import {
    authorName,
    extraFilterCount,
    groupAnnotations,
    type InboxState,
    lastActivity,
    lastSegment,
    matches,
    matchesSearch,
    plural,
    relativeTime,
    replyCount,
    statusLabel,
    TODO,
    VIEWS,
    type View,
    viewOf,
} from "./model.ts";
import { go, projectHref } from "./route.ts";
import { Empty, Icon, Segmented, StatusDot, When } from "./ui.tsx";

/** How many rows the list draws at first, and adds each time more are asked for. */
const ROWS_PAGE = 200;

interface Props {
    project: string;
    /** What the project is called. */
    name: string;
    all: Annotation[];
    /** `all` filtered, searched and sorted. */
    shown: Annotation[];
    bundles: BundleRecord[];
    state: InboxState;
    onState(next: Partial<InboxState>): void;
    selected?: string;
    since: string | null;
    read: Set<string>;
    onRead(id: string): void;
    detail: DetailLevel;
    onChange(next: Annotation): void;
    onDeleted(id: string): void;
    /** The project's actions, for the corner of the list. */
    menu: ReactNode;
}

/** Typing in a field, so single-key shortcuts must leave the key alone. */
const typing = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * A project's inbox: its notes, searched, filtered, sorted and grouped, beside the one that is open. J and K move
 * through the list, R replies, E resolves, / searches.
 */
export function Inbox(props: Props) {
    const { project, all, shown, bundles, state, onState, selected, since, read, onRead } = props;
    const { filters } = state;
    const search = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);

    const current = selected ? all.find((a) => a.id === selected) : undefined;
    const groups = useMemo(() => groupAnnotations(shown, state.group), [shown, state.group]);
    /** In the order they are drawn, which grouping can change. */
    const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups]);

    // A project with thousands of notes draws them a page at a time: every row on screen at once took seconds, and
    // made each live update redraw them all. The open note is always drawn, so J and K never move out of the list.
    const [limit, setLimit] = useState(ROWS_PAGE);
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter, search or grouping starts from the top
    useEffect(() => setLimit(ROWS_PAGE), [project, filters, state.search, state.group]);
    const selectedAt = selected ? ordered.findIndex((a) => a.id === selected) : -1;
    const drawn = Math.max(limit, selectedAt + 1);
    /** The groups as far as the rows drawn reach, each with how many it has in all. */
    const visibleGroups = useMemo(() => {
        let left = drawn;
        const out: Array<(typeof groups)[number] & { total: number }> = [];
        for (const g of groups) {
            if (left <= 0) break;
            const items = g.items.length <= left ? g.items : g.items.slice(0, left);
            out.push({ ...g, items, total: g.items.length });
            left -= g.items.length;
        }
        return out;
    }, [groups, drawn]);
    const hiddenCount = Math.max(0, ordered.length - drawn);

    const view = viewOf(filters.status);
    /** How many each view would show with the other filters and the search as they are. */
    const viewCounts = useMemo(() => {
        const out = new Map<string, number>();
        for (const v of VIEWS) {
            const f = { ...filters, status: v.statuses };
            out.set(
                v.id,
                all.filter((a) => matches(a, f) && matchesSearch(a, state.search)).length
            );
        }
        return out;
    }, [all, filters, state.search]);

    const open = (id: string, replace = false) => go(projectHref(project, "inbox", id), replace);

    // Seeing an annotation clears its "new" mark.
    useEffect(() => {
        if (selected) onRead(selected);
    }, [selected, onRead]);

    // Keep the open row in view as the selection moves.
    useEffect(() => {
        if (!selected) return;
        list.current
            ?.querySelector(`[data-id="${CSS.escape(selected)}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    // The inbox's keys. Attached again on every render, so they always act on the list and the note on screen.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === "/" && !typing(e.target)) {
                e.preventDefault();
                search.current?.focus();
                return;
            }
            if (typing(e.target)) {
                if (e.key === "Escape" && e.target === search.current) search.current?.blur();
                return;
            }
            const at = ordered.findIndex((a) => a.id === selected);
            const step = (by: number) => {
                const next = ordered[at < 0 ? (by > 0 ? 0 : ordered.length - 1) : at + by];
                if (next) {
                    e.preventDefault();
                    open(next.id, true);
                }
            };
            if (e.key === "j" || e.key === "ArrowDown") step(1);
            else if (e.key === "k" || e.key === "ArrowUp") step(-1);
            else if (e.key === "Escape" && selected) go(projectHref(project), true);
            else if (e.key === "r" && selected) {
                e.preventDefault();
                document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
            } else if (
                e.key === "e" &&
                current &&
                (current.status === "open" || current.status === "acknowledged")
            ) {
                e.preventDefault();
                setStatus(current.id, "resolved").then(
                    (r) => props.onChange(r.annotation),
                    () => {}
                );
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    const isNew = (a: Annotation) =>
        since !== null && !read.has(a.id) && Date.parse(lastActivity(a)) > Date.parse(since);
    const extra = extraFilterCount(filters);

    const todo = all.filter((a) => TODO.includes(a.status)).length;

    return (
        <div className={current ? "inbox has-detail" : "inbox"}>
            <section className="card list-col" aria-label="Notes">
                <div className="list-top">
                    <header className="list-head">
                        <div className="list-title">
                            <h1 title={props.name === project ? undefined : project}>
                                {props.name}
                            </h1>
                            <p>
                                {todo
                                    ? `${todo} ${todo === 1 ? "note is" : "notes are"} waiting on you`
                                    : all.length
                                      ? "All caught up. Nice."
                                      : "No notes yet"}
                            </p>
                        </div>
                        {props.menu}
                    </header>
                    <div className="search">
                        <Icon name="search" size={15} />
                        <input
                            ref={search}
                            type="search"
                            placeholder="Search notes, pages, components"
                            value={state.search}
                            onChange={(e) => onState({ search: e.target.value })}
                            aria-label="Search"
                        />
                        <kbd className="hint">/</kbd>
                    </div>
                    <Segmented
                        label="Status"
                        className="views"
                        value={view}
                        onChange={(id) =>
                            onState({
                                filters: {
                                    ...filters,
                                    status: VIEWS.find((v) => v.id === id)?.statuses ?? [],
                                },
                            })
                        }
                        options={VIEWS.map((v) => ({
                            id: v.id,
                            label: v.label,
                            count: viewCounts.get(v.id) ?? 0,
                        }))}
                    />
                    <FilterBar all={all} bundles={bundles} state={state} onState={onState} />
                </div>

                <div className="list" ref={list}>
                    {shown.length === 0 ? (
                        <Empty title={emptyTitle(all.length, state.search, extra, view)}>
                            {all.length === 0 ? (
                                <p>
                                    Notes land here the moment someone pins one in an app for this
                                    project.
                                </p>
                            ) : state.search ? (
                                <p>Try a page name, a component or a word from the note.</p>
                            ) : view === "todo" && !extra ? (
                                <p>Nothing waiting on you. Go make a snack.</p>
                            ) : null}
                        </Empty>
                    ) : (
                        visibleGroups.map((g) => (
                            <div key={g.key || "all"} className="group">
                                {g.label ? (
                                    <h2 className="group-head">
                                        <span>{g.label}</span>
                                        <span className="muted">{g.total}</span>
                                    </h2>
                                ) : null}
                                {g.items.map((a) => (
                                    <Row
                                        key={a.id}
                                        a={a}
                                        project={project}
                                        active={a.id === selected}
                                        unread={isNew(a)}
                                    />
                                ))}
                            </div>
                        ))
                    )}
                    {hiddenCount > 0 ? (
                        <button
                            type="button"
                            className="link more-rows"
                            onClick={() => setLimit(drawn + ROWS_PAGE)}
                        >
                            Show {Math.min(ROWS_PAGE, hiddenCount)} more of {hiddenCount}
                        </button>
                    ) : null}
                </div>
                <p className="list-foot">
                    <span>
                        <kbd>J</kbd> <kbd>K</kbd> move
                    </span>
                    <span>
                        <kbd>R</kbd> reply
                    </span>
                    <span>
                        <kbd>E</kbd> resolve
                    </span>
                    <span>
                        <kbd>/</kbd> search
                    </span>
                </p>
            </section>

            <section className="card detail-col" aria-label="Note">
                {current ? (
                    <Detail
                        key={current.id}
                        annotation={current}
                        project={project}
                        detail={props.detail}
                        hidden={!shown.some((a) => a.id === current.id)}
                        onChange={props.onChange}
                        onDeleted={(id) => {
                            // Move on to the next one, the way an inbox does.
                            const at = ordered.findIndex((a) => a.id === id);
                            const next = ordered[at + 1] ?? ordered[at - 1];
                            props.onDeleted(id);
                            go(
                                next
                                    ? projectHref(project, "inbox", next.id)
                                    : projectHref(project),
                                true
                            );
                        }}
                    />
                ) : selected ? (
                    <Empty title="This note is gone" logo={96}>
                        <p>It was deleted, or it belongs to another project.</p>
                    </Empty>
                ) : (
                    <Empty title="Pick a note" logo={96}>
                        <p>Its screenshot, source and conversation show up here.</p>
                    </Empty>
                )}
            </section>
        </div>
    );
}

/** What an empty list says: why it is empty, as far as can be told. */
function emptyTitle(total: number, search: string, extraFilters: number, view: View | null) {
    if (total === 0) return "Nothing here yet";
    if (search) return "No matches";
    if (extraFilters) return "Nothing matches these filters";
    switch (view) {
        case "todo":
            return "All caught up";
        case "done":
            return "Nothing done yet";
        case "dismissed":
            return "Nothing dismissed";
        default:
            return "Nothing here";
    }
}

/** "3h ago", "Yesterday", "Mon", "3 Oct". */
const shortAgo = (iso: string) => {
    const r = relativeTime(iso);
    return /^\d+[mh]$/.test(r) ? `${r} ago` : r;
};

/** One note in the list. Memoised: a live update to one note redraws its row, not the thousands beside it. */
const Row = memo(function Row({
    a,
    project,
    active,
    unread,
}: {
    a: Annotation;
    project: string;
    active: boolean;
    unread: boolean;
}) {
    const replies = replyCount(a);
    const crop = a.screenshots?.crop ?? a.screenshots?.full;
    const at = lastActivity(a);
    return (
        <a
            className={`row${active ? " active" : ""}${unread ? " unread" : ""}`}
            href={projectHref(project, "inbox", a.id)}
            data-id={a.id}
            aria-current={active ? "true" : undefined}
        >
            <span className="row-main">
                <span className="row-top">
                    <StatusDot status={a.status} />
                    <span className="row-status">{statusLabel(a.status)}</span>
                    <When iso={at}>· {shortAgo(at)}</When>
                    {unread ? <span className="unseen" title="New since you last looked" /> : null}
                    {replies ? (
                        <span className="row-replies">{plural(replies, "reply", "replies")}</span>
                    ) : null}
                </span>
                <span className="row-comment">{a.comment}</span>
                <span className="row-sub">
                    <span className="row-route" title={a.url}>
                        {lastSegment(a.route)}
                    </span>
                    {a.severity ? (
                        <span className={`sev sev-${a.severity}`}>{a.severity}</span>
                    ) : null}
                    {a.peopleOnly ? (
                        <span
                            className="sev people"
                            title="Between people: the agent doesn't see it"
                        >
                            People only
                        </span>
                    ) : null}
                    {a.author.kind === "agent" ? (
                        <span className="row-who">by {authorName(a.author)}</span>
                    ) : null}
                </span>
            </span>
            {crop ? (
                <span className="row-thumb">
                    <img src={assetHref(crop.id)} alt="" loading="lazy" />
                    <span className="tape" aria-hidden="true" />
                </span>
            ) : null}
        </a>
    );
});
