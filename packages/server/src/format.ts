import {
    awaitsAgent,
    clip,
    type Detail,
    lastWord,
    pinNumber,
    renderAnnotation,
    sharedAgain,
} from "@notato/core";
import type { Annotation } from "@notato/schema";
import type { StoredAnnotation } from "./storage.ts";

export { pinNumber };

/** What an agent is told when the person has asked for a resolved change to be undone. */
export const REVERT_INSTRUCTIONS =
    "⟲ REVERT REQUESTED. The person does not want the change you made for this annotation, so undo it. " +
    'The thread says what you did when you resolved it ("Resolved: …", with the files and commit if you gave them) and the last message from the person says why. ' +
    "Undo exactly that change and nothing else, for example by reverting the commit or restoring those files, and check the app still builds. " +
    "Then call notato_reverted with a one-line summary. If you cannot undo it cleanly, call notato_reply to say why and leave it for the person.";

/** What an agent is told when the person has picked one of the versions it offered. */
export const variantInstructions = (chosen: string, others: string[]) =>
    `⇄ VARIANT CHOSEN: “${chosen}”. The person compared the versions you put in the page and picked this one. ` +
    `Make it the only version: keep its content and delete ${others.length ? `the others (${others.map((o) => `“${o}”`).join(", ")}), ` : "the others, "}` +
    "remove every wrapper element and both data-notato-variant attributes so no scaffolding is left, and leave no flag or dead code. " +
    "If “Original” was picked, restore what was there before you started. Check the app still builds, commit the result on its own " +
    "(staging only your own files), then call notato_resolve with the files and the commit.";

/** What an agent is told when someone has written in a thread it already has: the latest word below is theirs. */
export const FOLLOW_UP_INSTRUCTIONS =
    "↩ FOLLOW-UP. Someone wrote in this annotation's thread: their latest message is the last one below. Everything people write reaches you, so read it for what it asks. " +
    "If it answers a question you asked or changes what they want, carry on: answer with notato_reply, or change what you did (for variants, adjust the versions and call notato_variants_ready again), and finish with notato_resolve as usual. " +
    "If it asks a question, answer it with notato_reply. A plain acknowledgement (thanks, looks good) needs nothing: no reply, no change. If it is people talking among themselves, take it as context and do not reply.";

/** Added when the follow-up is on an annotation already finished: replying does not reopen it, the agent does. */
export const FINISHED_FOLLOW_UP_INSTRUCTIONS =
    "This annotation is already finished (resolved, dismissed or reverted), and the reply did not reopen it. If it asks for more work, reopen it with notato_acknowledge, make the change, commit, and call notato_resolve again. If it only needs an answer, reply and leave it finished.";

/** What an agent is told when People only has just been turned off: the note is back with it, thread and all. */
export const SHARED_AGAIN_INSTRUCTIONS =
    "⇢ SHARED WITH YOU. This annotation was People only (between people, kept from you) and has just been handed back. Read the whole thread: it may say what they settled on. Then work it as usual: acknowledge, fix or answer, resolve.";

/** What an agent is told about a People only note it asked for by id: it may read it, but it is not for it. */
export const PEOPLE_ONLY_INSTRUCTIONS =
    "⊘ PEOPLE ONLY. The people on this annotation marked it as between themselves, so it is not for you: do not act on it, reply to it or change its status. It reaches you again only if someone turns People only off.";

/** The person's latest word in the thread, when it is theirs to be answered (asides left out). */
export const lastHumanReply = (a: Annotation) => (awaitsAgent(a) ? lastWord(a) : undefined);

const FINISHED = new Set(["resolved", "dismissed", "reverted"]);

/** One annotation as Markdown for the model: everything needed to find and fix the thing. */
export function formatAnnotation(
    stored: StoredAnnotation,
    options: { screenshotsAttached?: boolean; detail?: Detail; followUp?: boolean } = {}
): string {
    const a = stored.annotation;
    // What the person just wrote comes before the standing instruction for the status: it is what to act on now.
    const notes = a.peopleOnly
        ? ["", PEOPLE_ONLY_INSTRUCTIONS]
        : a.status === "revert_requested"
          ? ["", REVERT_INSTRUCTIONS]
          : options.followUp
            ? sharedAgain(a)
                ? ["", SHARED_AGAIN_INSTRUCTIONS]
                : FINISHED.has(a.status)
                  ? ["", FOLLOW_UP_INSTRUCTIONS, "", FINISHED_FOLLOW_UP_INSTRUCTIONS]
                  : ["", FOLLOW_UP_INSTRUCTIONS]
            : a.status === "variant_chosen" && a.variants?.chosen
              ? [
                    "",
                    variantInstructions(
                        a.variants.chosen,
                        a.variants.options
                            .map((o) => o.name)
                            .filter((n) => n !== a.variants?.chosen)
                    ),
                ]
              : undefined;
    return renderAnnotation(a, {
        detail: options.detail ?? "standard",
        screenshotsAttached: options.screenshotsAttached,
        notes,
        // Asides are for the people on the thread.
        forAgent: true,
    });
}

/** A compact table row per annotation, for `notato_list_open`. */
export function formatList(items: StoredAnnotation[]): string {
    if (items.length === 0) return "No open annotations.";
    return items
        .map(({ annotation: a }) => {
            const pin = pinNumber(a);
            const target = a.target.identity[0];
            return `- ${pin ? `#${pin} ` : ""}${a.id} [${a.status}${a.intent ? `, ${a.intent}` : ""}${a.severity ? `, ${a.severity}` : ""}] ${a.route} · ${target ? `\`${target.selector}\`${target.component ? ` in <${target.component.name}>` : ""}${target.source && !target.source.nearest ? ` at ${target.source.file}:${target.source.line}` : ""}` : a.target.kind} · ${clip(a.comment, 140)}`;
        })
        .join("\n");
}
