import { KEYS, type ProjectSummary, projectHref, remembered, teamRequest } from "@notato/board";
import { useEffect, useState } from "react";
import { PageRedirect } from "./Layout.tsx";

/** Saved workspace-wide links resolve to the same review in its project. */
export function LegacyReviews({
    selected = "",
    projects,
}: {
    selected?: string;
    projects: ProjectSummary[] | null;
}) {
    const [target, setTarget] = useState("");
    const [error, setError] = useState("");
    useEffect(() => {
        let active = true;
        if (!selected) return;
        setTarget("");
        setError("");
        teamRequest<{ work: { id: string; projectId: string } }>(
            `/pull-request-reviews/${encodeURIComponent(selected)}`
        ).then(
            ({ work }) => {
                if (active)
                    setTarget(projectHref(work.projectId, "sessions", `pull-request/${work.id}`));
            },
            (reason: Error) => {
                if (active) setError(reason.message);
            }
        );
        return () => {
            active = false;
        };
    }, [selected]);
    if (error)
        return (
            <div className="sheet">
                <div className="sheet-inner">
                    <h1>Review unavailable</h1>
                    <p className="error" role="alert">
                        {error}
                    </p>
                    <a href="#/">Back to projects</a>
                </div>
            </div>
        );
    if (selected)
        return target ? (
            <PageRedirect to={target} />
        ) : (
            <p className="center muted">Opening review…</p>
        );
    if (!projects) return <p className="center muted">Opening reviews…</p>;
    const previous = remembered<string>(KEYS.project, null, "");
    const project = projects.find((item) => item.id === previous)?.id ?? projects[0]?.id;
    return <PageRedirect to={project ? projectHref(project, "sessions") : "#/"} />;
}
