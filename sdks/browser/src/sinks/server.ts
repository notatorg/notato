import type { AssetMap, SinkPlugin } from "@notato/core";
import type { Annotation, Bundle } from "@notato/schema";
import { authHeaders } from "../auth.ts";
import { net } from "../net.ts";
import { bundleToZip } from "./zip.ts";

export interface ServerSinkOptions {
    baseUrl: string;
    project: string;
    /** Project token for a server that needs one (serve mode). */
    token?: string;
    /**
     * `annotations` posts each one as it is made (dev and agent mode). `bundles` posts only packaged
     * bundles, because in test mode annotations travel inside the bundle.
     */
    delivers?: "annotations" | "bundles";
    /** First retry delay for an unreachable server; doubles up to a minute. */
    retryMs?: number;
    /** Called whenever the number of annotations waiting to be sent changes. */
    onPending?(count: number): void;
    /** An annotation reached the server. */
    onSent?(id: string): void;
    /** The server refused an annotation for good, and said why. The ones queued after it are still sent. */
    onRefused?(id: string, message: string): void;
    /**
     * What the server said when it would not take annotations for now (a project it does not have, a missing token),
     * or undefined once it takes them again. They stay queued meanwhile.
     */
    onProblem?(message: string | undefined): void;
}

export interface ServerSink extends SinkPlugin {
    /** Always present on this sink: it registers the `online` listener and the retry timer. */
    setup(): undefined | (() => void);
    /** Tries to send everything waiting now. */
    flush(): Promise<void>;
    pending(): number;
    /** Annotations the server does not have: waiting to be sent, or refused. */
    unsent(): string[];
    /** What the server said when it refused an annotation for good; undefined for any other. */
    refusal(id: string): string | undefined;
    /** What the server last said when it would not take annotations for now; undefined while it takes them. */
    problem(): string | undefined;
    /** What is waiting, screenshots and all, so a remounted toolbar can carry on with it. */
    queued(): Queued[];
    /** Takes back annotations not sent before (a reload, a remount). Refused ones are only remembered, not sent. */
    restore(items: Array<Queued & { refused?: string }>): void;
    /**
     * Drops an annotation that will not be sent after all (deleted). Waits for a send of it already under way, and
     * says whether the server may have it: then it has to be deleted there too.
     */
    discard(id: string): Promise<boolean>;
}

export interface Queued {
    annotation: Annotation;
    assets: AssetMap;
}

type Outcome =
    | { kind: "sent" }
    | { kind: "retry"; said?: string }
    | { kind: "refused"; said: string };

/**
 * The server understood the annotation and will never take it: retrying the same bytes would fail the same way.
 * Anything else that is not a success (401, 403, 404 for a project it does not have, 408, 429, 5xx) may pass later.
 */
const REFUSED = new Set([400, 409, 413, 415, 422]);

export function buildAnnotationForm(annotation: Annotation, assets: AssetMap): FormData {
    const form = new FormData();
    form.set("annotation", JSON.stringify(annotation));
    for (const ref of [annotation.screenshots?.full, annotation.screenshots?.crop]) {
        const blob = ref && assets.get(ref.id);
        if (blob) form.set(`asset:${ref.id}`, blob, ref.id);
    }
    return form;
}

/**
 * Posts annotations to the Notato server. If the server is unreachable the annotation is kept and sent
 * later, so a note made while the dev server was down still reaches the agent.
 */
export function serverSink(options: ServerSinkOptions): ServerSink {
    const base = options.baseUrl.replace(/\/$/, "");
    const queue = new Map<string, Queued>();
    const refused = new Map<string, string>();
    const initialDelay = options.retryMs ?? 3000;
    let delay = initialDelay;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flushing: Promise<void> | undefined;
    let sending: { id: string; done: Promise<Outcome | undefined> } | undefined;
    let problem: string | undefined;
    let stopped = false;

    const notify = () => options.onPending?.(queue.size);
    const setProblem = (next: string | undefined) => {
        if (next === problem) return;
        problem = next;
        options.onProblem?.(next);
    };

    const post = async ({ annotation, assets }: Queued): Promise<Outcome> => {
        let res: Response;
        try {
            res = await net.fetch(
                `${base}/projects/${encodeURIComponent(options.project)}/annotations`,
                {
                    method: "POST",
                    headers: authHeaders(options.token),
                    body: buildAnnotationForm(annotation, assets),
                }
            );
        } catch {
            return { kind: "retry" };
        }
        if (res.ok) return { kind: "sent" };
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        const said = detail?.error ?? `the server answered ${res.status}`;
        if (!REFUSED.has(res.status)) return { kind: "retry", said };
        console.warn(`[notato] the server refused annotation ${annotation.id}: ${said}`);
        return { kind: "refused", said };
    };

    /** Bundles are not queued: the tester has the zip too, and is told when the upload fails. */
    const uploadBundle = async (bundle: Bundle, assets: AssetMap) => {
        let res: Response;
        try {
            res = await net.fetch(
                `${base}/projects/${encodeURIComponent(options.project)}/bundles`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/zip", ...authHeaders(options.token) },
                    body: (await bundleToZip(bundle, assets)) as BodyInit,
                }
            );
        } catch {
            throw new Error(`could not reach the server at ${base}`);
        }
        if (!res.ok) {
            const detail = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(`the server rejected the bundle: ${detail?.error ?? res.status}`);
        }
    };

    const schedule = () => {
        if (timer || stopped || queue.size === 0) return;
        timer = setTimeout(() => {
            timer = undefined;
            void flush();
        }, delay);
        delay = Math.min(delay * 2, 60_000);
    };

    const flush = (): Promise<void> => {
        flushing ??= (async () => {
            // In order, and including any queued while this flush is under way.
            const tried = new Set<string>();
            for (;;) {
                const next = [...queue].find(([id]) => !tried.has(id));
                if (!next) break;
                const [id, item] = next;
                tried.add(id);
                const attempt = post(item);
                sending = { id, done: attempt.catch(() => undefined) };
                const outcome = await attempt;
                sending = undefined;
                if (!queue.has(id)) continue; // deleted while it was on its way: whoever deleted it handles the rest
                if (outcome.kind === "retry") {
                    // An answer says why (shown to the person); no answer is the connection, which says so itself.
                    if (outcome.said) setProblem(outcome.said);
                    break;
                }
                queue.delete(id);
                delay = initialDelay;
                setProblem(undefined);
                if (outcome.kind === "sent") options.onSent?.(id);
                else {
                    refused.set(id, outcome.said);
                    options.onRefused?.(id, outcome.said);
                }
            }
            notify();
            schedule();
        })().finally(() => {
            flushing = undefined;
        });
        return flushing;
    };

    return {
        id: "server",
        pending: () => queue.size,
        unsent: () => [...queue.keys(), ...refused.keys()],
        refusal: (id) => refused.get(id),
        problem: () => problem,
        queued: () => [...queue.values()],
        restore(items) {
            for (const { refused: why, ...item } of items) {
                if (why) refused.set(item.annotation.id, why);
                else queue.set(item.annotation.id, item);
            }
            notify();
        },
        async discard(id) {
            const waiting = queue.delete(id);
            const wasRefused = refused.delete(id);
            if (waiting) notify();
            if (sending?.id === id) return (await sending.done)?.kind === "sent";
            // Neither waiting nor refused: it was sent, or came from the server in the first place.
            return !waiting && !wasRefused;
        },
        flush,
        setup() {
            stopped = false;
            const onOnline = () => void flush();
            window.addEventListener("online", onOnline);
            return () => {
                stopped = true;
                if (timer) clearTimeout(timer);
                timer = undefined;
                window.removeEventListener("online", onOnline);
            };
        },
        async deliver(input: Annotation | Bundle, assets: AssetMap) {
            const delivers = options.delivers ?? "annotations";
            if ("annotations" in input) {
                if (delivers === "bundles") await uploadBundle(input, assets);
                return;
            }
            if (delivers === "bundles") return;
            queue.set(input.id, { annotation: input, assets });
            notify();
            await flush();
        },
    };
}
