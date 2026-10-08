import { clip, pinNumber } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { useEffect, useId, useState } from "react";
import {
    isStale,
    listAnnotations,
    type Preview,
    type ProjectSummary,
    previewWebhook,
    type TestResult,
    testWebhook,
    type WebhookDraft,
    type WebhookView,
} from "./api.ts";
import { byActivity } from "./model.ts";
import { Modal } from "./ui.tsx";
import { eventLabel, orderEvents } from "./webhook-form.ts";

interface Props {
    /** The webhook as the form or the list has it. */
    hook: WebhookDraft;
    /** The saved webhook it is, which supplies the URL and secret the board cannot see. */
    existing?: WebhookView;
    projects: ProjectSummary[];
    events: string[];
    /** "Close" from the list, "Back" from the form. */
    closeLabel: string;
    onClose(): void;
    /** The webhook changed elsewhere since this was opened. */
    onStale(message: string): void;
}

/**
 * Choose an event and a note, see the message exactly as it would go out, and send that one. Renders its own body,
 * status line and buttons, so it can stand in for a dialog's.
 */
export function TestPanel({
    hook,
    existing,
    projects,
    events,
    closeLabel,
    onClose,
    onStale,
}: Props) {
    const id = useId();
    const [event, setEvent] = useState(() => hook.events?.[0] ?? "annotation.created");
    /** The webhook's own project, or else the one with the newest activity. */
    const [project, setProject] = useState(
        () => hook.project || [...projects].sort(byActivity)[0]?.id || ""
    );
    const [notes, setNotes] = useState<Annotation[] | null>(null);
    /** "" is the made-up note. */
    const [annotationId, setAnnotationId] = useState("");
    const [preview, setPreview] = useState<Preview | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [result, setResult] = useState<TestResult | "sending" | null>(null);

    // The project's notes, newest first; the newest one with a screenshot is chosen, since that is what is worth seeing.
    useEffect(() => {
        if (!project) {
            setNotes([]);
            return;
        }
        let live = true;
        setNotes(null);
        listAnnotations(project).then(
            (all) => {
                if (!live) return;
                const newest = [...all]
                    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
                    .slice(0, 50);
                setNotes(newest);
                setAnnotationId((newest.find((a) => a.screenshots) ?? newest[0])?.id ?? "");
            },
            () => live && setNotes([])
        );
        return () => {
            live = false;
        };
    }, [project]);

    const subject = { event, annotationId: annotationId || undefined };
    const key = JSON.stringify([hook, existing?.fingerprint, subject]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for everything the preview depends on
    useEffect(() => {
        if (notes === null) return;
        let live = true;
        setResult(null);
        previewWebhook(hook, existing, subject).then(
            (p) => {
                if (!live) return;
                setPreview(p);
                setProblem(null);
            },
            (e: Error) => {
                if (!live) return;
                if (isStale(e)) onStale(e.message);
                else {
                    setPreview(null);
                    setProblem(e.message);
                }
            }
        );
        return () => {
            live = false;
        };
    }, [key, notes === null]);

    const send = async () => {
        setResult("sending");
        try {
            setResult(await testWebhook(hook, existing, subject));
        } catch (e) {
            if (isStale(e)) return onStale((e as Error).message);
            setResult({
                ok: false,
                ms: 0,
                detail: e instanceof Error ? e.message : "Could not send.",
            });
        }
    };

    return (
        <>
            <div className="modal-body test-panel">
                <div className="test-pick">
                    <label className="field">
                        <span>Event</span>
                        <select value={event} onChange={(e) => setEvent(e.target.value)}>
                            {orderEvents(events).map((e) => (
                                <option key={e} value={e}>
                                    {eventLabel(e)}
                                </option>
                            ))}
                        </select>
                    </label>
                    {hook.project ? null : (
                        <label className="field">
                            <span>Project</span>
                            <select value={project} onChange={(e) => setProject(e.target.value)}>
                                {projects.length === 0 ? (
                                    <option value="">No projects yet</option>
                                ) : null}
                                {projects.map((p) => (
                                    <option key={p.id}>{p.id}</option>
                                ))}
                            </select>
                        </label>
                    )}
                    <label className="field note-pick" htmlFor={`${id}-note`}>
                        <span>Note</span>
                        <select
                            id={`${id}-note`}
                            value={annotationId}
                            disabled={notes === null}
                            onChange={(e) => setAnnotationId(e.target.value)}
                        >
                            <option value="">A made-up note</option>
                            {(notes ?? []).map((a) => {
                                const pin = pinNumber(a);
                                return (
                                    <option key={a.id} value={a.id}>
                                        {pin ? `#${pin} · ` : ""}
                                        {clip(a.comment, 70)}
                                        {a.screenshots ? "" : " (no screenshot)"}
                                    </option>
                                );
                            })}
                        </select>
                    </label>
                </div>

                <div className="preview-frame" aria-live="polite">
                    {problem ? (
                        <p className="error small">{problem}</p>
                    ) : !preview ? (
                        <p className="muted small">Preparing the preview…</p>
                    ) : (
                        <>
                            <p className="preview-to muted small">
                                {preview.format === "json" ? "POST" : "Posts"} to{" "}
                                <code className="preview-url">{preview.url}</code>
                            </p>
                            <MessagePreview preview={preview} />
                        </>
                    )}
                </div>
                {preview?.notes.length ? (
                    <ul className="preview-notes">
                        {preview.notes.map((n) => (
                            <li key={n}>{n}</li>
                        ))}
                    </ul>
                ) : null}
            </div>

            {result ? (
                <div className="modal-status">
                    <TestLine result={result} />
                </div>
            ) : null}

            <footer className="modal-foot">
                <button type="button" onClick={onClose}>
                    {closeLabel}
                </button>
                <span className="grow" />
                <button
                    type="button"
                    className="primary"
                    disabled={!preview || result === "sending"}
                    onClick={send}
                    title="Sends exactly the message shown"
                >
                    {result === "sending" ? "Sending…" : "Send this test"}
                </button>
            </footer>
        </>
    );
}

function MessagePreview({ preview }: { preview: Preview }) {
    const body = preview.body as Record<string, unknown>;
    if (preview.format === "teams") {
        const card = (body.attachments as Array<{ content: Card }> | undefined)?.[0]?.content;
        return card ? <CardPreview card={card} images={preview.images} /> : null;
    }
    if (preview.format === "slack" || preview.format === "discord") {
        const text = String(body.text ?? body.content ?? "");
        return (
            <div className="chat-preview">
                <span className="chat-avatar" aria-hidden="true">
                    N
                </span>
                <div>
                    <strong>Notato</strong>
                    <p className="chat-text">{text}</p>
                </div>
            </div>
        );
    }
    return (
        <details className="json-preview" open>
            <summary>
                JSON body <span className="muted">· headers below</span>
            </summary>
            <pre>{JSON.stringify(body, null, 2)}</pre>
            <pre className="headers">
                {Object.entries(preview.headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n")}
            </pre>
        </details>
    );
}

/** The test panel on its own, for a saved webhook's Test button. */
export function TestDialog({
    webhook,
    projects,
    events,
    onClose,
    onStale,
}: {
    webhook: WebhookView;
    projects: ProjectSummary[];
    events: string[];
    onClose(): void;
    onStale(message: string): void;
}) {
    // What the saved webhook is; the URL and any secret stay on the server and are filled in there.
    const hook: WebhookDraft = {
        format: webhook.format,
        name: webhook.name,
        project: webhook.project,
        events: webhook.events,
        screenshots: webhook.screenshots,
    };
    return (
        <Modal title={`Test ${webhook.name ?? webhook.host}`} size="wide" onClose={onClose}>
            <TestPanel
                hook={hook}
                existing={webhook}
                projects={projects}
                events={events}
                closeLabel="Close"
                onClose={onClose}
                onStale={onStale}
            />
        </Modal>
    );
}

// ---- an Adaptive Card, drawn the way Teams draws the parts Notato's cards use ---------------------------------

interface Element {
    type: string;
    text?: string;
    size?: string;
    weight?: string;
    isSubtle?: boolean;
    style?: string;
    items?: Element[];
    facts?: Array<{ title: string; value: string }>;
    url?: string;
    altText?: string;
}
interface Card {
    body?: Element[];
    actions?: Array<{ type: string; title?: string; url?: string }>;
}

/** Card elements have no ids; what they say and where they sit tells them apart. */
const elementKey = (el: Element, at: number) => `${at}:${el.type}:${el.text ?? el.url ?? ""}`;

function CardPreview({ card, images }: { card: Card; images: Record<string, string> }) {
    return (
        <div className="ac-card">
            {(card.body ?? []).map((el, at) => (
                <CardElement key={elementKey(el, at)} el={el} images={images} />
            ))}
            {card.actions?.length ? (
                <div className="ac-actions">
                    {card.actions.map((a) => (
                        <a
                            key={a.title}
                            className="ac-action"
                            href={a.url}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            {a.title}
                        </a>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function CardElement({ el, images }: { el: Element; images: Record<string, string> }) {
    switch (el.type) {
        case "TextBlock":
            return (
                <p
                    className={[
                        "ac-text",
                        el.size === "Medium" ? "ac-medium" : el.size === "Small" ? "ac-small" : "",
                        el.weight === "Bolder" ? "ac-bold" : "",
                        el.isSubtle ? "ac-subtle" : "",
                    ].join(" ")}
                >
                    {el.text}
                </p>
            );
        case "Container":
            return (
                <div
                    className={
                        el.style === "emphasis" ? "ac-container ac-emphasis" : "ac-container"
                    }
                >
                    {(el.items ?? []).map((item, at) => (
                        <CardElement key={elementKey(item, at)} el={item} images={images} />
                    ))}
                </div>
            );
        case "FactSet":
            return (
                <dl className="ac-facts">
                    {(el.facts ?? []).map((f) => (
                        <div key={f.title} className="ac-fact">
                            <dt>{f.title}</dt>
                            <dd>{f.value}</dd>
                        </div>
                    ))}
                </dl>
            );
        case "Image": {
            const local = el.url ? images[el.url] : undefined;
            return local ? (
                <img className="ac-image" src={local} alt={el.altText ?? ""} />
            ) : (
                <p className="ac-text ac-subtle">[image]</p>
            );
        }
        default:
            return null;
    }
}

function TestLine({ result }: { result: TestResult | "sending" }) {
    if (result === "sending") return <p className="test-line muted small">Sending…</p>;
    return (
        <div className={result.ok ? "test-line ok" : "test-line bad"} role="status">
            <span className="test-mark" aria-hidden="true">
                {result.ok ? "✓" : "✕"}
            </span>
            <span>
                {result.ok ? "Delivered" : "Not delivered"}
                {result.status ? ` · HTTP ${result.status}` : ""}
                {result.ms ? ` · ${result.ms} ms` : ""}
                {result.ok ? "" : ` · ${result.detail}`}
                {result.response ? <code className="test-response">{result.response}</code> : null}
            </span>
        </div>
    );
}
