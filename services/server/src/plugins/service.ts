import { TeamCoordinator, workId } from "@notato/server";
import type { CloudBackend } from "../backend.ts";
import { AUTOMATION_LIMITS } from "../plans.ts";
import {
    type Action,
    type ActionEditInput,
    type Connection,
    decrypt,
    encrypt,
    fingerprint,
    keyFromEnv,
    matches,
    notePayload,
    type Payload,
    PluginError,
    personalWorkflowMatch,
    type Result,
    type Workflow,
    workflowMatches,
} from "./model.ts";
import { oauthToken } from "./oauth.ts";
import { type Credential, ProviderError, Providers } from "./providers.ts";
import { type Http, publicFetch } from "./transport.ts";

export interface PluginOptions {
    key?: Buffer | null;
    providers?: Providers;
    oauthHttp?: Http;
}

export class PluginService {
    readonly repository;
    private renewing = new Map<string, Promise<Credential>>();
    private scheduledAt = 0;
    private prunedAt = 0;
    constructor(
        readonly backend: CloudBackend,
        readonly origin: string,
        readonly key: Buffer | null = keyFromEnv(),
        readonly providers = new Providers(),
        readonly oauthHttp: Http = publicFetch
    ) {
        this.repository = backend.store.plugins;
    }
    ready() {
        if (!this.key || !this.repository)
            throw new PluginError("Plugins have not been configured for this service.");
        return { key: this.key, repository: this.repository };
    }
    async allowance(workspace: string) {
        if (!(await this.backend.store.getWorkspacePlan(workspace)))
            return { workflows: Number.MAX_SAFE_INTEGER, actions: Number.MAX_SAFE_INTEGER };
        const state = await this.backend.store.getWorkspaceEntitlement(workspace);
        return state.locked ? AUTOMATION_LIMITS.free : AUTOMATION_LIMITS[state.plan.id];
    }
    async secret(c: Connection): Promise<Credential> {
        const { key, repository } = this.ready();
        const secret = JSON.parse(
            decrypt(c.encrypted, key, `${c.workspaceId}:${c.provider}:${c.id}`)
        ) as Credential;
        if (
            secret.oauth &&
            secret.refreshToken &&
            secret.expiresAt &&
            secret.expiresAt < Date.now() + 60_000
        ) {
            const known = this.renewing.get(c.id);
            if (known) return known;
            const pending = (async () => {
                const latest = await repository.connection(c.workspaceId, c.id);
                if (!latest || latest.revoked)
                    throw new PluginError("The connection has been revoked.");
                const existing = JSON.parse(
                    decrypt(latest.encrypted, key, `${c.workspaceId}:${c.provider}:${c.id}`)
                ) as Credential;
                if (existing.expiresAt && existing.expiresAt > Date.now() + 60_000) return existing;
                const renewed = await oauthToken(
                    c.provider,
                    {
                        grant_type: "refresh_token",
                        refresh_token: existing.refreshToken ?? "",
                    },
                    this.oauthHttp
                );
                const value = {
                    ...renewed,
                    refreshToken: renewed.refreshToken ?? existing.refreshToken,
                };
                if (
                    !(await repository.rotateConnection(
                        latest,
                        encrypt(
                            JSON.stringify(value),
                            key,
                            `${c.workspaceId}:${c.provider}:${c.id}`
                        )
                    ))
                )
                    throw new PluginError("The connection changed while access was being renewed.");
                return value;
            })().finally(() => this.renewing.delete(c.id));
            this.renewing.set(c.id, pending);
            return pending;
        }
        return secret;
    }
    async connectOAuth(
        workspace: string,
        provider: Connection["provider"],
        secret: Credential,
        actor: string,
        replacing?: { id: string; revision?: string }
    ) {
        const { key, repository } = this.ready();
        if (
            !replacing &&
            (await repository.connections(workspace)).filter((c) => !c.revoked).length >= 100
        )
            throw new PluginError("This workspace has reached its connection limit.");
        await this.providers.verify({ provider }, secret);
        const c: Connection = {
            id: replacing?.id ?? crypto.randomUUID(),
            workspaceId: workspace,
            provider,
            name: `${provider} connection`,
            createdAt: new Date().toISOString(),
            revoked: false,
            encrypted: "",
            revision: crypto.randomUUID(),
        };
        c.encrypted = encrypt(JSON.stringify(secret), key, `${workspace}:${provider}:${c.id}`);
        if (replacing) await repository.replaceConnection(c, actor, replacing.revision);
        else await repository.saveConnection(c, actor);
        return c.id;
    }
    async connect(
        workspace: string,
        input: {
            name: string;
            provider: Connection["provider"];
            credential: string;
            installationId?: string;
            refreshToken?: string;
            signingSecret?: string;
        },
        actor: string,
        replacing?: { id: string; revision?: string }
    ) {
        const { key, repository } = this.ready();
        if (
            !replacing &&
            (await repository.connections(workspace)).filter((c) => !c.revoked).length >= 100
        )
            throw new PluginError("This workspace has reached its connection limit.");
        const secret: Credential = {
            token: input.credential,
            ...(input.installationId ? { installationId: input.installationId } : {}),
            ...(input.signingSecret || input.refreshToken
                ? { refreshToken: input.signingSecret ?? input.refreshToken }
                : {}),
        };
        if (input.provider === "webhook" && !input.signingSecret)
            throw new PluginError("Provide a webhook signing secret of at least 32 characters.");
        if (input.installationId && input.provider !== "github")
            throw new PluginError("Only GitHub connections use an installation id.");
        await this.providers.verify({ provider: input.provider }, secret);
        // App installation access is minted server-side for each execution; the verifying user's token is discarded.
        if (secret.installationId) secret.token = "";
        const c: Connection = {
            id: replacing?.id ?? crypto.randomUUID(),
            workspaceId: workspace,
            name: input.name,
            provider: input.provider,
            createdAt: new Date().toISOString(),
            revoked: false,
            encrypted: "",
            revision: crypto.randomUUID(),
        };
        c.encrypted = encrypt(JSON.stringify(secret), key, `${workspace}:${c.provider}:${c.id}`);
        if (replacing) await repository.replaceConnection(c, actor, replacing.revision);
        else await repository.saveConnection(c, actor);
        return c.id;
    }
    async checkConnection(workspace: string, id: string) {
        const { repository } = this.ready();
        const c = await repository.connection(workspace, id);
        if (!c || c.revoked) throw new PluginError("Reconnect this connection before checking it.");
        let health: NonNullable<Connection["health"]>;
        try {
            const secret = await this.secret(c);
            // Stored installation connections intentionally discard the verifying user's token.
            // Repository discovery below verifies the App credential without trying to reuse that discarded token.
            if (!(c.provider === "github" && secret.installationId))
                await this.providers.verify(c, secret);
            if (c.provider === "teams" || c.provider === "webhook")
                health = {
                    status: "unchecked",
                    checkedAt: new Date().toISOString(),
                    message:
                        "Endpoint format checked. Run a previewed manual action to verify delivery; no test message was sent.",
                };
            else if (c.provider === "azure") {
                const a = (await repository.actions(workspace)).find(
                    (a) => a.connectionId === c.id && !a.archived
                );
                if (a) {
                    await this.providers.validateDestination(a.destination, secret);
                    health = {
                        status: "ready",
                        checkedAt: new Date().toISOString(),
                        message:
                            "Access to the first saved Azure DevOps destination was verified. Other actions retain their own permissions.",
                    };
                } else
                    health = {
                        status: "unchecked",
                        checkedAt: new Date().toISOString(),
                        message: "Save an Azure DevOps project action to verify its access.",
                    };
            } else if (
                c.provider === "github" &&
                !(await this.providers.destinations(c.provider, secret)).length
            )
                health = {
                    status: "attention",
                    checkedAt: new Date().toISOString(),
                    message:
                        "Account authorized, but no repositories were found. Install or update App access, then check again.",
                };
            else
                health = {
                    status: "ready",
                    checkedAt: new Date().toISOString(),
                    message:
                        "Provider authorization verified. Saved destinations still require their own permissions.",
                };
        } catch (e) {
            health = {
                status:
                    e instanceof ProviderError && e.disposition === "retry"
                        ? "unavailable"
                        : "attention",
                checkedAt: new Date().toISOString(),
                message:
                    e instanceof ProviderError && e.disposition === "retry"
                        ? "The provider could not be checked. Try again shortly."
                        : "Access could not be verified. Check provider permissions or reconnect this account.",
            };
        }
        await repository.connectionHealth(c, health);
        return health;
    }
    async action(workspace: string, id: string) {
        const { repository } = this.ready();
        const a = await repository.action(workspace, id);
        if (
            !a ||
            a.archived ||
            (await this.backend.store.getProject(a.projectId))?.workspaceId !== workspace
        )
            throw new PluginError("This action is unavailable.");
        const c = await repository.connection(workspace, a.connectionId);
        if (!c || c.revoked || c.provider !== a.destination.provider)
            throw new PluginError("This action's connection has been revoked.");
        return { a, c };
    }
    async payload(
        a: Action,
        noteId: string | null,
        automatic = false,
        actor?: string,
        workflow?: Workflow
    ): Promise<Payload> {
        if (noteId) {
            const n = (await this.backend.store.getAnnotation(noteId))?.annotation;
            if (automatic && n && this.backend.store.coordination) {
                const work = await new TeamCoordinator(this.backend.store).work(workId(n));
                if (
                    work &&
                    !(workflow && personalWorkflowMatch(workflow, n)) &&
                    (work.shared === false ||
                        (work.shared === undefined && work.contextId && !work.pullRequest))
                )
                    throw new PluginError(
                        "Personal checkout feedback is excluded from shared workflows."
                    );
            }
            if (
                !n ||
                n.projectId !== a.projectId ||
                n.review?.draft ||
                (automatic &&
                    (n.peopleOnly ||
                        n.author.kind === "agent" ||
                        (n.visibility === "personal" &&
                            !(workflow && personalWorkflowMatch(workflow, n))))) ||
                (n.visibility === "personal" && n.createdBy !== actor)
            )
                throw new PluginError("This feedback is unavailable for this action.");
            return notePayload(n, this.origin);
        }
        const notes = (await this.ready().repository.digest(a.projectId, workflow)).filter(
            (n) => !n.review?.draft && (!workflow || workflowMatches(workflow, n))
        );
        const url = `${this.origin}/#/p/${encodeURIComponent(a.projectId)}`;
        return {
            title: `Daily feedback review: ${Math.min(100, notes.length)}${notes.length > 100 ? "+" : ""} notes`,
            text:
                notes
                    .slice(0, 20)
                    .map(
                        (n) =>
                            `${notePayload(n, this.origin).title}\n${notePayload(n, this.origin).url}`
                    )
                    .join("\n\n") || "No new feedback in the last 24 hours.",
            url,
            noteIds: notes.slice(0, 20).map((n) => n.id),
        };
    }
    async preview(workspace: string, actionId: string, noteId: string, actor?: string) {
        const { key } = this.ready();
        const { a, c } = await this.action(workspace, actionId);
        const payload = {
            ...(await this.payload(a, noteId, false, actor)),
            ...(c.revision ? { connectionRevision: c.revision } : {}),
        };
        return {
            payload,
            hash: fingerprint(key, {
                a,
                c: { id: c.id, provider: c.provider, revoked: c.revoked },
                payload,
            }),
        };
    }
    async enqueue(
        workspace: string,
        actor: string,
        actionId: string,
        noteId: string,
        hash: string,
        requestId: string
    ) {
        const { a } = await this.action(workspace, actionId);
        const checked = await this.preview(workspace, actionId, noteId, actor);
        if (!matches(checked.hash, hash))
            throw new PluginError(
                "The action or feedback changed. Preview it again before sending."
            );
        const { repository } = this.ready();
        return repository.enqueue({
            workspace,
            action: actionId,
            actor,
            note: noteId,
            payload: checked.payload,
            expectedAction: a,
            ...(checked.payload.personal ? { personalActor: actor } : {}),
            operation: `manual:${requestId}`,
        });
    }
    async link(workspace: string, actionId: string, noteId: string, url: string, actor?: string) {
        const { a, c } = await this.action(workspace, actionId);
        await this.payload(a, noteId, false, actor);
        const result = await this.providers.link(a.destination, await this.secret(c), url);
        if (result.url)
            await this.backend.addLink(noteId, {
                plugin: c.provider,
                url: result.url,
                ref: result.reference,
                title: a.name,
            });
        return result;
    }
    async review(workspace: string, id: string, delivered: boolean, url?: string, actor?: string) {
        const { repository } = this.ready();
        const j = await repository.job(workspace, id, actor);
        if (!j) throw new PluginError("Delivery not found.", 404);
        if (j?.status !== "review") throw new PluginError("This delivery no longer needs review.");
        let result: { url?: string; reference?: string } = { reference: id };
        const { a, c } = await this.action(workspace, j.actionId);
        if (delivered && ["github", "azure", "linear", "gitlab"].includes(c.provider)) {
            if (!url)
                throw new PluginError("Provide the existing issue link to confirm this delivery.");
            result = await this.providers.link(a.destination, await this.secret(c), url);
        }
        if (!(await repository.review(workspace, id, delivered)))
            throw new PluginError("This delivery was already reviewed.");
        if (delivered) {
            await repository.finish(j, "succeeded", result);
            if (result.url && j.noteId)
                await this.backend.addLink(j.noteId, {
                    plugin: c.provider,
                    url: result.url,
                    ref: result.reference,
                    title: a.name,
                });
        }
    }
    async run(now = new Date()) {
        const { repository } = this.ready();
        if (now.getTime() - this.prunedAt >= 3600_000) {
            await repository.prune(now);
            this.prunedAt = now.getTime();
        }
        if (now.getTime() - this.scheduledAt >= 60_000) {
            await repository.scheduled(now);
            this.scheduledAt = now.getTime();
        }
        for (let i = 0; i < 10; i++) {
            const j = await repository.claim(now.toISOString());
            if (!j) break;
            let dispatching = false;
            let delivered: Result | undefined;
            let connection: Connection | undefined;
            let workflow: Workflow | undefined;
            try {
                const membership = await repository.membership(j.workspaceId, j.actor);
                if (
                    !membership ||
                    (j.workflowId && membership.role === "member") ||
                    (await this.backend.store.betaAccountBlocked(j.actor)) ||
                    (await this.backend.store.betaWorkspaceBlocked(j.workspaceId))
                )
                    throw new PluginError("The authorizing account no longer has access.");
                const entitlement = await this.backend.store.getWorkspaceEntitlement(j.workspaceId);
                if (
                    (await this.backend.store.getWorkspacePlan(j.workspaceId)) &&
                    entitlement.locked
                ) {
                    await repository.finish(
                        j,
                        "paused",
                        undefined,
                        "Restore your workspace plan to continue."
                    );
                    continue;
                }
                const { a, c } = await this.action(j.workspaceId, j.actionId);
                connection = c;
                if (j.workflowId) {
                    const workflows = await repository.workflows(j.workspaceId);
                    const w = workflows.find((w) => w.id === j.workflowId);
                    if (!w?.enabled || w.actionId !== j.actionId || w.creator !== j.actor)
                        throw new PluginError("This workflow is paused or unavailable.");
                    workflow = w;
                    if (
                        (j.personalActor &&
                            (!w.includePersonal || j.personalActor !== w.creator)) ||
                        (w.includePersonal && !j.noteId && j.personalActor !== w.creator)
                    )
                        throw new PluginError(
                            "Personal annotation routing is no longer authorized."
                        );
                    const limit = await this.allowance(j.workspaceId);
                    if (
                        workflows.filter((w) => w.enabled).length > limit.workflows ||
                        !limit.actions
                    ) {
                        await repository.finish(
                            j,
                            "paused",
                            undefined,
                            "Upgrade or pause excess workflows to resume automation."
                        );
                        continue;
                    }
                    if (
                        !(await repository.reserve(j, now.toISOString().slice(0, 7), limit.actions))
                    ) {
                        await repository.finish(
                            j,
                            "paused",
                            undefined,
                            "This month's automation allowance is used up. Manual actions remain available."
                        );
                        continue;
                    }
                    if (j.noteId) {
                        const note = (await this.backend.store.getAnnotation(j.noteId))?.annotation;
                        if (
                            !note ||
                            !workflowMatches(w, note) ||
                            (note.visibility === "personal" &&
                                j.personalActor !== note.createdBy) ||
                            ((w.trigger === "unanswered" || w.trigger === "awaiting_response") &&
                                note.status !== "awaiting_response") ||
                            (w.trigger === "unanswered" &&
                                !(await repository.unansweredReady(j.noteId, w, now)))
                        )
                            throw new PluginError("This feedback no longer matches the workflow.");
                    }
                }
                const current = {
                    ...(await this.payload(a, j.noteId, Boolean(j.workflowId), j.actor, workflow)),
                    ...(c.revision ? { connectionRevision: c.revision } : {}),
                };
                if (j.payload && JSON.stringify(current) !== JSON.stringify(j.payload))
                    throw new ProviderError(
                        "review",
                        "Feedback changed after a delivery attempt. Preview the current feedback before another send."
                    );
                const payload = j.payload ?? current;
                const credential = await this.secret(c);
                if (workflow && j.personalActor) {
                    const latest = (await repository.workflows(j.workspaceId)).find(
                        (w) => w.id === workflow?.id
                    );
                    if (
                        JSON.stringify(latest) !== JSON.stringify(workflow) ||
                        JSON.stringify(await this.payload(a, j.noteId, true, j.actor, workflow)) !==
                            JSON.stringify(
                                Object.fromEntries(
                                    Object.entries(current).filter(
                                        ([key]) => key !== "connectionRevision"
                                    )
                                )
                            )
                    )
                        throw new PluginError(
                            "Personal annotation routing changed before delivery."
                        );
                }
                dispatching = true;
                const result = await this.providers.execute(
                    a.destination,
                    credential,
                    payload,
                    j.id
                );
                delivered = result;
                await repository.finish(j, "succeeded", result, undefined, payload);
                if (result.url && j.noteId) {
                    // The external result is durable before touching the note; a local failure must never repeat a create.
                    try {
                        await this.backend.addLink(j.noteId, {
                            plugin: c.provider,
                            url: result.url,
                            ref: result.reference,
                            title: a.name,
                        });
                    } catch {
                        /* History retains the external link even if a concurrent delete prevents linking the note. */
                    }
                }
            } catch (e) {
                const provider = e instanceof ProviderError;
                if (connection && provider && (e.status === 401 || e.status === 403)) {
                    try {
                        await repository.connectionHealth(connection, {
                            status: "attention",
                            checkedAt: new Date().toISOString(),
                            message:
                                "The provider refused access. Check destination permissions or reconnect this account.",
                        });
                    } catch {
                        /* Delivery status remains authoritative if health metadata cannot be updated. */
                    }
                }
                const status =
                    provider && e.disposition === "retry" && j.attempts < 5
                        ? "queued"
                        : (provider && e.disposition === "review") || (!provider && dispatching)
                          ? "review"
                          : "failed";
                await repository.finish(
                    j,
                    status,
                    delivered,
                    provider
                        ? e.message
                        : dispatching
                          ? "Delivery could not be recorded. Check the destination before retrying."
                          : "This action is unavailable or its authorization changed."
                );
            }
        }
    }
    start() {
        if (!this.key || !this.repository) return () => {};
        let stopped = false;
        let pending: Promise<void> | undefined;
        const run = () => {
            if (!stopped && !pending)
                pending = this.run()
                    .catch(() => {})
                    .finally(() => {
                        pending = undefined;
                    });
        };
        const timer = setInterval(run, 15_000);
        timer.unref();
        run();
        return async () => {
            stopped = true;
            clearInterval(timer);
            await pending;
        };
    }
    private async validateAction(a: Action) {
        const { repository } = this.ready();
        if ((await this.backend.store.getProject(a.projectId))?.workspaceId !== a.workspaceId)
            throw new PluginError("Select a project in this workspace.");
        const c = await repository.connection(a.workspaceId, a.connectionId);
        if (!c || c.revoked || c.provider !== a.destination.provider)
            throw new PluginError("Select an active connection for this provider.");
        await this.providers.validateDestination(a.destination, await this.secret(c));
    }
    async saveAction(a: Action) {
        const { repository } = this.ready();
        await this.validateAction(a);
        if ((await repository.actions(a.workspaceId)).filter((a) => !a.archived).length >= 500)
            throw new PluginError("This workspace has reached its saved-action limit.");
        await repository.saveAction(a);
    }
    async editAction(
        workspace: string,
        id: string,
        input: typeof ActionEditInput._output,
        actor: string
    ) {
        const { repository } = this.ready();
        const known = await repository.action(workspace, id);
        if (!known || known.archived) throw new PluginError("Action not found.", 404);
        const { expectedUpdatedAt, ...values } = input;
        if (expectedUpdatedAt && expectedUpdatedAt !== known.updatedAt)
            throw new PluginError("This action changed. Reload it before saving.", 409);
        const next = {
            ...known,
            ...values,
            updatedAt: new Date(
                Math.max(Date.now(), Date.parse(known.updatedAt) + 1)
            ).toISOString(),
        };
        await this.validateAction(next);
        await repository.editAction(next, actor, known);
    }
    async saveWorkflow(w: Workflow, expectedUpdatedAt?: string, actor = w.creator) {
        const { repository } = this.ready();
        const saved = { ...w, updatedAt: new Date().toISOString() };
        if (!w.enabled) {
            if (!(await repository.action(w.workspaceId, w.actionId)))
                throw new PluginError("Select an action in this workspace.");
            await repository.saveWorkflow(saved, 0, expectedUpdatedAt, actor);
            return;
        }
        const { a } = await this.action(w.workspaceId, w.actionId);
        if (w.trigger === "daily_digest" && !w.conditions && (w.severity || w.intent))
            throw new PluginError(
                "Daily digests use tag filters; remove severity and type filters."
            );
        if (
            ["daily_digest", "unanswered"].includes(w.trigger) &&
            !["teams", "slack", "webhook"].includes(a.destination.provider)
        )
            throw new PluginError("Digests and reminders need a notification action.");
        await repository.saveWorkflow(
            saved,
            (await this.allowance(w.workspaceId)).workflows,
            expectedUpdatedAt,
            actor
        );
    }
}
