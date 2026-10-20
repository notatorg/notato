import { useState } from "react";
import { projectHref } from "./route.ts";
import { Icon, Segmented } from "./ui.tsx";

/** Both review workflows share a list, while their own pages retain their permissions and actions. */
export interface ReviewListItem {
    id: string;
    projectId: string;
    kind: "session" | "pull-request";
    name: string;
    description?: string;
    createdAt: string;
    createdBy?: string;
    visibility: "personal" | "shared";
    closed: boolean;
    status?: string;
    context?: string;
}

export function filterReviews(
    items: ReviewListItem[],
    project: string,
    actor: string,
    kind = "all",
    scope = "all"
) {
    return items
        .filter(
            (item) =>
                item.projectId === project &&
                (item.visibility !== "personal" || item.createdBy === actor) &&
                (kind === "all" || item.kind === kind) &&
                (scope === "all" ||
                    (scope === "mine" ? item.createdBy === actor : item.visibility === "shared"))
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function ReviewsList({
    items,
    project,
    actor,
    pullRequests,
    loading,
}: {
    items: ReviewListItem[];
    project: string;
    actor: string;
    pullRequests: boolean;
    loading: boolean;
}) {
    const [kind, setKind] = useState("all");
    const [scope, setScope] = useState("all");
    const shown = filterReviews(items, project, actor, kind, scope);
    return (
        <>
            <div className="reviews-filters">
                {pullRequests ? (
                    <Segmented
                        label="Review type"
                        value={kind}
                        onChange={setKind}
                        options={[
                            { id: "all", label: "All reviews" },
                            { id: "session", label: "Testing sessions" },
                            { id: "pull-request", label: "Pull requests" },
                        ]}
                    />
                ) : (
                    <span className="muted small">Testing sessions</span>
                )}
                <label>
                    <span className="sr">Review visibility</span>
                    <select
                        aria-label="Review visibility"
                        value={scope}
                        onChange={(event) => setScope(event.target.value)}
                    >
                        <option value="all">All accessible</option>
                        <option value="mine">Created by me</option>
                        <option value="shared">Shared with project</option>
                    </select>
                </label>
            </div>
            {loading ? (
                <p className="muted" role="status">
                    Loading reviews…
                </p>
            ) : null}
            <div className="reviews-list">
                {shown.map((item) => (
                    <a
                        className="review-list-item"
                        key={`${item.kind}:${item.id}`}
                        href={projectHref(project, "sessions", `${item.kind}/${item.id}`)}
                    >
                        <span className="review-list-icon">
                            <Icon name={item.kind === "session" ? "chat" : "file"} size={19} />
                        </span>
                        <div className="review-list-main">
                            <div className="review-list-meta">
                                <span className="tag">
                                    {item.kind === "session" ? "Testing session" : "Pull request"}
                                </span>
                                <span>{item.visibility === "personal" ? "Mine" : "Shared"}</span>
                                {item.context && <span>{item.context}</span>}
                            </div>
                            <h2>{item.name}</h2>
                            {item.description && <p>{item.description}</p>}
                        </div>
                        <span className="review-list-status">
                            {item.status ?? (item.closed ? "Closed" : "Open")}
                        </span>
                        <Icon name="back" className="review-list-arrow" size={15} />
                    </a>
                ))}
            </div>
            {!loading && !shown.length ? (
                <div className="reviews-empty">
                    <Icon name="chat" size={26} />
                    <h2>
                        {items.length
                            ? "No reviews match these filters"
                            : "Ready for your first review"}
                    </h2>
                    <p>
                        {items.length
                            ? "Try another review type or visibility."
                            : pullRequests
                              ? "Start a testing session to gather feedback, or review a pull request’s running preview."
                              : "Start a testing session to gather related feedback for your coding agent."}
                    </p>
                </div>
            ) : null}
        </>
    );
}
