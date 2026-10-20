import type { Annotation } from "@notato/schema";
import { useState } from "react";
import { request } from "./api.ts";

type StoredAnnotation = { seq: number; annotation: Annotation };

export function RecoveryArchive({ projects }: { projects: { id: string; name: string }[] }) {
    const [project, setProject] = useState("");
    const [items, setItems] = useState<StoredAnnotation[]>([]);
    const [next, setNext] = useState<number | undefined>();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const load = async (id: string, after = 0) => {
        setBusy(true);
        setError("");
        try {
            const response = await request<{ items: StoredAnnotation[]; next?: number }>(
                `/billing/recovery/projects/${encodeURIComponent(id)}/notes?after=${after}`
            );
            setItems((old) => (after ? [...old, ...response.items] : response.items));
            setNext(response.next);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load feedback.");
        } finally {
            setBusy(false);
        }
    };
    return (
        <details className="plugin-panel">
            <summary>Read and export retained feedback</summary>
            <p>
                Your retained feedback is available to you as workspace owner while new capture and
                automation are paused.
            </p>
            <label>
                Project
                <select
                    value={project}
                    disabled={busy}
                    onChange={(e) => {
                        setProject(e.target.value);
                        setItems([]);
                        if (e.target.value) void load(e.target.value);
                    }}
                >
                    <option value="">Choose a project</option>
                    {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name}
                        </option>
                    ))}
                </select>
            </label>
            {project && (
                <p>
                    <a href={`/billing/recovery/projects/${encodeURIComponent(project)}/export`}>
                        Download project with images (.zip)
                    </a>
                </p>
            )}
            {error && (
                <p className="error" role="alert">
                    {error}
                </p>
            )}
            {items.map(({ annotation: n }) => (
                <details key={n.id}>
                    <summary>
                        {n.comment.slice(0, 120) || n.route} · {n.status}
                    </summary>
                    <p style={{ whiteSpace: "pre-wrap" }}>{n.comment}</p>
                    <p className="muted">{n.route}</p>
                    {n.thread.map((r) => (
                        <p key={r.id}>
                            {r.peopleOnly ? "Private reply: " : ""}
                            {r.body}
                        </p>
                    ))}
                    {n.screenshots?.full && (
                        <img
                            alt="Feedback capture"
                            style={{ maxWidth: "100%" }}
                            loading="lazy"
                            src={`/billing/recovery/assets/${n.screenshots.full.id}?project=${encodeURIComponent(project)}`}
                        />
                    )}
                </details>
            ))}
            {next !== undefined && (
                <button type="button" disabled={busy} onClick={() => void load(project, next)}>
                    Load more feedback
                </button>
            )}
        </details>
    );
}
