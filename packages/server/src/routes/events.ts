import type { LocalBackend } from "../backend.ts";
import type { NotatoEvent } from "../events.ts";
import { assertAccess, projectIdFrom, type Routes } from "./common.ts";

const encoder = new TextEncoder();
const frame = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const PING = encoder.encode(": ping\n\n");
/** A comment every so often keeps proxies and the server's idle timeout from closing a quiet stream. */
const PING_MS = 15_000;
/** How far behind a client of the event stream may fall before it is let go. */
const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;
/** How much a stream buffers for its client before that client counts as falling behind. */
const BUFFER_BYTES = 64 * 1024;

/**
 * A change as the event stream sends it, written once however many clients are listening: a reply on a long thread is
 * a large note, and serialising it once per listener would multiply that.
 */
const framed = new WeakMap<NotatoEvent, Uint8Array>();
function changeFrame(e: NotatoEvent): Uint8Array {
    let bytes = framed.get(e);
    if (!bytes) {
        bytes = frame(e.type, {
            id: e.id,
            projectId: e.projectId,
            seq: e.seq,
            annotation: e.annotation,
            // What a change changed from, so a board can tell a status change without remembering.
            ...(e.previous ? { previous: e.previous } : {}),
        });
        framed.set(e, bytes);
    }
    return bytes;
}

/**
 * The server-sent event streams pages and boards listen on: every change to a project's notes, whether an agent is
 * there, what `@` can call, and (for a page in agent mode) the annotate requests relayed from `notato_annotate`.
 */
export class EventStreams {
    /** How many are open now. Separate from `notato_watch` waiters, which wait on the bus directly. */
    open = 0;

    constructor(private readonly backend: LocalBackend) {}

    /** A stream for one project, or for every project with `*` (the board). `agent`: the page takes annotate requests. */
    stream(req: Request, projectId: string, agent: boolean): Response {
        const { backend } = this;
        let cleanup = () => {};
        const stream = new ReadableStream<Uint8Array>(
            {
                start: (controller) => {
                    const enqueue = (bytes: Uint8Array) => {
                        try {
                            controller.enqueue(bytes);
                            // A client that has stopped reading (asleep, on a dead connection) would have every event
                            // kept for it in memory: past a few megabytes behind, it is let go, and reconnects when it
                            // wakes.
                            if ((controller.desiredSize ?? 0) < -SLOW_CLIENT_BYTES) cleanup();
                        } catch {
                            cleanup();
                        }
                    };
                    const send = (event: string, data: unknown) => enqueue(frame(event, data));
                    this.open += 1;
                    send("hello", {
                        projectId,
                        agent: backend.agents.stateFor(projectId),
                        mentions: backend.mentions.list(),
                    });
                    // Whether an agent is listening, and what @ can call (the mention plugins), as they change.
                    const unwatchAgents = backend.agents.subscribe(
                        (state) => send("agent", state),
                        projectId
                    );
                    const unwatchMentions = backend.mentions.subscribe((mentions) =>
                        send("mentions", mentions)
                    );
                    const unregister =
                        agent && projectId !== "*"
                            ? backend.relay.register(projectId, (request) =>
                                  send("annotate-request", request)
                              )
                            : () => {};
                    const unsubscribe = backend.bus.subscribe((e) => {
                        if (projectId === "*" || e.projectId === projectId) enqueue(changeFrame(e));
                    });
                    const ping = setInterval(() => enqueue(PING), PING_MS);
                    cleanup = () => {
                        cleanup = () => {};
                        this.open -= 1;
                        clearInterval(ping);
                        unsubscribe();
                        unwatchAgents();
                        unwatchMentions();
                        unregister();
                        try {
                            controller.close();
                        } catch {
                            // already closed
                        }
                    };
                    req.signal.addEventListener("abort", () => cleanup());
                },
                cancel() {
                    cleanup();
                },
            },
            new ByteLengthQueuingStrategy({ highWaterMark: BUFFER_BYTES })
        );
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            },
        });
    }
}

/** `GET /projects/:id/events`. The id `*` is every project, for a credential that may see them all. */
export const eventRoutes: Routes = async ({ method, principal, url, req, match }, app) => {
    const events = match(/^\/projects\/([^/]+)\/events$/);
    if (!events || method !== "GET") return null;
    const projectId = events[0] === "*" ? "*" : projectIdFrom(events[0]);
    assertAccess(principal, projectId);
    return app.streams.stream(req, projectId, url.searchParams.get("agent") === "1");
};
