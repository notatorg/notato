import type { Annotation, Reply } from "@notato/schema";
import { ulid } from "ulid";

// What the agent sees of a note. Everything people write reaches it, except what they keep for themselves: a note
// marked People only (all of it), and a single reply sent as an aside.

/**
 * The latest word on a note as the agent sees it: the newest reply that is not an aside. Asides are for the people on
 * the thread, so one can never be what the agent answers, nor hide the message before it.
 */
export function lastWord(a: Annotation): Reply | undefined {
    for (let i = a.thread.length - 1; i >= 0; i--) {
        const r = a.thread[i];
        if (r && !r.aside) return r;
    }
    return undefined;
}

/**
 * Whether the latest word is a person's for the agent to take up: something they said, or People only being turned
 * off, which hands the note (and what was said meanwhile) back to the agent. Other automatic records (picking a
 * version) are something the person did, and are delivered their own way.
 */
export function awaitsAgent(a: Annotation): boolean {
    const last = lastWord(a);
    return last?.author.kind === "human" && (!last.automatic || last.peopleOnly === false);
}

/** Whether the latest word hands the note back to the agent: People only, just turned off. */
export const sharedAgain = (a: Annotation) => lastWord(a)?.peopleOnly === false;

/** The note as the agent is shown it: asides left out. */
export function agentView(a: Annotation): Annotation {
    return a.thread.some((r) => r.aside) ? { ...a, thread: a.thread.filter((r) => !r.aside) } : a;
}

/** What the thread says when someone turns People only on or off. The same words from the server and from a page. */
export const PEOPLE_ONLY_TEXT = {
    on: "Made this people only: the agent won't see it.",
    off: "Shared this with the agent.",
} as const;

/** The automatic entry recording People only being turned on or off, by a person. */
export function peopleOnlyRecord(on: boolean, name?: string, at = new Date().toISOString()): Reply {
    return {
        id: ulid(),
        author: { kind: "human", ...(name ? { name } : {}) },
        body: on ? PEOPLE_ONLY_TEXT.on : PEOPLE_ONLY_TEXT.off,
        createdAt: at,
        automatic: true,
        peopleOnly: on,
    };
}
