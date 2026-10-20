import type { Annotation, Reply } from "@notato/schema";
import { useCallback, useEffect, useState } from "react";
import { ApiError, json, type Me, request } from "./api.ts";
import { useBoardExtension } from "./extension.tsx";
import { type ReviewListItem, ReviewsList } from "./ReviewsList.tsx";
import { go, projectHref } from "./route.ts";
import { copyText, Icon, Modal } from "./ui.tsx";

interface Session {
    id: string;
    projectId: string;
    createdBy: string;
    createdAt: string;
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
    projectName,
    me,
    selection,
    actor,
    annotations,
}: {
    project: string;
    projectName?: string;
    me: Me;
    selection?: string;
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
    const extension = useBoardExtension();
    const source = extension?.projectReviews;
    const extra = source && source.available?.(me) !== false ? source : undefined;
    const [additional, setAdditional] = useState<ReviewListItem[]>([]);
    const [additionalError, setAdditionalError] = useState("");
    const [loading, setLoading] = useState(true);
    const [additionalLoading, setAdditionalLoading] = useState(Boolean(extra));
    const [choosing, setChoosing] = useState(false);
    const back = projectHref(project, "sessions");
    const external = selection?.startsWith("pull-request/") || selection === "new/pull-request";
    useEffect(() => {
        if (external) return;
        const apply = () => {
            document.title = `${selected?.name ?? (selection === "new/session" ? "New testing session" : "Reviews")} · Notato`;
        };
        apply();
        const later = setTimeout(apply, 250);
        return () => {
            clearTimeout(later);
            document.title = `${projectName ?? project} · Notato`;
        };
    }, [external, selected?.name, selection, projectName, project]);
    const loadAdditional = useCallback(async () => {
        if (!extra) return;
        try {
            setAdditional(await extra.load(project));
            setAdditionalError("");
        } catch (reason) {
            setAdditionalError(
                reason instanceof Error ? reason.message : "Could not load pull-request reviews."
            );
        } finally {
            setAdditionalLoading(false);
        }
    }, [extra, project]);
    const path = "/projects/" + encodeURIComponent(project) + "/review-sessions";
    const load = useCallback(
        () =>
            request<{ items: Session[] }>(path).then(
                (data) => {
                    setSessions(data.items);
                    setLoading(false);
                },
                (reason) => {
                    setLoading(false);
                    throw reason;
                }
            ),
        [path]
    );
    useEffect(() => {
        request<{ labels?: Record<string, { name: string }> }>(
            "/projects/" + encodeURIComponent(project) + "/members"
        ).then(
            (data) => setLabels(data.labels ?? {}),
            () => {}
        );
        if (selection) return;
        load().catch((e: Error) => setError(e.message));
        void loadAdditional();
        const timer = setInterval(() => {
            void load().catch(() => {});
            void loadAdditional();
        }, 5000);
        return () => clearInterval(timer);
    }, [project, load, loadAdditional, selection]);
    const open = useCallback(
        async (session: Session | string, current: () => boolean = () => true) => {
            const data = await request<{
                session: Session;
                items: Array<{ annotation: Annotation }>;
            }>(
                "/review-sessions/" +
                    encodeURIComponent(typeof session === "string" ? session : session.id)
            );
            if (!current()) return;
            if (data.session.projectId !== project)
                throw new Error("This testing session belongs to another project.");
            select(data.session);
            setNotes(data.items.map((item) => item.annotation));
            setName(data.session.name);
            setDescription(data.session.description ?? "");
            setVisibility(data.session.visibility);
            setBranch(data.session.branch ?? "");
            setEnvironment(data.session.environment ?? "");
            setChecked([]);
        },
        [project]
    );
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
    const create = useCallback(() => {
        setComposing(true);
        select(null);
        setName("");
        setDescription("");
        setVisibility("personal");
        setBranch("");
        setEnvironment("");
        setNotes([]);
    }, []);
    useEffect(() => {
        let active = true;
        select(null);
        setNotes([]);
        setComposing(false);
        setError("");
        if (selection === "new/session") create();
        else if (selection?.startsWith("session/")) {
            void open(selection.slice("session/".length), () => active).catch((reason: Error) => {
                if (active) setError(reason.message);
            });
        }
        return () => {
            active = false;
        };
    }, [selection, open, create]);
    if (external && extra) {
        return (
            <extra.Page
                key={`${project}:${selection}`}
                me={me}
                projectId={project}
                selected={
                    selection?.startsWith("pull-request/")
                        ? selection.slice("pull-request/".length)
                        : undefined
                }
                startNew={selection === "new/pull-request"}
            />
        );
    }
    return (
        <div className="sheet">
            <div
                className={selection ? "sheet-inner settings" : "sheet-inner settings reviews-page"}
            >
                <header className="sheet-head">
                    <div>
                        <h1>{selected?.name ?? (composing ? "New testing session" : "Reviews")}</h1>
                        <p>
                            {selection
                                ? "Testing session · Gather related feedback and hand it to your coding agent."
                                : extra
                                  ? "Testing sessions and pull-request feedback, together for this project."
                                  : "Gather feedback from testing passes and related changes in this project."}
                        </p>
                    </div>
                    {selection ? (
                        <a className="button-link" href={back}>
                            <Icon name="back" size={15} /> All reviews
                        </a>
                    ) : (
                        <button
                            type="button"
                            className="primary"
                            onClick={() =>
                                extra
                                    ? setChoosing(true)
                                    : go(projectHref(project, "sessions", "new/session"))
                            }
                        >
                            <Icon name="plus" size={16} /> New review
                        </button>
                    )}
                </header>
                {error ? (
                    <p className="error" role="alert">
                        {error}
                    </p>
                ) : null}
                {external && !extra ? (
                    <div className="banner bad" role="alert">
                        <span>
                            Pull-request reviews are not available for this account. Testing
                            sessions are available from All reviews.
                        </span>
                    </div>
                ) : null}
                {!selection ? (
                    <>
                        {additionalError ? (
                            <div className="banner bad" role="alert">
                                <span>
                                    Pull-request reviews could not be loaded. Testing sessions are
                                    still available.
                                </span>
                                <button
                                    type="button"
                                    className="link"
                                    onClick={() => void loadAdditional()}
                                >
                                    Retry
                                </button>
                            </div>
                        ) : null}
                        <ReviewsList
                            project={project}
                            actor={actor}
                            pullRequests={Boolean(extra)}
                            loading={loading || additionalLoading}
                            items={[
                                ...sessions.map(
                                    (session): ReviewListItem => ({
                                        ...session,
                                        kind: "session",
                                        context: [session.branch, session.environment]
                                            .filter(Boolean)
                                            .join(" · "),
                                    })
                                ),
                                ...(extra ? additional : []),
                            ]}
                        />
                        <p className="muted small reviews-handoff">
                            Want a particular developer’s agent to take a review?{" "}
                            <a href={projectHref(project, "team")}>Assignments</a> are optional.
                        </p>
                    </>
                ) : null}
                {selection?.startsWith("session/") && !selected && !error ? (
                    <p className="muted" role="status">
                        Loading testing session…
                    </p>
                ) : null}
                {choosing ? (
                    <Modal title="New review" onClose={() => setChoosing(false)}>
                        <div className="modal-body review-type-options">
                            <p>What would you like to review?</p>
                            <button
                                type="button"
                                className="review-type-choice"
                                onClick={() => {
                                    setChoosing(false);
                                    go(projectHref(project, "sessions", "new/session"));
                                }}
                            >
                                <Icon name="chat" size={22} />
                                <span>
                                    <strong>Testing session</strong>
                                    <span>
                                        Gather feedback from a testing pass or a set of related
                                        changes.
                                    </span>
                                </span>
                            </button>
                            <button
                                type="button"
                                className="review-type-choice"
                                onClick={() => {
                                    setChoosing(false);
                                    go(projectHref(project, "sessions", "new/pull-request"));
                                }}
                            >
                                <Icon name="file" size={22} />
                                <span>
                                    <strong>Pull request</strong>
                                    <span>
                                        Review a GitHub pull request’s running preview and keep
                                        feedback tied to its commit.
                                    </span>
                                </span>
                            </button>
                        </div>
                    </Modal>
                ) : null}
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
                                go(projectHref(project, "sessions", `session/${data.session.id}`));
                            });
                        }}
                    >
                        <section className="set-section">
                            <div className="set-label">
                                <h2>{selected ? "Session details" : "Testing session details"}</h2>
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
