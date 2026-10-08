import type { MemoryStore } from "@notato/core";
import { type AgentStep, Annotation, type Severity, Status } from "@notato/schema";
import { authHeaders } from "./auth.ts";
import { type EventStream, net, STREAM_CLOSED } from "./net.ts";
import type { ConnectionState } from "./ui/toolbar.ts";

export interface ServerSyncOptions {
    baseUrl: string;
    project: string;
    /** Project token for a server that needs one (serve mode). */
    token?: string;
    store: MemoryStore;
    onState(state: ConnectionState): void;
    /** Called each time the connection (re)opens, so unsent annotations can go out. */
    onConnected?(): void;
    /** Register as a page that can take `notato_annotate` requests relayed from the server. */
    agent?: boolean;
    onAnnotateRequest?(request: AnnotateRequest): void;
    /** Whether a coding agent is connected, and what it is called, from the first event and as it changes. */
    onAgent?(agent: AgentInfo): void;
    /** Annotations the server may not have yet (waiting to be sent, or refused): never dropped as gone from it. */
    keep?(): Iterable<string>;
    /** What the server changed in the store, once it is in: so a copy kept in this browser can follow. */
    onApplied?(change: { updated: Annotation[]; removed: string[] }): void;
    /** First wait before opening the stream again after the server refused it; doubles up to 30 seconds. */
    retryMs?: number;
}

/** What the server says about the agents with its MCP open. */
export interface AgentInfo {
    connected: boolean;
    watching: boolean;
    /** "Claude", "Codex"…: each connected agent once, as its MCP client names itself. Older servers send none. */
    names: string[];
}

const agentInfo = (raw: unknown): AgentInfo | undefined => {
    if (!raw || typeof raw !== "object") return undefined;
    const a = raw as { connected?: unknown; watching?: unknown; names?: unknown };
    return {
        connected: Boolean(a.connected),
        watching: Boolean(a.watching),
        names: Array.isArray(a.names)
            ? a.names.filter((n): n is string => typeof n === "string")
            : [],
    };
};

/** An annotate request the server relays to this page on behalf of an agent. */
export interface AnnotateRequest {
    requestId: string;
    args: {
        target: string;
        comment: string;
        severity?: Severity;
        steps?: AgentStep[];
        author?: string;
    };
}

export interface ServerSync {
    start(): void;
    stop(): void;
    /** Re-reads everything from the server. */
    refresh(): Promise<void>;
    /** Where the live stream is: taken before a request whose answer is passed to `apply`. */
    mark(): number;
    /**
     * Takes the note the server answered a change with (a reply, a status, a pick), so the page has it at once without
     * reading the whole list again. Left alone when the stream has said something about the note since `since`: that is
     * at least as new. False when the answer is not a note (an older server), and the list should be read instead.
     */
    apply(raw: unknown, since: number): boolean;
}

const EVENTS = ["created", "updated", "replied"] as const;
/** The most the server sends at once. */
const PAGE = 500;
/**
 * A dismissed note has no pin and is counted nowhere in the page, so it is neither read nor kept: on a project people
 * have triaged, most of the list. The statuses are named, as the server has no "all but"; one too old to know a status
 * refuses the lot, and is then read whole.
 */
const SHOWN = Status.options.filter((s) => s !== "dismissed").join(",");
/** Neither read nor kept: a dismissed note. */
const unwanted = (a: Annotation) => a.status === "dismissed";
/** Far more than any project has: a server that never stops saying `next` cannot keep the page reading forever. */
const MAX_PAGES = 400;

/**
 * Mirrors the server's annotations for this project into the page: the whole list, then live updates over SSE, so a pin
 * turns green when the agent resolves it. The list is read again each time the stream (re)connects.
 */
export function createServerSync(options: ServerSyncOptions): ServerSync {
    const base = options.baseUrl.replace(/\/$/, "");
    const project = encodeURIComponent(options.project);
    const firstRetry = options.retryMs ?? 1000;
    let source: EventStream | undefined;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = firstRetry;
    /** While the list is being read: the ids live events spoke of meanwhile, which are newer than any page of it. */
    let heard: Set<string> | undefined;
    /** How many live events there have been, and the count at each note's latest, for `apply`. */
    let events = 0;
    const lastEvent = new Map<string, number>();
    /** The server would not filter the list by status (too old to know one of them): it is read whole. */
    let whole = false;

    const parse = (raw: unknown) => {
        const parsed = Annotation.safeParse(raw);
        return parsed.success ? parsed.data : undefined;
    };
    /** Same as what the store has: nothing to tell anyone. */
    const unchanged = (a: Annotation) => {
        const current = options.store.get(a.id)?.annotation;
        return current !== undefined && JSON.stringify(current) === JSON.stringify(a);
    };

    /** A note as the server has it now: in the store, or out of it once dismissed. */
    const take = (annotation: Annotation) => {
        if (unwanted(annotation)) {
            if (!options.store.get(annotation.id)) return;
            options.store.remove(annotation.id);
            options.onApplied?.({ updated: [], removed: [annotation.id] });
            return;
        }
        if (unchanged(annotation)) return;
        options.store.upsert(annotation);
        options.onApplied?.({ updated: [annotation], removed: [] });
    };

    const heardOf = (id: string) => {
        heard?.add(id);
        events += 1;
        lastEvent.set(id, events);
    };

    const live = (raw: unknown) => {
        const annotation = parse(raw);
        if (!annotation) return;
        heardOf(annotation.id);
        take(annotation);
    };

    /** Every page of the list, oldest first. Throws if any page fails, so nothing is concluded from part of it. */
    const readAll = async (): Promise<Annotation[]> => {
        const all: Annotation[] = [];
        let after: number | undefined;
        const ask = () => {
            const query = new URLSearchParams({ limit: String(PAGE) });
            if (after !== undefined) query.set("afterSeq", String(after));
            if (!whole) query.set("status", SHOWN);
            return net.fetch(`${base}/projects/${project}/annotations?${query}`, {
                headers: authHeaders(options.token),
            });
        };
        for (let page = 0; page < MAX_PAGES; page++) {
            let res = await ask();
            if (res.status === 400 && !whole) {
                whole = true; // a status this server does not know: the whole list, then
                res = await ask();
            }
            if (!res.ok) throw new Error(`server answered ${res.status}`);
            const body = (await res.json()) as {
                items?: Array<{ annotation: unknown }>;
                next?: unknown;
            };
            for (const item of body.items ?? []) {
                const annotation = parse(item.annotation);
                if (annotation && !unwanted(annotation)) all.push(annotation);
            }
            // An older server sends one page and no `next`.
            if (typeof body.next !== "number" || (after !== undefined && body.next <= after))
                return all;
            after = body.next;
        }
        throw new Error("the list did not end");
    };

    const load = async () => {
        const known = new Set(options.store.list().map((r) => r.annotation.id));
        // Waiting to be sent as the read began: it may reach the server after its page was read.
        const keep = new Set(options.keep?.() ?? []);
        const during = new Set<string>();
        heard = during;
        let items: Annotation[];
        try {
            items = await readAll();
        } finally {
            if (heard === during) heard = undefined;
        }
        // An event that came in while the pages were read is newer than they are: it stands.
        const fresh = items.filter((a) => !during.has(a.id) && !unchanged(a));
        const onServer = new Set(items.map((a) => a.id));
        for (const id of options.keep?.() ?? []) keep.add(id);
        // Only what was here before the read began, and was neither on its way to the server nor refused by it, then
        // or now: a note made or sent meanwhile may have reached the server after its page was read.
        const removed = [...known].filter(
            (id) =>
                !onServer.has(id) &&
                !keep.has(id) &&
                !during.has(id) &&
                options.store.get(id) !== undefined
        );
        // One change for the whole list: a big project would otherwise redraw the pins once per note.
        options.store.upsertMany(fresh, removed);
        if (fresh.length || removed.length) options.onApplied?.({ updated: fresh, removed });
    };

    // One read at a time. A read asked for while one is running runs again after it, so it sees what was just done.
    let running: Promise<void> | undefined;
    let again: Promise<void> | undefined;
    const refresh = (): Promise<void> => {
        if (!running) {
            running = load().finally(() => {
                running = undefined;
            });
            return running;
        }
        again ??= running
            .catch(() => {})
            .then(() => {
                again = undefined;
                return refresh();
            });
        return again;
    };

    /**
     * The list is read when the stream opens. A read that fails then (a proxy's timeout, a server busy for a moment) is
     * tried again, waiting longer each time, for as long as that stream is open: the connection itself is fine, and the
     * toolbar goes on saying so. Only the stream's own failure means the server cannot be reached.
     */
    let reading: ReturnType<typeof setTimeout> | undefined;
    let readDelay = firstRetry;
    const stopReading = () => {
        if (reading) clearTimeout(reading);
        reading = undefined;
    };
    const readFor = (stream: EventStream) => {
        stopReading();
        refresh().then(
            () => {
                readDelay = firstRetry;
            },
            (error: unknown) => {
                if (stopped || source !== stream) return;
                if (readDelay === firstRetry)
                    console.warn(
                        "[notato] could not read the notes from the server; trying again",
                        error
                    );
                reading = setTimeout(() => {
                    reading = undefined;
                    if (!stopped && source === stream) readFor(stream);
                }, readDelay);
                readDelay = Math.min(readDelay * 2, 30_000);
            }
        );
    };

    const reopen = () => {
        if (stopped || retry) return;
        retry = setTimeout(() => {
            retry = undefined;
            if (!stopped) open();
        }, delay);
        delay = Math.min(delay * 2, 30_000);
    };

    const open = () => {
        options.onState("connecting");
        // EventSource cannot set headers, so the token travels in the query string for this one GET.
        const query = new URLSearchParams();
        if (options.agent) query.set("agent", "1");
        if (options.token) query.set("token", options.token);
        const stream = net.events(
            `${base}/projects/${project}/events${query.size ? `?${query}` : ""}`
        );
        source = stream;
        stream.addEventListener("hello", (ev) => {
            delay = firstRetry;
            try {
                const agent = agentInfo((JSON.parse(ev.data) as { agent?: unknown }).agent);
                if (agent) options.onAgent?.(agent);
            } catch {
                // a hello without agent news is still a hello
            }
            options.onState("connected");
            readDelay = firstRetry;
            readFor(stream);
            options.onConnected?.();
        });
        for (const type of EVENTS) {
            stream.addEventListener(type, (ev) => {
                try {
                    live((JSON.parse(ev.data) as { annotation: unknown }).annotation);
                } catch {
                    // a malformed event is ignored; the next refresh repairs any drift
                }
            });
        }
        stream.addEventListener("agent", (ev) => {
            try {
                const agent = agentInfo(JSON.parse(ev.data));
                if (agent) options.onAgent?.(agent);
            } catch {
                // a malformed event is ignored; the next one says the same again
            }
        });
        stream.addEventListener("annotate-request", (ev) => {
            try {
                options.onAnnotateRequest?.(JSON.parse(ev.data) as AnnotateRequest);
            } catch {
                // a malformed request is dropped; the server times it out
            }
        });
        stream.addEventListener("deleted", (ev) => {
            let id: string;
            try {
                id = (JSON.parse(ev.data) as { id: string }).id;
            } catch {
                return; // ignored, as above
            }
            heardOf(id);
            if (!options.store.get(id)) return;
            options.store.remove(id);
            options.onApplied?.({ updated: [], removed: [id] });
        });
        stream.onerror = () => {
            if (stopped || source !== stream) return;
            if (stream.readyState !== STREAM_CLOSED) {
                options.onState("connecting"); // the browser is already trying again
                return;
            }
            // An EventSource that got an error status (a 502 from a proxy, a 401) gives up for good: try again
            // ourselves, waiting longer each time. The next hello reads the list again.
            options.onState("offline");
            stream.close();
            source = undefined;
            stopReading();
            reopen();
        };
    };

    return {
        refresh,
        mark: () => events,
        apply(raw, since) {
            const annotation = parse(raw);
            if (!annotation) return false;
            // The stream spoke of this note after the request went: what it said is at least as new as this answer.
            if ((lastEvent.get(annotation.id) ?? 0) > since) return true;
            heard?.add(annotation.id); // newer than any page of a list being read now
            take(annotation);
            return true;
        },
        start() {
            stopped = false;
            open();
        },
        stop() {
            stopped = true;
            if (retry) clearTimeout(retry);
            retry = undefined;
            stopReading();
            source?.close();
            source = undefined;
        },
    };
}
