import {
    assetsFor,
    awaitsAgent,
    BundleError,
    buildBundle,
    PEOPLE_ONLY_TEXT,
    peopleOnlyRecord,
    readBundle,
    screenshotCrop,
    streamBundle,
} from "@notato/core";
import {
    Annotation,
    type Author,
    annotationAssets,
    ExternalLink,
    type Severity,
    type Status,
    type VariantOption,
    Variants,
} from "@notato/schema";
import { ulid } from "ulid";
import { AgentPresence } from "./agents.ts";
import { UnknownProjectError } from "./auth.ts";
import { sha256Hex } from "./blob-store.ts";
import { captureReceipt } from "./capture-receipt.ts";
import { type ConfigSource, defaultConfig } from "./config.ts";
import { EventBus, type EventType } from "./events.ts";
import { ImageViews } from "./image-views.ts";
import { MentionRegistry } from "./mentions.ts";
import { type RelayArgs, RelayHub, type RelayResult } from "./relay.ts";
import {
    type AnnotationFilter,
    type BlobStore,
    type BundleRecord,
    type CaptureReceipt,
    type HandedEntry,
    inProjects,
    PROJECT_ID,
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
    screenshot?(id: string, view: "crop" | "thumbnail"): Promise<AssetBytes | null>;
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

/** Inspect headers before decoding/storing any explicit reference, including bundle preflight. */
async function referenceDimensions(bytes: Uint8Array) {
    if (bytes.byteLength > 5 * 1024 * 1024)
        throw new RequestError("Reference images must be at most 5 MB each.", 413);
    try {
        const meta = await new Bun.Image(bytes).metadata();
        if (meta.width <= 0 || meta.height <= 0 || meta.width * meta.height > 16_000_000)
            throw new Error("invalid dimensions");
        return meta;
    } catch {
        throw new RequestError(
            "Reference images must be valid PNG/WebP images of at most 16 megapixels."
        );
    }
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
export const FINISHED = new Set<Status>(["resolved", "dismissed", "reverted"]);

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

/**
 * Where an extension steps in on what the backend does. Each runs before the change is made, and throwing a
 * `RequestError` refuses it with that message and status (402 for a limit reached, say).
 */
export interface BackendHooks {
    /** A new note is about to be stored. `assetBytes` is the size of its screenshots. */
    beforeIngest?(annotation: Annotation, assetBytes: number): void | Promise<void>;
    /** A project is about to be created through `createProject`. */
    beforeCreateProject?(project: ProjectRecord): void | Promise<void>;
    /**
     * A bundle the server has no record of is about to be imported, and recorded once a note of it is stored. Each of
     * its notes still goes through `beforeIngest`.
     */
    beforeImportBundle?(bundle: BundleRecord): void | Promise<void>;
}

/** What a bundle import keeps, by who sends it. */
export interface ImportOptions {
    /** The project the bundle must be for. */
    projectId?: string;
    /**
     * For a credential that speaks for people and never for an agent (an app's token, a member). Each note comes in
     * as one sent directly would: a person's (under `name`, when the credential always writes under one), open, with
     * nothing in its thread but who made it People only. Without it, a bundle's authors, statuses and threads are kept,
     * as reading back an export needs.
     */
    asPerson?: { name?: string };
    /** Send-only imports acknowledge only notes previously accepted from this credential with the same content. */
    captureScope?: string;
}

interface IngestOptions {
    projectId?: string;
    preserveLifecycle?: boolean;
    bundleId?: string | null;
    receipt?: CaptureReceipt;
}

/** The most bundle records a listing holds: the newest. */
export const BUNDLE_LIST_MAX = 500;

export interface LocalBackendOptions {
    hooks?: BackendHooks;
    /** The settings in force (see `notato config`). Read on every use, so a change applies without a restart. */
    config?: ConfigSource;
    /**
     * Whether a note for a project the server does not have creates it. True for `notato dev`, where whoever runs it
     * owns it and an app should just work; false for `notato serve`, where an admin creates projects (and their tokens)
     * first, so a typo or a stray app cannot invent one.
     */
    autoCreateProjects?: boolean;
    /** Where changes are announced. Default: a bus of its own. */
    bus?: EventBus;
    /** Where `notato_annotate` requests go to pages. Default: a hub of its own. */
    relay?: RelayHub;
}

/** The longest project name kept. */
const PROJECT_NAME_MAX = 80;

/** The most replies a note takes (status notes from the agent still go on): see `reply`. */
export const MAX_REPLIES = 1000;

/** The longest comment, reply or note the server takes, in characters. */
export const TEXT_MAX = 10_000;

/** The rest of what one note may carry as it arrives. */
const NOTE_LIMITS = { url: 4096, route: 2048, elements: 50, steps: 500, contextBytes: 512 * 1024 };

const count = (n: number) => n.toLocaleString("en-US");

/**
 * What is too large in a note as it arrives, or undefined. The edit and reply endpoints cap their text; a note itself
 * came with no limit but the upload's, so one could carry megabytes into every list page, event and agent's context.
 */
export function oversized(a: Annotation): string | undefined {
    const text = `${count(TEXT_MAX)} characters`;
    if (a.comment.length > TEXT_MAX) return `the comment is over ${text}`;
    if (a.url.length > NOTE_LIMITS.url)
        return `the url is over ${count(NOTE_LIMITS.url)} characters`;
    if (a.route.length > NOTE_LIMITS.route)
        return `the route is over ${count(NOTE_LIMITS.route)} characters`;
    if (a.target.identity.length > NOTE_LIMITS.elements)
        return `more than ${NOTE_LIMITS.elements} elements`;
    if ((a.target.selectedText?.length ?? 0) > TEXT_MAX) return `the selected text is over ${text}`;
    if (a.thread.length > MAX_REPLIES) return `more than ${MAX_REPLIES} replies`;
    if (a.thread.some((r) => r.body.length > TEXT_MAX)) return `a reply is over ${text}`;
    if ((a.steps?.length ?? 0) > NOTE_LIMITS.steps) return `more than ${NOTE_LIMITS.steps} steps`;
    if (JSON.stringify(a.context).length > NOTE_LIMITS.contextBytes)
        return `the context is over ${NOTE_LIMITS.contextBytes / 1024} kB`;
    return undefined;
}

/**
 * The server's own backend: notes in a `Store`, screenshots in a `BlobStore`, and every change announced on the bus
 * (to event streams, watching agents, webhooks and mention plugins).
 */
export class LocalBackend implements Backend {
    /** The settings in force (see `notato config`). Read on every use, so a change applies without a restart. */
    readonly config: ConfigSource;
    readonly autoCreateProjects: boolean;
    readonly bus: EventBus;
    readonly relay: RelayHub;

    private assetsTurn: Promise<unknown> = Promise.resolve();
    /**
     * Uploads and deletions take turns, so a screenshot a new note reuses cannot be removed by a deletion that is
     * finishing at the same moment, before the note is stored.
     */
    protected serialAssets<T>(work: () => Promise<T>): Promise<T> {
        const next = this.assetsTurn.then(work, work);
        this.assetsTurn = next.catch(() => {});
        return next;
    }

    /** An extension's hooks, if it has any. */
    readonly hooks: BackendHooks;
    private readonly imageViews: ImageViews;
    get derivedScreenshots() {
        return this.imageViews.supported;
    }

    constructor(
        readonly store: Store,
        readonly blobs: BlobStore,
        options: LocalBackendOptions = {}
    ) {
        this.hooks = options.hooks ?? {};
        this.imageViews = new ImageViews((id) => this.asset(id));
        this.config = options.config ?? defaultConfig;
        this.autoCreateProjects = options.autoCreateProjects ?? true;
        this.bus = options.bus ?? new EventBus();
        this.relay = options.relay ?? new RelayHub();
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

    async screenshot(id: string, view: "crop" | "thumbnail"): Promise<AssetBytes | null> {
        const stored = await this.get(id);
        const shots = stored?.annotation.screenshots;
        if (!shots || !stored) return null;
        const crop = screenshotCrop(stored.annotation);
        if (view === "thumbnail" && shots.thumbnail) return this.asset(shots.thumbnail.id);
        if (view === "crop" && shots.crop) return this.asset(shots.crop.id);
        if (view === "crop" && !crop) return null;
        const source = crop ? shots.full : (shots.crop ?? shots.full);
        return this.imageViews.get(source.id, crop, view === "thumbnail");
    }

    /**
     * Validates an incoming annotation, stores its screenshot bytes content-addressed, and rewrites the
     * asset references to the canonical ids. Idempotent on `annotation.id`, so a client retry is safe.
     *
     * Live annotations always start `open` with an empty thread: a client cannot pre-resolve its own note, or offer
     * itself variants. The one thing kept is that the person who sent a People only note turned it on first, so the
     * thread says who did; the server writes that line itself.
     */
    ingest(
        raw: unknown,
        files: ReadonlyMap<string, Uint8Array>,
        options: IngestOptions = {}
    ): Promise<{ stored: StoredAnnotation; created: boolean }> {
        return this.serialAssets(() => this.ingestUnlocked(raw, files, options));
    }

    private async ingestUnlocked(
        raw: unknown,
        files: ReadonlyMap<string, Uint8Array>,
        options: IngestOptions
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

        if (annotation.review?.draft)
            throw new RequestError("Send the review before uploading its notes.");
        const tooLarge = oversized(annotation);
        if (tooLarge) throw new RequestError(`annotation too large: ${tooLarge}`, 413);

        const existing = await this.store.getAnnotation(annotation.id);
        if (existing)
            return {
                stored: await this.acceptExisting(existing, annotation, options.receipt),
                created: false,
            };
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
        const references = await Promise.all(
            (annotation.references ?? []).map(async (ref) => {
                const image = await bytesOf(ref);
                const meta = await referenceDimensions(image.bytes);
                return { ...image, ref: { ...ref, w: meta.width, h: meta.height } };
            })
        );
        const referenceBytes = references.reduce((n, r) => n + r.bytes.byteLength, 0);
        let assetBytes = referenceBytes;
        if (!annotation.screenshots || !this.config().screenshots) {
            // Screenshots are off: whatever a client sent is dropped here, so none is ever stored, whatever the page did.
            annotation = { ...annotation, screenshots: undefined };
            await this.hooks.beforeIngest?.(annotation, referenceBytes);
        } else {
            const full = await bytesOf(annotation.screenshots.full);
            let crop = annotation.screenshots.crop
                ? await bytesOf(annotation.screenshots.crop)
                : undefined;
            let thumbnail = annotation.screenshots.thumbnail
                ? await bytesOf(annotation.screenshots.thumbnail)
                : undefined;
            const region = screenshotCrop(annotation);
            const derived = async (image: typeof full, box: typeof region, small: boolean) => {
                const output = await this.imageViews.get(
                    await sha256Hex(image.bytes),
                    box,
                    small,
                    image
                );
                if (!output) return undefined;
                const dimensions = await new Bun.Image(output.bytes).metadata();
                return {
                    ref: {
                        id: "derived",
                        mime: "image/webp" as const,
                        w: dimensions.width,
                        h: dimensions.height,
                    },
                    bytes: output.bytes,
                    mime: "image/webp" as const,
                };
            };
            if (this.imageViews.supported) {
                try {
                    // Generate once from bytes already in the upload. Cold crop reads must never re-download the original.
                    if (!crop && region) crop = await derived(full, region, false);
                    if (!thumbnail)
                        thumbnail = await derived(crop ?? full, crop ? undefined : region, true);
                } catch {
                    // A preview is optional: corrupt/oversized images or a busy encoder cannot discard the note.
                }
            }
            // Checked before anything is written, so a refused note leaves no screenshot behind.
            assetBytes =
                referenceBytes +
                full.bytes.byteLength +
                (crop?.bytes.byteLength ?? 0) +
                (thumbnail?.bytes.byteLength ?? 0);
            await this.hooks.beforeIngest?.(annotation, assetBytes);
            const fullRef = await store(full);
            const cropRef = crop ? await store(crop) : undefined;
            const thumbnailRef = thumbnail ? await store(thumbnail) : undefined;
            annotation = {
                ...annotation,
                screenshots: {
                    full: fullRef,
                    ...(cropRef ? { crop: cropRef } : {}),
                    ...(thumbnailRef ? { thumbnail: thumbnailRef } : {}),
                },
            };
        }

        if (references.length)
            annotation = {
                ...annotation,
                references: await Promise.all(
                    references.map(async (image) => ({
                        ...(await store(image)),
                        name: image.ref.name,
                    }))
                ),
            };

        if (!options.preserveLifecycle) {
            annotation = {
                ...annotation,
                // Where a note went is for integrations to say, and what to choose between for the agent.
                links: undefined,
                variants: undefined,
                status: "open",
                awaitingResponse: undefined,
                thread: sentPeopleOnly(annotation),
                bundleId: options.bundleId ?? null,
            };
        } else if (options.bundleId !== undefined) {
            annotation = { ...annotation, bundleId: options.bundleId };
        }

        let stored: StoredAnnotation;
        try {
            stored = await this.store.insertAnnotation(annotation, assetBytes, options.receipt);
        } catch (error) {
            // The same note sent twice at once: the other request stored it first.
            const raced = await this.store.getAnnotation(annotation.id);
            if (!raced) throw error;
            return {
                stored: await this.acceptExisting(raced, annotation, options.receipt),
                created: false,
            };
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

    private async acceptExisting(
        existing: StoredAnnotation,
        sent: Annotation,
        receipt?: CaptureReceipt
    ): Promise<StoredAnnotation> {
        if (receipt) {
            const accepted = await this.store.getCaptureReceipt?.(sent.id);
            if (
                existing.annotation.projectId !== sent.projectId ||
                !accepted ||
                accepted.scope !== receipt.scope ||
                accepted.fingerprint !== receipt.fingerprint
            )
                throw new RequestError("annotation id conflicts with an existing submission", 409);
        }
        return this.sameProject(existing, sent);
    }

    // ---- projects ----------------------------------------------------------------------------------------

    /** Creates the project when this server makes projects on first use; otherwise it must already exist. */
    async ensureProject(projectId: string): Promise<void> {
        assertProjectId(projectId);
        if (await this.store.getProject(projectId)) return;
        if (!this.autoCreateProjects) throw new UnknownProjectError(projectId);
        await this.store.createProject({
            id: projectId,
            name: projectId,
            createdAt: new Date().toISOString(),
        });
    }

    /**
     * Null when a project with that id already exists. `extra` is what a deployment's own store keeps on a project
     * (who it belongs to, say), handed to it as it is.
     */
    async createProject(
        id: string,
        name?: string,
        extra: Record<string, unknown> = {}
    ): Promise<ProjectRecord | null> {
        assertProjectId(id);
        const record: ProjectRecord = {
            ...extra,
            id,
            name: cleanProjectName(name) || id,
            createdAt: new Date().toISOString(),
        };
        await this.hooks.beforeCreateProject?.(record);
        return (await this.store.createProject(record)) ? record : null;
    }

    renameProject(id: string, name: string): Promise<ProjectRecord | null> {
        const clean = cleanProjectName(name);
        if (!clean) throw new RequestError("a project name cannot be empty");
        return this.store.renameProject(id, clean);
    }

    /** Deletes the project, every note in it, and the screenshots only those notes showed. */
    deleteProject(id: string): Promise<boolean> {
        return this.serialAssets(() => this.deleteProjectUnlocked(id));
    }

    private async deleteProjectUnlocked(id: string): Promise<boolean> {
        const removed = await this.store.deleteProject(id);
        if (!removed) return false;
        for (const stored of removed) this.emit("deleted", stored, undefined, true);
        await this.forgetScreenshots(removed.map((s) => s.annotation));
        return true;
    }

    /** The projects whose notes show this screenshot; none once they are all deleted. */
    projectsWithAsset(
        assetId: string,
        filter?: Pick<AnnotationFilter, "peopleOnly">
    ): Promise<string[]> {
        return this.store.projectsWithAsset(assetId, filter);
    }

    /** Deletes the bytes of screenshots no remaining note shows. */
    protected async forgetScreenshots(gone: Annotation[]) {
        const ids = new Set<string>();
        for (const a of gone) {
            for (const ref of annotationAssets(a)) ids.add(ref.id);
        }
        for (const id of ids) {
            if ((await this.store.projectsWithAsset(id)).length === 0) await this.blobs.delete(id);
        }
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
            if (status === "awaiting_response") {
                if (author.kind !== "agent")
                    throw new RequestError("only an agent can request an answer", 403);
                if (!change.note?.trim()) throw new RequestError("a question is required");
                if (FINISHED.has(a.status))
                    throw new RequestError("reopen this note before asking a question", 409);
                next.awaitingResponse = {
                    resumeStatus:
                        a.status === "awaiting_response"
                            ? (a.awaitingResponse?.resumeStatus ?? "acknowledged")
                            : a.status === "variant_chosen" || a.status === "revert_requested"
                              ? a.status
                              : "acknowledged",
                };
            } else if (status) next.awaitingResponse = undefined;
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
    protected async mutate(
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

    /**
     * Records where this note went in another system. The same plugin and address twice is one link, so an integration
     * that retries does not repeat itself. Null when there is no such note.
     */
    async addLink(
        id: string,
        link: { plugin: string; url: string; ref?: string; title?: string }
    ): Promise<StoredAnnotation | null> {
        const parsed = ExternalLink.safeParse({ ...link, createdAt: new Date().toISOString() });
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new RequestError(
                `invalid link: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`
            );
        }
        const current = await this.store.getAnnotation(id);
        if (!current) return null;
        const links = current.annotation.links ?? [];
        if (links.some((l) => l.plugin === parsed.data.plugin && l.url === parsed.data.url))
            return current;
        if (links.length >= 20) throw new RequestError("a note can have at most 20 links", 409);
        return this.mutate(id, (a) => ({ ...a, links: [...(a.links ?? []), parsed.data] }));
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
        const said = note?.trim();
        return this.mutate(id, (a) => {
            const offered = a.variants as NonNullable<typeof a.variants>;
            const { chosen: _chosen, chosenAt: _chosenAt, ...rest } = offered;
            return {
                ...a,
                status: name === null ? "acknowledged" : "variant_chosen",
                variants: name === null ? rest : { ...rest, chosen: name, chosenAt: at },
                thread: [
                    ...a.thread,
                    // A pick is something the person did, note or not (the note travels with it), so its reply is
                    // automatic. Taking one back with a note is something they said, which the agent should hear.
                    this.makeReply(
                        author,
                        said ? `${body}\n${said}` : body,
                        name !== null || !said,
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
                    ...(a.status === "awaiting_response" &&
                    author.kind === "human" &&
                    !options.aside &&
                    !a.peopleOnly
                        ? {
                              status: a.awaitingResponse?.resumeStatus ?? "acknowledged",
                              awaitingResponse: undefined,
                          }
                        : {}),
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

    remove(id: string): Promise<boolean> {
        return this.serialAssets(() => this.removeUnlocked(id));
    }

    private async removeUnlocked(id: string): Promise<boolean> {
        const existing = await this.store.getAnnotation(id);
        if (!existing) return false;
        await this.store.deleteAnnotation(id);
        this.emit("deleted", existing);
        // A deleted note's screenshot goes with it, so a link to it (a Teams card) stops working too.
        await this.forgetScreenshots([existing.annotation]);
        return true;
    }

    /**
     * `watching: false` is for a caller that may wait for notes but does not speak for an agent (an app's token, a
     * member): pages are not told an agent is watching while it waits.
     */
    waitForNew(
        filter: AnnotationFilter,
        timeoutMs: number,
        signal?: AbortSignal,
        { watching = true }: { watching?: boolean } = {}
    ): Promise<boolean> {
        // Someone waiting for annotations is an agent watching (notato_watch, here or attached).
        const waited = watching
            ? this.agents.waitStarted(
                  filter.projectId === undefined ? undefined : [filter.projectId].flat()
              )
            : () => {};
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

    /**
     * Loads a bundle zip into the store, with a record of the bundle once a note of it is stored. Importing it again
     * adds only the notes that are new. See `ImportOptions` for what is kept.
     */
    async importBundle(zip: Uint8Array, options: ImportOptions = {}): Promise<ImportResult> {
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
        if (bundle.annotations.length === 0)
            throw new RequestError("the bundle has no notes in it: there is nothing to import");
        // A bundle's id is the one it was given where it was made, so another project can name it too: whoever imported
        // it first keeps it. Refused before anything is stored, as its record would show this project's notes there.
        const recorded = await this.store.getBundle(bundle.id);
        if (recorded && recorded.projectId !== bundle.projectId)
            throw new RequestError(
                `a bundle with id "${bundle.id}" was already imported into another project`,
                409
            );
        // Check everything first so a bad note cannot leave a half-imported bundle behind.
        await this.ensureProject(bundle.projectId);
        let fresh = 0;
        for (const a of bundle.annotations) {
            const parsed = Annotation.safeParse(a);
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                throw new RequestError(
                    `annotation ${String((a as { id?: unknown }).id)}: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`
                );
            }
            if (parsed.data.review?.draft)
                throw new RequestError("Send the review before uploading its notes.");
            const bundledAssets = assetsFor(a, files);
            for (const ref of parsed.data.references ?? []) {
                const bytes = bundledAssets.get(ref.id);
                if (!bytes)
                    throw new RequestError(`missing reference image bytes for asset "${ref.id}"`);
                await referenceDimensions(bytes);
            }
            if (parsed.data.projectId !== bundle.projectId)
                throw new RequestError(
                    `annotation ${parsed.data.id} is for project "${parsed.data.projectId}", not the bundle's "${bundle.projectId}"`
                );
            if (options.captureScope) {
                const assets = assetsFor(a, files);
                for (const ref of annotationAssets(a))
                    if (ref && !assets.has(ref.id))
                        throw new RequestError("capture tokens must supply screenshot bytes");
            }
            const existing = await this.store.getAnnotation(parsed.data.id);
            if (existing)
                await this.acceptExisting(
                    existing,
                    parsed.data,
                    options.captureScope
                        ? await captureReceipt(
                              parsed.data,
                              assetsFor(a, files),
                              options.captureScope
                          )
                        : undefined
                );
            else fresh += 1;
            for (const bytes of assetsFor(a, files).values()) {
                if (!sniffImageMime(bytes))
                    throw new RequestError(
                        `annotation ${a.id}: screenshots must be PNG or WebP images`
                    );
            }
        }
        const record: BundleRecord = {
            id: bundle.id,
            projectId: bundle.projectId,
            createdAt: bundle.createdAt,
            author: bundle.author,
            appName: bundle.appName,
            appVersion: bundle.appVersion,
            annotationCount: bundle.annotations.length,
            importedAt: new Date().toISOString(),
        };
        if (!recorded && fresh > 0) await this.hooks.beforeImportBundle?.(record);
        const asPerson = options.asPerson;
        let imported = 0;
        let skipped = 0;
        for (const a of bundle.annotations) {
            const sent: Annotation = asPerson
                ? {
                      ...a,
                      author: {
                          ...a.author,
                          kind: "human",
                          ...(asPerson.name ? { name: asPerson.name } : {}),
                      },
                      ...(options.captureScope
                          ? {
                                context: {
                                    ...a.context,
                                    notatoCaptureSource: "unverified app feedback",
                                },
                            }
                          : {}),
                  }
                : a;
            const { created } = await this.ingest(sent, assetsFor(a, files), {
                projectId: bundle.projectId,
                preserveLifecycle: !asPerson,
                bundleId: bundle.id,
                receipt: options.captureScope
                    ? await captureReceipt(a, assetsFor(a, files), options.captureScope)
                    : undefined,
            });
            if (created) imported += 1;
            else skipped += 1;
        }
        // Recorded only once a note of it is stored: a bundle whose notes are all here already (another bundle's), or
        // one refused part way (a limit reached), leaves no record listing nothing. Two imports of one id into different
        // projects at the same moment both pass the check above, and one of them records it; the other's notes are
        // still never shown in its bundle, which every read keeps to the project of its record.
        if (imported > 0) await this.store.insertBundle(record);
        return { bundleId: bundle.id, projectId: bundle.projectId, imported, skipped };
    }

    getBundle(id: string): Promise<BundleRecord | null> {
        return this.store.getBundle(id);
    }

    /** The newest first, at most `BUNDLE_LIST_MAX` (or `limit`) of them. */
    async listBundles(projectId?: string, limit = BUNDLE_LIST_MAX) {
        const most = Math.min(Math.max(1, Math.floor(limit)), BUNDLE_LIST_MAX);
        // Kept to the limit here too, for a store that reads every record.
        return (await this.store.listBundles(projectId, most)).slice(0, most);
    }

    /**
     * A zip of an imported bundle as it stands now (statuses and threads included), or of any filtered set
     * of a project's annotations, which becomes a new bundle.
     */
    async exportBundle(
        selector:
            | { bundleId: string; filter?: AnnotationFilter }
            | { projectId: string; filter?: AnnotationFilter }
    ): Promise<{ filename: string; zip: ReadableStream<Uint8Array> } | null> {
        let projectId: string;
        let items: StoredAnnotation[];
        let meta: Parameters<typeof buildBundle>[1];
        if ("bundleId" in selector) {
            const record = await this.store.getBundle(selector.bundleId);
            if (!record) return null;
            // Only its own project's notes: another project may have notes carrying the same bundle id.
            items = await this.store.listAnnotations({
                ...selector.filter,
                bundleId: record.id,
                projectId: record.projectId,
            });
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

    protected emit(type: EventType, stored: StoredAnnotation, before?: Annotation, bulk?: true) {
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

/**
 * The thread a new note starts with: when the page recorded that the note's author made it People only before sending
 * it, that line, in the server's own words and under the note's author. The board shows an automatic entry as something
 * that happened rather than something said, so no other name, text or entry a page sends is kept.
 */
function sentPeopleOnly(a: Annotation): Annotation["thread"] {
    const made = a.thread.find((r) => r.automatic && r.peopleOnly === true);
    if (!a.peopleOnly || !made || a.author.kind !== "human") return [];
    const at = Date.parse(made.createdAt);
    return [
        peopleOnlyRecord(
            true,
            a.author.name,
            Number.isNaN(at) ? undefined : new Date(at).toISOString()
        ),
    ];
}

/** Refuses an id no project can have (see `PROJECT_ID`), such as one a bundle names. */
function assertProjectId(id: string): void {
    if (!PROJECT_ID.test(id))
        throw new RequestError(
            `"${id.slice(0, 140)}" is not a project id: letters, digits and _ . @ - (not only dots), at most 128`
        );
}

/** A project name as kept: one line, trimmed, at most PROJECT_NAME_MAX characters. */
function cleanProjectName(name: string | undefined): string {
    return (name ?? "").replace(/\s+/g, " ").trim().slice(0, PROJECT_NAME_MAX);
}
