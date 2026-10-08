import type { Annotation, Reply } from "@notato/schema";
import { ago, authorName } from "./model.ts";
import { Avatar, Logo, When } from "./ui.tsx";

/** Said wherever an aside can be chosen, in the board, the toolbar and the mobile SDKs. */
export const ASIDE_HINT = "Just for people: the agent won't see this reply.";

const lowerFirst = (s: string) => `${s[0]?.toLowerCase() ?? ""}${s.slice(1)}`;

/** A note's conversation: what people and agents wrote, with what Notato recorded on its own in between. */
export function Thread({ annotation: a }: { annotation: Annotation }) {
    return (
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
                            <ThreadEvent key={r.id} reply={r} />
                        ) : (
                            <Message key={r.id} reply={r} />
                        )
                    )}
                </ol>
            )}
        </section>
    );
}

/** A line Notato wrote itself: a version picked, People only turned on. */
function ThreadEvent({ reply: r }: { reply: Reply }) {
    // Who turned People only on or off, since anyone on the thread can.
    const who = r.peopleOnly !== undefined;
    return (
        <li className="event">
            <span>
                {who ? <strong>{authorName(r.author)} </strong> : null}
                {who ? lowerFirst(r.body) : r.body}
            </span>
            <When iso={r.createdAt}>{ago(r.createdAt)}</When>
        </li>
    );
}

/** Something a person or an agent wrote; an aside is drawn apart, since the agent is never shown it. */
function Message({ reply: r }: { reply: Reply }) {
    const agent = r.author.kind === "agent";
    return (
        <li className={`message${agent ? " agent" : ""}${r.aside ? " aside" : ""}`}>
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
    );
}
