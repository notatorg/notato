import type { Annotation, Intent, Severity } from "@notato/schema";
import { useMemo, useState } from "react";
import type { BundleRecord } from "./api.ts";
import {
    extraFilterCount,
    type Filters,
    GROUPS,
    type Group,
    INTENTS,
    type InboxState,
    NO_EXTRA_FILTERS,
    NO_NAME,
    SEVERITIES,
    SORTS,
    type Sort,
} from "./model.ts";
import { Icon } from "./ui.tsx";

/** A filter that is set, as a chip that takes it off when pressed. */
interface Chip {
    key: string;
    label: string;
    clear: Partial<Filters>;
}

function chipsOf(f: Filters): Chip[] {
    const chips: Chip[] = [];
    if (f.route) chips.push({ key: "route", label: f.route, clear: { route: "" } });
    if (f.by)
        chips.push({ key: "by", label: f.by === NO_NAME ? "No name" : f.by, clear: { by: "" } });
    if (f.severity) chips.push({ key: "severity", label: f.severity, clear: { severity: "" } });
    if (f.intent) chips.push({ key: "intent", label: f.intent, clear: { intent: "" } });
    if (f.author)
        chips.push({
            key: "author",
            label: f.author === "human" ? "People" : "Agents",
            clear: { author: "" },
        });
    if (f.bundle)
        chips.push({
            key: "bundle",
            label: f.bundle === "none" ? "Live only" : "From a bundle",
            clear: { bundle: "" },
        });
    return chips;
}

/**
 * The row under the inbox's views: Filter, with a chip for each filter that is set, then the sort and the grouping.
 * Pressing Filter opens a select for each filter in place of the chips.
 */
export function FilterBar({
    all,
    bundles,
    state,
    onState,
}: {
    /** Every note in the project, for the pages and people to choose from. */
    all: Annotation[];
    bundles: BundleRecord[];
    state: InboxState;
    onState(next: Partial<InboxState>): void;
}) {
    const { filters } = state;
    const [open, setOpen] = useState(false);
    const setFilters = (next: Partial<Filters>) => onState({ filters: { ...filters, ...next } });
    const extra = extraFilterCount(filters);

    const people = useMemo(
        () => [...new Set(all.flatMap((a) => (a.author.name ? [a.author.name] : [])))].sort(),
        [all]
    );
    const unnamed = useMemo(() => all.some((a) => !a.author.name), [all]);
    const routes = useMemo(() => [...new Set(all.map((a) => a.route))].sort(), [all]);

    return (
        <>
            <div className="arrange">
                <button
                    type="button"
                    className={open || extra ? "ghost-button on" : "ghost-button"}
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                >
                    <Icon name="filter" size={13} />
                    Filter
                    {extra ? <span className="n">{extra}</span> : null}
                </button>
                {open
                    ? null
                    : chipsOf(filters).map((c) => (
                          <button
                              key={c.key}
                              type="button"
                              className="chip"
                              onClick={() => setFilters(c.clear)}
                              title="Remove this filter"
                          >
                              {c.label}
                              <Icon name="close" size={11} />
                          </button>
                      ))}
                <span className="grow" />
                <select
                    className="quiet-select"
                    aria-label="Sort"
                    title="Sort"
                    value={state.sort}
                    onChange={(e) => onState({ sort: e.target.value as Sort })}
                >
                    {SORTS.map((s) => (
                        <option key={s.id} value={s.id}>
                            {s.label}
                        </option>
                    ))}
                </select>
                <select
                    className="quiet-select"
                    aria-label="Group"
                    title="Group"
                    value={state.group}
                    onChange={(e) => onState({ group: e.target.value as Group })}
                >
                    {GROUPS.map((g) => (
                        <option key={g.id} value={g.id}>
                            {g.label}
                        </option>
                    ))}
                </select>
            </div>
            {open ? (
                <div className="filters">
                    <select
                        aria-label="Page"
                        className={filters.route ? "set" : ""}
                        value={filters.route}
                        onChange={(e) => setFilters({ route: e.target.value })}
                    >
                        <option value="">All pages</option>
                        {routes.map((r) => (
                            <option key={r}>{r}</option>
                        ))}
                    </select>
                    {/* Only when there is a choice to make, or one already made. */}
                    {people.length + (unnamed ? 1 : 0) > 1 || filters.by ? (
                        <select
                            aria-label="Person"
                            className={filters.by ? "set" : ""}
                            value={filters.by}
                            onChange={(e) => setFilters({ by: e.target.value })}
                        >
                            <option value="">Everyone</option>
                            {people.map((p) => (
                                <option key={p}>{p}</option>
                            ))}
                            {unnamed ? <option value={NO_NAME}>No name given</option> : null}
                        </select>
                    ) : null}
                    <select
                        aria-label="Severity"
                        className={filters.severity ? "set" : ""}
                        value={filters.severity}
                        onChange={(e) => setFilters({ severity: e.target.value as Severity | "" })}
                    >
                        <option value="">Any severity</option>
                        {SEVERITIES.map((s) => (
                            <option key={s}>{s}</option>
                        ))}
                    </select>
                    <select
                        aria-label="Intent"
                        className={filters.intent ? "set" : ""}
                        value={filters.intent}
                        onChange={(e) => setFilters({ intent: e.target.value as Intent | "" })}
                    >
                        <option value="">Any intent</option>
                        {INTENTS.map((i) => (
                            <option key={i}>{i}</option>
                        ))}
                    </select>
                    <select
                        aria-label="Author"
                        className={filters.author ? "set" : ""}
                        value={filters.author}
                        onChange={(e) =>
                            setFilters({ author: e.target.value as Filters["author"] })
                        }
                    >
                        <option value="">People and agents</option>
                        <option value="human">People</option>
                        <option value="agent">Agents</option>
                    </select>
                    {bundles.length ? (
                        <select
                            aria-label="Source"
                            className={filters.bundle ? "set" : ""}
                            value={filters.bundle}
                            onChange={(e) => setFilters({ bundle: e.target.value })}
                        >
                            <option value="">Any source</option>
                            <option value="none">Live (not from a bundle)</option>
                            {bundles.map((b) => (
                                <option key={b.id} value={b.id}>
                                    {`Bundle: ${b.author.name ?? "unnamed"} · ${new Date(b.createdAt).toLocaleDateString()} (${b.annotationCount})`}
                                </option>
                            ))}
                        </select>
                    ) : null}
                    {extra ? (
                        <button
                            type="button"
                            className="link"
                            onClick={() => setFilters(NO_EXTRA_FILTERS)}
                        >
                            Clear {extra}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </>
    );
}
