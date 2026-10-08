import { pinNumber, renderAnnotation } from "@notato/core";
import type { Annotation, Severity, Status } from "@notato/schema";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    assetHref,
    chooseVariant,
    copyText,
    remove,
    reply,
    setPeopleOnly,
    setSeverity,
    setStatus,
    useBoardName,
} from "./api.ts";
import { ago, authorName, dayLabel, restoreDraft, SEVERITIES, serial } from "./model.ts";
import type { Detail as DetailLevel } from "./Project.tsx";
import { go, projectHref } from "./route.ts";
import { Avatar, Icon, Logo, StatusPill, When } from "./ui.tsx";

interface Props {
    annotation: Annotation;
    project: string;
    /** How much to write when this is copied as Markdown. */
    detail: DetailLevel;
    /** It no longer matches the inbox's filters (just resolved, say), so it is not in the list beside it. */
    hidden: boolean;
    onChange(next: Annotation): void;
    onDeleted(id: string): void;
}

const INTENT_MEANING: Record<NonNullable<Annotation["intent"]>, string> = {
    fix: "Something is broken",
    change: "It works, but should be different",
    question: "A question: answer it, change nothing",
    approve: "This is right as it is",
    variants: "Wants a few versions to compare, and will pick one",
};

/** What to call the platforms the SDKs here send; a newer SDK's is shown as it is. */
const PLATFORM: Record<string, string> = {
    web: "Web",
    maui: ".NET MAUI",
    ios: "iOS",
    android: "Android",
    flutter: "Flutter",
    "react-native": "React Native",
};

const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** "Today, 15:23", "Yesterday, 09:10", "3 Oct 2026, 11:02". */
const when = (iso: string) => {
    const day = dayLabel(iso);
    return day === "Today" || day === "Yesterday"
        ? `${day}, ${clock(iso)}`
        : new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
/** Said wherever People only or an aside can be chosen, in the board, the toolbar and the mobile SDKs. */
const PEOPLE_ONLY_HINT = "Keep this between people: the agent won't see it.";
const ASIDE_HINT = "Just for people: the agent won't see this reply.";
const cap = (s: string) => `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;

export function Detail({ annotation: a, project, detail, hidden, onChange, onDeleted }: Props) {
    const [text, setText] = useState("");
    /** The next reply goes as an aside: for the people on the thread, not the agent. */
    const [aside, setAside] = useState(false);
    /** Requests still on their way. Status buttons wait for them; the reply box never does. */
    const [pending, setPending] = useState(0);
    const busy = pending > 0;
    /** One request at a time, in the order they were made: a reply sent before a resolve lands before it. */
    const [queue] = useState(serial);
    const [error, setError] = useState<string | null>(null);
    const [zoom, setZoom] = useState(false);
    const [more, setMore] = useState(false);
    const [flash, setFlash] = useState<string | null>(null);
    const body = useRef<HTMLDivElement>(null);
    const field = useRef<HTMLTextAreaElement>(null);
    const name = useBoardName();
    const shots = a.screenshots;
    const pin = pinNumber(a);
    const target = a.target.identity[0];
    const note = text.trim();

    // The reply field grows with what is written, up to a point, then scrolls.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the text is what changes its height
    useLayoutEffect(() => {
        const el = field.current;
        if (!el) return;
        el.style.height = "auto";
        // scrollHeight leaves out the border, which the height (border-box) includes.
        const full = el.scrollHeight + el.offsetHeight - el.clientHeight;
        el.style.height = `${Math.min(full, 160)}px`;
        el.style.overflowY = full > 160 ? "auto" : "hidden";
    }, [text]);

    useEffect(() => {
        if (!zoom) return;
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                setZoom(false);
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [zoom]);

    /**
     * Sends a request. With `sent`, it takes what is in the reply box with it: the box empties at once, so what is typed
     * while the request is on its way is the next message and stays, and what was taken comes back if it fails.
     */
    const run = (
        fn: () => Promise<{ annotation: Annotation } | undefined>,
        sent?: string,
        scroll = true
    ) => {
        if (sent !== undefined) setText("");
        setError(null);
        setPending((n) => n + 1);
        queue(fn)
            .then(
                (result) => {
                    if (result) onChange(result.annotation);
                    // Show what was just added to the thread, which is at the bottom.
                    if (scroll)
                        requestAnimationFrame(() =>
                            body.current?.scrollTo({
                                top: body.current.scrollHeight,
                                behavior: "smooth",
                            })
                        );
                },
                (e) => {
                    setError(e instanceof Error ? e.message : "Something went wrong");
                    if (sent !== undefined) setText((current) => restoreDraft(current, sent));
                }
            )
            .finally(() => setPending((n) => n - 1));
    };
    /** The reply box's text goes with this request, when there is any. */
    const taking = note ? text : undefined;

    const say = (message: string) => {
        setFlash(message);
        setTimeout(() => setFlash(null), 1600);
    };
    const copyMarkdown = async () => {
        try {
            await copyText(renderAnnotation(a, { detail }));
            say(`Copied as Markdown (${detail})`);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not copy.");
        }
    };
    const copyLink = async () => {
        try {
            await copyText(
                `${window.location.origin}${window.location.pathname}${projectHref(project, "inbox", a.id)}`
            );
            say("Link copied");
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not copy.");
        }
    };

    /** A status button. `fallback` is what the thread records when the box is empty. */
    const to = (
        status: Status,
        label: string,
        options: { fallback?: string; look?: "primary" | "tonal" | "ghost" } = {}
    ) => (
        <button
            type="button"
            className={options.look ?? "tonal"}
            disabled={busy}
            onClick={() => run(() => setStatus(a.id, status, note || options.fallback), taking)}
            title={note ? "Changes the status and adds what you wrote as a note" : undefined}
        >
            {options.look === "primary" ? <Icon name="check" size={15} /> : null}
            {label}
        </button>
    );

    /** Sends what is in the box, as an aside if that is pressed; the next one is for the agent again. */
    const send = () => {
        setAside(false);
        run(() => reply(a.id, note, aside), text);
    };

    const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        // Enter sends, Shift+Enter starts a new line.
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (note) send();
        }
        if (e.key === "Escape") e.currentTarget.blur();
    };

    const actions = (() => {
        switch (a.status) {
            case "open":
                return (
                    <>
                        {to("dismissed", "Dismiss", { look: "ghost" })}
                        {to("acknowledged", "Acknowledge")}
                        {to("resolved", "Resolve", { look: "primary" })}
                    </>
                );
            case "acknowledged":
                return (
                    <>
                        {to("dismissed", "Dismiss", { look: "ghost" })}
                        {to("resolved", "Resolve", { look: "primary" })}
                    </>
                );
            case "variant_chosen":
                // The agent applies the pick and resolves it.
                return to("dismissed", "Dismiss", { look: "ghost" });
            case "resolved":
                return (
                    <>
                        {to("revert_requested", "Ask the agent to revert", {
                            fallback: "Please revert this change.",
                            look: "ghost",
                        })}
                        {to("open", "Reopen")}
                    </>
                );
            case "revert_requested":
                return (
                    <>
                        {to("dismissed", "Dismiss", { look: "ghost" })}
                        {to("resolved", "Cancel revert", { fallback: "Revert request cancelled." })}
                    </>
                );
            case "reverted":
            case "dismissed":
                return to("open", "Reopen");
        }
    })();

    const long = a.comment.length > 160 || a.comment.includes("\n");

    return (
        <article className="detail">
            <header className="detail-head">
                <button
                    type="button"
                    className="icon-button back"
                    aria-label="Back to the list"
                    onClick={() => go(projectHref(project), true)}
                >
                    <Icon name="back" />
                </button>
                <StatusPill status={a.status} />
                {pin ? (
                    <span className="note-num" title="The number on the pin in the page">
                        Note #{pin}
                    </span>
                ) : null}
                {a.intent ? (
                    <span className="tag" title={INTENT_MEANING[a.intent]}>
                        {cap(a.intent)}
                    </span>
                ) : null}
                <button
                    type="button"
                    className={a.peopleOnly ? "tag people on" : "tag people"}
                    aria-pressed={Boolean(a.peopleOnly)}
                    aria-label="People only"
                    disabled={busy}
                    title={
                        a.peopleOnly
                            ? "Between people: the agent doesn't see this note. Press to share it with the agent."
                            : PEOPLE_ONLY_HINT
                    }
                    onClick={() => run(() => setPeopleOnly(a.id, !a.peopleOnly), undefined, false)}
                >
                    People only
                </button>
                <select
                    className={a.severity ? `sev-select set sev-${a.severity}` : "sev-select"}
                    aria-label="Severity"
                    title="Severity"
                    value={a.severity ?? ""}
                    disabled={busy}
                    onChange={(e) =>
                        run(
                            () => setSeverity(a.id, (e.target.value || null) as Severity | null),
                            undefined,
                            false
                        )
                    }
                >
                    <option value="">No severity</option>
                    {SEVERITIES.map((s) => (
                        <option key={s} value={s}>
                            {cap(s)}
                        </option>
                    ))}
                </select>
                <span className="grow" />
                {flash ? (
                    <span className="flash" role="status">
                        {flash}
                    </span>
                ) : null}
                <div className="head-actions">
                    <button
                        type="button"
                        className="icon-button"
                        onClick={copyLink}
                        title="Copy link"
                    >
                        <Icon name="link" size={15} />
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        onClick={copyMarkdown}
                        title={`Copy as Markdown (${detail}), to paste into an agent or an issue`}
                    >
                        <Icon name="copy" size={15} />
                    </button>
                    <button
                        type="button"
                        className="icon-button danger"
                        disabled={busy}
                        title="Delete"
                        onClick={() => {
                            if (
                                window.confirm("Delete this note and its screenshots for everyone?")
                            )
                                run(() =>
                                    remove(a.id).then(() => {
                                        onDeleted(a.id);
                                        return undefined;
                                    })
                                );
                        }}
                    >
                        <Icon name="trash" size={15} />
                    </button>
                </div>
            </header>

            <div className="detail-body" ref={body}>
                {hidden ? (
                    <p className="hidden-note">This note no longer matches the view on the left.</p>
                ) : null}
                <div className="detail-title">
                    <h2 className={long ? "comment long" : "comment"}>{a.comment}</h2>
                    <p className="byline">
                        {authorName(a.author)}
                        {a.author.kind === "agent" ? <span className="tag">agent</span> : null} ·{" "}
                        <When iso={a.createdAt}>{when(a.createdAt)}</When> ·{" "}
                        {PLATFORM[a.environment.platform] ?? a.environment.platform}
                    </p>
                </div>
                {a.target.selectedText ? <blockquote>“{a.target.selectedText}”</blockquote> : null}

                {shots ? (
                    <div className={shots.crop ? "shots two" : "shots"}>
                        <button
                            type="button"
                            className="shot"
                            onClick={() => setZoom(true)}
                            aria-label="Enlarge the screenshot"
                        >
                            <img
                                src={assetHref(shots.full.id)}
                                alt="The page, with the target outlined"
                                loading="lazy"
                            />
                            {pin ? (
                                <span className="paper-tag" aria-hidden="true">
                                    #{pin}
                                </span>
                            ) : null}
                            <span className="shot-route">{a.route}</span>
                        </button>
                        {shots.crop ? (
                            <button
                                type="button"
                                className="shot crop"
                                onClick={() => setZoom(true)}
                                aria-label="Enlarge"
                            >
                                <img
                                    src={assetHref(shots.crop.id)}
                                    alt="Close-up of the target"
                                    loading="lazy"
                                />
                            </button>
                        ) : null}
                    </div>
                ) : null}

                <dl className="target">
                    <dt>Page</dt>
                    <dd>
                        <a href={a.url} target="_blank" rel="noreferrer noopener" title={a.url}>
                            {a.route}
                            <Icon name="external" size={11} />
                        </a>
                    </dd>
                    {target?.component ? (
                        <>
                            <dt>Component</dt>
                            <dd>
                                {target.component.path?.join(" › ") ?? target.component.name}
                                {target.component.source ? (
                                    <span className="muted"> · {target.component.source}</span>
                                ) : null}
                            </dd>
                        </>
                    ) : null}
                    {target ? (
                        <>
                            <dt>{a.target.kind === "multi" ? "Elements" : "Element"}</dt>
                            <dd>
                                {target.selector}
                                {a.target.identity.length > 1 ? (
                                    <span className="muted">
                                        {" "}
                                        and {a.target.identity.length - 1} more
                                    </span>
                                ) : null}
                            </dd>
                        </>
                    ) : null}
                    {target?.source ? (
                        <>
                            <dt>{target.source.nearest ? "Inside" : "Source"}</dt>
                            <dd className="source">
                                {target.source.file}:{target.source.line}:{target.source.col}
                            </dd>
                        </>
                    ) : null}
                </dl>

                {a.variants ? (
                    <section className="variants">
                        <h3>Versions</h3>
                        <p className="muted small">
                            {a.status === "variant_chosen"
                                ? `Picked “${a.variants.chosen}”. Waiting for the agent to apply it.`
                                : a.status === "acknowledged"
                                  ? "The versions are in the page: switch between them there, or pick one here."
                                  : `Offered in group ${a.variants.group}.`}
                        </p>
                        <ul>
                            {a.variants.options.map((o) => {
                                const picked = o.name === a.variants?.chosen;
                                const pickable =
                                    (a.status === "acknowledged" ||
                                        a.status === "variant_chosen") &&
                                    !picked;
                                return (
                                    <li key={o.name} className={picked ? "picked" : ""}>
                                        <div>
                                            <strong>{o.name}</strong>
                                            {o.summary ? (
                                                <span className="muted"> · {o.summary}</span>
                                            ) : null}
                                        </div>
                                        {picked ? <span className="tag">picked</span> : null}
                                        {pickable ? (
                                            <button
                                                type="button"
                                                className="small"
                                                disabled={busy}
                                                onClick={() =>
                                                    run(
                                                        () => chooseVariant(a.id, o.name, note),
                                                        taking
                                                    )
                                                }
                                            >
                                                Pick
                                            </button>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                        {a.status === "variant_chosen" ? (
                            <button
                                type="button"
                                className="link"
                                disabled={busy}
                                onClick={() => run(() => chooseVariant(a.id, null, note), taking)}
                            >
                                Take back the pick
                            </button>
                        ) : null}
                    </section>
                ) : null}

                <section className="conversation" aria-label="Conversation">
                    {a.thread.length === 0 ? (
                        <div className="no-replies">
                            <Logo size={34} tilt={-10} />
                            {a.peopleOnly
                                ? "No replies yet. This note is between people: the agent doesn't see it."
                                : "No replies yet. The agent answers here when it picks the note up."}
                        </div>
                    ) : (
                        <ol className="thread">
                            {a.thread.map((r) =>
                                r.automatic ? (
                                    <li key={r.id} className="event">
                                        <span>
                                            {/* Who turned People only on or off: anyone on the thread can. */}
                                            {r.peopleOnly !== undefined ? (
                                                <strong>{authorName(r.author)} </strong>
                                            ) : null}
                                            {r.peopleOnly === undefined
                                                ? r.body
                                                : r.body[0]?.toLowerCase() + r.body.slice(1)}
                                        </span>
                                        <When iso={r.createdAt}>{ago(r.createdAt)}</When>
                                    </li>
                                ) : (
                                    <li
                                        key={r.id}
                                        className={`message${r.author.kind === "agent" ? " agent" : ""}${r.aside ? " aside" : ""}`}
                                    >
                                        <Avatar author={r.author} size={30} />
                                        <div className="bubble">
                                            <div className="bubble-head">
                                                <strong>{authorName(r.author)}</strong>{" "}
                                                {r.aside ? (
                                                    <span className="aside-tag" title={ASIDE_HINT}>
                                                        Aside
                                                    </span>
                                                ) : null}{" "}
                                                <When iso={r.createdAt}>{ago(r.createdAt)}</When>
                                            </div>
                                            <div className="bubble-body">{r.body}</div>
                                        </div>
                                    </li>
                                )
                            )}
                        </ol>
                    )}
                </section>

                <section className="facts">
                    <button
                        type="button"
                        className="link"
                        onClick={() => setMore(!more)}
                        aria-expanded={more}
                    >
                        {more ? "Hide details" : "Show details"}
                    </button>
                    {more ? (
                        <dl>
                            <dt>Page</dt>
                            <dd>
                                <a href={a.url} target="_blank" rel="noreferrer noopener">
                                    {a.url}
                                </a>
                            </dd>
                            <dt>Screen</dt>
                            <dd>
                                {a.environment.viewport.w}×{a.environment.viewport.h} @
                                {a.environment.dpr}x
                            </dd>
                            <dt>Browser</dt>
                            <dd>{a.environment.userAgent}</dd>
                            {a.appName ? (
                                <>
                                    <dt>App</dt>
                                    <dd>
                                        {a.appName} {a.appVersion}
                                    </dd>
                                </>
                            ) : null}
                            <dt>Mode</dt>
                            <dd>{a.mode}</dd>
                            {a.bundleId ? (
                                <>
                                    <dt>Bundle</dt>
                                    <dd>
                                        <code>{a.bundleId}</code>
                                    </dd>
                                </>
                            ) : null}
                            {target?.testId ? (
                                <>
                                    <dt>Test id</dt>
                                    <dd>
                                        <code>{target.testId}</code>
                                    </dd>
                                </>
                            ) : null}
                            {target?.role || target?.name ? (
                                <>
                                    <dt>Accessible</dt>
                                    <dd>
                                        {target.role} {target.name ? `“${target.name}”` : ""}
                                    </dd>
                                </>
                            ) : null}
                            {target?.ancestors?.length ? (
                                <>
                                    <dt>Inside</dt>
                                    <dd>
                                        <code>{target.ancestors.join(" › ")}</code>
                                    </dd>
                                </>
                            ) : null}
                            {target?.styles && Object.keys(target.styles).length ? (
                                <>
                                    <dt>Styles</dt>
                                    <dd className="styles">
                                        {Object.entries(target.styles).map(([k, v]) => (
                                            <code key={k}>
                                                {k}: {v}
                                            </code>
                                        ))}
                                    </dd>
                                </>
                            ) : null}
                            {a.steps?.length ? (
                                <>
                                    <dt>Steps</dt>
                                    <dd>
                                        <ol>
                                            {a.steps.map((s) => (
                                                <li
                                                    key={`${s.at}-${s.action}-${s.target ?? s.value ?? ""}`}
                                                >
                                                    {s.action}{" "}
                                                    {s.target ? <code>{s.target}</code> : null}{" "}
                                                    {s.value ?? ""}
                                                </li>
                                            ))}
                                        </ol>
                                    </dd>
                                </>
                            ) : null}
                            <dt>Id</dt>
                            <dd>
                                <code>{a.id}</code>
                            </dd>
                        </dl>
                    ) : null}
                </section>
            </div>

            <footer className="composer">
                {error ? (
                    <p className="error small" role="alert">
                        {error}
                    </p>
                ) : null}
                <div className="reply-field">
                    <textarea
                        ref={field}
                        placeholder={
                            aside
                                ? `Aside to the people here, as ${name || "Anonymous"}…`
                                : `Reply as ${name || "Anonymous"}… press Enter to send`
                        }
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={onComposerKey}
                        rows={1}
                        aria-label="Reply"
                    />
                    {/* On a People only note too: an aside stays from the agent if the note is shared later. */}
                    <button
                        type="button"
                        className={aside ? "aside-toggle on" : "aside-toggle"}
                        aria-pressed={aside}
                        title={ASIDE_HINT}
                        onClick={() => setAside(!aside)}
                    >
                        Aside
                    </button>
                    <button
                        type="button"
                        className="send"
                        aria-label="Send reply"
                        title="Send (Enter)"
                        disabled={!note}
                        onClick={send}
                    >
                        <Icon name="send" size={15} />
                    </button>
                </div>
                <div className="status-actions">{actions}</div>
            </footer>

            {zoom && shots ? (
                <dialog className="lightbox" open aria-label="Screenshot">
                    <button
                        type="button"
                        className="shade"
                        aria-label="Close"
                        onClick={() => setZoom(false)}
                    />
                    <img
                        className="lightbox-img"
                        src={assetHref(shots.full.id)}
                        alt="The page, with the target outlined"
                    />
                    <button
                        type="button"
                        className="icon-button lightbox-close"
                        aria-label="Close"
                        onClick={() => setZoom(false)}
                    >
                        <Icon name="close" />
                    </button>
                </dialog>
            ) : null}
        </article>
    );
}
