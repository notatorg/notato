import { authHeaders } from "./auth.ts";
import { net } from "./net.ts";
import type { ServerSync } from "./sync.ts";
import type { ServerInfo } from "./ui/settings-panel.ts";

/** What a relayed `notato_annotate` request came to, as the server wants to hear it. */
export type RelayOutcome = { ok: true; annotationId: string } | { ok: false; error: string };

/** What the toolbar asks of a live server besides posting notes: the person's changes to them, and its status. */
export interface ServerActions {
    /** Moves an annotation to a status, as the person. */
    changeStatus(id: string, status: "revert_requested" | "resolved", note: string): Promise<void>;
    /** Picks one of the versions an agent offered, or (with `null`) takes the pick back. */
    chooseVariant(id: string, name: string | null): Promise<void>;
    /** Writes in an annotation's thread as the person; an aside is for the people on it, kept from the agent. */
    reply(id: string, body: string, aside?: boolean): Promise<void>;
    /** Turns People only on or off. The server records the change in the thread. */
    setPeopleOnly(id: string, on: boolean): Promise<void>;
    /** Deletes an annotation. One the server does not have counts as deleted. */
    remove(id: string): Promise<void>;
    /** Tells the server how a relayed annotate request went. */
    reportRelay(requestId: string, outcome: RelayOutcome): Promise<void>;
    /** What the server says about itself and the agents connected to it, or null when it does not answer. */
    status(): Promise<ServerInfo | null>;
}

interface ServerActionsOptions {
    server: string;
    token?: string;
    /** The live mirror of the server's notes: an answer that is a note goes straight into it. */
    sync: ServerSync;
    /** The person's name, recorded on what they change. */
    author(): string | undefined;
}

/** What `GET /status` answers, as far as the toolbar reads it. */
interface StatusBody {
    version?: string;
    mode?: string;
    pages?: number;
    config?: { screenshots?: "on" | "off" };
    agents?: { connected?: boolean; watching?: boolean; names?: string[] };
}

export function createServerActions(options: ServerActionsOptions): ServerActions {
    const { server, token, sync } = options;
    const annotation = (id: string) => `${server}/annotations/${encodeURIComponent(id)}`;

    /** A request to the server as the person. Rejects with a message fit to show. */
    async function asPerson(url: string, method: string, body: Record<string, unknown>) {
        const since = sync.mark();
        let res: Response;
        try {
            res = await net.fetch(url, {
                method,
                headers: { "content-type": "application/json", ...authHeaders(token) },
                body: JSON.stringify({
                    ...body,
                    author: { kind: "human", name: options.author() },
                }),
            });
        } catch {
            throw new Error("Cannot reach the Notato server.");
        }
        if (!res.ok) {
            const detail = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(detail?.error ?? `The server answered ${res.status}.`);
        }
        // The server answers with the note as it is now, which makes the card right straight away. (It also pushes the
        // change.) Only an answer that is not a note, from an older server, has the list read again for it.
        const answer = (await res.json().catch(() => null)) as { annotation?: unknown } | null;
        if (!sync.apply(answer?.annotation, since)) await sync.refresh().catch(() => {});
    }

    return {
        changeStatus: (id, status, note) => asPerson(annotation(id), "PATCH", { status, note }),
        chooseVariant: (id, name) =>
            asPerson(`${annotation(id)}/variants/choose`, "POST", { name }),
        reply: (id, body, aside = false) =>
            asPerson(`${annotation(id)}/replies`, "POST", { body, ...(aside ? { aside } : {}) }),
        setPeopleOnly: (id, on) => asPerson(annotation(id), "PATCH", { peopleOnly: on }),

        async remove(id) {
            const res = await net.fetch(annotation(id), {
                method: "DELETE",
                headers: authHeaders(token),
            });
            if (!res.ok && res.status !== 404) throw new Error(`the server answered ${res.status}`);
        },

        async reportRelay(requestId, outcome) {
            await net.fetch(`${server}/relay/${encodeURIComponent(requestId)}/result`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders(token) },
                body: JSON.stringify(outcome),
            });
        },

        async status() {
            try {
                const res = await net.fetch(`${server}/status`, { headers: authHeaders(token) });
                if (!res.ok) return null;
                const body = (await res.json()) as StatusBody;
                return {
                    version: body.version,
                    mode: body.mode,
                    pages: body.pages,
                    screenshots: body.config?.screenshots,
                    agent: body.agents
                        ? {
                              connected: Boolean(body.agents.connected),
                              watching: Boolean(body.agents.watching),
                              names: body.agents.names,
                          }
                        : undefined,
                };
            } catch {
                return null;
            }
        },
    };
}
