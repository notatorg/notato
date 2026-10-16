import type { Annotation } from "@notato/schema";
import { useEffect, useState } from "react";
import { request } from "./api.ts";
import { projectHref } from "./route.ts";

export function Review({ annotation: a }: { annotation: Annotation }) {
    const [items, setItems] = useState<Annotation[]>([]);
    const [error, setError] = useState("");
    const id = a.review?.id;
    useEffect(() => {
        if (!id) return;
        const controller = new AbortController();
        setItems([]);
        setError("");
        void request<{ items: Array<{ annotation: Annotation }> }>(
            `/projects/${encodeURIComponent(a.projectId)}/annotations?review=${encodeURIComponent(id)}&limit=50&fields=summary`,
            { signal: controller.signal }
        )
            .then((result) => setItems(result.items.map((i) => i.annotation)))
            .catch((e: unknown) => {
                if (!controller.signal.aborted)
                    setError(e instanceof Error ? e.message : "Could not load the review.");
            });
        return () => controller.abort();
    }, [id, a.projectId]);
    if (!a.review) return null;
    return (
        <section className="review-summary">
            <h3>Grouped review</h3>
            <p>{a.review.instruction}</p>
            <p className="muted">
                {items.length} of {a.review.total ?? items.length} related targets
            </p>
            {error ? (
                <p role="alert">{error}</p>
            ) : (
                <ul>
                    {items.map((item) => (
                        <li key={item.id}>
                            {item.id === a.id ? (
                                <strong>
                                    {item.route} · {item.comment}
                                </strong>
                            ) : (
                                <a href={projectHref(a.projectId, "inbox", item.id)}>
                                    {item.route} · {item.comment}
                                </a>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
