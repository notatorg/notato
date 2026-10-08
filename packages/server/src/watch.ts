import { awaitsAgent, lastWord, sharedAgain } from "@notato/core";
import type { Status } from "@notato/schema";
import type { Backend } from "./backend.ts";
import { plural } from "./format.ts";
import { type AnnotationFilter, inProjects, type StoredAnnotation } from "./storage.ts";

/** The most new notes one call of `notato_watch` hands over; more wait for the next call. */
export const MAX_NEW = 50;
/** The most replies from the person one call hands over; more wait for the next call. */
export const MAX_FOLLOW_UPS = 20;
/** A reply cannot be waited for with a filter, so a waiting watch looks for one this often. */
const FOLLOW_UP_POLL_MS = 2500;

/**
 * Where a person's reply can be a follow-up: every status but a revert request, which has a delivery of its own.
 * Finished ones are included: a reply does not reopen a note, the agent does if there is work in it.
 */
const FOLLOW_UP_STATUSES: Status[] = [
    "open",
    "acknowledged",
    "variant_chosen",
    "resolved",
    "reverted",
    "dismissed",
];

/** Which projects a watch is for: one, several, or every one (undefined). */
type Projects = AnnotationFilter["projectId"];

/** What is waiting for the agent besides new notes. */
export interface Pending {
    /** Requests to undo a change it made. */
    undo: StoredAnnotation[];
    /** Variants the person picked from what it offered. */
    picks: StoredAnnotation[];
    /** Notes whose latest word is the person's, for the agent to take up. */
    followUps: StoredAnnotation[];
}

/** What one call of `notato_watch` hands over, in the order the agent should take it. */
export interface Batch {
    undo: StoredAnnotation[];
    picks: StoredAnnotation[];
    /** Replies from the person, at most `MAX_FOLLOW_UPS`. */
    replies: StoredAnnotation[];
    /** New notes, at most `MAX_NEW`. */
    fresh: StoredAnnotation[];
    /** Replies left for the next call. */
    laterReplies: number;
}

/** A note handed over, with what it was at the time: a new request or pick for it is one that differs. */
interface Handed {
    projectId: string;
    key: string;
}

/** The id of the person's latest word on a note: a revert asked for again comes with a new one. */
const revertKey = (s: StoredAnnotation) => {
    const human = s.annotation.thread.filter((r) => r.author.kind === "human" && !r.aside);
    return human.at(-1)?.id ?? "";
};

/** When the person made the pick: picking again is a new pick. */
const choiceKey = (s: StoredAnnotation) => s.annotation.variants?.chosenAt ?? "";

/** A pick the person has since written about ("make it bolder") is out of date: the message is what to act on. */
const superseded = (s: StoredAnnotation) => {
    // The pick's own reply is marked automatic, so any later human reply that is not is something they said.
    const last = lastWord(s.annotation);
    return last?.author.kind === "human" && !last.automatic;
};

/** Forgets what was handed over for notes in `projects` that are no longer in `current`. */
function forgetGone(handed: Map<string, Handed>, projects: Projects, current: StoredAnnotation[]) {
    const ids = new Set(current.map((s) => s.annotation.id));
    for (const [id, entry] of handed)
        if (inProjects(projects, entry.projectId) && !ids.has(id)) handed.delete(id);
}

const handedOf = (s: StoredAnnotation, key: string): Handed => ({
    projectId: s.annotation.projectId,
    key,
});

/**
 * What one MCP session has handed its agent through `notato_watch`, and finding what it has not: new notes past its
 * cursor, revert requests, variant picks, and replies from the person (follow-ups). Each session keeps its own, so a
 * backlog is delivered once to each and then only what is new. A reply is also recorded on the server
 * (`markHanded`), so a new session, or this agent after a restart, is not handed it again.
 */
export class WatchSession {
    /** The newest note handed over, by `seq`. */
    private cursor = 0;
    private readonly handedReverts = new Map<string, Handed>();
    private readonly handedChoices = new Map<string, Handed>();
    /** By note id, the id of the latest word the agent was handed. */
    private readonly handedFollowUps = new Map<string, string>();

    constructor(private readonly backend: Backend) {}

    /** Open notes this session has not been handed. */
    newNotes(projects: Projects): AnnotationFilter {
        return {
            projectId: projects,
            status: "open",
            afterSeq: this.cursor,
            // Between people: it reaches the agent if someone turns People only off, as a follow-up.
            peopleOnly: false,
            // `notato doctor` checks the server with a note it deletes at once: it is nobody's work to wake for.
            diagnostic: false,
        };
    }

    /** Requested reverts this session has not been told about yet, or that the person has written to again. */
    async pendingReverts(projects: Projects): Promise<StoredAnnotation[]> {
        // Every one: a cap would fill with requests already handed over and hide newer ones.
        const requested = await this.backend.list({
            projectId: projects,
            status: "revert_requested",
            peopleOnly: false,
        });
        forgetGone(this.handedReverts, projects, requested);
        return requested.filter(
            (r) => this.handedReverts.get(r.annotation.id)?.key !== revertKey(r)
        );
    }

    /** Picks the person has made that this session has not been told about yet (or has made again). */
    async pendingChoices(projects: Projects): Promise<StoredAnnotation[]> {
        const chosen = await this.backend.list({
            projectId: projects,
            status: "variant_chosen",
            peopleOnly: false,
        });
        forgetGone(this.handedChoices, projects, chosen);
        return chosen.filter(
            (c) => this.handedChoices.get(c.annotation.id)?.key !== choiceKey(c) && !superseded(c)
        );
    }

    /**
     * Notes whose latest word is the person's: an answer to a question, a note on a reopened one, a request for
     * different versions after a pick, more to do on one already finished, or People only turned off. A brand-new
     * note is not one of these (it is delivered as new), and neither is a pick's own note or a revert request, which
     * have their own delivery. People only notes never are.
     */
    async pendingFollowUps(projects: Projects): Promise<StoredAnnotation[]> {
        // Only what ends with something the person wrote, however old the note: no cap that newer ones fall past.
        // Not what an agent was handed already, in this session or any before it: a follow-up is delivered once.
        const items = await this.backend.list({
            projectId: projects,
            status: FOLLOW_UP_STATUSES,
            lastReplyBy: "human",
            peopleOnly: false,
            unhanded: true,
        });
        return items.filter(
            (s) =>
                // A pick recorded without a note is something the person did, not something they said.
                awaitsAgent(s.annotation) &&
                this.handedFollowUps.get(s.annotation.id) !== lastWord(s.annotation)?.id &&
                !(s.annotation.status === "open" && s.seq > this.cursor)
        );
    }

    /** Everything that is waiting for the agent but is not a new note. */
    async pending(projects: Projects): Promise<Pending> {
        return {
            undo: await this.pendingReverts(projects),
            picks: await this.pendingChoices(projects),
            followUps: await this.pendingFollowUps(projects),
        };
    }

    /** How much is waiting, new notes included: only whether it grows matters, so it stops counting past `MAX_NEW`. */
    async waiting(projects: Projects): Promise<number> {
        const { undo, picks, followUps } = await this.pending(projects);
        const fresh = await this.backend.list({ ...this.newNotes(projects), limit: MAX_NEW + 1 });
        return fresh.length + undo.length + picks.length + followUps.length;
    }

    /** True as soon as there is work of any kind, false when `sliceMs` runs out or `signal` aborts. */
    async waitForWork(projects: Projects, sliceMs: number, signal: AbortSignal): Promise<boolean> {
        const { undo, picks, followUps } = await this.pending(projects);
        if (undo.length + picks.length + followUps.length > 0) return true;
        const done = new AbortController();
        const stop = () => done.abort();
        signal.addEventListener("abort", stop);
        try {
            const waits = [
                this.backend.waitForNew(this.newNotes(projects), sliceMs, done.signal),
                this.backend.waitForNew(
                    {
                        projectId: projects,
                        status: "revert_requested",
                        peopleOnly: false,
                        excludeIds: [...this.handedReverts.keys()],
                    },
                    sliceMs,
                    done.signal
                ),
                this.backend.waitForNew(
                    {
                        projectId: projects,
                        status: "variant_chosen",
                        peopleOnly: false,
                        excludeIds: [...this.handedChoices.keys()],
                    },
                    sliceMs,
                    done.signal
                ),
                this.pollFollowUps(projects, sliceMs, done.signal),
            ];
            return await firstTrue(waits);
        } finally {
            done.abort();
            signal.removeEventListener("abort", stop);
        }
    }

    /** Looks for a follow-up every few seconds until `sliceMs` runs out. */
    private async pollFollowUps(projects: Projects, sliceMs: number, signal: AbortSignal) {
        const end = Date.now() + sliceMs;
        while (Date.now() < end && !signal.aborted) {
            await new Promise((resolve) =>
                setTimeout(resolve, Math.min(FOLLOW_UP_POLL_MS, end - Date.now()))
            );
            if (signal.aborted) return false;
            if ((await this.pendingFollowUps(projects)).length > 0) return true;
        }
        return false;
    }

    /** Collects what is waiting and records it as handed over, here and on the server. */
    async take(projects: Projects): Promise<Batch> {
        const fresh = await this.backend.list({ ...this.newNotes(projects), limit: MAX_NEW });
        const { undo, picks, followUps } = await this.pending(projects);
        // A follow-up is not also a new note or a pick: those are delivered with their threads.
        const delivered = new Set([...fresh, ...picks].map((s) => s.annotation.id));
        const allReplies = followUps.filter((f) => !delivered.has(f.annotation.id));
        // Twenty at a time, oldest first: the rest wait for the next call rather than flood the agent's context.
        const replies = allReplies.slice(0, MAX_FOLLOW_UPS);

        this.cursor = Math.max(this.cursor, ...fresh.map((s) => s.seq));
        // A new note is delivered with its thread, so a reply already on it is not a follow-up to send again.
        for (const f of fresh) {
            const last = lastWord(f.annotation);
            if (last) this.handedFollowUps.set(f.annotation.id, last.id);
        }
        for (const u of undo) this.handedReverts.set(u.annotation.id, handedOf(u, revertKey(u)));
        for (const c of picks) {
            this.handedChoices.set(c.annotation.id, handedOf(c, choiceKey(c)));
            // The note that came with the pick is part of delivering it, not a second thing to deliver.
            this.handedFollowUps.set(c.annotation.id, lastWord(c.annotation)?.id ?? "");
        }
        for (const r of replies) {
            this.handedFollowUps.set(r.annotation.id, lastWord(r.annotation)?.id ?? "");
            // A pick the reply was about is now out of date, and must not wake the next watch as if it were new.
            if (r.annotation.status === "variant_chosen")
                this.handedChoices.set(r.annotation.id, handedOf(r, choiceKey(r)));
        }
        // Recorded on the server too, so a new session, or this agent after a restart, is not handed them again.
        const handed = [...fresh, ...picks, ...replies].flatMap((s) => {
            const last = lastWord(s.annotation);
            return last ? [{ id: s.annotation.id, replyId: last.id }] : [];
        });
        await this.backend.markHanded(handed).catch((error) => {
            console.error(`[notato] could not record what watch handed over: ${error}`);
        });
        return { undo, picks, replies, fresh, laterReplies: allReplies.length - replies.length };
    }
}

/** Resolves true as soon as one of `waits` does, false once all have resolved false. */
function firstTrue(waits: Array<Promise<boolean>>): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        let remaining = waits.length;
        for (const wait of waits)
            wait.then((ready) => {
                if (ready) resolve(true);
                else if (--remaining === 0) resolve(false);
            }, reject);
    });
}

/** The first line of what a watch returns: "2 new annotations, 1 variant pick and 1 reply from the person." */
export function batchHeadline({ fresh, picks, replies, undo }: Batch): string {
    const shared = replies.filter((r) => sharedAgain(r.annotation)).length;
    const said = replies.length - shared;
    const parts = [
        fresh.length ? plural(fresh.length, "new annotation") : "",
        picks.length ? plural(picks.length, "variant pick") : "",
        said ? `${plural(said, "reply", "replies")} from the person` : "",
        shared ? `${plural(shared, "annotation")} shared with you again` : "",
        undo.length ? plural(undo.length, "revert request") : "",
    ].filter(Boolean);
    const last = parts.pop() ?? "";
    return `${parts.length ? `${parts.join(", ")} and ${last}` : last}.`;
}
