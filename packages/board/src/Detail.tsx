import { type Detail as DetailLevel, pinNumber, renderAnnotation } from "@notato/core";
import type { Annotation, Severity, Status } from "@notato/schema";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { chooseVariant, remove, reply, setPeopleOnly, setSeverity, setStatus } from "./api.ts";
import {
    authorName,
    capitalise,
    clock,
    dayLabel,
    restoreDraft,
    SEVERITIES,
    serial,
} from "./model.ts";
import { MoreFacts, TargetFacts } from "./NoteFacts.tsx";
import { go, projectHref } from "./route.ts";
import { Screenshots } from "./Screenshots.tsx";
import { useBoardName } from "./storage.ts";
import { ASIDE_HINT, Thread } from "./Thread.tsx";
import { copyText, FLASH_MS, Icon, StatusPill, When } from "./ui.tsx";

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

/** "Today, 15:23", "Yesterday, 09:10", "3 Oct 2026, 11:02". */
const when = (iso: string) => {
    const day = dayLabel(iso);
    return day === "Today" || day === "Yesterday"
        ? `${day}, ${clock(iso)}`
        : new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** Said wherever People only can be chosen, in the board, the toolbar and the mobile SDKs. */
const PEOPLE_ONLY_HINT = "Keep this between people: the agent won't see it.";

/** A comment longer than this, or on more than one line, is set as text rather than as a headline. */
const LONG_COMMENT = 160;
/** The reply box grows with what is written up to this height (px), then scrolls. */
const REPLY_MAX_HEIGHT = 160;

/** A status button's look: the main way on, a quieter one, or the one to reach for least. */
type Look = "primary" | "tonal" | "ghost";

/** One note, open beside the inbox: everything it recorded, its thread, and the reply box and status buttons. */
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
    const [flash, setFlash] = useState<string | null>(null);
    const body = useRef<HTMLDivElement>(null);
    const field = useRef<HTMLTextAreaElement>(null);
    const name = useBoardName();
    const pin = pinNumber(a);
    const note = text.trim();

    // The reply field grows with what is written, up to a point, then scrolls.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the text is what changes its height
    useLayoutEffect(() => {
        const el = field.current;
        if (!el) return;
        el.style.height = "auto";
        // scrollHeight leaves out the border, which the height (border-box) includes.
        const full = el.scrollHeight + el.offsetHeight - el.clientHeight;
        el.style.height = `${Math.min(full, REPLY_MAX_HEIGHT)}px`;
        el.style.overflowY = full > REPLY_MAX_HEIGHT ? "auto" : "hidden";
    }, [text]);

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

    const copy = async (what: string, done: string) => {
        try {
            await copyText(what);
            setFlash(done);
            setTimeout(() => setFlash(null), FLASH_MS);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not copy.");
        }
    };
    const copyLink = () =>
        copy(
            `${window.location.origin}${window.location.pathname}${projectHref(project, "inbox", a.id)}`,
            "Link copied"
        );
    const copyMarkdown = () =>
        copy(renderAnnotation(a, { detail }), `Copied as Markdown (${detail})`);

    const deleteNote = () => {
        if (!window.confirm("Delete this note and its screenshots for everyone?")) return;
        run(() =>
            remove(a.id).then(() => {
                onDeleted(a.id);
                return undefined;
            })
        );
    };

    /** A status button. `fallback` is what the thread records when the box is empty. */
    const to = (
        status: Status,
        label: string,
        options: { fallback?: string; look?: Look } = {}
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

    /** What can happen next from where the note is now. */
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

    const long = a.comment.length > LONG_COMMENT || a.comment.includes("\n");

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
                        {capitalise(a.intent)}
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
                            {capitalise(s)}
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
                        onClick={deleteNote}
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
                <Screenshots annotation={a} />
                <TargetFacts annotation={a} />
                {a.variants ? (
                    <Variants
                        annotation={a}
                        busy={busy}
                        onPick={(name) => run(() => chooseVariant(a.id, name, note), taking)}
                    />
                ) : null}
                <Thread annotation={a} />
                <MoreFacts annotation={a} />
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
        </article>
    );
}

/**
 * The versions an agent offered. While the agent waits for a pick (or before it applies one), any of them can be
 * picked here, which sends what is in the reply box with it; a pick can be taken back until the agent applies it.
 */
function Variants({
    annotation: a,
    busy,
    onPick,
}: {
    annotation: Annotation;
    busy: boolean;
    /** Picks a version by name, or (with null) takes the pick back. */
    onPick(name: string | null): void;
}) {
    if (!a.variants) return null;
    const { chosen, group, options } = a.variants;
    const open = a.status === "acknowledged" || a.status === "variant_chosen";
    return (
        <section className="variants">
            <h3>Versions</h3>
            <p className="muted small">
                {a.status === "variant_chosen"
                    ? `Picked “${chosen}”. Waiting for the agent to apply it.`
                    : a.status === "acknowledged"
                      ? "The versions are in the page: switch between them there, or pick one here."
                      : `Offered in group ${group}.`}
            </p>
            <ul>
                {options.map((o) => {
                    const picked = o.name === chosen;
                    return (
                        <li key={o.name} className={picked ? "picked" : ""}>
                            <div>
                                <strong>{o.name}</strong>
                                {o.summary ? <span className="muted"> · {o.summary}</span> : null}
                            </div>
                            {picked ? <span className="tag">picked</span> : null}
                            {open && !picked ? (
                                <button
                                    type="button"
                                    className="small"
                                    disabled={busy}
                                    onClick={() => onPick(o.name)}
                                >
                                    Pick
                                </button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
            {a.status === "variant_chosen" ? (
                <button type="button" className="link" disabled={busy} onClick={() => onPick(null)}>
                    Take back the pick
                </button>
            ) : null}
        </section>
    );
}
