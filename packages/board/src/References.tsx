import type { Annotation } from "@notato/schema";
import { useState } from "react";
import { assetHref } from "./api.ts";
import { Modal } from "./ui.tsx";

export function References({ annotation }: { annotation: Annotation }) {
    const [selected, select] = useState<string | null>(null);
    const ref = annotation.references?.find((r) => r.id === selected);
    if (!annotation.references?.length) return null;
    return (
        <section className="reference-images">
            <h3>Design references</h3>
            <div className="reference-grid">
                {annotation.references
                    .filter((r, i, all) => all.findIndex((item) => item.id === r.id) === i)
                    .map((r) => (
                        <button
                            key={r.id}
                            type="button"
                            className="shot"
                            onClick={() => select(r.id)}
                            aria-label={`Enlarge reference: ${r.name}`}
                        >
                            <img src={assetHref(r.id)} alt={r.name} loading="lazy" />
                            <span>{r.name}</span>
                        </button>
                    ))}
            </div>
            {ref ? (
                <Modal title={ref.name} onClose={() => select(null)}>
                    <img className="reference-full" src={assetHref(ref.id)} alt={ref.name} />
                </Modal>
            ) : null}
        </section>
    );
}
