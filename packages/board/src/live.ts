import type { Annotation, Status } from "@notato/schema";
import { useEffect, useState } from "react";
import { getMe, signedOut } from "./api.ts";
import { later } from "./model.ts";

/** One change on the server, from the stream every project shares. */
export interface LiveEvent {
    type: "created" | "updated" | "replied" | "deleted";
    projectId: string;
    id: string;
    annotation?: Annotation;
    /** What the note was before the change, from servers that say. */
    previous?: { status?: Status };
}

type Listener = (event: LiveEvent) => void;

export type LiveState = "connecting" | "live" | "offline";

/** The part of an EventSource the hub uses, so a test can stand in for it. */
export interface StreamLike {
    readonly readyState: number;
    onerror: ((ev: Event) => void) | null;
    addEventListener(type: string, fn: (ev: Event) => void): void;
    close(): void;
}

export interface LiveOptions {
    open(url: string): StreamLike;
    /**
     * Asked when the stream is refused (the browser gives up on a 401, a 502…): false means the session is over, and the
     * person is sent to sign in instead of retrying.
     */
    signedIn(): Promise<boolean>;
    onSignedOut(): void;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

/** EventSource.CLOSED: the browser will not try again by itself. */
const CLOSED = 2;

/** How long to wait before the `attempt`th reopen: 1 s, doubling, at most 30 s. */
export const retryDelay = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);

/**
 * One stream for the whole board (`/projects/*\/events`), open while anything listens. A dropped connection the
 * browser retries by itself; one it gives up on (the server answered with an error) is reopened here with backoff,
 * unless the session is over, which sends the person to sign in.
 */
export function createLive(options: LiveOptions) {
    const listeners = new Set<Listener>();
    /** Called when the stream comes back after a gap: anything could have changed meanwhile, so reload. */
    const resyncs = new Set<() => void>();
    const states = new Set<() => void>();
    let source: StreamLike | null = null;
    let retry: unknown = null;
    let attempts = 0;
    let live = false;
    let connectedBefore = false;
    let users = 0;

    const setLive = (next: boolean) => {
        if (next === live) return;
        live = next;
        for (const fn of states) fn();
    };

    const close = () => {
        if (retry !== null) options.clearTimeout(retry);
        retry = null;
        source?.close();
        source = null;
        setLive(false);
    };

    const open = () => {
        if (source || retry !== null || users === 0) return;
        const stream = options.open("/projects/*/events");
        source = stream;
        const forward = (type: LiveEvent["type"]) => (ev: Event) => {
            try {
                const data = JSON.parse((ev as MessageEvent<string>).data) as Omit<
                    LiveEvent,
                    "type"
                >;
                for (const fn of [...listeners]) fn({ ...data, type });
            } catch {
                // ignored; the next full load repairs any drift
            }
        };
        for (const type of ["created", "updated", "replied", "deleted"] as const) {
            stream.addEventListener(type, forward(type));
        }
        stream.addEventListener("hello", () => {
            if (stream !== source) return;
            const again = connectedBefore;
            connectedBefore = true;
            attempts = 0;
            setLive(true);
            if (again) for (const fn of [...resyncs]) fn();
        });
        stream.onerror = () => {
            if (stream !== source) return;
            setLive(false);
            // Still CONNECTING: a dropped connection the browser is already retrying.
            if (stream.readyState !== CLOSED) return;
            stream.close();
            source = null;
            const wait = retryDelay(attempts++);
            options.signedIn().then(
                (yes) => {
                    // Signed out: nothing to retry until the person signs in again, which opens a new stream.
                    if (yes) reopenAfter(wait);
                    else options.onSignedOut();
                },
                // The server cannot even say who this is (it is down, say): keep trying.
                () => reopenAfter(wait)
            );
        };
    };

    const reopenAfter = (ms: number) => {
        if (users === 0 || source || retry !== null) return;
        retry = options.setTimeout(() => {
            retry = null;
            open();
        }, ms);
    };

    /** Keeps the stream open until the returned function is called. */
    const use = () => {
        users += 1;
        open();
        let done = false;
        return () => {
            if (done) return;
            done = true;
            users = Math.max(0, users - 1);
            if (users === 0) close();
        };
    };

    return {
        /** Every change on the server as it happens. `onResync` runs when the stream reconnects after a gap. */
        subscribe(fn: Listener, onResync?: () => void): () => void {
            listeners.add(fn);
            if (onResync) resyncs.add(onResync);
            const release = use();
            return () => {
                listeners.delete(fn);
                if (onResync) resyncs.delete(onResync);
                release();
            };
        },
        /** Follows the connection's state; keeps the stream open meanwhile. */
        watch(fn: () => void): () => void {
            states.add(fn);
            const release = use();
            return () => {
                states.delete(fn);
                release();
            };
        },
        state(): LiveState {
            return live ? "live" : connectedBefore ? "offline" : "connecting";
        },
    };
}

/** The board's one stream. */
const hub = createLive({
    open: (url) => new EventSource(url),
    signedIn: async () => {
        const me = await getMe();
        return !me.authRequired || me.authenticated;
    },
    onSignedOut: signedOut,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/** Every change on the server as it happens. `onResync` runs when the stream reconnects after a gap. */
export function onLive(fn: Listener, onResync?: () => void): () => void {
    if (typeof EventSource === "undefined") return () => {};
    return hub.subscribe(fn, onResync);
}

/** Whether the board is getting changes as they happen; "connecting" until the stream first answers. */
export function useLiveState(): LiveState {
    const [state, setState] = useState(hub.state);
    useEffect(() => {
        if (typeof EventSource === "undefined") return;
        const update = () => setState(hub.state());
        const stop = hub.watch(update);
        update();
        return stop;
    }, []);
    return state;
}

// ---- what this browser has already seen, so new activity can be marked -------------------------------------
//
// What is kept is the newest activity time the server reported while the person was looking, never this browser's
// clock: the dots compare it with the server's own times, and two clocks need not agree.

const seenKey = (project: string) => `notato.seen.${project}`;

/** The newest activity this browser has seen in the project, or null if it never looked. */
export function lastSeen(project: string): string | null {
    try {
        return localStorage.getItem(seenKey(project));
    } catch {
        return null;
    }
}

const seenListeners = new Set<() => void>();

/**
 * The person has seen the project as of `at`, a time the server reported (its latest activity, a note's last reply).
 * It only moves forward, so an older note changing never brings back a dot for what was already seen.
 */
export function markSeen(project: string, at: string | null | undefined) {
    if (!at) return;
    const before = lastSeen(project);
    const next = later(before, at);
    if (next === before) return;
    try {
        localStorage.setItem(seenKey(project), next ?? at);
    } catch {
        // marked for this visit only, which is all a broken storage allows
    }
    for (const fn of seenListeners) fn();
}

/** Re-renders when any project is marked seen, so the sidebar's dots follow along. */
export function useSeenVersion(): number {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const bump = () => setVersion((v) => v + 1);
        seenListeners.add(bump);
        return () => {
            seenListeners.delete(bump);
        };
    }, []);
    return version;
}

/** Something happened in the project since this browser last looked. A project never opened here counts as seen. */
export function hasUnseen(project: string, lastActivityAt: string | undefined): boolean {
    if (!lastActivityAt) return false;
    const seen = lastSeen(project);
    return seen !== null && Date.parse(lastActivityAt) > Date.parse(seen);
}
