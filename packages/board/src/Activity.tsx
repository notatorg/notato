import { clip } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { type ReactNode, useMemo, useState } from "react";
import { activityOf, authorName, clock, dayLabel, lastSegment } from "./model.ts";
import { projectHref } from "./route.ts";
import { Avatar, Empty, Logo, Segmented, StatusDot, When } from "./ui.tsx";

/** How many entries the feed shows at first, and adds each time older ones are asked for. */
const PAGE = 100;

type Who = "" | "human" | "agent";

/** Everything said in the project, newest first, a day at a time. */
export function Activity({
    project,
    name,
    all,
    since,
    menu,
}: {
    project: string;
    /** What the project is called. */
    name: string;
    all: Annotation[];
    since: string | null;
    menu: ReactNode;
}) {
    const [limit, setLimit] = useState(PAGE);
    const [who, setWho] = useState<Who>("");
    const items = useMemo(
        () =>
            activityOf(all).filter(
                (i) => !who || (i.reply ? i.reply.author.kind : i.annotation.author.kind) === who
            ),
        [all, who]
    );
    const days = useMemo(() => {
        const out: Array<{ label: string; items: typeof items }> = [];
        for (const item of items.slice(0, limit)) {
            const label = dayLabel(item.at);
            const last = out.at(-1);
            if (last?.label === label) last.items.push(item);
            else out.push({ label, items: [item] });
        }
        return out;
    }, [items, limit]);

    return (
        <div className="sheet">
            <div className="sheet-inner activity">
                <header className="sheet-head">
                    <div>
                        <h1>Activity</h1>
                        <p>Everything that happened in {name}</p>
                    </div>
                    <div className="sheet-tools">
                        <Segmented<Who>
                            label="Whose activity"
                            value={who}
                            onChange={setWho}
                            options={[
                                { id: "", label: "Everything" },
                                { id: "human", label: "People" },
                                { id: "agent", label: "Agents" },
                            ]}
                        />
                        {menu}
                    </div>
                </header>
                {all.length === 0 ? (
                    <Empty title="Nothing has happened here yet" logo={56}>
                        <p>Pinned notes and the replies to them show up here, newest first.</p>
                    </Empty>
                ) : days.length === 0 ? (
                    <div className="quiet">
                        <Logo size={40} />
                        Quiet in here. Nothing to show for this filter.
                    </div>
                ) : null}
                {days.map((day) => (
                    <section key={day.label} className="day">
                        <h2 className="day-head">{day.label}</h2>
                        <ol className="feed">
                            {day.items.map((item) => {
                                const a = item.annotation;
                                const author = item.reply ? item.reply.author : a.author;
                                const fresh =
                                    since !== null && Date.parse(item.at) > Date.parse(since);
                                return (
                                    <li
                                        key={item.key}
                                        className={fresh ? "feed-item fresh" : "feed-item"}
                                    >
                                        <a
                                            href={projectHref(project, "inbox", a.id)}
                                            className="feed-link"
                                        >
                                            <Avatar author={author} size={30} />
                                            <div className="feed-main">
                                                <div className="feed-line">
                                                    <strong>{authorName(author)}</strong>{" "}
                                                    <span className="muted">
                                                        {item.kind === "created"
                                                            ? "pinned a note on"
                                                            : item.kind === "automatic"
                                                              ? "updated"
                                                              : "replied on"}
                                                    </span>{" "}
                                                    <span
                                                        className="feed-target"
                                                        title={
                                                            item.kind === "created"
                                                                ? a.route
                                                                : a.comment
                                                        }
                                                    >
                                                        {item.kind === "created"
                                                            ? lastSegment(a.route)
                                                            : clip(a.comment, 70)}
                                                    </span>
                                                    {fresh ? (
                                                        <span
                                                            className="unseen"
                                                            title="New since you last looked"
                                                        />
                                                    ) : null}
                                                </div>
                                                <p className="feed-text">
                                                    <StatusDot status={a.status} label />
                                                    <span className="feed-body">
                                                        {item.kind === "created"
                                                            ? a.comment
                                                            : (item.reply?.body ?? "")}
                                                    </span>
                                                </p>
                                            </div>
                                            <When iso={item.at}>{clock(item.at)}</When>
                                        </a>
                                    </li>
                                );
                            })}
                        </ol>
                    </section>
                ))}
                {items.length > limit ? (
                    <button type="button" className="more" onClick={() => setLimit(limit + PAGE)}>
                        Show older ({items.length - limit} more)
                    </button>
                ) : null}
            </div>
        </div>
    );
}
