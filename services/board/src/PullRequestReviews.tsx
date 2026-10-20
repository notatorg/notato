import {
    type Checkout,
    copyText,
    Icon,
    type Me,
    Modal,
    onLive,
    projectHref,
    type ReviewWork,
    StatusPill,
    teamRequest,
} from "@notato/board";
import type { Annotation } from "@notato/schema";
import { useCallback, useEffect, useState } from "react";
import { usePageTitle } from "./Layout.tsx";
import { GuestNotice, RoleNote, whoIs } from "./Role.tsx";

// Types crossing this page are JSON only; server code is never imported at runtime.
type PRWork = ReviewWork & {
    createdAt: string;
    publication?: { status: "sending" | "sent" | "uncertain"; url?: string; error?: string };
    pullRequest: NonNullable<ReviewWork["pullRequest"]> & {
        connectionId: string;
        latestHeadSha?: string;
        checkedAt: string;
        /** Set when the preview address was found from a CI deployment rather than typed in. */
        previewSource?: "deployment";
        previewEnvironment?: string;
        /** A ready preview for a commit newer than the reviewed one. */
        latestPreview?: { sha: string; url: string; environment?: string };
    };
};
interface Catalog {
    items: PRWork[];
    connections: Array<{ id: string; name: string }>;
    projects: Array<{ id: string; name: string }>;
    /** True when GitHub App webhooks are configured: status and previews then arrive without a refresh. */
    automation?: { webhooks: boolean };
}
interface Detail {
    work: PRWork;
    notes: Array<{ annotation: Annotation }>;
    contexts: Checkout[];
    truncated: boolean;
}
interface Preview {
    text: string;
    hash: string;
    operation: string;
    count: number;
    excluded: number;
    commit: string;
}
export function PullRequestReviews({ me, selected = "" }: { me: Me; selected?: string }) {
    usePageTitle("Pull request reviews");
    const who = whoIs(me);
    const [catalog, setCatalog] = useState<Catalog | null>(null),
        [detail, setDetail] = useState<Detail | null>(null),
        [project, setProject] = useState(""),
        [connection, setConnection] = useState(""),
        [url, setUrl] = useState(""),
        [previewUrl, setPreviewUrl] = useState(""),
        [creating, setCreating] = useState(false),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(""),
        [notice, setNotice] = useState("");
    const [assignment, setAssignment] = useState(""),
        [recover, setRecover] = useState(false),
        [preview, setPreview] = useState<Preview | null>(null),
        [capture, setCapture] = useState<{
            token: string;
            server: string;
            projectId: string;
            expiresAt: string;
        } | null>(null);
    const load = useCallback(async () => {
        const c = await teamRequest<Catalog>("/pull-request-reviews");
        setCatalog(c);
        setProject((p) => p || c.projects[0]?.id || "");
        setConnection((v) => v || c.connections[0]?.id || "");
        if (selected) {
            const d = await teamRequest<Detail>(
                `/pull-request-reviews/${encodeURIComponent(selected)}`
            );
            setDetail(d);
            setAssignment(d.work.contextId ?? "");
        } else setDetail(null);
    }, [selected]);
    useEffect(() => {
        void load().catch((e) => setError(e.message));
    }, [load]);
    useEffect(() => {
        if (!selected) return;
        return onLive(
            () => {
                void teamRequest<Detail>(
                    `/pull-request-reviews/${encodeURIComponent(selected)}`
                ).then(setDetail, () => {});
            },
            () => {
                void load().catch(() => {});
            }
        );
    }, [selected, load]);
    const perform = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
            await fn();
            await load();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };
    const action = (name: string, method = "POST", body: unknown = {}) =>
        teamRequest(`/pull-request-reviews/${encodeURIComponent(selected)}/${name}`, method, body);
    const pr = detail?.work.pullRequest,
        changed = pr && pr.latestHeadSha && pr.latestHeadSha !== pr.headSha;
    if (who.guest) return <GuestNotice what="Pull request reviews" />;
    return (
        <div className="sheet">
            <div className="sheet-inner wide pr-page">
                <header className="sheet-head">
                    <div>
                        <h1>{pr ? pr.title : "Pull request reviews"}</h1>
                        <p>
                            {pr
                                ? `${pr.repository} · PR #${pr.number}`
                                : "Collect feedback on a pull request's running preview, keep it tied to the reviewed commit, and hand it to the right developer's agent."}
                        </p>
                    </div>
                    <div className="work-actions">
                        {selected ? (
                            <a className="button tonal" href="#/x/pr-reviews">
                                <Icon name="back" size={15} />
                                All reviews
                            </a>
                        ) : null}
                        <button type="button" onClick={() => setCreating(true)}>
                            <Icon name="plus" size={15} />
                            New PR review
                        </button>
                    </div>
                </header>
                {!selected ? (
                    <RoleNote
                        me={me}
                        can="connect GitHub and decide which repositories reviews can use"
                    >
                        You can start a review for a repository your admins have already set up
                        under Integrations, and work on any review you can open.
                    </RoleNote>
                ) : null}
                {error ? (
                    <div className="banner bad" role="alert">
                        <span>{error}</span>
                    </div>
                ) : null}
                {!selected && catalog && !catalog.connections.length ? (
                    <div className="banner" role="status">
                        <span>
                            Connect GitHub first. A review reads the pull request through a GitHub
                            connection: add one under <a href="#/x/plugins">Integrations</a>, then
                            come back here.
                        </span>
                    </div>
                ) : null}
                {notice ? (
                    <div className="banner ok" role="status">
                        <span>{notice}</span>
                    </div>
                ) : null}
                {!catalog ? (
                    <p className="muted">Loading PR reviews…</p>
                ) : !catalog.connections.length ? (
                    <section className="pr-empty">
                        <Icon name="link" />
                        <h2>Connect GitHub to start reviewing</h2>
                        <p>
                            A workspace connection reads the PR and publishes a summary only after
                            you approve its preview.
                        </p>
                        <a className="button" href="#/x/plugins">
                            Connect GitHub
                        </a>
                    </section>
                ) : null}
                {detail && pr ? (
                    <>
                        <section className="pr-summary">
                            <div>
                                <div className="work-heading">
                                    <span className="tag">
                                        {pr.merged
                                            ? "Merged"
                                            : pr.state === "closed"
                                              ? "Closed"
                                              : "Open PR"}
                                    </span>
                                    <span className="tag">
                                        {detail.work.contextId ? "Assigned" : "Shared inbox"}
                                    </span>
                                    <span className="muted">
                                        {detail.notes.length} feedback targets
                                    </span>
                                </div>
                                <p>
                                    Reviewed commit <code>{pr.headSha.slice(0, 8)}</code>
                                    {changed ? (
                                        <span className="pr-stale"> · PR has a newer commit</span>
                                    ) : null}
                                </p>
                                <div className="work-actions">
                                    <a href={pr.url} target="_blank" rel="noreferrer">
                                        Open pull request ↗
                                    </a>
                                    {pr.previewUrl ? (
                                        <a href={pr.previewUrl} target="_blank" rel="noreferrer">
                                            Open app preview ↗
                                        </a>
                                    ) : null}
                                    <button
                                        type="button"
                                        className="text-button"
                                        disabled={busy}
                                        onClick={() => void perform(() => action("refresh"))}
                                    >
                                        {catalog?.automation?.webhooks
                                            ? "Check GitHub now"
                                            : "Refresh PR status"}
                                    </button>
                                </div>
                                {pr.previewSource === "deployment" ? (
                                    <p className="muted">
                                        Preview address found from your CI deployment
                                        {pr.previewEnvironment ? ` (${pr.previewEnvironment})` : ""}
                                        .
                                    </p>
                                ) : null}
                                {catalog?.automation?.webhooks ? (
                                    <p className="muted">
                                        GitHub keeps this review's status and newest commit up to
                                        date.
                                    </p>
                                ) : null}
                                {changed ? (
                                    <p className="muted">
                                        These notes belong to the original reviewed commit. Start a
                                        new review for the latest preview; the history stays here.
                                    </p>
                                ) : null}
                                {changed && pr.latestPreview?.sha === pr.latestHeadSha ? (
                                    <p>
                                        A preview for the newest commit is ready.{" "}
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() =>
                                                void perform(async () => {
                                                    const w = await teamRequest<PRWork>(
                                                        "/pull-request-reviews",
                                                        "POST",
                                                        {
                                                            projectId: detail.work.projectId,
                                                            connectionId: pr.connectionId,
                                                            url: pr.url,
                                                            previewUrl: pr.latestPreview?.url,
                                                        }
                                                    );
                                                    window.location.hash = `#/x/pr-reviews/${w.id}`;
                                                })
                                            }
                                        >
                                            Start review for the latest commit
                                        </button>
                                    </p>
                                ) : null}
                            </div>
                            <div className="pr-capture">
                                <h3>Capture feedback on this PR</h3>
                                <p>
                                    Use the same SDK in your preview. Its capture key attaches notes
                                    to this review automatically.
                                </p>
                                <button
                                    type="button"
                                    className="tonal"
                                    disabled={busy}
                                    onClick={() =>
                                        void perform(async () =>
                                            setCapture(
                                                (await action("capture-key")) as typeof capture
                                            )
                                        )
                                    }
                                >
                                    Set up preview capture
                                </button>
                            </div>
                        </section>
                        {who.solo && !detail.work.contextId ? null : (
                            <details
                                className="pr-assignment pr-advanced"
                                open={Boolean(detail.work.contextId || detail.work.claim)}
                            >
                                <summary>
                                    {detail.work.contextId
                                        ? "Assigned to a dev setup"
                                        : "Hand this review to a developer's dev setup (optional)"}
                                </summary>
                                <div>
                                    <p className="muted">
                                        Every feedback target in this PR round follows the same
                                        assignment. The agent must check out the reviewed commit and
                                        reserve the review before editing.
                                    </p>
                                </div>
                                <div className="work-actions">
                                    <select
                                        aria-label="PR review dev setup"
                                        value={assignment}
                                        onChange={(e) => setAssignment(e.target.value)}
                                    >
                                        <option value="">Shared inbox · unassigned</option>
                                        {detail.contexts
                                            .filter((c) => !c.archived)
                                            .map((c) => (
                                                <option key={c.id} value={c.id}>
                                                    {c.name}
                                                    {c.branch ? ` · ${c.branch}` : ""}
                                                </option>
                                            ))}
                                    </select>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() =>
                                            void perform(() =>
                                                action("assign", "PUT", {
                                                    contextId: assignment || null,
                                                    recover,
                                                })
                                            )
                                        }
                                    >
                                        Assign review
                                    </button>
                                </div>
                                {detail.work.claim ? (
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={recover}
                                            onChange={(e) => setRecover(e.target.checked)}
                                        />{" "}
                                        I have checked that the previous agent stopped editing;
                                        recover its claim.
                                    </label>
                                ) : null}
                                <a href={projectHref(detail.work.projectId, "team")}>
                                    Manage dev setups on the Assignments page ↗
                                </a>
                            </details>
                        )}
                        <section>
                            <div className="sheet-head">
                                <div>
                                    <h2>Feedback on this preview</h2>
                                    <p>
                                        Open a target to see its screenshot, element and
                                        conversation.
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    className="tonal"
                                    disabled={busy || !detail.notes.length || !!changed}
                                    onClick={() =>
                                        void perform(async () =>
                                            setPreview((await action("preview")) as Preview)
                                        )
                                    }
                                >
                                    Preview GitHub summary
                                </button>
                            </div>
                            <div className="team-reviews">
                                {detail.notes.length ? (
                                    detail.notes.map(({ annotation: a }) => (
                                        <article className="team-review" key={a.id}>
                                            <div>
                                                <div className="work-heading">
                                                    <StatusPill status={a.status} />
                                                    <span className="muted">
                                                        {a.review ? "Grouped review" : "Feedback"}
                                                        {a.peopleOnly ? " · People only" : ""}
                                                    </span>
                                                </div>
                                                <a href={projectHref(a.projectId, "inbox", a.id)}>
                                                    <h3>{a.comment}</h3>
                                                </a>
                                                <p className="muted">
                                                    {a.route} · {a.author.name || "Reviewer"}
                                                </p>
                                            </div>
                                            {a.screenshots?.thumbnail ? (
                                                <img
                                                    className="pr-target-image"
                                                    alt="Captured feedback target"
                                                    src={`/assets/${a.screenshots.thumbnail.id}`}
                                                />
                                            ) : null}
                                        </article>
                                    ))
                                ) : (
                                    <div className="team-empty">
                                        <Icon name="chat" />
                                        <h3>Ready for the first review</h3>
                                        <p>
                                            Connect the preview, then pin feedback to the app. It
                                            will appear here.
                                        </p>
                                    </div>
                                )}
                            </div>
                            {detail.truncated ? (
                                <p>
                                    Showing the first 500 targets. Open the project inbox for the
                                    full history.
                                </p>
                            ) : null}
                        </section>
                        {detail.work.resolution ? (
                            <section className="pr-resolution">
                                <Icon name="check" />
                                <div>
                                    <h3>Fix recorded on {detail.work.resolution.branch}</h3>
                                    <p>
                                        <code>{detail.work.resolution.commit.slice(0, 12)}</code> ·{" "}
                                        {pr.merged ? "PR merged" : "Ready to verify on the preview"}
                                    </p>
                                </div>
                            </section>
                        ) : null}
                        {detail.work.publication ? (
                            <section className="pr-publication">
                                <h3>
                                    {detail.work.publication.status === "sent"
                                        ? "Summary published to GitHub"
                                        : "GitHub publication needs checking"}
                                </h3>
                                {detail.work.publication.url ? (
                                    <a
                                        href={detail.work.publication.url}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        Open published review ↗
                                    </a>
                                ) : (
                                    <>
                                        <p className="muted">
                                            A previous delivery may have completed. Check its result
                                            before sending again.
                                        </p>
                                        <button
                                            type="button"
                                            className="tonal"
                                            disabled={busy}
                                            onClick={() =>
                                                void perform(async () => {
                                                    const result = (await action("reconcile")) as {
                                                        found: boolean;
                                                        message?: string;
                                                    };
                                                    if (!result.found)
                                                        setNotice(
                                                            result.message ??
                                                                "Check GitHub directly."
                                                        );
                                                })
                                            }
                                        >
                                            Check publication
                                        </button>
                                    </>
                                )}
                            </section>
                        ) : null}
                    </>
                ) : null}
                {!selected && catalog?.items.length ? (
                    <div className="pr-list">
                        {catalog.items.map((w) => (
                            <a
                                key={w.id}
                                className="pr-review-card"
                                href={`#/x/pr-reviews/${encodeURIComponent(w.id)}`}
                            >
                                <div className="work-heading">
                                    <Icon name="file" />
                                    <strong>
                                        {w.pullRequest.repository} #{w.pullRequest.number}
                                    </strong>
                                    <span className="tag">
                                        {w.pullRequest.merged
                                            ? "Merged"
                                            : w.pullRequest.state === "closed"
                                              ? "Closed"
                                              : "Open"}
                                    </span>
                                </div>
                                <h2>{w.pullRequest.title}</h2>
                                <p className="muted">
                                    Reviewed {w.pullRequest.headSha.slice(0, 8)} ·{" "}
                                    {w.contextId ? "Assigned dev setup" : "Waiting for assignment"}
                                </p>
                                <span className="pr-open">Open review →</span>
                            </a>
                        ))}
                    </div>
                ) : !selected && catalog?.connections.length ? (
                    <div className="pr-empty">
                        <Icon name="file" />
                        <h2>Your next PR can start here</h2>
                        <p>
                            Connect a pull request, review its running preview, then hand the
                            feedback to a developer's dev setup.
                        </p>
                    </div>
                ) : null}
                {creating ? (
                    <Modal title="Start a pull request review" onClose={() => setCreating(false)}>
                        <form
                            className="modal-body pr-form"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void perform(async () => {
                                    const w = await teamRequest<PRWork>(
                                        "/pull-request-reviews",
                                        "POST",
                                        {
                                            projectId: project,
                                            connectionId: connection,
                                            url,
                                            previewUrl: previewUrl || undefined,
                                        }
                                    );
                                    setCreating(false);
                                    window.location.hash = `#/x/pr-reviews/${w.id}`;
                                });
                            }}
                        >
                            <p>
                                Notato reads the PR and keeps a review round tied to its current
                                head commit.
                            </p>
                            <label>
                                Notato project
                                <select
                                    required
                                    value={project}
                                    onChange={(e) => setProject(e.target.value)}
                                >
                                    {catalog?.projects.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                GitHub connection
                                <select
                                    required
                                    value={connection}
                                    onChange={(e) => setConnection(e.target.value)}
                                >
                                    {catalog?.connections.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                Pull request URL
                                <input
                                    type="url"
                                    required
                                    placeholder="https://github.com/your-team/app/pull/42"
                                    value={url}
                                    onChange={(e) => setUrl(e.target.value)}
                                />
                            </label>
                            <label>
                                Running preview URL{" "}
                                <span className="muted">
                                    optional
                                    {catalog?.automation?.webhooks
                                        ? "; found from your CI deployment when GitHub sends it"
                                        : ""}
                                </span>
                                <input
                                    type="url"
                                    placeholder="https://preview.example.com"
                                    value={previewUrl}
                                    onChange={(e) => setPreviewUrl(e.target.value)}
                                />
                            </label>
                            <p className="muted">
                                GitHub App access needs Pull requests permission. Your workspace
                                owner may need to approve the updated app permissions.
                            </p>
                            <button type="submit" disabled={busy || !connection || !project}>
                                Start review
                            </button>
                            {error ? (
                                <p role="alert" className="error">
                                    {error}
                                </p>
                            ) : null}
                        </form>
                    </Modal>
                ) : null}
                {capture ? (
                    <Modal title="Connect this PR preview" onClose={() => setCapture(null)}>
                        <div className="modal-body">
                            <p>
                                Set the SDK server to <code>{capture.server}</code> and project to{" "}
                                <code>{capture.projectId}</code>. Pass this review's capture key as
                                the SDK's <code>token</code> option.
                            </p>
                            <button
                                type="button"
                                onClick={() =>
                                    void copyText(capture.token).then(() =>
                                        setNotice(
                                            "Capture key copied. Keep it in the preview's environment."
                                        )
                                    )
                                }
                            >
                                Copy capture key
                            </button>
                            <p className="muted">
                                This key submits feedback only to this PR review and expires in
                                seven days. It cannot read feedback or connect an agent.
                            </p>
                            <p>
                                Use a preview deployment's environment so your own dev setup can
                                keep its separate feedback loop.
                            </p>
                        </div>
                    </Modal>
                ) : null}
                {preview ? (
                    <Modal title="Publish this summary to GitHub" onClose={() => setPreview(null)}>
                        <div className="modal-body">
                            <p>
                                {preview.count} public feedback targets · commit{" "}
                                <code>{preview.commit.slice(0, 8)}</code>
                                {preview.excluded
                                    ? ` · ${preview.excluded} private targets excluded`
                                    : ""}
                            </p>
                            <pre className="pr-summary-preview">{preview.text}</pre>
                            <p className="muted">
                                This posts a comment review on the PR. Screenshots, diagnostics,
                                reporter names and private feedback are excluded.
                            </p>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                    void perform(async () => {
                                        await action("publish", "POST", {
                                            hash: preview.hash,
                                            operation: preview.operation,
                                        });
                                        setPreview(null);
                                        setNotice("Review summary published to GitHub.");
                                    })
                                }
                            >
                                Confirm and publish review
                            </button>
                            {error ? (
                                <p role="alert" className="error">
                                    {error}
                                </p>
                            ) : null}
                        </div>
                    </Modal>
                ) : null}
            </div>
        </div>
    );
}
