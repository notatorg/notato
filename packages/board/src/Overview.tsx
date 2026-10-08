import type { Annotation, Status } from "@notato/schema";
import { type ReactNode, useMemo, useState } from "react";
import {
    ago,
    duration,
    type Filters,
    NO_NAME,
    newestActivity,
    projectStats,
    SEVERITIES,
    TODO,
} from "./model.ts";
import { Avatar, Empty } from "./ui.tsx";

/** How many pages and people each ranking lists before it says how many more there are. */
const RANKED = 12;

const fmt = (n: number) => n.toLocaleString();
const shortDay = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** A project's numbers. Every row leads back to the inbox with that slice showing. */
export function Overview({
    name,
    all,
    onShow,
    menu,
}: {
    /** What the project is called. */
    name: string;
    all: Annotation[];
    onShow(filters: Partial<Filters>): void;
    menu: ReactNode;
}) {
    const stats = useMemo(() => projectStats(all), [all]);
    const latest = useMemo(() => newestActivity(all), [all]);

    const head = (
        <header className="sheet-head">
            <div>
                <h1>Overview</h1>
                <p>
                    How {name} is doing{latest ? `, last active ${ago(latest)}` : ""}
                </p>
            </div>
            <div className="sheet-tools">{menu}</div>
        </header>
    );

    if (all.length === 0) {
        return (
            <div className="sheet">
                <div className="sheet-inner wide">
                    {head}
                    <Empty title="No numbers yet" logo={56}>
                        <p>The overview fills in once notes arrive.</p>
                    </Empty>
                </div>
            </div>
        );
    }

    const s = stats.statuses;
    /** Each part of the bar, in the order work moves; the rarer states only when there are some. */
    const every: Array<{ key: string; label: string; value: number; statuses: Status[] }> = [
        { key: "open", label: "Open", value: s.open, statuses: ["open"] },
        {
            key: "acknowledged",
            label: "Acknowledged",
            value: s.acknowledged,
            statuses: ["acknowledged"],
        },
        {
            key: "variant_chosen",
            label: "Version picked",
            value: s.variant_chosen,
            statuses: ["variant_chosen"],
        },
        {
            key: "revert_requested",
            label: "Revert requested",
            value: s.revert_requested,
            statuses: ["revert_requested"],
        },
        { key: "resolved", label: "Done", value: stats.done, statuses: ["resolved", "reverted"] },
        { key: "dismissed", label: "Dismissed", value: stats.dismissed, statuses: ["dismissed"] },
    ];
    const parts = every.filter(
        (p) => p.value > 0 || ["open", "acknowledged", "resolved", "dismissed"].includes(p.key)
    );
    const maxRoute = Math.max(1, ...stats.routes.map((r) => r.total));
    const maxPerson = Math.max(1, ...stats.people.map((p) => p.total));
    const maxSeverity = Math.max(1, ...Object.values(stats.severities));
    const inHand = s.acknowledged + s.variant_chosen + s.revert_requested;

    return (
        <div className="sheet">
            <div className="sheet-inner wide overview">
                {head}
                <div className="kpis">
                    <button
                        type="button"
                        className="kpi lead"
                        onClick={() => onShow({ status: TODO })}
                    >
                        <span className="kpi-label">To do</span>
                        <span className="kpi-value">{fmt(stats.todo)}</span>
                        <span className="kpi-note">{inHand ? `${fmt(inHand)} in hand` : ""}</span>
                    </button>
                    <button
                        type="button"
                        className="kpi"
                        onClick={() => onShow({ status: ["resolved", "reverted"] })}
                    >
                        <span className="kpi-label">Done</span>
                        <span className="kpi-value">{fmt(stats.done)}</span>
                        <span className="kpi-note" />
                    </button>
                    <div className="kpi">
                        <span className="kpi-label">Replies</span>
                        <span className="kpi-value">{fmt(stats.replies)}</span>
                        <span className="kpi-note" />
                    </div>
                    <div className="kpi">
                        <span className="kpi-label">Typical first reply</span>
                        <span className="kpi-value">
                            {stats.medianFirstReplyMs === null
                                ? "–"
                                : duration(stats.medianFirstReplyMs)}
                        </span>
                        <span className="kpi-note">median, where there is one</span>
                    </div>
                </div>

                <section className="block">
                    <h2>Where things stand</h2>
                    <div
                        className="stack"
                        role="img"
                        aria-label={parts
                            .map((p) => `${p.value} ${p.label.toLowerCase()}`)
                            .join(", ")}
                    >
                        {parts.map((p) =>
                            p.value ? (
                                <button
                                    key={p.key}
                                    type="button"
                                    className={`seg s-${p.key}`}
                                    style={{ flexGrow: p.value }}
                                    onClick={() => onShow({ status: p.statuses })}
                                    title={`${p.label}: ${p.value}`}
                                    aria-label={`Show ${p.label.toLowerCase()}`}
                                />
                            ) : null
                        )}
                    </div>
                    <ul className="legend">
                        {parts.map((p) => (
                            <li key={p.key}>
                                <button
                                    type="button"
                                    className="link"
                                    onClick={() => onShow({ status: p.statuses })}
                                >
                                    <span className={`swatch s-${p.key}`} />
                                    {p.label} <strong>{fmt(p.value)}</strong>
                                    <span className="muted">
                                        {Math.round((p.value / stats.total) * 100)}%
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>

                <PerDay perDay={stats.perDay} />

                <div className="two-col">
                    <section className="block">
                        <h2>Pages with the most to do</h2>
                        <ul className="rank">
                            {stats.routes.slice(0, RANKED).map((r) => (
                                <li key={r.key}>
                                    <button
                                        type="button"
                                        className="rank-row"
                                        onClick={() => onShow({ route: r.key })}
                                    >
                                        <code className="rank-name" title={r.key}>
                                            {r.key}
                                        </code>
                                        <span className="track">
                                            <span
                                                className="hbar"
                                                style={{ width: `${(r.todo / maxRoute) * 100}%` }}
                                            />
                                        </span>
                                        <span className="num">
                                            {fmt(r.todo)}
                                            <span className="muted">/{fmt(r.total)}</span>
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {stats.routes.length > RANKED ? (
                            <p className="muted small">
                                and {stats.routes.length - RANKED} more pages
                            </p>
                        ) : null}
                    </section>

                    <section className="block">
                        <h2>Who's giving feedback</h2>
                        <ul className="rank">
                            {stats.people.slice(0, RANKED).map((p) => {
                                const kind = p.agent ? "agent" : "human";
                                return (
                                    <li key={p.key}>
                                        <button
                                            type="button"
                                            className="rank-row person"
                                            title={`${fmt(p.todo)} still to do`}
                                            // Just this row's notes: by kind and name, or by kind and no name at all.
                                            onClick={() =>
                                                onShow({ author: kind, by: p.name ?? NO_NAME })
                                            }
                                        >
                                            <Avatar author={{ kind, name: p.name }} size={24} />
                                            <span className="rank-name">
                                                {p.name ?? (p.agent ? "Agent" : "No name given")}
                                            </span>
                                            <span className="track">
                                                <span
                                                    className="hbar ink"
                                                    style={{
                                                        width: `${(p.total / maxPerson) * 100}%`,
                                                    }}
                                                />
                                            </span>
                                            <span className="num">{fmt(p.total)}</span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>

                    <section className="block">
                        <h2>To do by severity</h2>
                        <ul className="rank">
                            {[...SEVERITIES, "none" as const].map((sev) => (
                                <li key={sev}>
                                    <button
                                        type="button"
                                        className="rank-row"
                                        disabled={sev === "none"}
                                        onClick={() =>
                                            sev !== "none" &&
                                            onShow({ status: TODO, severity: sev })
                                        }
                                    >
                                        <span className="rank-name">
                                            {sev === "none" ? (
                                                <span className="muted">No severity</span>
                                            ) : (
                                                <span className={`sev sev-${sev}`}>{sev}</span>
                                            )}
                                        </span>
                                        <span className="track">
                                            <span
                                                className="hbar"
                                                style={{
                                                    width: `${(stats.severities[sev] / maxSeverity) * 100}%`,
                                                }}
                                            />
                                        </span>
                                        <span className="num">{fmt(stats.severities[sev])}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                </div>
            </div>
        </div>
    );
}

/** New notes a day, as columns, with the numbers on hover and in a table for anyone who wants them. */
function PerDay({ perDay }: { perDay: Array<{ day: string; count: number }> }) {
    const [hover, setHover] = useState<number | null>(null);
    const [table, setTable] = useState(false);
    const max = Math.max(1, ...perDay.map((d) => d.count));
    const total = perDay.reduce((n, d) => n + d.count, 0);
    const shown = hover === null ? null : perDay[hover];
    // A clean top for the scale: the max rounded up to 1, 2 or 5 times a power of ten.
    const top = (() => {
        const p = 10 ** Math.floor(Math.log10(max));
        return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= max) ?? max;
    })();

    return (
        <section className="block">
            <div className="section-head">
                <h2>New notes, last {perDay.length} days</h2>
                <span className="muted">{fmt(total)} in total</span>
                <span className="grow" />
                <button
                    type="button"
                    className="link"
                    onClick={() => setTable(!table)}
                    aria-expanded={table}
                >
                    {table ? "Show chart" : "Show as table"}
                </button>
            </div>
            {table ? (
                <table className="day-table">
                    <thead>
                        <tr>
                            <th>Day</th>
                            <th className="num">New notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[...perDay].reverse().map((d) => (
                            <tr key={d.day}>
                                <td>{shortDay(d.day)}</td>
                                <td className="num">{d.count}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <div className="columns-chart">
                    <div className="y-axis" aria-hidden="true">
                        <span>{top}</span>
                        <span>0</span>
                    </div>
                    <div className="plot">
                        <span className="gridline" style={{ bottom: "100%" }} />
                        <span className="gridline" style={{ bottom: "50%" }} />
                        {perDay.map((d, i) => (
                            <button
                                key={d.day}
                                type="button"
                                className={hover === i ? "col on" : "col"}
                                onMouseEnter={() => setHover(i)}
                                onMouseLeave={() => setHover(null)}
                                onFocus={() => setHover(i)}
                                onBlur={() => setHover(null)}
                                aria-label={`${shortDay(d.day)}: ${d.count} new note${d.count === 1 ? "" : "s"}`}
                            >
                                <span
                                    className={d.count ? "col-bar" : "col-bar zero"}
                                    style={
                                        d.count
                                            ? { height: `${(d.count / top) * 100}%` }
                                            : undefined
                                    }
                                />
                            </button>
                        ))}
                        {shown && hover !== null ? (
                            <div
                                className="chart-tip"
                                // Beside the column, on whichever side keeps it inside the chart.
                                style={{
                                    left: `${((hover + 0.5) / perDay.length) * 100}%`,
                                    transform:
                                        hover >= perDay.length * 0.7
                                            ? "translateX(calc(-100% - 10px))"
                                            : hover < perDay.length * 0.3
                                              ? "translateX(10px)"
                                              : "translateX(-50%)",
                                }}
                                role="status"
                            >
                                <strong>{shown.count}</strong> new note
                                {shown.count === 1 ? "" : "s"}
                                <span className="muted">{shortDay(shown.day)}</span>
                            </div>
                        ) : null}
                    </div>
                    <div className="x-axis" aria-hidden="true">
                        <span>{shortDay(perDay[0]?.day ?? "")}</span>
                        <span>{shortDay(perDay[Math.floor(perDay.length / 2)]?.day ?? "")}</span>
                        <span>Today</span>
                    </div>
                </div>
            )}
        </section>
    );
}
