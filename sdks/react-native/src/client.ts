import type { Annotation, Author } from "@notato/schema";
import { createEventParser, type ServerEvent } from "./events.ts";

/** A note as the server keeps it: `seq` orders every note it has. */
export interface StoredAnnotation {
    seq: number;
    annotation: Annotation;
}

export interface Connection {
    server: string;
    project: string;
    token?: string;
}

/** What went wrong talking to the server: its reason and status, or no status when it could not be reached. */
export class NotatoError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
    }

    /** The server will not take this app as it is (a missing or wrong token, a project it cannot use): not a blip. */
    get permanent(): boolean {
        return (
            this.status !== undefined &&
            this.status >= 400 &&
            this.status < 500 &&
            this.status !== 408 &&
            this.status !== 429
        );
    }

    /**
     * The server will never take this note as it is (malformed, too large, an id it has for another): it is marked
     * failed and the notes after it are still sent. Anything else (401, 403, an unknown project's 404, 408, 429, 5xx,
     * no answer) is about the server or the app rather than the note, and holds the queue for a later try.
     */
    get refusesNote(): boolean {
        return this.status !== undefined && [400, 409, 413, 415, 422].includes(this.status);
    }
}

const auth = (c: Connection): Record<string, string> =>
    c.token ? { Authorization: `Bearer ${c.token}` } : {};
const segment = encodeURIComponent;

/** A request through React Native's own XMLHttpRequest, which sends bytes as they are, in every app. */
function request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string | Uint8Array,
    timeoutMs = 60_000
): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        xhr.timeout = timeoutMs;
        xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
        xhr.onerror = () =>
            reject(
                new NotatoError(
                    `cannot reach the Notato server at ${url.split("/").slice(0, 3).join("/")}`
                )
            );
        xhr.ontimeout = () => reject(new NotatoError("the Notato server did not answer in time"));
        // A Uint8Array is sent as its bytes; React Native's networking takes an ArrayBuffer view.
        xhr.send((body ?? null) as never);
    });
}

async function call<T>(
    c: Connection,
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json"
): Promise<T> {
    const payload =
        body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body);
    const res = await request(
        method,
        `${c.server}${path}`,
        {
            ...auth(c),
            ...(payload === undefined ? {} : { "Content-Type": contentType }),
        },
        payload
    );
    let parsed: unknown;
    try {
        parsed = res.text ? JSON.parse(res.text) : undefined;
    } catch {
        parsed = undefined;
    }
    if (res.status < 200 || res.status >= 300) {
        const reason = (parsed as { error?: unknown } | undefined)?.error;
        throw new NotatoError(
            typeof reason === "string" ? reason : `the server answered ${res.status}`,
            res.status
        );
    }
    return parsed as T;
}

const encoder = new TextEncoder();

/** The multipart body every SDK sends a note as: the note's JSON, then each screenshot as an `asset:<id>` file. */
export function multipart(
    annotation: Annotation,
    files: Array<{ id: string; bytes: Uint8Array }>,
    boundary: string
): Uint8Array {
    const parts: Uint8Array[] = [];
    const text = (s: string) => parts.push(encoder.encode(s));
    text(
        `--${boundary}\r\nContent-Disposition: form-data; name="annotation"\r\nContent-Type: application/json\r\n\r\n`
    );
    text(JSON.stringify(annotation));
    text("\r\n");
    for (const file of files) {
        text(
            `--${boundary}\r\nContent-Disposition: form-data; name="asset:${file.id}"; filename="${file.id}.png"\r\nContent-Type: image/png\r\n\r\n`
        );
        parts.push(file.bytes);
        text("\r\n");
    }
    text(`--${boundary}--\r\n`);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** Sends a note and its screenshots. Returns it as the server stored it. */
export function sendAnnotation(
    c: Connection,
    annotation: Annotation,
    files: Array<{ id: string; bytes: Uint8Array }>
): Promise<StoredAnnotation> {
    const boundary = `notato-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return call(
        c,
        "POST",
        `/projects/${segment(c.project)}/annotations`,
        multipart(annotation, files, boundary),
        `multipart/form-data; boundary=${boundary}`
    );
}

/** The most pages a list reads: 50,000 notes. */
const MAX_PAGES = 100;

/**
 * Every note in the project, oldest first, page by page, without what the app never shows (a note's context and an
 * agent's steps: `fields=summary`, which older servers ignore). Throws when the list cannot be read to its end (too many
 * pages, or a server whose pages do not move on): a list cut short would look like deletions.
 */
export async function listAnnotations(c: Connection): Promise<StoredAnnotation[]> {
    const all: StoredAnnotation[] = [];
    let after: number | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
        const body = await call<{ items: StoredAnnotation[]; next?: number }>(
            c,
            "GET",
            `/projects/${segment(c.project)}/annotations?limit=500&fields=summary${after === undefined ? "" : `&afterSeq=${after}`}`
        );
        all.push(...(Array.isArray(body?.items) ? body.items : []));
        const next = body?.next;
        if (next === undefined || next === null) return all;
        if (typeof next !== "number" || (after !== undefined && next <= after))
            throw new NotatoError(
                "the server's list of notes did not move on from one page to the next"
            );
        after = next;
    }
    throw new NotatoError(`the project has more notes than Notato reads (${MAX_PAGES} pages)`);
}

export const reply = (c: Connection, id: string, body: string, author: Author, aside: boolean) =>
    call<StoredAnnotation>(c, "POST", `/annotations/${segment(id)}/replies`, {
        body,
        author,
        ...(aside ? { aside: true } : {}),
    });

export const setStatus = (
    c: Connection,
    id: string,
    status: Annotation["status"],
    note: string,
    author: Author
) => call<StoredAnnotation>(c, "PATCH", `/annotations/${segment(id)}`, { status, note, author });

export const setPeopleOnly = (c: Connection, id: string, peopleOnly: boolean, author: Author) =>
    call<StoredAnnotation>(c, "PATCH", `/annotations/${segment(id)}`, { peopleOnly, author });

export const deleteAnnotation = (c: Connection, id: string) =>
    call<void>(c, "DELETE", `/annotations/${segment(id)}`);

export const relayResult = (
    c: Connection,
    requestId: string,
    result: { ok: true; annotationId: string } | { ok: false; error: string }
) => call<void>(c, "POST", `/relay/${segment(requestId)}/result`, result);

/** What the server says before anything is captured: whether it takes screenshots. */
export const getConfig = (c: Connection) =>
    call<{ screenshots?: boolean }>(c, "GET", `/config?project=${segment(c.project)}`);

export const uploadBundle = (c: Connection, zip: Uint8Array) =>
    call<{ bundleId: string; imported: number }>(
        c,
        "POST",
        `/projects/${segment(c.project)}/bundles`,
        zip,
        "application/zip"
    );

export type StreamState = "connecting" | "connected" | "offline" | "refused";

const reasonOf = (text: string, status: number) => {
    try {
        const reason = (JSON.parse(text) as { error?: unknown }).error;
        if (typeof reason === "string") return reason;
    } catch {
        // not JSON
    }
    return `the server answered ${status}`;
};

/** The server says something at least every 15 seconds: a stream silent for this long has gone without saying so. */
const IDLE_MS = 45_000;

/** A stream that has run for hours: past this much text, a fresh one is opened rather than keep it all. */
const ROTATE_AT = 2_000_000;

/**
 * Follows the project's events (`/projects/:id/events`, with `agent` its relayed annotate requests too). React
 * Native's fetch cannot stream, so this reads the stream through XMLHttpRequest's progress events, and reconnects
 * when it drops or goes quiet for 45 seconds: after 1 second, then longer, up to 15, and 10 seconds after the server
 * refuses the app.
 */
export function followEvents(
    c: Connection,
    agent: boolean,
    onEvent: (event: ServerEvent) => void,
    onState: (state: StreamState, detail?: string) => void
): { stop(): void; retry(): void } {
    let stopped = false;
    let xhr: XMLHttpRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let wait = 1000;

    const open = (quietly = false) => {
        if (stopped) return;
        if (timer) clearTimeout(timer);
        if (!quietly) onState("connecting");
        const parse = createEventParser();
        const req = new XMLHttpRequest();
        xhr = req;
        /** Why this request was ended here: a fresh stream in its place, or one that went quiet. */
        let ended: "rotated" | "quiet" | undefined;
        const watch = () => {
            if (idle) clearTimeout(idle);
            idle = setTimeout(() => {
                if (xhr !== req) return;
                ended = "quiet";
                req.abort();
            }, IDLE_MS);
        };
        req.open(
            "GET",
            `${c.server}/projects/${segment(c.project)}/events${agent ? "?agent=1" : ""}`
        );
        req.setRequestHeader("Accept", "text/event-stream");
        for (const [name, value] of Object.entries(auth(c))) req.setRequestHeader(name, value);
        req.onprogress = () => {
            if (xhr !== req || !req.status || req.status < 200 || req.status >= 300) return;
            watch();
            wait = 1000;
            for (const event of parse(req.responseText)) onEvent(event);
            if (req.responseText.length > ROTATE_AT) {
                ended = "rotated";
                req.abort();
            }
        };
        const again = () => {
            if (stopped || xhr !== req) return;
            if (idle) clearTimeout(idle);
            if (ended === "rotated") {
                // Ended here on purpose: the fresh stream takes over at once, and nothing about the connection changed.
                open(true);
                return;
            }
            const ok = req.status >= 200 && req.status < 300;
            const error = new NotatoError(
                reasonOf(req.responseText ?? "", req.status),
                req.status || undefined
            );
            if (!ok && req.status && error.permanent) {
                onState("refused", error.message);
                wait = 10_000;
                timer = setTimeout(open, wait);
                return;
            }
            onState(
                "offline",
                ended === "quiet"
                    ? "The server stopped answering."
                    : ok
                      ? "The server closed the connection."
                      : req.status
                        ? error.message
                        : `cannot reach the Notato server at ${c.server}`
            );
            timer = setTimeout(open, wait);
            wait = Math.min(wait * 2, 15_000);
        };
        req.onerror = again;
        req.onload = again;
        req.onabort = again;
        // Watched from the start: a server that never answers at all is as quiet as one that stopped.
        watch();
        req.send();
    };
    open();
    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            if (idle) clearTimeout(idle);
            const old = xhr;
            xhr = undefined;
            old?.abort();
        },
        retry() {
            if (stopped) return;
            wait = 1000;
            const old = xhr;
            xhr = undefined;
            old?.abort();
            open();
        },
    };
}
