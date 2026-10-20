import type { Annotation } from "@notato/schema";
import { workId } from "@notato/server";
import type { PgConnection, PgDatabase } from "../postgres-store.ts";
import { conditionsSql, WorkflowConditions, workflowTags } from "./conditions.ts";
import type { Action, Connection, Job, Payload, Workflow } from "./model.ts";
import {
    PluginError,
    personalWorkflowMatch,
    tagPattern,
    WorkflowTag,
    workflowMatches,
} from "./model.ts";

export const PLUGIN_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS notato.plugin_oauth (state_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES notato.workspaces(id) ON DELETE CASCADE, actor TEXT NOT NULL, provider TEXT NOT NULL, verifier TEXT NOT NULL, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS notato.plugin_connections (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES notato.workspaces(id) ON DELETE CASCADE, json TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_plugin_connections_workspace ON notato.plugin_connections(workspace_id)`,
    `CREATE TABLE IF NOT EXISTS notato.plugin_actions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES notato.workspaces(id) ON DELETE CASCADE, connection_id TEXT NOT NULL REFERENCES notato.plugin_connections(id), project_id TEXT NOT NULL REFERENCES notato.projects(id) ON DELETE CASCADE, json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS notato.plugin_workflows (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES notato.workspaces(id) ON DELETE CASCADE, action_id TEXT NOT NULL REFERENCES notato.plugin_actions(id) ON DELETE CASCADE, json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS notato.plugin_jobs (id TEXT PRIMARY KEY, operation TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES notato.workspaces(id) ON DELETE CASCADE, action_id TEXT NOT NULL REFERENCES notato.plugin_actions(id) ON DELETE CASCADE, actor TEXT NOT NULL, note_id TEXT, workflow_id TEXT REFERENCES notato.plugin_workflows(id) ON DELETE CASCADE, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, next_at TEXT NOT NULL, result TEXT, error TEXT, payload TEXT, period TEXT, UNIQUE(workspace_id,operation))`,
    `CREATE INDEX IF NOT EXISTS idx_plugin_jobs_ready ON notato.plugin_jobs(status,next_at)`,
    `CREATE INDEX IF NOT EXISTS idx_plugin_jobs_workspace ON notato.plugin_jobs(workspace_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS notato.plugin_usage (workspace_id TEXT NOT NULL REFERENCES notato.workspaces(id) ON DELETE CASCADE, period TEXT NOT NULL, actions INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,period))`,
    `CREATE INDEX IF NOT EXISTS idx_plugin_actions_project ON notato.plugin_actions(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plugin_workflows_action ON notato.plugin_workflows(action_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plugin_workflows_workspace ON notato.plugin_workflows(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plugin_jobs_period ON notato.plugin_jobs(workspace_id,period,status)`,
    `CREATE INDEX IF NOT EXISTS idx_plugin_jobs_created ON notato.plugin_jobs(created_at)`,
];
const parse = <T>(row: { json: string } | undefined): T | null =>
    row ? (JSON.parse(row.json) as T) : null;
const JOB = `id,workspace_id AS "workspaceId",action_id AS "actionId",actor,note_id AS "noteId",workflow_id AS "workflowId",status,attempts,created_at AS "createdAt",result,error,payload`;
function storedPayload(payload?: Payload, personalActor?: string) {
    return personalActor
        ? JSON.stringify({ personalActor, content: payload })
        : payload
          ? JSON.stringify(payload)
          : null;
}
const visibleJob = (actor: string) =>
    `(${actor}::text IS NULL OR ((payload IS NULL OR payload::jsonb->>'personalActor' IS NULL OR payload::jsonb->>'personalActor'=${actor}) AND NOT EXISTS (SELECT 1 FROM notato.annotations n WHERE n.id=plugin_jobs.note_id AND n.json::jsonb->>'visibility'='personal' AND COALESCE(n.json::jsonb->>'createdBy','')!=${actor})))`;
const privateWork = `EXISTS (SELECT 1 FROM notato.team_records t WHERE t.id=COALESCE(notato.annotations.json::jsonb->>'workId','work:' || notato.annotations.project_id || ':' || COALESCE(notato.annotations.json::jsonb #>> '{review,id}',notato.annotations.id)) AND (t.json::jsonb->>'shared'='false' OR (t.json::jsonb->>'shared' IS NULL AND t.json::jsonb->>'contextId' IS NOT NULL AND t.json::jsonb->'pullRequest' IS NULL)))`;
function eligibleAnnotation(workflow: Workflow | undefined, params: unknown[]) {
    const bind = (value: string | null) => {
        params.push(value);
        return `$${params.length}`;
    };
    const criteria = workflow ?? {};
    const rules = conditionsSql(criteria, bind);
    const tags = workflowTags(criteria);
    const actor = bind(workflow?.includePersonal && tags.length ? workflow.creator : null);
    const tagged = tags.length
        ? `(${tags.map((tag) => `json::jsonb->>'comment' ~* ${bind(tagPattern(tag))}`).join(" OR ")})`
        : "FALSE";
    return `people_only=0 AND author_kind!='agent' AND COALESCE(json::jsonb #>> '{review,draft}','false')!='true' AND ((COALESCE(json::jsonb->>'visibility','shared')='shared' AND NOT ${privateWork}) OR (${actor}::text IS NOT NULL AND json::jsonb->>'visibility'='personal' AND json::jsonb->>'createdBy'=${actor} AND ${tagged})) AND ${rules}`;
}
function job(row: Job & { result?: unknown; payload?: unknown }): Job {
    const saved = row.payload ? JSON.parse(String(row.payload)) : undefined;
    return {
        ...row,
        attempts: Number(row.attempts),
        result: row.result ? JSON.parse(String(row.result)) : undefined,
        payload: saved?.personalActor ? saved.content : saved,
        ...(saved?.personalActor ? { personalActor: saved.personalActor } : {}),
    };
}
export class PluginStore {
    constructor(readonly db: PgDatabase) {}
    private async managed<T>(
        workspace: string,
        actor: string,
        work: (tx: PgConnection) => Promise<T>
    ) {
        return this.db.transaction(async (tx) => {
            await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [workspace]);
            const role = (
                await tx.query<{ role: string }>(
                    "SELECT role FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
                    [workspace, actor]
                )
            )[0]?.role;
            if (!role || role === "member")
                throw new PluginError("Workspace owner or admin required.", 403);
            return work(tx);
        });
    }
    async membership(workspace: string, actor: string) {
        return (
            (
                await this.db.query<{ role: "owner" | "admin" | "member" }>(
                    "SELECT role FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
                    [workspace, actor]
                )
            )[0] ?? null
        );
    }
    async oauthState(
        hash: string,
        workspace: string,
        actor: string,
        provider: string,
        verifier: string
    ) {
        await this.db.query("DELETE FROM notato.plugin_oauth WHERE expires_at<$1", [
            new Date().toISOString(),
        ]);
        await this.db.query("INSERT INTO notato.plugin_oauth VALUES ($1,$2,$3,$4,$5,$6)", [
            hash,
            workspace,
            actor,
            provider,
            verifier,
            new Date(Date.now() + 900_000).toISOString(),
        ]);
    }
    async consumeOAuth(hash: string, workspace: string, actor: string) {
        return (
            (
                await this.db.query<{ provider: string; verifier: string }>(
                    "DELETE FROM notato.plugin_oauth WHERE state_hash=$1 AND workspace_id=$2 AND actor=$3 AND expires_at>$4 RETURNING provider,verifier",
                    [hash, workspace, actor, new Date().toISOString()]
                )
            )[0] ?? null
        );
    }
    async digest(project: string, workflow?: Workflow) {
        const params: unknown[] = [project, new Date(Date.now() - 86400_000).toISOString()];
        const eligible = eligibleAnnotation(workflow, params);
        return (
            await this.db.query<{ json: string }>(
                `SELECT json FROM notato.annotations WHERE project_id=$1 AND ${eligible} AND activity_received_at>=$2 ORDER BY seq DESC LIMIT 101`,
                params
            )
        ).map((r) => JSON.parse(r.json) as Annotation);
    }
    async connections(workspace: string) {
        return (
            await this.db.query<{ json: string }>(
                "SELECT json FROM notato.plugin_connections WHERE workspace_id=$1",
                [workspace]
            )
        ).map((r) => JSON.parse(r.json) as Connection);
    }
    async connection(workspace: string, id: string) {
        return parse<Connection>(
            (
                await this.db.query<{ json: string }>(
                    "SELECT json FROM notato.plugin_connections WHERE workspace_id=$1 AND id=$2",
                    [workspace, id]
                )
            )[0]
        );
    }
    async saveConnection(c: Connection, actor?: string) {
        const save = (tx: PgConnection) =>
            tx.query(
                "INSERT INTO notato.plugin_connections (id,workspace_id,json) VALUES ($1,$2,$3) ON CONFLICT(id) DO UPDATE SET json=excluded.json WHERE plugin_connections.workspace_id=excluded.workspace_id",
                [c.id, c.workspaceId, JSON.stringify(c)]
            );
        if (actor) await this.managed(c.workspaceId, actor, save);
        else await save(this.db);
    }
    async renameConnection(workspace: string, id: string, name: string, actor: string) {
        await this.managed(workspace, actor, (tx) =>
            tx.query(
                "UPDATE notato.plugin_connections SET json=jsonb_set(json::jsonb,'{name}',to_jsonb($3::text))::text WHERE workspace_id=$1 AND id=$2",
                [workspace, id, name]
            )
        );
    }
    async replaceConnection(c: Connection, actor: string, expectedRevision?: string) {
        await this.managed(c.workspaceId, actor, async (tx) => {
            const current = parse<Connection>(
                (
                    await tx.query<{ json: string }>(
                        "SELECT json FROM notato.plugin_connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
                        [c.workspaceId, c.id]
                    )
                )[0]
            );
            if (
                !current ||
                current.provider !== c.provider ||
                current.revision !== expectedRevision
            )
                throw new PluginError("This connection changed. Start reconnecting again.", 409);
            await tx.query(
                "UPDATE notato.plugin_connections SET json=$3 WHERE workspace_id=$1 AND id=$2",
                [
                    c.workspaceId,
                    c.id,
                    JSON.stringify({ ...c, name: current.name, createdAt: current.createdAt }),
                ]
            );
            await this.disablePersonal(tx, c.workspaceId, null, c.id);
        });
    }
    private async disablePersonal(
        tx: PgConnection,
        workspace: string,
        action: string | null,
        connection: string | null
    ) {
        const rows = await tx.query<{ json: string }>(
            "SELECT w.json FROM notato.plugin_workflows w JOIN notato.plugin_actions a ON a.id=w.action_id WHERE w.workspace_id=$1 AND (a.id=$2 OR a.connection_id=$3) AND w.json::jsonb->>'includePersonal'='true'",
            [workspace, action, connection]
        );
        for (const row of rows) {
            const w = JSON.parse(row.json) as Workflow;
            const updatedAt = new Date(
                Math.max(Date.now(), Date.parse(w.updatedAt ?? w.createdAt) + 1)
            ).toISOString();
            await tx.query(
                "UPDATE notato.plugin_workflows SET json=$3 WHERE workspace_id=$1 AND id=$2",
                [workspace, w.id, JSON.stringify({ ...w, includePersonal: false, updatedAt })]
            );
            await tx.query(
                "UPDATE notato.plugin_jobs SET status='canceled',error='The destination changed. Enable personal annotation routing again after reviewing it.' WHERE workspace_id=$1 AND workflow_id=$2 AND status IN ('queued','paused')",
                [workspace, w.id]
            );
        }
    }
    async connectionHealth(c: Connection, health: NonNullable<Connection["health"]>) {
        await this.db.query(
            "UPDATE notato.plugin_connections SET json=jsonb_set(json::jsonb,'{health}',$3::jsonb)::text WHERE workspace_id=$1 AND id=$2 AND coalesce(json::jsonb->>'revision','')=$4 AND json::jsonb->>'revoked'='false'",
            [c.workspaceId, c.id, JSON.stringify(health), c.revision ?? ""]
        );
    }
    async rotateConnection(c: Connection, encrypted: string) {
        return Boolean(
            (
                await this.db.query(
                    "UPDATE notato.plugin_connections SET json=jsonb_set(json::jsonb,'{encrypted}',to_jsonb($3::text))::text WHERE workspace_id=$1 AND id=$2 AND json::jsonb->>'encrypted'=$4 AND json::jsonb->>'revoked'='false' RETURNING id",
                    [c.workspaceId, c.id, encrypted, c.encrypted]
                )
            ).length
        );
    }
    async actions(workspace: string) {
        return (
            await this.db.query<{ json: string }>(
                "SELECT json FROM notato.plugin_actions WHERE workspace_id=$1",
                [workspace]
            )
        ).map((r) => JSON.parse(r.json) as Action);
    }
    async action(workspace: string, id: string) {
        return parse<Action>(
            (
                await this.db.query<{ json: string }>(
                    "SELECT json FROM notato.plugin_actions WHERE workspace_id=$1 AND id=$2",
                    [workspace, id]
                )
            )[0]
        );
    }
    async saveAction(a: Action) {
        await this.managed(a.workspaceId, a.creator, (tx) =>
            tx.query(
                "INSERT INTO notato.plugin_actions (id,workspace_id,connection_id,project_id,json) VALUES ($1,$2,$3,$4,$5)",
                [a.id, a.workspaceId, a.connectionId, a.projectId, JSON.stringify(a)]
            )
        );
    }
    async editAction(a: Action, actor: string, expected: Action) {
        await this.managed(a.workspaceId, actor, async (tx) => {
            const current = parse<Action>(
                (
                    await tx.query<{ json: string }>(
                        "SELECT json FROM notato.plugin_actions WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
                        [a.workspaceId, a.id]
                    )
                )[0]
            );
            if (!current || current.archived) throw new PluginError("Action not found.", 404);
            if (JSON.stringify(current) !== JSON.stringify(expected))
                throw new PluginError("This action changed. Reload it before saving.", 409);
            const connection = parse<Connection>(
                (
                    await tx.query<{ json: string }>(
                        "SELECT json FROM notato.plugin_connections WHERE workspace_id=$1 AND id=$2",
                        [a.workspaceId, a.connectionId]
                    )
                )[0]
            );
            const project = (
                await tx.query<{ id: string }>(
                    "SELECT id FROM notato.projects WHERE workspace_id=$1 AND id=$2",
                    [a.workspaceId, a.projectId]
                )
            )[0];
            if (
                !project ||
                !connection ||
                connection.revoked ||
                connection.provider !== a.destination.provider
            )
                throw new PluginError("Select a project and active connection in this workspace.");
            const workflows = await tx.query<{ json: string }>(
                "SELECT json FROM notato.plugin_workflows WHERE workspace_id=$1 AND action_id=$2",
                [a.workspaceId, a.id]
            );
            if (
                !["teams", "slack", "webhook"].includes(a.destination.provider) &&
                workflows.some(({ json }) => {
                    const w = JSON.parse(json) as Workflow;
                    return w.enabled && ["daily_digest", "unanswered"].includes(w.trigger);
                })
            )
                throw new PluginError(
                    "Pause this action's digest and reminder workflows before choosing an issue destination."
                );
            // Lock the jobs before checking their state: the worker must not claim one between the check and cancel.
            const jobs = await tx.query<{ status: string }>(
                "SELECT status FROM notato.plugin_jobs WHERE workspace_id=$1 AND action_id=$2 AND status IN ('queued','paused','running','review') FOR UPDATE",
                [a.workspaceId, a.id]
            );
            if (jobs.some((j) => ["running", "review"].includes(j.status)))
                throw new PluginError(
                    "Finish or review this action's in-flight deliveries before editing it.",
                    409
                );
            await tx.query(
                "UPDATE notato.plugin_actions SET connection_id=$3,project_id=$4,json=$5 WHERE workspace_id=$1 AND id=$2",
                [
                    a.workspaceId,
                    a.id,
                    a.connectionId,
                    a.projectId,
                    JSON.stringify({ ...a, creator: current.creator }),
                ]
            );
            if (
                current.connectionId !== a.connectionId ||
                current.projectId !== a.projectId ||
                JSON.stringify(current.destination) !== JSON.stringify(a.destination)
            )
                await this.disablePersonal(tx, a.workspaceId, a.id, null);
            await tx.query(
                "UPDATE notato.plugin_jobs SET status='canceled',error='The saved action was edited. Preview it again before sending.' WHERE workspace_id=$1 AND action_id=$2 AND status IN ('queued','paused')",
                [a.workspaceId, a.id]
            );
        });
    }
    async archiveAction(workspace: string, id: string, actor: string) {
        await this.managed(workspace, actor, async (tx) => {
            await tx.query(
                "UPDATE notato.plugin_actions SET json=(json::jsonb || '{\"archived\":true}'::jsonb)::text WHERE workspace_id=$1 AND id=$2",
                [workspace, id]
            );
            await tx.query(
                "UPDATE notato.plugin_workflows SET json=(json::jsonb || '{\"enabled\":false}'::jsonb)::text WHERE workspace_id=$1 AND action_id=$2",
                [workspace, id]
            );
            await tx.query(
                "UPDATE notato.plugin_jobs SET status='canceled',error='The saved action was archived.' WHERE workspace_id=$1 AND action_id=$2 AND status IN ('queued','paused')",
                [workspace, id]
            );
        });
    }
    async cancel(workspace: string, id: string, actor: string) {
        return Boolean(
            (
                await this.db.query(
                    `UPDATE notato.plugin_jobs SET status='canceled',error=NULL WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','paused') AND ${visibleJob("$3")} AND EXISTS (SELECT 1 FROM notato.memberships m WHERE m.workspace_id=$1 AND m.username=$3 AND (plugin_jobs.actor=$3 OR m.role IN ('owner','admin'))) RETURNING id`,
                    [workspace, id, actor]
                )
            ).length
        );
    }
    async workflows(workspace: string) {
        return (
            await this.db.query<{ json: string }>(
                "SELECT json FROM notato.plugin_workflows WHERE workspace_id=$1",
                [workspace]
            )
        ).map((r) => JSON.parse(r.json) as Workflow);
    }
    async saveWorkflow(w: Workflow, limit: number, expectedUpdatedAt?: string, actor = w.creator) {
        if (w.conditions) {
            const parsed = WorkflowConditions.safeParse(w.conditions);
            if (!parsed.success)
                throw new PluginError("Check the workflow conditions and tag values.");
            w = { ...w, conditions: parsed.data };
            if (w.tag || w.severity || w.intent)
                throw new PluginError("Use the condition rules instead of legacy filters.");
        }
        if (w.tag && WorkflowTag.safeParse(w.tag).data !== w.tag)
            throw new PluginError("Use a tag with letters, numbers, hyphens or underscores.");
        if (w.includePersonal && !workflowTags(w).length)
            throw new PluginError("Choose a required tag before including personal annotations.");
        await this.db.transaction(async (tx) => {
            await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
                w.workspaceId,
            ]);
            const role = (
                await tx.query<{ role: string }>(
                    "SELECT role FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
                    [w.workspaceId, actor]
                )
            )[0]?.role;
            if (!role || role === "member")
                throw new PluginError("Workspace owner or admin required.", 403);
            const action = parse<Action>(
                (
                    await tx.query<{ json: string }>(
                        "SELECT json FROM notato.plugin_actions WHERE workspace_id=$1 AND id=$2",
                        [w.workspaceId, w.actionId]
                    )
                )[0]
            );
            if (!action || (w.enabled && action.archived))
                throw new PluginError("Select an active action in this workspace.");
            if (
                w.enabled &&
                ["daily_digest", "unanswered"].includes(w.trigger) &&
                !["teams", "slack", "webhook"].includes(action.destination.provider)
            )
                throw new PluginError("Digests and reminders need a notification action.");
            const rows = await tx.query<{ json: string }>(
                "SELECT json FROM notato.plugin_workflows WHERE workspace_id=$1",
                [w.workspaceId]
            );
            const known = rows
                .map((r) => JSON.parse(r.json) as Workflow)
                .find((v) => v.id === w.id);
            const creator = known?.creator ?? w.creator;
            if (known?.conditions && !w.conditions)
                throw new PluginError(
                    "This workflow uses condition rules. Refresh before editing it.",
                    409
                );
            if (w.includePersonal && creator !== actor) {
                const fields = [
                    "name",
                    "actionId",
                    "tag",
                    "includePersonal",
                    "trigger",
                    "severity",
                    "intent",
                    "hourUtc",
                    "delayHours",
                    "conditions",
                ] as const;
                const pausing =
                    known &&
                    !w.enabled &&
                    fields.every(
                        (field) => JSON.stringify(w[field]) === JSON.stringify(known[field])
                    );
                if (!pausing)
                    throw new PluginError(
                        "Only this workflow’s creator can enable or edit personal annotation routing.",
                        403
                    );
            }
            if (expectedUpdatedAt && expectedUpdatedAt !== (known?.updatedAt ?? known?.createdAt))
                throw new PluginError("This workflow changed. Reload it before saving.", 409);
            if (
                w.enabled &&
                rows.filter((r) => {
                    const v = JSON.parse(r.json) as Workflow;
                    return v.enabled && v.id !== w.id;
                }).length >= limit
            )
                throw new PluginError("Your plan's active workflow allowance is full.");
            if (known) {
                await tx.query(
                    "SELECT id FROM notato.plugin_jobs WHERE workspace_id=$1 AND workflow_id=$2 AND status IN ('queued','paused') FOR UPDATE",
                    [w.workspaceId, w.id]
                );
                await tx.query(
                    "UPDATE notato.plugin_jobs SET status='canceled',error='The workflow was edited.' WHERE workspace_id=$1 AND workflow_id=$2 AND status IN ('queued','paused')",
                    [w.workspaceId, w.id]
                );
            }
            const saved = {
                ...w,
                creator,
                createdAt: known?.createdAt ?? w.createdAt,
                updatedAt: new Date(
                    Math.max(
                        Date.now(),
                        Date.parse(known?.updatedAt ?? known?.createdAt ?? w.createdAt) + 1
                    )
                ).toISOString(),
            };
            await tx.query(
                "INSERT INTO notato.plugin_workflows (id,workspace_id,action_id,json) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET action_id=excluded.action_id,json=excluded.json WHERE plugin_workflows.workspace_id=excluded.workspace_id",
                [w.id, w.workspaceId, w.actionId, JSON.stringify(saved)]
            );
        });
    }
    async history(workspace: string, actor?: string) {
        return (
            await this.db.query<Job>(
                `SELECT ${JOB} FROM notato.plugin_jobs WHERE workspace_id=$1 AND ${visibleJob("$2")} ORDER BY created_at DESC,id LIMIT 100`,
                [workspace, actor ?? null]
            )
        ).map(job);
    }
    async job(workspace: string, id: string, actor?: string) {
        const row = (
            await this.db.query<Job>(
                `SELECT ${JOB} FROM notato.plugin_jobs WHERE workspace_id=$1 AND id=$2 AND ${visibleJob("$3")}`,
                [workspace, id, actor ?? null]
            )
        )[0];
        return row ? job(row) : null;
    }
    async review(workspace: string, id: string, delivered: boolean) {
        return Boolean(
            (
                await this.db.query(
                    "UPDATE notato.plugin_jobs SET status=$3,next_at=$4 WHERE workspace_id=$1 AND id=$2 AND status='review' RETURNING id",
                    [
                        workspace,
                        id,
                        delivered ? "running" : "queued",
                        new Date(Date.now() + (delivered ? 120_000 : 0)).toISOString(),
                    ]
                )
            ).length
        );
    }
    async usage(workspace: string, period: string) {
        return Number(
            (
                await this.db.query<{ actions: number }>(
                    "SELECT actions FROM notato.plugin_usage WHERE workspace_id=$1 AND period=$2",
                    [workspace, period]
                )
            )[0]?.actions ?? 0
        );
    }
    async enqueue(
        input: {
            workspace: string;
            action: string;
            actor: string;
            note: string | null;
            workflow?: string;
            operation: string;
            payload?: Payload;
            personalActor?: string;
            expectedAction?: Action;
            expectedWorkflow?: Workflow;
        },
        tx: PgConnection = this.db
    ): Promise<string | undefined> {
        if (tx === this.db && typeof this.db.transaction === "function")
            return this.db.transaction((connection) => this.enqueue(input, connection));
        await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
            input.workspace,
        ]);
        if (input.expectedAction) {
            const current = parse<Action>(
                (
                    await tx.query<{ json: string }>(
                        "SELECT json FROM notato.plugin_actions WHERE workspace_id=$1 AND id=$2",
                        [input.workspace, input.action]
                    )
                )[0]
            );
            if (JSON.stringify(current) !== JSON.stringify(input.expectedAction))
                throw new PluginError("The action changed. Preview it again before sending.", 409);
        }
        if (input.expectedWorkflow) {
            const current = parse<Workflow>(
                (
                    await tx.query<{ json: string }>(
                        "SELECT json FROM notato.plugin_workflows WHERE workspace_id=$1 AND id=$2",
                        [input.workspace, input.workflow]
                    )
                )[0]
            );
            if (JSON.stringify(current) !== JSON.stringify(input.expectedWorkflow)) return;
        }
        const known = (
            await tx.query<{ id: string }>(
                "SELECT id FROM notato.plugin_jobs WHERE workspace_id=$1 AND operation=$2",
                [input.workspace, input.operation]
            )
        )[0];
        if (known) return known.id;
        if (!input.workflow) {
            const recent = Number(
                (
                    await tx.query<{ n: string }>(
                        "SELECT count(*) AS n FROM notato.plugin_jobs WHERE workspace_id=$1 AND workflow_id IS NULL AND created_at>=$2",
                        [input.workspace, new Date(Date.now() - 60_000).toISOString()]
                    )
                )[0]?.n ?? 0
            );
            if (recent >= 30)
                throw new PluginError(
                    "Action rate limit reached. Wait a minute before sending more actions.",
                    429
                );
        }
        const at = new Date().toISOString();
        const rows = await tx.query<{ id: string }>(
            "INSERT INTO notato.plugin_jobs (id,operation,workspace_id,action_id,actor,note_id,workflow_id,status,created_at,next_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$8,$9) ON CONFLICT(workspace_id,operation) DO NOTHING RETURNING id",
            [
                crypto.randomUUID(),
                input.operation,
                input.workspace,
                input.action,
                input.actor,
                input.note,
                input.workflow ?? null,
                at,
                storedPayload(input.payload, input.personalActor),
            ]
        );
        return (
            rows[0]?.id ??
            (
                await tx.query<{ id: string }>(
                    "SELECT id FROM notato.plugin_jobs WHERE workspace_id=$1 AND operation=$2",
                    [input.workspace, input.operation]
                )
            )[0]?.id
        );
    }
    /** Called inside the annotation transaction: an accepted capture and its workflow jobs commit together. */
    static async capture(
        tx: PgConnection,
        note: Annotation,
        trigger: string,
        previous?: Annotation
    ) {
        if (note.peopleOnly || note.review?.draft || note.author.kind === "agent") return;
        const assigned = (
            await tx.query<{ json: string }>("SELECT json FROM notato.team_records WHERE id=$1", [
                workId(note),
            ])
        )[0];
        let inPrivateWork = false;
        if (assigned) {
            const work = JSON.parse(assigned.json);
            if (
                work.shared === false ||
                (work.shared === undefined && work.contextId && !work.pullRequest)
            )
                inPrivateWork = true;
        }
        const rows = await tx.query<{ json: string; workspace: string }>(
            "SELECT w.json,p.workspace_id AS workspace FROM notato.plugin_workflows w JOIN notato.plugin_actions a ON a.id=w.action_id JOIN notato.projects p ON p.id=a.project_id WHERE p.id=$1",
            [note.projectId]
        );
        for (const row of rows) {
            const w = JSON.parse(row.json) as Workflow;
            if (
                !w.enabled ||
                w.trigger !== trigger ||
                !workflowMatches(w, note) ||
                (inPrivateWork && !personalWorkflowMatch(w, note)) ||
                (previous &&
                    (workflowMatches(w, previous) ||
                        (!w.conditions &&
                            !w.tag &&
                            !(previous.visibility === "personal" && note.visibility === "shared"))))
            )
                continue;
            await new PluginStore(tx as PgDatabase).enqueue(
                {
                    workspace: row.workspace,
                    action: w.actionId,
                    actor: w.creator,
                    note: note.id,
                    workflow: w.id,
                    expectedWorkflow: w,
                    ...(note.visibility === "personal" ? { personalActor: note.createdBy } : {}),
                    operation: `${w.id}:${note.id}:${trigger}${trigger === "created" ? "" : `:${crypto.randomUUID()}`}`,
                },
                tx
            );
        }
    }
    async claim(now: string): Promise<Job | null> {
        return this.db.transaction(async (tx) => {
            // A process may have sent an external create before dying: never blindly replay a stale in-flight job.
            await tx.query(
                "UPDATE notato.plugin_jobs SET status='review',error='Delivery was interrupted. Check the destination before retrying.' WHERE status='running' AND next_at<$1",
                [now]
            );
            await tx.query(
                "UPDATE notato.plugin_jobs SET status='queued' WHERE status='paused' AND next_at<=$1",
                [now]
            );
            const row = (
                await tx.query<Job>(
                    `SELECT ${JOB} FROM notato.plugin_jobs WHERE status='queued' AND next_at<=$1 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
                    [now]
                )
            )[0];
            if (!row) return null;
            await tx.query(
                "UPDATE notato.plugin_jobs SET status='running',attempts=attempts+1,next_at=$2 WHERE id=$1",
                [row.id, new Date(Date.parse(now) + 120_000).toISOString()]
            );
            return { ...job(row), attempts: Number(row.attempts) + 1 };
        });
    }
    async reserve(j: Job, period: string, limit: number) {
        return this.db.transaction(async (tx) => {
            await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
                j.workspaceId,
            ]);
            const used = Number(
                (
                    await tx.query<{ actions: number }>(
                        "SELECT actions FROM notato.plugin_usage WHERE workspace_id=$1 AND period=$2",
                        [j.workspaceId, period]
                    )
                )[0]?.actions ?? 0
            );
            const held = Number(
                (
                    await tx.query<{ n: string }>(
                        "SELECT count(*) AS n FROM notato.plugin_jobs WHERE workspace_id=$1 AND period=$2 AND status='running' AND workflow_id IS NOT NULL AND id!=$3",
                        [j.workspaceId, period, j.id]
                    )
                )[0]?.n ?? 0
            );
            if (used + held >= limit) return false;
            await tx.query("UPDATE notato.plugin_jobs SET period=$2 WHERE id=$1", [j.id, period]);
            return true;
        });
    }
    async finish(j: Job, status: string, result?: unknown, error?: string, payload?: Payload) {
        await this.db.transaction(async (tx) => {
            const rows = await tx.query<{ period: string }>(
                "UPDATE notato.plugin_jobs SET status=$2,result=$3,error=$4,payload=coalesce($5,payload),next_at=$6 WHERE id=$1 AND status='running' RETURNING period",
                [
                    j.id,
                    status,
                    result ? JSON.stringify(result) : null,
                    error ?? null,
                    storedPayload(payload ?? j.payload, j.personalActor),
                    new Date(
                        Date.now() + Math.min(3600_000, 30_000 * 2 ** j.attempts)
                    ).toISOString(),
                ]
            );
            if (status === "succeeded" && j.workflowId && rows[0]?.period)
                await tx.query(
                    "INSERT INTO notato.plugin_usage (workspace_id,period,actions) VALUES ($1,$2,1) ON CONFLICT(workspace_id,period) DO UPDATE SET actions=plugin_usage.actions+1",
                    [j.workspaceId, rows[0].period]
                );
        });
    }
    async prune(now: Date) {
        await this.db.query(
            "DELETE FROM notato.plugin_jobs WHERE created_at<$1 AND status IN ('succeeded','failed','canceled')",
            [new Date(now.getTime() - 90 * 86400_000).toISOString()]
        );
        await this.db.query("DELETE FROM notato.plugin_oauth WHERE expires_at<$1", [
            now.toISOString(),
        ]);
    }
    async unansweredReady(note: string, workflow: Workflow, now: Date) {
        const params: unknown[] = [
            note,
            new Date(now.getTime() - workflow.delayHours * 3600_000).toISOString(),
            workflow.createdAt,
        ];
        const eligible = eligibleAnnotation(workflow, params);
        return Boolean(
            (
                await this.db.query(
                    `SELECT id FROM notato.annotations WHERE id=$1 AND status='awaiting_response' AND ${eligible} AND activity_received_at<=$2 AND activity_received_at>=$3`,
                    params
                )
            ).length
        );
    }
    async scheduled(now: Date) {
        const workflows = await this.db.query<{ json: string; project: string }>(
            "SELECT w.json,a.project_id AS project FROM notato.plugin_workflows w JOIN notato.plugin_actions a ON a.id=w.action_id WHERE w.json::jsonb->>'enabled'='true' AND w.json::jsonb->>'trigger' IN ('unanswered','daily_digest')"
        );
        for (const row of workflows) {
            const w = JSON.parse(row.json) as Workflow;
            if (w.trigger === "daily_digest" && now.getUTCHours() >= w.hourUtc)
                await this.enqueue({
                    workspace: w.workspaceId,
                    action: w.actionId,
                    actor: w.creator,
                    note: null,
                    workflow: w.id,
                    expectedWorkflow: w,
                    ...(w.includePersonal ? { personalActor: w.creator } : {}),
                    operation: `${w.id}:${now.toISOString().slice(0, 10)}`,
                });
            if (w.trigger === "unanswered") {
                const params: unknown[] = [
                    row.project,
                    new Date(now.getTime() - w.delayHours * 3600_000).toISOString(),
                    w.createdAt,
                ];
                const eligible = eligibleAnnotation(w, params);
                const notes = await this.db.query<{ id: string; activity: string; json: string }>(
                    `SELECT id,activity_received_at AS activity,json FROM notato.annotations WHERE project_id=$1 AND status='awaiting_response' AND ${eligible} AND activity_received_at<=$2 AND activity_received_at>=$3 LIMIT 100`,
                    params
                );
                for (const n of notes)
                    await this.enqueue({
                        workspace: w.workspaceId,
                        action: w.actionId,
                        actor: w.creator,
                        note: n.id,
                        workflow: w.id,
                        expectedWorkflow: w,
                        ...(JSON.parse(n.json).visibility === "personal"
                            ? { personalActor: w.creator }
                            : {}),
                        operation: `${w.id}:${n.id}:unanswered:${n.activity}`,
                    });
            }
        }
    }
}
