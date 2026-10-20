import type { Annotation } from "@notato/schema";
import { useCallback, useEffect, useState } from "react";
import { isAdmin, type Me, request } from "./api.ts";
import { onLive } from "./live.ts";
import { projectHref } from "./route.ts";
import { copyText, Icon, Modal, StatusPill } from "./ui.tsx";
export interface Checkout {
    id: string;
    projectId: string;
    owner: string;
    name: string;
    branch?: string;
    archived: boolean;
    createdAt: string;
}
export interface ReviewWork {
    id: string;
    projectId: string;
    contextId: string | null;
    claim?: { session: string; version: number; expiresAt: number };
    resolution?: { branch: string; commit: string; at: string };
    pullRequest?: {
        repository: string;
        number: number;
        title: string;
        url: string;
        headSha: string;
        state: string;
        merged: boolean;
        previewUrl?: string;
    };
}
const key = (a: Annotation) => a.workId ?? `work:${a.projectId}:${a.review?.id ?? a.id}`;
export const teamRequest = <T,>(path: string, method = "GET", body?: unknown) =>
    request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const path = (project: string, suffix: string) =>
    `/projects/${encodeURIComponent(project)}/${suffix}`;
export function WorkAssignment({ annotation }: { annotation: Annotation }) {
    const [contexts, setContexts] = useState<Checkout[]>([]),
        [work, setWork] = useState<ReviewWork | null>(null),
        [selected, setSelected] = useState(""),
        [recover, setRecover] = useState(false),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(""),
        [available, setAvailable] = useState(false);
    const load = useCallback(
        () =>
            Promise.all([
                teamRequest<{ items: Checkout[] }>(path(annotation.projectId, "contexts")),
                teamRequest<ReviewWork | null>(
                    `/annotations/${encodeURIComponent(annotation.id)}/work`
                ),
            ]).then(([c, w]) => {
                setContexts(c.items.filter((c) => !c.archived));
                setWork(w);
                setSelected(w?.contextId ?? "");
                setAvailable(true);
            }),
        [annotation.id, annotation.projectId]
    );
    useEffect(() => {
        void load().catch(() => {});
        return onLive(
            (e) => {
                if (e.projectId === annotation.projectId) void load().catch(() => {});
            },
            () => {
                void load().catch(() => {});
            }
        );
    }, [load, annotation.projectId]);
    const assign = async () => {
        setBusy(true);
        setError("");
        try {
            await teamRequest(`/annotations/${encodeURIComponent(annotation.id)}/work`, "PUT", {
                contextId: selected || null,
                recover,
            });
            await load();
            setRecover(false);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };
    if (!available) return null;
    return (
        <section className="work-assignment">
            <div className="work-heading">
                <Icon name="users" />
                <strong>
                    {work?.pullRequest
                        ? `PR #${work.pullRequest.number} review`
                        : "Review ownership"}
                </strong>
                <span className="muted">{work?.contextId ? "Assigned" : "Shared inbox"}</span>
            </div>
            {work?.pullRequest ? (
                <a href={work.pullRequest.url} target="_blank" rel="noreferrer">
                    {work.pullRequest.title}
                </a>
            ) : null}
            <div className="work-actions">
                <select
                    aria-label="Assign review to a dev setup"
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                >
                    <option value="">Shared inbox · unassigned</option>
                    {contexts.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.name}
                            {c.branch ? ` · ${c.branch}` : ""}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className="tonal"
                    disabled={busy || contexts.length === 0}
                    onClick={() => void assign()}
                >
                    Assign review
                </button>
            </div>
            {work?.claim ? (
                <>
                    <p className="muted">
                        {work.claim.expiresAt > Date.now()
                            ? "An agent holds this review."
                            : "Agent lease expired. It may still be editing."}
                    </p>
                    <label>
                        <input
                            type="checkbox"
                            checked={recover}
                            onChange={(e) => setRecover(e.target.checked)}
                        />{" "}
                        I have checked that the previous agent stopped editing; recover this review.
                    </label>
                </>
            ) : null}
            {work?.resolution ? (
                <p className="muted">
                    Fixed on {work.resolution.branch} ·{" "}
                    <code>{work.resolution.commit.slice(0, 8)}</code>
                    {work.pullRequest?.merged
                        ? " · PR merged"
                        : " · verify on the preview before merging"}
                </p>
            ) : null}
            {error ? (
                <p role="alert" className="error">
                    {error}
                </p>
            ) : null}
        </section>
    );
}
export function Contexts({
    project,
    annotations,
    me,
}: {
    project: string;
    annotations: Annotation[];
    me: Me;
}) {
    const [contexts, setContexts] = useState<Checkout[]>([]),
        [works, setWorks] = useState<ReviewWork[]>([]),
        [name, setName] = useState(""),
        [branch, setBranch] = useState(""),
        [error, setError] = useState(""),
        [busy, setBusy] = useState(false),
        [filter, setFilter] = useState("shared");
    const [credentials, setCredentials] = useState<{
            context: Checkout;
            capture: { token: string };
            agent: { token: string };
            server: string;
            mcpUrl: string;
        } | null>(null),
        [copied, setCopied] = useState(false);
    const load = useCallback(
        () =>
            Promise.all([
                teamRequest<{ items: Checkout[] }>(path(project, "contexts")),
                teamRequest<{ items: ReviewWork[] }>(path(project, "work")),
            ]).then(([c, w]) => {
                setContexts(c.items);
                setWorks(w.items);
            }),
        [project]
    );
    useEffect(() => {
        void load().catch((e) => setError(e.message));
        return onLive(
            (e) => {
                if (e.projectId === project) void load().catch(() => {});
            },
            () => {
                void load().catch(() => {});
            }
        );
    }, [load, project]);
    const perform = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        setError("");
        try {
            await fn();
            await load();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };
    const active = contexts.filter((c) => !c.archived),
        workMap = new Map(works.map((w) => [w.id, w]));
    const groups = new Map<string, Annotation[]>();
    for (const a of annotations) {
        const id = key(a);
        groups.set(id, [...(groups.get(id) ?? []), a]);
    }
    const shown = [...groups.entries()].filter(
        ([id]) =>
            filter === "all" ||
            (filter === "shared"
                ? !workMap.get(id)?.contextId
                : workMap.get(id)?.contextId === filter)
    );
    return (
        <div className="sheet">
            <div className="sheet-inner wide team-page">
                <header className="sheet-head">
                    <div>
                        <h1>Assignments</h1>
                        <p>
                            Optional. Hand a shared review to one developer's agent, so only that
                            agent works on it, and see who is working on what.
                        </p>
                    </div>
                </header>
                <div className="banner" role="note">
                    <span>
                        <strong>Most teams do not need this page.</strong> Everyone connects with
                        their own tokens on the project's Connect page, what you capture while
                        building stays yours, and Reviews already groups shared feedback. Use
                        assignments when a particular developer's agent should take a shared review,
                        such as a pull request.
                    </span>
                </div>
                {error ? (
                    <p className="error" role="alert">
                        {error}
                    </p>
                ) : null}
                <details className="team-setup" open={active.length === 0}>
                    <summary>
                        {active.length
                            ? "Add a dev setup"
                            : "Add the first dev setup to start assigning"}
                    </summary>
                    <section className="team-intro">
                        <div>
                            <Icon name="users" />
                            <h2>Add a dev setup</h2>
                            <p>
                                A dev setup is one developer's app and coding agent on one machine
                                or branch. Name it and Notato makes two keys: one for the app, one
                                for the agent. Shared reviews can then be assigned to it, and one
                                agent reserves each review before editing it.
                            </p>
                            <p className="muted">
                                Everyone on the project can still see all of its feedback. Setups
                                only decide which agent is sent the work.
                            </p>
                        </div>
                        <form
                            onSubmit={(e) => {
                                e.preventDefault();
                                void perform(async () => {
                                    await teamRequest(path(project, "contexts"), "POST", {
                                        name,
                                        branch: branch || undefined,
                                    });
                                    setName("");
                                    setBranch("");
                                });
                            }}
                        >
                            <label>
                                Name this setup
                                <input
                                    required
                                    maxLength={120}
                                    placeholder="My laptop"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                />
                            </label>
                            <label>
                                Branch or worktree label
                                <input
                                    maxLength={200}
                                    placeholder="feature/pricing"
                                    value={branch}
                                    onChange={(e) => setBranch(e.target.value)}
                                />
                            </label>
                            <button disabled={busy} type="submit">
                                Connect this setup
                            </button>
                        </form>
                    </section>
                </details>
                <div className="checkout-grid">
                    {active.map((c) => (
                        <article className="checkout-card" key={c.id}>
                            <div className="work-heading">
                                <span className="checkout-dot" />
                                <strong>{c.name}</strong>
                                <span className="tag">
                                    {c.owner === (me.username ?? "local") ? "Yours" : "Teammate's"}
                                </span>
                            </div>
                            <p>
                                <code>{c.branch || "Branch not set"}</code>
                            </p>
                            <p className="muted">
                                {works.filter((w) => w.contextId === c.id).length} assigned{" "}
                                {works.filter((w) => w.contextId === c.id).length === 1
                                    ? "review"
                                    : "reviews"}
                            </p>
                            <div className="work-actions">
                                <button
                                    type="button"
                                    className="tonal"
                                    disabled={
                                        busy ||
                                        (!isAdmin(me) && c.owner !== (me.username ?? "local"))
                                    }
                                    onClick={() =>
                                        void perform(async () =>
                                            setCredentials(
                                                await teamRequest(
                                                    `/contexts/${c.id}/credentials`,
                                                    "POST",
                                                    {}
                                                )
                                            )
                                        )
                                    }
                                >
                                    Get keys
                                </button>
                                <button
                                    type="button"
                                    className="text-button"
                                    disabled={
                                        busy ||
                                        (!isAdmin(me) && c.owner !== (me.username ?? "local"))
                                    }
                                    onClick={() => {
                                        if (
                                            window.confirm(
                                                "Archive this setup? Its keys will stop working. Assigned work stays visible and can be recovered."
                                            )
                                        )
                                            void perform(() =>
                                                teamRequest(`/contexts/${c.id}`, "PATCH", {
                                                    archived: true,
                                                })
                                            );
                                    }}
                                >
                                    Archive
                                </button>
                            </div>
                        </article>
                    ))}
                </div>
                <section>
                    <div className="sheet-head">
                        <div>
                            <h2>Review queues</h2>
                            <p>
                                Shared feedback waits for assignment. Related targets move together.
                            </p>
                        </div>
                        <select
                            aria-label="Review queue"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        >
                            <option value="shared">Shared inbox</option>
                            <option value="all">All reviews</option>
                            {active.map((c) => (
                                <option key={c.id} value={c.id}>
                                    {c.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="team-reviews">
                        {shown.length ? (
                            shown.map(([id, notes]) => {
                                const a = notes[0]!,
                                    w = workMap.get(id);
                                return (
                                    <article className="team-review" key={id}>
                                        <div>
                                            <div className="work-heading">
                                                <StatusPill status={a.status} />
                                                <span className="muted">
                                                    {notes.length} target
                                                    {notes.length === 1 ? "" : "s"}
                                                    {w?.pullRequest
                                                        ? ` · PR #${w.pullRequest.number}`
                                                        : ""}
                                                </span>
                                            </div>
                                            <a href={projectHref(project, "inbox", a.id)}>
                                                <h3>
                                                    {a.review?.instruction ||
                                                        w?.pullRequest?.title ||
                                                        a.comment}
                                                </h3>
                                            </a>
                                            <p className="muted">
                                                {a.author.name || "Reviewer"} · {a.route}
                                            </p>
                                        </div>
                                        <span className="tag">
                                            {active.find((c) => c.id === w?.contextId)?.name ||
                                                "Unassigned"}
                                        </span>
                                    </article>
                                );
                            })
                        ) : (
                            <div className="team-empty">
                                <Icon name="check" />
                                <h3>This queue is clear</h3>
                                <p>Feedback for this queue will appear here.</p>
                            </div>
                        )}
                    </div>
                </section>
                {credentials ? (
                    <Modal
                        title={`Connect ${credentials.context.name}`}
                        onClose={() => setCredentials(null)}
                    >
                        <div className="modal-body">
                            <p>
                                These keys are shown once. The capture key goes in your app; the
                                agent key stays in your agent's environment.
                            </p>
                            <h3>1. App capture and feedback</h3>
                            <p>
                                Set <code>VITE_NOTATO_SERVER</code> to{" "}
                                <code>{credentials.server}</code> and pass your capture key as the
                                SDK's <code>token</code> option.
                            </p>
                            <button
                                type="button"
                                className="tonal"
                                onClick={() =>
                                    void copyText(credentials.capture.token).then(() =>
                                        setCopied(true)
                                    )
                                }
                            >
                                Copy capture key
                            </button>
                            <p className="muted">
                                The app key can read and reply to this setup's feedback. It cannot
                                connect to MCP or reach another setup.
                            </p>
                            <h3>2. Coding agent</h3>
                            <p>
                                Save the agent key as <code>NOTATO_AGENT_TOKEN</code>, then use this
                                MCP command:
                            </p>
                            <pre>
                                <code>{`npx notato dev --server ${credentials.server} --project ${project}`}</code>
                            </pre>
                            <button
                                type="button"
                                className="tonal"
                                onClick={() =>
                                    void copyText(credentials.agent.token).then(() =>
                                        setCopied(true)
                                    )
                                }
                            >
                                Copy agent key
                            </button>
                            {copied ? <p role="status">Copied. Keep keys out of Git.</p> : null}
                            <p className="muted">
                                Credentials expire in 90 days. Archiving this setup immediately
                                stops both connections.
                            </p>
                        </div>
                    </Modal>
                ) : null}
            </div>
        </div>
    );
}
