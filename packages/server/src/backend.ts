import {
    assetsFor,
    awaitsAgent,
    BundleError,
    buildBundle,
    PEOPLE_ONLY_TEXT,
    readBundle,
    streamBundle,
} from "@notato/core";
import {
    Annotation,
    type Author,
    type Severity,
    type Status,
    type VariantOption,
    Variants,
} from "@notato/schema";
import { ulid } from "ulid";
import { AgentPresence } from "./agents.ts";
import { UnknownProjectError } from "./auth.ts";
import { type ConfigSource, defaultConfig } from "./config.ts";
import { EventBus, type EventType } from "./events.ts";
import { MentionRegistry } from "./mentions.ts";
import { type RelayArgs, RelayHub, type RelayResult } from "./relay.ts";
import {
    type AnnotationFilter,
    type BlobStore,
    type BundleRecord,
    type HandedEntry,
    inProjects,
    type ProjectRecord,
    type Store,
    type StoredAnnotation,
    sniffImageMime,
} from "./storage.ts";

export interface ImportResult {
    bundleId: string;
    projectId: string;
    imported: number;
    /** Annotations already present (same id), left untouched. Importing twice is safe. */
    skipped: number;
}

/** What an agent offers for a person to choose between. */
export interface VariantOffer {
    group: string;
    /** The original first, then each new version. */
    options: VariantOption[];
    /** Shown in the thread. A default listing the options is used when absent. */
    note?: string;
}

export interface AssetBytes {
    bytes: Uint8Array;
    mime: string;
}

/**
 * Everything the MCP tools need. `LocalBackend` implements it over the store; `RemoteBackend` over HTTP,
 * which is how a second `notato dev` attaches to the first.
 */
export interface Backend {
    list(filter?: AnnotationFilter): Promise<StoredAnnotation[]>;
    get(id: string): Promise<StoredAnnotation | null>;
    /** Records follow-ups as delivered to an agent, so another session (or a restart) is not handed them again. */
    markHanded(entries: HandedEntry[]): Promise<void>;
    asset(id: string): Promise<AssetBytes | null>;
    setStatus(
        id: string,
        status: Status,
        note?: string,
        author?: Author
    ): Promise<StoredAnnotation | null>;
    reply(id: string, body: string, author?: Author): Promise<StoredAnnotation | null>;
    /**
     * The agent has put several versions in the code for the person to compare. The annotation stays (or becomes)
     * acknowledged, with `variants` set, and any earlier pick is cleared.
     */
    offerVariants(
        id: string,
        offer: VariantOffer,
        author?: Author
    ): Promise<StoredAnnotation | null>;
    /** The person's pick among what was offered, or `null` to take a pick back. */
    chooseVariant(
        id: string,
        name: string | null,
        note?: string,
        author?: Author
    ): Promise<StoredAnnotation | null>;
    /** Resolves true as soon as an annotation matching `filter` exists, false on timeout or abort. */
    waitForNew(filter: AnnotationFilter, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
    /** Loads a bundle zip into the store. */
    importBundle(zip: Uint8Array): Promise<ImportResult>;
    /**
     * Asks a connected page to annotate an element, for agents that cannot reach the page themselves.
     * Rejects with a message the agent can act on when no page is connected or none answers in time.
     */
    requestAnnotation(
        projectId: string | undefined,
        args: RelayArgs,
        timeoutMs: number
    ): Promise<RelayResult>;
}

/** Raised for input the caller can fix; the HTTP layer turns it into a 4xx. */
export class RequestError extends Error {
    constructor(
        message: string,
        readonly status = 400
    ) {
        super(message);
    }
}

const HUMAN: Author = { kind: "human" };

/** Statuses after which nothing more is expected; going back to open from one is a reopen. */
const FINISHED = new Set<Status>(["resolved", "dismissed", "reverted"]);

/** What a PATCH may change, all at once. */
export interface AnnotationChange {
    status?: Status;
    severity?: Severity | null;
    comment?: string;
    /** Recorded as a reply alongside a status change. */
    note?: string;
    /** People only on or off. Only a person can change it, and each change is recorded in the thread. */
    peopleOnly?: boolean;
}

export function matchesFilter(stored: StoredAnnotation, f: AnnotationFilter): boolean {
    const a = stored.annotation;
    if (!inProjects(f.projectId, a.projectId)) return false;
    if (
        f.status !== undefined &&
        !(Array.isArray(f.status) ? f.status : [f.status]).includes(a.status)
    )
        return false;
    if (f.route !== undefined && a.route !== f.route) return false;
    if (f.severity !== undefined && a.severity !== f.severity) return false;
    if (
        f.intent !== undefined &&
        !(Array.isArray(f.intent) ? f.intent : [f.intent]).includes(
            a.intent as NonNullable<typeof a.intent>
        )
    )
        return false;
    if (f.bundleId === null && a.bundleId !== null) return false;
    if (typeof f.bundleId === "string" && a.bundleId !== f.bundleId) return false;
    if (f.authorKind !== undefined && a.author.kind !== f.authorKind) return false;
    if (
        f.authorName === null
            ? a.author.name !== undefined
            : f.authorName !== undefined && a.author.name !== f.authorName
    )
        return false;
    if (f.afterSeq !== undefined && stored.seq <= f.afterSeq) return false;
    if (f.excludeIds?.includes(a.id)) return false;
    if (f.diagnostic === false && a.context?.notatoDiagnostic === true) return false;
    if (f.lastReplyBy === "human" && !awaitsAgent(a)) return false;
    if (f.peopleOnly === false && a.peopleOnly) return false;
    return true;
}

export interface LocalBackendOptions {
    /**
     * Whether a note for a project the server does not have creates it. True for `notato dev`, where whoever runs it
     * owns it and an app should just work; false for `notato serve`, where an admin creates projects (and their tokens)
     * first, so a typo or a stray app cannot invent one.
     */
    autoCreateProjects?: boolean;
}

/** The longest project name kept. */
const PROJECT_NAME_MAX = 80;

/** The most replies a note takes (status notes from the agent still go on): see `reply`. */
export const MAX_REPLIES = 1000;

/**
 * What is too large in a note as it arrives, or undefined. The edit and reply endpoints cap their text; a note itself
 * came with no limit but the upload's, so one could carry megabytes into every list page, event and agent's context.
 */
export function oversized(a: Annotation): string | undefined {
    if (a.comment.length > 10_000) return "the comment is over 10,000 characters";
    if (a.url.length > 4096) return "the url is over 4,096 characters";
    if (a.route.length > 2048) return "the route is over 2,048 characters";
    if (a.target.identity.length > 50) return "more than 50 elements";
    if ((a.target.selectedText?.length ?? 0) > 10_000)
        return "the selected text is over 10,000 characters";
    if (a.thread.length > MAX_REPLIES) return `more than ${MAX_REPLIES} replies`;
    if (a.thread.some((r) => r.body.length > 10_000)) return "a reply is over 10,000 characters";
    if ((a.steps?.length ?? 0) > 500) return "more than 500 steps";
    if (JSON.stringify(a.context).length > 512 * 1024) return "the context is over 512 kB";
    return undefined;
}

export class LocalBackend implements Backend {
    readonly autoCreateProjects: boolean;

    constructor(
        readonly store: Store,
        readonly blobs: BlobStore,
        readonly bus: EventBus = new EventBus(),
        readonly relay: RelayHub = new RelayHub(),
        /** The settings in force (see `notato config`). Read on every use, so a change applies without a restart. */
        readonly config: ConfigSource = defaultConfig,
        options: LocalBackendOptions = {}
    ) {
        this.autoCreateProjects = options.autoCreateProjects ?? true;
        // An agent only counts as there while the server lets agents in.
        this.agents.allowed = () => this.config().mcp;
    }

    /** The agents with Notato's MCP open, here or attached: what pages show as connected. */
    readonly agents = new AgentPresence();

    /** What people can call with `@name` in a note or a reply: the mention plugins (`@jira`, `@slack`), none built in. */
    readonly mentions = new MentionRegistry();

    requestAnnotation(projectId: string | undefined, args: RelayArgs, timeoutMs: number) {
        return this.relay.request(projectId, args, timeoutMs);
    }

    list(filter?: AnnotationFilter) {
        return this.store.listAnnotations(filter);
    }

    markHanded(entries: HandedEntry[]) {
        return entries.length ? this.store.markHanded(entries) : Promise.resolve();
    }

    get(id: string) {
        return this.store.getAnnotation(id);
    }

    asset(id: string) {
        return this.blobs.get(id);
    }

    /**
     * Validates an incoming annotation, stores its screenshot bytes content-addressed, and rewrites the
     * asset references to the canonical ids. Idempotent on `annotation.id`, so a client retry is safe.
     *
     * Live annotations always start `open` with an empty thread: a client cannot pre-resolve its own note. The one thing
     * kept is the record of a person turning People only on or off before the note was sent, so the thread says who did.
     */
    async ingest(
        raw: unknown,
        files: ReadonlyMap<string, Uint8Array>,
        options: { projectId?: string; preserveLifecycle?: boolean; bundleId?: string | null } = {}
    ): Promise<{ stored: StoredAnnotation; created: boolean }> {
        const parsed = Annotation.safeParse(raw);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new RequestError(
                `invalid annotation: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`
            );
        }
        let annotation = parsed.data;
        if (options.projectId !== undefined && annotation.projectId !== options.projectId) {
            throw new RequestError(
                `annotation.projectId "${annotation.projectId}" does not match the URL project "${options.projectId}"`
            );
        }

        const tooLarge = oversized(annotation);
        if (tooLarge) throw new RequestError(`annotation too large: ${tooLarge}`, 413);

        const existing = await this.store.getAnnotation(annotation.id);
        if (existing) return { stored: this.sameProject(existing, annotation), created: false };
        await this.ensureProject(annotation.projectId);

        type Ref = NonNullable<Annotation["screenshots"]>["full"];
        /** A screenshot's bytes, checked: nothing is written until every screenshot of the note is good. */
        const bytesOf = async (ref: Ref) => {
            // Bytes already stored may be reused (a retry, a re-import), but only from a note of the same project:
            // knowing a screenshot's hash must not be a way to copy it out of another project.
            const reusable = async () =>
                (await this.store.projectsWithAsset(ref.id)).includes(annotation.projectId)
                    ? (await this.blobs.get(ref.id))?.bytes
                    : undefined;
            const bytes = files.get(ref.id) ?? (await reusable());
            if (!bytes) throw new RequestError(`missing screenshot bytes for asset "${ref.id}"`);
            const mime = sniffImageMime(bytes);
            if (!mime) throw new RequestError("screenshots must be PNG or WebP images");
            return { ref, bytes, mime: mime as "image/png" | "image/webp" };
        };
        const store = async ({ ref, bytes, mime }: Awaited<ReturnType<typeof bytesOf>>) => {
            const { id } = await this.blobs.put(bytes);
            return { ...ref, id, mime };
        };
        if (!annotation.screenshots || !this.config().screenshots) {
            // Screenshots are off: whatever a client sent is dropped here, so none is ever stored, whatever the page did.
            annotation = { ...annotation, screenshots: undefined };
        } else {
            const full = await bytesOf(annotation.screenshots.full);
            const crop = annotation.screenshots.crop
                ? await bytesOf(annotation.screenshots.crop)
                : undefined;
            const fullRef = await store(full);
            const cropRef = crop ? await store(crop) : undefined;
            annotation = {
                ...annotation,
                screenshots: { full: fullRef, ...(cropRef ? { crop: cropRef } : {}) },
            };
        }

        if (!options.preserveLifecycle) {
            annotation = {
                ...annotation,
                status: "open",
                thread: annotation.thread.filter(
                    (r) => r.automatic && r.peopleOnly !== undefined && r.author.kind === "human"
                ),
                bundleId: options.bundleId ?? null,
            };
        } else if (options.bundleId !== undefined) {
            annotation = { ...annotation, bundleId: options.bundleId };
        }

        let stored: StoredAnnotation;
        try {
            stored = await this.store.insertAnnotation(annotation);
        } catch (error) {
            // The same note sent twice at once: the other request stored it first.
            const raced = await this.store.getAnnotation(annotation.id);
            if (!raced) throw error;
            return { stored: this.sameProject(raced, annotation), created: false };
        }
        this.emit("created", stored);
        return { stored, created: true };
    }

    /** An id is a note's for good: sending it again is a retry, but only into the project it is already in. */
    private sameProject(existing: StoredAnnotation, sent: Annotation): StoredAnnotation {
        if (existing.annotation.projectId !== sent.projectId)
            throw new RequestError(
                `an annotation with id "${sent.id}" already exists in another project`,
                409
            );
        return existing;
    }

    // ---- projects ----------------------------------------------------------------------------------------

    /** Creates the project when this server makes projects on first use; otherwise it must already exist. */
    async ensureProject(projectId: string): Promise<void> {
        if (await this.store.getProject(projectId)) return;
        if (!this.autoCreateProjects) throw new UnknownProjectError(projectId);
        await this.store.createProject({
            id: projectId,
            name: projectId,
            createdAt: new Date().toISOString(),
        });
    }

    /** Null when a project with that id already exists. */
    async createProject(id: string, name?: string): Promise<ProjectRecord | null> {
        const record = {
            id,
            name: cleanProjectName(name) || id,
            createdAt: new Date().toISOString(),
        };
        return (await this.store.createProject(record)) ? record : null;
    }

    renameProject(id: string, name: string): Promise<ProjectRecord | null> {
        const clean = cleanProjectName(name);
        if (!clean) throw new RequestError("a project name cannot be empty");
        return this.store.renameProject(id, clean);
    }

    /** Deletes the project, every note in it, and the screenshots only those notes showed. */
    async deleteProject(id: string): Promise<boolean> {
        const removed = await this.store.deleteProject(id);
        if (!removed) return false;
        for (const stored of removed) this.emit("deleted", stored, undefined, true);
        await this.forgetScreenshots(removed.map((s) => s.annotation));
        return true;
    }

    /** The projects whose notes show this screenshot; none once they are all deleted. */
    projectsWithAsset(assetId: string): Promise<string[]> {
        return this.store.projectsWithAsset(assetId);
    }

    /** Deletes the bytes of screenshots no remaining note shows. */
    private async forgetScreenshots(gone: Annotation[]) {
        const ids = new Set<string>();
        for (const a of gone) {
            if (a.screenshots?.full) ids.add(a.screenshots.full.id);
            if (a.screenshots?.crop) ids.add(a.screenshots.crop.id);
        }
        for (const id of ids) {
            if ((await this.store.projectsWithAsset(id)).length === 0) await this.blobs.delete(id);
        }
    }

    /** Severity or comment (and status, if given): all of it or, when any part is refused, none of it. */
    patch(id: string, change: AnnotationChange) {
        return this.update(id, change);
    }

    setStatus(id: string, status: Status, note?: string, author: Author = HUMAN) {
        return this.update(id, { status, note }, author);
    }

    /**
     * Changes an annotation in one step: a status change that is refused (a pick that did not go through
     * `chooseVariant`, a revert asked of something not resolved) leaves the severity and comment alone too.
     */
    async update(id: string, change: AnnotationChange, author: Author = HUMAN) {
        const { status } = change;
        if (status === "variant_chosen") {
            // A pick has to name one of the options that were offered, so it only goes through `chooseVariant`.
            throw new RequestError(
                "a variant is chosen with POST /annotations/:id/variants/choose, not by status",
                409
            );
        }
        return this.mutate(id, (a) => {
            // Checked against the stored annotation inside the update, so nothing can change it in between.
            if (status === "revert_requested" && a.status !== "resolved") {
                // Only a change that was made can be undone; asking about anything else is a mistake worth saying so.
                throw new RequestError(
                    `only a resolved annotation can have its revert requested (this one is ${a.status})`,
                    409
                );
            }
            const next = { ...a };
            if (change.peopleOnly !== undefined && change.peopleOnly !== Boolean(a.peopleOnly)) {
                if (author.kind !== "human")
                    throw new RequestError(
                        "only a person can turn People only on or off: it is how people keep a note from the agent",
                        403
                    );
                if (change.peopleOnly) next.peopleOnly = true;
                else delete next.peopleOnly;
                next.thread = [
                    ...next.thread,
                    {
                        ...this.makeReply(
                            author,
                            change.peopleOnly ? PEOPLE_ONLY_TEXT.on : PEOPLE_ONLY_TEXT.off,
                            true
                        ),
                        peopleOnly: change.peopleOnly,
                    },
                ];
            }
            if (change.comment !== undefined) next.comment = change.comment;
            if (change.severity === null) next.severity = undefined;
            else if (change.severity) next.severity = change.severity;
            if (status) {
                next.status = status;
                // Reopening something finished is something to tell a watching agent, note or not: the thread says so.
                const note =
                    change.note ||
                    (status === "open" && FINISHED.has(a.status) && author.kind === "human"
                        ? "Reopened."
                        : undefined);
                if (note) next.thread = [...next.thread, this.makeReply(author, note)];
            }
            return next;
        });
    }

    /** Applies `change` to the stored annotation atomically and announces the result, with what it was before. */
    private async mutate(
        id: string,
        change: (current: Annotation) => Annotation,
        type: EventType = "updated"
    ): Promise<StoredAnnotation | null> {
        let before: Annotation | undefined;
        const updated = await this.store.updateAnnotation(id, (current) => {
            before = current;
            return change(current);
        });
        if (updated) this.emit(type, updated, before);
        return updated;
    }

    async offerVariants(
        id: string,
        offer: VariantOffer,
        author: Author = { kind: "agent", name: "Agent" }
    ) {
        const current = await this.store.getAnnotation(id);
        if (!current) return null;
        const status = current.annotation.status;
        if (status !== "open" && status !== "acknowledged" && status !== "variant_chosen") {
            throw new RequestError(
                `variants can only be offered for an annotation that is open or acknowledged (this one is ${status})`,
                409
            );
        }
        const parsed = Variants.safeParse({ ...offer, offeredAt: new Date().toISOString() });
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new RequestError(
                `invalid variants: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`
            );
        }
        const names = parsed.data.options.map((o) => o.name);
        const repeated = names.find((n, i) => names.indexOf(n) !== i);
        if (repeated !== undefined)
            throw new RequestError(
                `variant names must be different from each other: "${repeated}" appears twice`
            );
        const note =
            offer.note?.trim() ||
            `Variants ready: ${names.join(", ")}. Switch between them in the page, then press “Use this” on the one you want.`;
        return this.mutate(id, (a) => ({
            ...a,
            status: "acknowledged",
            variants: parsed.data,
            thread: [...a.thread, this.makeReply(author, note)],
        }));
    }

    async chooseVariant(id: string, name: string | null, note?: string, author: Author = HUMAN) {
        const current = await this.store.getAnnotation(id);
        if (!current) return null;
        const { variants, status } = current.annotation;
        if (!variants)
            throw new RequestError(
                "no variants have been offered for this annotation, so there is nothing to choose",
                409
            );
        if (status !== "acknowledged" && status !== "variant_chosen") {
            throw new RequestError(
                `a variant can only be chosen while the annotation is acknowledged (this one is ${status})`,
                409
            );
        }
        if (name !== null && !variants.options.some((o) => o.name === name)) {
            throw new RequestError(
                `"${name}" is not one of the variants offered: ${variants.options.map((o) => o.name).join(", ")}`
            );
        }
        if (name === null && variants.chosen === undefined) return current; // nothing to take back
        const body =
            name === null
                ? `Took back the pick${variants.chosen ? ` (“${variants.chosen}”)` : ""}.`
                : `Picked “${name}”.`;
        const at = new Date().toISOString();
        return this.mutate(id, (a) => {
            const offered = a.variants as NonNullable<typeof a.variants>;
            const { chosen: _chosen, chosenAt: _chosenAt, ...rest } = offered;
            return {
                ...a,
                status: name === null ? "acknowledged" : "variant_chosen",
                variants: name === null ? rest : { ...rest, chosen: name, chosenAt: at },
                // With a note it is something the person said as well as did; without one it only records what they did.
                thread: [
                    ...a.thread,
                    // A pick is something the person did, note or not (the note travels with it). Taking one back with a note is
                    // something they said, which the agent should hear.
                    this.makeReply(
                        author,
                        note?.trim() ? `${body}\n${note.trim()}` : body,
                        name !== null || !note?.trim(),
                        at
                    ),
                ],
            };
        });
    }

    /** `aside`: a remark for the people on the thread, kept from the agent. Only a person's reply can be one. */
    reply(id: string, body: string, author: Author = HUMAN, options: { aside?: boolean } = {}) {
        if (options.aside && author.kind !== "human")
            throw new RequestError("only a person's reply can be an aside", 400);
        return this.mutate(
            id,
            (a) => {
                // Every reply rewrites the note, and every listener is sent it whole: a thread stops somewhere.
                if (a.thread.length >= MAX_REPLIES)
                    throw new RequestError(
                        `this note has ${MAX_REPLIES} replies, as many as a note takes: start a new note to go on`,
                        409
                    );
                return {
                    ...a,
                    thread: [
                        ...a.thread,
                        {
                            ...this.makeReply(author, body),
                            ...(options.aside ? { aside: true } : {}),
                        },
                    ],
                };
            },
            "replied"
        );
    }

    async remove(id: string): Promise<boolean> {
        const existing = await this.store.getAnnotation(id);
        if (!existing) return false;
        await this.store.deleteAnnotation(id);
        this.emit("deleted", existing);
        // A deleted note's screenshot goes with it, so a link to it (a Teams card) stops working too.
        await this.forgetScreenshots([existing.annotation]);
        return true;
    }

    waitForNew(
        filter: AnnotationFilter,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<boolean> {
        // Someone waiting for annotations is an agent watching (notato_watch, here or attached).
        const waited = this.agents.waitStarted(
            filter.projectId === undefined ? undefined : [filter.projectId].flat()
        );
        return new Promise((resolve) => {
            let finished = false;
            const finish = (value: boolean) => {
                if (finished) return;
                finished = true;
                waited();
                clearTimeout(timer);
                unsubscribe();
                signal?.removeEventListener("abort", onAbort);
                resolve(value);
            };
            const onAbort = () => finish(false);
            // Subscribe before checking the store so an annotation landing in between is not missed.
            const unsubscribe = this.bus.subscribe((event) => {
                // A change of status counts too: that is how a revert request reaches a watcher.
                if (
                    (event.type === "created" || event.type === "updated") &&
                    matchesFilter({ seq: event.seq, annotation: event.annotation }, filter)
                )
                    finish(true);
            });
            const timer = setTimeout(() => finish(false), timeoutMs);
            signal?.addEventListener("abort", onAbort);
            if (signal?.aborted) return finish(false);
            this.store.listAnnotations({ ...filter, limit: 1 }).then(
                (found) => found.length > 0 && finish(true),
                () => finish(false)
            );
        });
    }

    async importBundle(
        zip: Uint8Array,
        options: { projectId?: string } = {}
    ): Promise<ImportResult> {
        let read: ReturnType<typeof readBundle>;
        try {
            read = readBundle(zip);
        } catch (error) {
            if (error instanceof BundleError) throw new RequestError(error.message);
            throw error;
        }
        const { bundle, files } = read;
        if (options.projectId !== undefined && bundle.projectId !== options.projectId) {
            throw new RequestError(
                `bundle is for project "${bundle.projectId}", not "${options.projectId}"`
            );
        }
        // Check everything first so a bad note cannot leave a half-imported bundle behind.
        await this.ensureProject(bundle.projectId);
        for (const a of bundle.annotations) {
            const parsed = Annotation.safeParse(a);
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                throw new RequestError(
                    `annotation ${String((a as { id?: unknown }).id)}: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`
                );
            }
            if (parsed.data.projectId !== bundle.projectId)
                throw new RequestError(
                    `annotation ${parsed.data.id} is for project "${parsed.data.projectId}", not the bundle's "${bundle.projectId}"`
                );
            const existing = await this.store.getAnnotation(parsed.data.id);
            if (existing) this.sameProject(existing, parsed.data);
            for (const bytes of assetsFor(a, files).values()) {
                if (!sniffImageMime(bytes))
                    throw new RequestError(
                        `annotation ${a.id}: screenshots must be PNG or WebP images`
                    );
            }
        }
        let imported = 0;
        let skipped = 0;
        for (const a of bundle.annotations) {
            const { created } = await this.ingest(a, assetsFor(a, files), {
                projectId: bundle.projectId,
                preserveLifecycle: true,
                bundleId: bundle.id,
            });
            if (created) imported += 1;
            else skipped += 1;
        }
        await this.store.insertBundle({
            id: bundle.id,
            projectId: bundle.projectId,
            createdAt: bundle.createdAt,
            author: bundle.author,
            appName: bundle.appName,
            appVersion: bundle.appVersion,
            annotationCount: bundle.annotations.length,
            importedAt: new Date().toISOString(),
        });
        return { bundleId: bundle.id, projectId: bundle.projectId, imported, skipped };
    }

    getBundle(id: string): Promise<BundleRecord | null> {
        return this.store.getBundle(id);
    }

    listBundles(projectId?: string) {
        return this.store.listBundles(projectId);
    }

    /**
     * A zip of an imported bundle as it stands now (statuses and threads included), or of any filtered set
     * of a project's annotations, which becomes a new bundle.
     */
    async exportBundle(
        selector: { bundleId: string } | { projectId: string; filter?: AnnotationFilter }
    ): Promise<{ filename: string; zip: ReadableStream<Uint8Array> } | null> {
        let projectId: string;
        let items: StoredAnnotation[];
        let meta: Parameters<typeof buildBundle>[1];
        if ("bundleId" in selector) {
            const record = await this.store.getBundle(selector.bundleId);
            if (!record) return null;
            items = await this.store.listAnnotations({ bundleId: record.id });
            projectId = record.projectId;
            meta = {
                id: record.id,
                projectId,
                author: record.author,
                appName: record.appName,
                appVersion: record.appVersion,
                createdAt: record.createdAt,
            };
        } else {
            projectId = selector.projectId;
            items = await this.store.listAnnotations({ ...selector.filter, projectId });
            meta = { projectId };
        }
        const { bundle } = buildBundle(
            items.map((s) => ({ annotation: s.annotation, assets: new Map<string, Blob>() })),
            meta
        );
        // Re-export keeps each annotation's own bundle id when it came from one, rather than the new id.
        bundle.annotations = items.map((s, i) => ({
            ...(bundle.annotations[i] as Annotation),
            bundleId: s.annotation.bundleId ?? bundle.id,
        }));
        // Streamed, a screenshot at a time: a project of thousands of notes with screenshots would not fit in memory whole.
        const zip = streamBundle(bundle, async (ref) => (await this.blobs.get(ref.id))?.bytes, {
            compact: true,
        });
        return { filename: `notato-${projectId}-${bundle.id}.zip`, zip };
    }

    private makeReply(
        author: Author,
        body: string,
        automatic = false,
        at = new Date().toISOString()
    ) {
        return { id: ulid(), author, body, createdAt: at, ...(automatic ? { automatic } : {}) };
    }

    private emit(type: EventType, stored: StoredAnnotation, before?: Annotation, bulk?: true) {
        const event = {
            type,
            ...(bulk ? { bulk } : {}),
            projectId: stored.annotation.projectId,
            id: stored.annotation.id,
            seq: stored.seq,
            annotation: stored.annotation,
            ...(before
                ? {
                      previous: {
                          status: before.status,
                          offeredAt: before.variants?.offeredAt,
                      },
                  }
                : {}),
        };
        this.bus.publish(event);
        // Mention plugins hear about it here rather than on the bus, which counts the pages and watches listening.
        this.mentions.handle(event);
    }
}

/** A project name as kept: one line, trimmed, at most PROJECT_NAME_MAX characters. */
function cleanProjectName(name: string | undefined): string {
    return (name ?? "").replace(/\s+/g, " ").trim().slice(0, PROJECT_NAME_MAX);
}
