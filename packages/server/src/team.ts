import { AsyncLocalStorage } from "node:async_hooks";
import type { Annotation } from "@notato/schema";
import { type Backend, RequestError } from "./backend.ts";
import type { Store, StoredAnnotation } from "./storage.ts";

export interface DevelopmentContext {
    id: string;
    projectId: string;
    owner: string;
    name: string;
    branch?: string;
    createdAt: string;
    archived: boolean;
}
export interface WorkClaim {
    session: string;
    version: number;
    expiresAt: number;
}
export interface WorkRecord {
    id: string;
    projectId: string;
    contextId: string | null;
    /** Sharing is independent of which checkout owns execution. */
    shared?: boolean;
    version: number;
    createdAt: string;
    updatedAt: string;
    assignedBy?: string;
    claim?: WorkClaim;
    recoveryRequired?: boolean;
    resolution?: { branch: string; commit: string; at: string };
    publication?: {
        status: "sending" | "sent" | "uncertain";
        operation: string;
        commit: string;
        hash: string;
        at: string;
        url?: string;
        error?: string;
    };
    pullRequest?: {
        connectionId: string;
        repository: string;
        number: number;
        title: string;
        url: string;
        headSha: string;
        latestHeadSha?: string;
        baseSha: string;
        previewUrl?: string;
        state: string;
        merged: boolean;
        checkedAt: string;
        creator: string;
    };
}
export const workView = (work: WorkRecord): WorkRecord => ({
    ...work,
    ...(work.claim ? { claim: { ...work.claim, session: "reserved" } } : {}),
});
export type TeamRecord =
    | DevelopmentContext
    | WorkRecord
    | import("./collaboration.ts").ProjectAccess
    | import("./collaboration.ts").ReviewSession;
export type RecordKind = "context" | "work" | "project" | "review-session";
export interface CoordinationStore {
    get(id: string): Promise<TeamRecord | null>;
    list(project: string, kind: RecordKind): Promise<TeamRecord[]>;
    change<T extends TeamRecord>(
        id: string,
        project: string,
        kind: RecordKind,
        mutate: (current: T | null) => T
    ): Promise<T>;
}
export interface WorkPermit {
    credentialId?: string;
    contextId: string;
    session: string;
    version: number;
}
const permits = new AsyncLocalStorage<WorkPermit>();
export const currentWorkPermit = () => permits.getStore();
export const withWorkPermit = <T>(permit: WorkPermit, run: () => T): T => permits.run(permit, run);
export const workId = (a: Annotation) => a.workId ?? `work:${a.projectId}:${a.review?.id ?? a.id}`;
export const LEASE_MS = 5 * 60_000;
export function assertWorkPermit(
    a: Pick<Annotation, "projectId">,
    work: WorkRecord | null,
    context: DevelopmentContext | null,
    permit = currentWorkPermit()
) {
    if (!permit) return;
    if (
        !context ||
        context.archived ||
        context.id !== permit.contextId ||
        context.projectId !== a.projectId ||
        !work ||
        work.contextId !== permit.contextId ||
        work.claim?.session !== permit.session ||
        work.claim.version !== permit.version ||
        work.claim.expiresAt <= Date.now()
    )
        throw new RequestError(
            "Work ownership changed or expired. Claim the review again before making changes.",
            409
        );
}
export class TeamCoordinator {
    constructor(readonly store: Store) {}
    get records() {
        if (!this.store.coordination)
            throw new RequestError(
                "Development contexts are unavailable for this storage backend.",
                503
            );
        return this.store.coordination;
    }
    async context(id: string) {
        const record = await this.records.get(id);
        return record && "owner" in record && "archived" in record ? record : null;
    }
    async work(id: string) {
        const record = await this.records.get(id);
        return record && "contextId" in record ? record : null;
    }
    async create(projectId: string, owner: string, name: string, branch?: string) {
        const id = `ctx_${crypto.randomUUID()}`;
        if (
            (await this.records.list(projectId, "context")).filter(
                (r) => !(r as DevelopmentContext).archived
            ).length >= 200
        )
            throw new RequestError("Archive an unused checkout before connecting another.", 409);
        return this.records.change<DevelopmentContext>(id, projectId, "context", () => ({
            id,
            projectId,
            owner,
            name,
            branch,
            createdAt: new Date().toISOString(),
            archived: false,
        }));
    }
    async route(a: Annotation, contextId?: string, captureWorkId?: string) {
        const id = captureWorkId ?? workId(a);
        const context = contextId ? await this.context(contextId) : null;
        if (contextId && (!context || context.archived || context.projectId !== a.projectId))
            throw new RequestError("Checkout connection revoked.", 403);
        return this.records.change<WorkRecord>(id, a.projectId, "work", (current) => {
            if (current && !contextId && !captureWorkId && current.contextId)
                throw new RequestError(
                    "This review belongs to a checkout; use its capture connection.",
                    403
                );
            if (
                current &&
                (current.projectId !== a.projectId ||
                    (contextId && current.contextId !== contextId))
            )
                throw new RequestError("This review belongs to another checkout.", 403);
            return (
                current ?? {
                    id,
                    projectId: a.projectId,
                    contextId: contextId ?? null,
                    shared: !contextId,
                    version: 0,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }
            );
        });
    }
    async assign(
        a: Annotation,
        contextId: string | null,
        actor: string,
        recover = false,
        expectedVersion?: number
    ) {
        if (
            a.review?.total &&
            (await this.store.listAnnotations({ projectId: a.projectId, reviewId: a.review.id }))
                .length < a.review.total
        )
            throw new RequestError("Wait for every review target before assigning it.", 409);
        const context = contextId ? await this.context(contextId) : null;
        if (contextId && (!context || context.archived || context.projectId !== a.projectId))
            throw new RequestError("Select an active checkout in this project.", 400);
        return this.records.change<WorkRecord>(workId(a), a.projectId, "work", (current) => {
            if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion)
                throw new RequestError(
                    "Review ownership changed. Reload before assigning it.",
                    409
                );
            if (current?.claim && !recover)
                throw new RequestError(
                    "An agent may still be editing this review. Confirm recovery before reassigning.",
                    409
                );
            return {
                ...(current ?? {
                    id: workId(a),
                    projectId: a.projectId,
                    createdAt: new Date().toISOString(),
                }),
                contextId,
                shared: contextId === null ? true : (current?.shared ?? !current?.contextId),
                version: (current?.version ?? 0) + 1,
                assignedBy: actor,
                claim: undefined,
                recoveryRequired: false,
                updatedAt: new Date().toISOString(),
            };
        });
    }
    async claim(
        a: Annotation,
        contextId: string,
        session: string,
        action: "claim" | "heartbeat" | "release",
        version?: number,
        checkoutHead?: string
    ) {
        const context = await this.context(contextId);
        if (!context || context.archived || context.projectId !== a.projectId)
            throw new RequestError("Checkout connection revoked.", 403);
        if (
            action === "claim" &&
            a.review?.total &&
            (await this.store.listAnnotations({ projectId: a.projectId, reviewId: a.review.id }))
                .length < a.review.total
        )
            throw new RequestError("Wait for every review target before claiming it.", 409);
        return this.records.change<WorkRecord>(workId(a), a.projectId, "work", (current) => {
            if (!current || current.contextId !== contextId)
                throw new RequestError("This work is not assigned to your checkout.", 403);
            if (
                action === "claim" &&
                current.pullRequest &&
                (!checkoutHead ||
                    (checkoutHead !== current.pullRequest.headSha &&
                        checkoutHead !== current.resolution?.commit))
            )
                throw new RequestError(
                    "Check out the reviewed PR head commit and include checkoutHead before claiming this PR review.",
                    409
                );
            const claim = current.claim;
            if (action === "claim") {
                if (claim && claim.session !== session)
                    throw new RequestError(
                        claim.expiresAt > Date.now()
                            ? "Another agent is working on this review."
                            : "The previous agent's lease expired. Ask a person to recover the review before taking it over.",
                        409
                    );
                if (claim && claim.expiresAt <= Date.now())
                    throw new RequestError(
                        "The lease expired. Ask a person to recover the review before taking it over.",
                        409
                    );
                const next = claim?.version ?? current.version + 1;
                return {
                    ...current,
                    version: next,
                    claim: { session, version: next, expiresAt: Date.now() + LEASE_MS },
                    updatedAt: new Date().toISOString(),
                };
            }
            if (
                !claim ||
                claim.session !== session ||
                claim.version !== version ||
                claim.expiresAt <= Date.now()
            )
                throw new RequestError("Your work claim expired or changed.", 409);
            return {
                ...current,
                claim:
                    action === "release"
                        ? undefined
                        : { ...claim, expiresAt: Date.now() + LEASE_MS },
                updatedAt: new Date().toISOString(),
            };
        });
    }
}
/** Mandatory server scope for an agent's checkout, including direct reads and images. */
export function teamBackend(
    inner: Backend,
    store: Store,
    contextId: string | undefined,
    validate: () => Promise<void>,
    credentialId?: string
): Backend {
    const teams = new TeamCoordinator(store);
    const session = crypto.randomUUID();
    const claims = new Map<string, WorkClaim>();
    const valid = async () => {
        await validate();
        if (contextId) {
            const c = await teams.context(contextId);
            if (!c || c.archived) throw new RequestError("Checkout connection revoked.", 403);
        }
    };
    const allowed = async (stored: StoredAnnotation | null) => {
        await validate();
        const context = contextId ? await teams.context(contextId) : null;
        if (contextId && (!context || context.archived))
            throw new RequestError("Checkout connection revoked.", 403);
        if (!stored || stored.annotation.peopleOnly) return null;
        const work = store.coordination ? await teams.work(workId(stored.annotation)) : null;
        return (contextId ? work?.contextId === contextId : !work?.contextId) ? stored : null;
    };
    const mutation = async <T>(id: string, run: () => Promise<T>) => {
        const stored = await allowed(await inner.get(id));
        if (!stored) throw new RequestError("Feedback is outside this checkout.", 404);
        if (!contextId) return run();
        const claim = claims.get(workId(stored.annotation));
        if (!claim)
            throw new RequestError(
                "Call notato_claim before editing or replying to this review.",
                409
            );
        return withWorkPermit({ contextId, session, version: claim.version, credentialId }, run);
    };
    return {
        listReviewSessions: async (project, actor) => {
            await valid();
            return (await inner.listReviewSessions?.(project, actor)) ?? [];
        },
        getReviewSession: async (id, actor) => {
            await valid();
            const result = await inner.getReviewSession?.(id, actor);
            if (!result) return null;
            const items: StoredAnnotation[] = [];
            for (const item of result.items) if (await allowed(item)) items.push(item);
            return { ...result, items };
        },
        replyReviewSession: async (id, actor, body, author) => {
            await valid();
            return (await inner.replyReviewSession?.(id, actor, body, author)) ?? null;
        },
        list: async (filter = {}) => {
            await valid();
            return inner.list({
                ...filter,
                ...(contextId
                    ? { workContext: contextId, workSession: session }
                    : { legacyOnly: true as const }),
                peopleOnly: false,
            });
        },
        get: async (id) => allowed(await inner.get(id)),
        asset: async (id) => {
            const items = await inner.list({
                ...(contextId
                    ? { workContext: contextId, workSession: session }
                    : { legacyOnly: true as const }),
                peopleOnly: false,
            });
            await valid();
            return items.some(({ annotation: a }) =>
                [...Object.values(a.screenshots ?? {}), ...(a.references ?? [])].some(
                    (r) => r?.id === id
                )
            )
                ? inner.asset(id)
                : null;
        },
        screenshot: async (id, view) =>
            (await allowed(await inner.get(id))) ? (inner.screenshot?.(id, view) ?? null) : null,
        markHanded: async (entries) => {
            for (const e of entries)
                if (!(await allowed(await inner.get(e.id))))
                    throw new RequestError("Feedback is outside this checkout.", 403);
            return inner.markHanded(entries);
        },
        setStatus: (id, ...args) => mutation(id, () => inner.setStatus(id, ...args)),
        reply: (id, ...args) => mutation(id, () => inner.reply(id, ...args)),
        offerVariants: (id, ...args) => mutation(id, () => inner.offerVariants(id, ...args)),
        chooseVariant: (id, ...args) => mutation(id, () => inner.chooseVariant(id, ...args)),
        waitForNew: async (filter, timeout, signal) => {
            await valid();
            const ready = await inner.waitForNew(
                {
                    ...filter,
                    ...(contextId
                        ? { workContext: contextId, workSession: session }
                        : { legacyOnly: true as const }),
                    peopleOnly: false,
                },
                timeout,
                signal
            );
            await valid();
            return (
                ready &&
                (
                    await inner.list({
                        ...filter,
                        ...(contextId
                            ? { workContext: contextId, workSession: session }
                            : { legacyOnly: true }),
                        peopleOnly: false,
                        limit: 1,
                    })
                ).length > 0
            );
        },
        importBundle: async (zip) => {
            if (contextId) throw new RequestError("Import feedback through the board.", 403);
            const { readBundle } = await import("@notato/core");
            const bundle = readBundle(zip).bundle;
            if (
                store.coordination &&
                (await teams.records.list(bundle.projectId, "context")).length
            )
                throw new RequestError("Import team feedback through the board.", 403);
            return inner.importBundle(zip);
        },
        requestAnnotation: async (project, args, timeout) => {
            await valid();
            return inner.requestAnnotation(
                project,
                { ...args, developmentContextId: contextId },
                timeout
            );
        },
        claimWork: async (id, action, checkoutHead) => {
            if (!contextId)
                throw new RequestError(
                    "Connect a dev setup (the board's Assignments page) to claim assigned work.",
                    409
                );
            const stored = await allowed(await inner.get(id));
            if (!stored) throw new RequestError("Feedback is outside this checkout.", 404);
            const result = await teams.claim(
                stored.annotation,
                contextId,
                session,
                action,
                claims.get(workId(stored.annotation))?.version,
                checkoutHead
            );
            if (result.claim) claims.set(result.id, result.claim);
            else claims.delete(result.id);
            return workView(result);
        },
        recordResolution: async (id, branch, commit) => {
            const stored = await allowed(await inner.get(id));
            if (!stored || !contextId) throw new RequestError("Checkout work required.", 403);
            const claim = claims.get(workId(stored.annotation));
            if (!claim) throw new RequestError("Claim the review first.", 409);
            await withWorkPermit({ contextId, session, version: claim.version, credentialId }, () =>
                teams.records.change<WorkRecord>(
                    workId(stored.annotation),
                    stored.annotation.projectId,
                    "work",
                    (r) => {
                        if (
                            !r ||
                            !claim ||
                            r.claim?.session !== session ||
                            r.claim.version !== claim.version ||
                            r.claim.expiresAt <= Date.now()
                        )
                            throw new RequestError("Work ownership expired or changed.", 409);
                        return {
                            ...r,
                            resolution: { branch, commit, at: new Date().toISOString() },
                            updatedAt: new Date().toISOString(),
                        };
                    }
                )
            );
        },
        getWork: async (id) => {
            const stored = await allowed(await inner.get(id));
            const work = stored ? await teams.work(workId(stored.annotation)) : null;
            return work ? workView(work) : null;
        },
    };
}
