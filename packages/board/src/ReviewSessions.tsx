import type { Annotation, Reply } from "@notato/schema";
import { useCallback, useEffect, useState } from "react";
import { ApiError, json, request } from "./api.ts";
import { projectHref } from "./route.ts";
import { copyText } from "./ui.tsx";

interface Session {
    id: string;
    projectId: string;
    createdBy: string;
    name: string;
    description?: string;
    visibility: "personal" | "shared";
    branch?: string;
    environment?: string;
    closed: boolean;
    thread: Reply[];
}
export function ReviewSessions({
    project,
    actor,
    annotations,
}: {
    project: string;
    actor: string;
    annotations: Annotation[];
}) {
    const [labels, setLabels] = useState<Record<string, { name: string }>>({});
    const [sessions, setSessions] = useState<Session[]>([]);
    const [selected, select] = useState<Session | null>(null);
    /** The form is for starting a session or editing the open one, not always on screen. */
    const [composing, setComposing] = useState(false);
    const [notes, setNotes] = useState<Annotation[]>([]);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [visibility, setVisibility] = useState<"personal" | "shared">("personal");
    const [branch, setBranch] = useState("");
    const [environment, setEnvironment] = useState("");
    const [message, setMessage] = useState("");
    const [checked, setChecked] = useState<string[]>([]);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [scope, setScope] = useState("all");
    const path = "/projects/" + encodeURIComponent(project) + "/review-sessions";
    const load = useCallback(
        () => request<{ items: Session[] }>(path).then((data) => setSessions(data.items)),
        [path]
    );
    useEffect(() => {
        select(null);
        setNotes([]);
        load().catch((e: Error) => setError(e.message));
        request<{ labels?: Record<string, { name: string }> }>(
            "/projects/" + encodeURIComponent(project) + "/members"
        ).then(
            (data) => setLabels(data.labels ?? {}),
            () => {}
        );
        const timer = setInterval(() => {
            void load().catch(() => {});
        }, 5000);
        return () => clearInterval(timer);
    }, [project, load]);
    const open = async (session: Session) => {
        const data = await request<{ session: Session; items: Array<{ annotation: Annotation }> }>(
            "/review-sessions/" + session.id
        );
        select(data.session);
        setNotes(data.items.map((item) => item.annotation));
        setName(data.session.name);
        setDescription(data.session.description ?? "");
        setVisibility(data.session.visibility);
        setBranch(data.session.branch ?? "");
        setEnvironment(data.session.environment ?? "");
        setChecked([]);
    };
    const selectedId = selected?.id;
    useEffect(() => {
        if (!selectedId) return;
        const id = selectedId;
        let active = true;
        const timer = setInterval(() => {
            request<{ session: Session; items: Array<{ annotation: Annotation }> }>(
                "/review-sessions/" + id
            ).then(
                (data) => {
                    if (!active) return;
                    select((current) => (current?.id === id ? data.session : current));
                    setNotes(data.items.map((item) => item.annotation));
                },
                (error: unknown) => {
                    if (
                        active &&
                        error instanceof ApiError &&
                        [401, 403, 404].includes(error.status)
                    ) {
                        select(null);
                        setNotes([]);
                        setName("");
                        setDescription("");
                        setMessage("");
                        setError("This session is no longer accessible.");
                    }
                }
            );
        }, 5000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [selectedId]);
    const run = async (work: () => Promise<unknown>) => {
        setBusy(true);
        setError("");
        try {
            await work();
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save.");
        } finally {
            setBusy(false);
        }
    };
    const create = () => {
        setComposing(true);
        select(null);
        setName("");
        setDescription("");
        setVisibility("personal");
        setBranch("");
        setEnvironment("");
        setNotes([]);
    };
    return (
        <div className="sheet">
            <div className="sheet-inner settings">
                <header className="sheet-head">
                    <div>
                        <h1>Review sessions</h1>
                        <p>
                            A review session is a group of shared feedback, such as a testing pass
                            or a batch of related fixes. Open one to hand it to your coding agent.
                        </p>
                    </div>
                    <button type="button" className="primary" onClick={create}>
                        New session
                    </button>
                </header>
                {error ? (
                    <p className="error" role="alert">
                        {error}
                    </p>
                ) : null}
                <section className="set-section">
                    <div className="set-label">
                        <h2>Sessions</h2>
                        <select
                            aria-label="Session visibility"
                            value={scope}
                            onChange={(e) => setScope(e.target.value)}
                        >
                            <option value="all">All accessible</option>
                            <option value="mine">Mine</option>
                            <option value="shared">Shared</option>
                        </select>
                    </div>
                    <div className="set-body">
                        {sessions
                            .filter(
                                (session) =>
                                    scope === "all" ||
                                    (scope === "mine"
                                        ? session.visibility === "personal" &&
                                          session.createdBy === actor
                                        : session.visibility === "shared")
                            )
                            .map((session) => (
                                <div className="setting-row" key={session.id}>
                                    <button
                                        type="button"
                                        className="ghost-button"
                                        onClick={() => void run(() => open(session))}
                                    >
                                        {session.name}
                                    </button>
                                    <span className="tag">
                                        {session.visibility === "personal" ? "Mine" : "Shared"}
                                        {session.closed ? " · Closed" : ""}
                                    </span>
                                </div>
                            ))}
                        {!sessions.length ? (
                            <p className="muted">
                                No sessions yet. A testing run creates one automatically when it
                                sends shared notes; or start your own to gather related feedback for
                                your agent.
                            </p>
                        ) : null}
                        <p className="muted small">
                            Want one particular developer's agent to take a review?{" "}
                            <a href={projectHref(project, "team")}>Assignments</a> (optional).
                        </p>
                    </div>
                </section>
                {composing || selected ? (
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            void run(async () => {
                                const data = await request<{ session: Session }>(
                                    selected ? "/review-sessions/" + selected.id : path,
                                    json(selected ? "PATCH" : "POST", {
                                        name,
                                        description,
                                        visibility,
                                        branch,
                                        environment,
                                    })
                                );
                                await open(data.session);
                            });
                        }}
                    >
                        <section className="set-section">
                            <div className="set-label">
                                <h2>{selected ? selected.name : "New review session"}</h2>
                                {selected ? (
                                    <p>
                                        {selected.createdBy === actor
                                            ? "You"
                                            : (labels[selected.createdBy]?.name ??
                                              "Project member")}{" "}
                                        ·{" "}
                                        {selected.visibility === "personal"
                                            ? "Only its creator can see this session."
                                            : "Visible to project members."}
                                    </p>
                                ) : null}
                            </div>
                            <div className="set-body">
                                <label className="field">
                                    Name
                                    <input
                                        required
                                        maxLength={120}
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        disabled={Boolean(selected && selected.createdBy !== actor)}
                                    />
                                </label>
                                <label className="field">
                                    What should the agent focus on? (optional)
                                    <textarea
                                        maxLength={4000}
                                        value={description}
                                        onChange={(e) => setDescription(e.target.value)}
                                        disabled={Boolean(selected && selected.createdBy !== actor)}
                                    />
                                </label>
                                <label className="field">
                                    Visibility
                                    <select
                                        value={visibility}
                                        onChange={(e) =>
                                            setVisibility(e.target.value as "personal" | "shared")
                                        }
                                        disabled={Boolean(selected && selected.createdBy !== actor)}
                                    >
                                        <option value="personal">Mine</option>
                                        <option value="shared">Shared with project</option>
                                    </select>
                                </label>
                                <details className="session-more">
                                    <summary>More details</summary>
                                    <label className="field">
                                        Branch
                                        <input
                                            value={branch}
                                            onChange={(e) => setBranch(e.target.value)}
                                            maxLength={200}
                                            disabled={Boolean(
                                                selected && selected.createdBy !== actor
                                            )}
                                        />
                                    </label>
                                    <label className="field">
                                        Environment
                                        <input
                                            value={environment}
                                            onChange={(e) => setEnvironment(e.target.value)}
                                            maxLength={200}
                                            disabled={Boolean(
                                                selected && selected.createdBy !== actor
                                            )}
                                        />
                                    </label>
                                </details>
                                {!selected || selected.createdBy === actor ? (
                                    <button type="submit" disabled={busy || !name.trim()}>
                                        Save session
                                    </button>
                                ) : null}
                            </div>
                        </section>
                    </form>
                ) : null}
                {selected ? (
                    <>
                        <section className="set-section">
                            <div className="set-label">
                                <h2>Feedback</h2>
                                <p>
                                    Sharing this session never shares personal annotations
                                    automatically.
                                </p>
                            </div>
                            <div className="set-body">
                                {notes.map((note) => (
                                    <p key={note.id}>
                                        <a href={projectHref(project, "inbox", note.id)}>
                                            {note.comment}
                                        </a>{" "}
                                        <span className="tag">{note.visibility ?? "shared"}</span>
                                    </p>
                                ))}
                                {selected.createdBy === actor && !selected.closed ? (
                                    <>
                                        <label className="field">
                                            Add accessible feedback
                                            <select
                                                multiple
                                                aria-label="Feedback to group"
                                                value={checked}
                                                onChange={(e) =>
                                                    setChecked(
                                                        Array.from(
                                                            e.target.selectedOptions,
                                                            (option) => option.value
                                                        )
                                                    )
                                                }
                                            >
                                                {annotations
                                                    .filter(
                                                        (note) =>
                                                            !notes.some(
                                                                (current) => current.id === note.id
                                                            )
                                                    )
                                                    .map((note) => (
                                                        <option key={note.id} value={note.id}>
                                                            {note.comment}
                                                        </option>
                                                    ))}
                                            </select>
                                        </label>
                                        <button
                                            type="button"
                                            disabled={busy || !checked.length}
                                            onClick={() =>
                                                void run(async () => {
                                                    await request(
                                                        "/review-sessions/" +
                                                            selected.id +
                                                            "/annotations",
                                                        json("POST", { ids: checked })
                                                    );
                                                    await open(selected);
                                                })
                                            }
                                        >
                                            Add selected feedback
                                        </button>
                                    </>
                                ) : null}
                                <button
                                    type="button"
                                    onClick={() =>
                                        void run(() =>
                                            copyText(
                                                "Work through Notato review session " +
                                                    selected.id +
                                                    ". Call notato_get_review_session with this id, read its focus and conversation, then work through only the accessible feedback in this session."
                                            )
                                        )
                                    }
                                >
                                    Copy agent handoff
                                </button>
                                {selected.createdBy === actor ? (
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() =>
                                            void run(async () => {
                                                const result = await request<{ session: Session }>(
                                                    "/review-sessions/" + selected.id,
                                                    json("PATCH", { closed: !selected.closed })
                                                );
                                                await open(result.session);
                                            })
                                        }
                                    >
                                        {selected.closed ? "Reopen session" : "Close session"}
                                    </button>
                                ) : null}
                            </div>
                        </section>
                        <section className="set-section">
                            <div className="set-label">
                                <h2>Conversation</h2>
                                <p>One discussion and shared focus for this group.</p>
                            </div>
                            <div className="set-body">
                                {selected.thread.map((reply) => (
                                    <div key={reply.id}>
                                        <strong>{reply.author.name ?? reply.author.kind}</strong>
                                        <p style={{ whiteSpace: "pre-wrap" }}>{reply.body}</p>
                                    </div>
                                ))}
                                <form
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        void run(async () => {
                                            const result = await request<{ session: Session }>(
                                                "/review-sessions/" + selected.id + "/replies",
                                                json("POST", { body: message })
                                            );
                                            select(result.session);
                                            setMessage("");
                                        });
                                    }}
                                >
                                    <label className="field">
                                        Message
                                        <textarea
                                            value={message}
                                            onChange={(e) => setMessage(e.target.value)}
                                            maxLength={8000}
                                        />
                                    </label>
                                    <button type="submit" disabled={busy || !message.trim()}>
                                        Send message
                                    </button>
                                </form>
                            </div>
                        </section>
                    </>
                ) : null}
            </div>
        </div>
    );
}
