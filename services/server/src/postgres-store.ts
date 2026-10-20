import { Annotation, type Status } from "@notato/schema";
import {
    type AnnotationFilter,
    annotationColumns,
    assertWorkPermit,
    type BundleRecord,
    type CaptureReceipt,
    currentWorkPermit,
    type DevelopmentContext,
    type HandedEntry,
    type StoredAnnotation,
    tokenPurpose,
    type WorkRecord,
    workId,
} from "@notato/server";
import { ulid } from "ulid";
import * as betaOps from "./beta-store.ts";
import * as billingOps from "./billing-store.ts";
import * as cleanupOps from "./cleanup-store.ts";
import {
    COLLABORATION_SCHEMA,
    coordinationFor,
    validatePermitCredential,
} from "./collaboration-store.ts";
import { databasePool } from "./database.ts";
import * as emailOps from "./email-preferences-store.ts";
import * as lifecycle from "./lifecycle-store.ts";
import * as planOps from "./plan-store.ts";
import { FREE_PLAN, lockedPlanLimits, planLimits } from "./plans.ts";
import { PLUGIN_SCHEMA, PluginStore } from "./plugins/store.ts";
import {
    POSTGRES_SCHEMA,
    POSTGRES_SCHEMA_VERSION,
    POSTGRES_TABLES,
    PROJECT_READS_SCHEMA,
} from "./postgres-schema.ts";
import {
    type AuditRecord,
    type AuthStore,
    assertTokenPurpose,
    DataControlError,
    DEFAULT_WORKSPACE_ID,
    type ExternalAccount,
    type HostedLimits,
    type InvitationRecord,
    type MembershipRecord,
    type ProjectRecord,
    type ProjectSummary,
    QuotaError,
    type SessionRecord,
    type Store,
    type TokenRecord,
    type UserRecord,
    WorkspaceOwnershipError,
    type WorkspaceRecord,
    type WorkspaceRole,
} from "./storage.ts";

/** The most one bundle's details (its names, app and dates) may take. */
const MAX_BUNDLE_JSON = 8 * 1024;
/** How many bundles one workspace keeps on a hosted service; they go only with their project. */
const BUNDLES_PER_WORKSPACE = 10_000;

/** A bundle's record as stored. Its details are a few names and dates: anything near the limit was not made by an app. */
function bundleJson(b: BundleRecord): string {
    const json = JSON.stringify(b);
    if (Buffer.byteLength(json) > MAX_BUNDLE_JSON)
        throw new DataControlError("bundle details are too large", 413);
    return json;
}

/** All values are bound parameters; this interface also lets contract tests run against embedded Postgres. */
export interface PgConnection {
    query<T = Record<string, unknown>>(statement: string, parameters?: unknown[]): Promise<T[]>;
}
export interface PgDatabase extends PgConnection {
    transaction<T>(work: (connection: PgConnection) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}

interface AnnotationRow {
    seq: number | string | bigint;
    json: string;
}
const parse = (row: AnnotationRow): StoredAnnotation => ({
    seq: Number(row.seq),
    annotation: Annotation.parse(JSON.parse(row.json)),
});
const PROJECT = 'id, name, created_at AS "createdAt", workspace_id AS "workspaceId"';
const WORKSPACE = 'id, name, created_at AS "createdAt"';
const MEMBER =
    'workspace_id AS "workspaceId", username, role, created_at AS "createdAt", project_only AS "projectOnly"';
const USER =
    'username, password_hash AS "passwordHash", created_at AS "createdAt", is_admin AS "isAdmin", email, display_name AS "displayName", identity_provider AS "identityProvider", identity_subject AS "identitySubject"';
const SESSION =
    'id, username, created_at AS "createdAt", expires_at AS "expiresAt", workspace_id AS "workspaceId", identity_session_id AS "identitySessionId", assurance_level AS "assuranceLevel"';
const TOKEN =
    'id, project_id AS "projectId", name, token_hash AS "tokenHash", created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt", workspace_id AS "workspaceId", permission, purpose, expires_at AS "expiresAt", created_by AS "createdBy", ownership, owner_username AS "ownerUsername", identity_namespace AS "identityNamespace", development_context_id AS "developmentContextId", capture_work_id AS "captureWorkId"';
const INVITE =
    'id, project_id AS "projectId", workspace_id AS "workspaceId", email, role, token_hash AS "tokenHash", created_by AS "createdBy", created_at AS "createdAt", expires_at AS "expiresAt", accepted_at AS "acceptedAt", revoked_at AS "revokedAt"';
const clean = <T>(row: T): T =>
    Object.fromEntries(
        Object.entries(row as object).filter(
            ([key, value]) => value !== null && !(key === "projectOnly" && value === false)
        )
    ) as T;
const placeholders = (n: number) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(", ");
const derivedNames = [
    "awaits_agent",
    "people_only",
    "diagnostic",
    "intent",
    "author_name",
    "last_activity_at",
    "last_word_id",
];
const waiting = new Set<Status>([
    "open",
    "awaiting_response",
    "variant_chosen",
    "revert_requested",
]);

/** Hosted record storage. Workspace access is enforced by Notato; browser database roles have no access to this schema. */
export class PostgresStore implements Store, AuthStore {
    private limits?: HostedLimits;
    private testPlans = false;
    private workspacePlans = false;
    private get planRules() {
        return this.testPlans || this.workspacePlans;
    }
    async setWorkspacePlans(enabled: boolean) {
        if (enabled && !this.limits)
            throw new DataControlError("workspace plans require hosted resource limits");
        if (enabled && this.testPlans)
            throw new DataControlError("payment-backed plans cannot use test selection");
        if (enabled && !this.workspacePlans) await this.lifecycle(planOps.seedFreeMeters());
        this.workspacePlans = enabled;
    }
    setTestPlans(enabled: boolean) {
        if (enabled && this.workspacePlans)
            throw new DataControlError("test selection cannot use payment-backed plans");
        if (enabled && !this.limits)
            throw new DataControlError("test plans require hosted resource limits");
        this.testPlans = enabled;
    }
    setHostedLimits(limits: HostedLimits) {
        this.limits = limits;
    }
    readonly coordination;
    readonly plugins: PluginStore;
    private constructor(private db: PgDatabase) {
        this.plugins = new PluginStore(db);
        this.coordination = coordinationFor(db);
    }

    static async open(database: PgDatabase): Promise<PostgresStore> {
        const store = new PostgresStore(database);
        await store.migrate();
        return store;
    }

    static async connect(url: string): Promise<PostgresStore> {
        const pool = databasePool(url);
        const db: PgDatabase = {
            async query<T>(statement: string, parameters: unknown[] = []) {
                return (await pool.query(statement, parameters)).rows as T[];
            },
            async transaction<T>(work: (connection: PgConnection) => Promise<T>) {
                const client = await pool.connect();
                try {
                    await client.query("BEGIN");
                    const result = await work({
                        async query<R>(statement: string, parameters: unknown[] = []) {
                            return (await client.query(statement, parameters)).rows as R[];
                        },
                    });
                    await client.query("COMMIT");
                    return result;
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                } finally {
                    client.release();
                }
            },
            async close() {
                await pool.end();
            },
        };
        try {
            return await PostgresStore.open(db);
        } catch (error) {
            await db.close();
            throw error;
        }
    }

    private async migrate() {
        await this.db.transaction(async (tx) => {
            await tx.query("SELECT pg_advisory_xact_lock(1281277356)");
            if (!(await tx.query("SELECT 1 FROM pg_namespace WHERE nspname='notato'")).length)
                await tx.query("CREATE SCHEMA notato");
            await tx.query("REVOKE ALL ON SCHEMA notato FROM PUBLIC");
            await tx.query(
                "CREATE TABLE IF NOT EXISTS notato.meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            );
            const row = (
                await tx.query<{ value: string }>(
                    "SELECT value FROM notato.meta WHERE key = 'schema_version'"
                )
            )[0];
            const current = Number(row?.value ?? 0);
            if (current > POSTGRES_SCHEMA_VERSION)
                throw new Error(
                    `Postgres schema ${current} is newer than this build; upgrade notato`
                );
            if (current < 1) {
                for (const statement of POSTGRES_SCHEMA) await tx.query(statement);
                await tx.query(
                    "INSERT INTO notato.workspaces (id,name,created_at) VALUES ($1,$2,$3) ON CONFLICT(id) DO NOTHING",
                    [DEFAULT_WORKSPACE_ID, "Default workspace", new Date().toISOString()]
                );
                await tx.query(
                    "INSERT INTO notato.meta (key,value) VALUES ('schema_version',$1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [String(POSTGRES_SCHEMA_VERSION)]
                );
            }
            // Additive index: existing version-14 databases also need authorised thumbnail lookups.
            if (current < 15) {
                await tx.query(
                    "ALTER TABLE notato.annotations ADD COLUMN IF NOT EXISTS capture_scope TEXT"
                );
                await tx.query(
                    "ALTER TABLE notato.annotations ADD COLUMN IF NOT EXISTS capture_fingerprint TEXT"
                );
            }
            await tx.query(
                "CREATE INDEX IF NOT EXISTS idx_annotations_thumbnail_shot ON notato.annotations((json::jsonb #>> '{screenshots,thumbnail,id}'))"
            );
            if (current < 16) {
                await tx.query(
                    "CREATE INDEX IF NOT EXISTS idx_annotations_references ON notato.annotations USING gin ((json::jsonb->'references') jsonb_path_ops)"
                );
                await tx.query(
                    "CREATE INDEX IF NOT EXISTS idx_annotations_review ON notato.annotations(project_id, (json::jsonb #>> '{review,id}'))"
                );
            }
            if (current >= 1 && current < 17) {
                await tx.query(
                    "ALTER TABLE IF EXISTS notato.workspace_plans DROP CONSTRAINT IF EXISTS workspace_plans_plan_check"
                );
                await tx.query(
                    "ALTER TABLE IF EXISTS notato.workspace_plans ADD CONSTRAINT workspace_plans_plan_check CHECK (plan IN ('free','plus','pro','team'))"
                );
            }
            if (current < 2) {
                await tx.query(
                    "ALTER TABLE notato.tokens ADD COLUMN permission TEXT CHECK(permission IN ('capture','full'))"
                );
                await tx.query("ALTER TABLE notato.tokens ADD COLUMN expires_at TEXT");
            }
            await tx.query(
                "INSERT INTO notato.meta (key,value) VALUES ('schema_version',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [String(POSTGRES_SCHEMA_VERSION)]
            );
            if (current < 3) {
                await tx.query("ALTER TABLE notato.sessions ADD COLUMN identity_session_id TEXT");
                await tx.query(
                    "ALTER TABLE notato.sessions ADD COLUMN assurance_level TEXT CHECK(assurance_level IN ('aal1','aal2'))"
                );
                await tx.query(
                    "CREATE TABLE notato.identity_revocations (provider TEXT NOT NULL, subject TEXT NOT NULL, session_id TEXT NOT NULL, revoked_at TEXT NOT NULL, PRIMARY KEY(provider,subject,session_id))"
                );
            }
            if (current < 4) {
                await tx.query(
                    "CREATE TABLE notato.audit (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, outcome INTEGER NOT NULL, created_at TEXT NOT NULL)"
                );
                await tx.query(
                    "CREATE INDEX idx_audit_workspace ON notato.audit(workspace_id, created_at)"
                );
            }
            if (current < 6)
                await tx.query(
                    "CREATE TABLE notato.identity_devices (provider TEXT NOT NULL, subject TEXT NOT NULL, session_id TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY(provider,subject,session_id))"
                );
            if (current < 5)
                await tx.query(
                    "ALTER TABLE notato.annotations ADD COLUMN asset_bytes BIGINT NOT NULL DEFAULT 0"
                );
            if (current < 7)
                await tx.query(
                    "ALTER TABLE notato.tokens ADD COLUMN created_by TEXT REFERENCES notato.users(username)"
                );
            if (current < 8) await tx.query(PROJECT_READS_SCHEMA);
            if (current < 9) {
                for (const statement of lifecycle.LIFECYCLE_SCHEMA) await tx.query(statement);
                await tx.query(
                    "ALTER TABLE notato.annotations ADD COLUMN IF NOT EXISTS activity_received_at TEXT NOT NULL DEFAULT ''"
                );
                await tx.query(
                    "UPDATE notato.annotations SET activity_received_at=$1 WHERE activity_received_at=''",
                    [new Date().toISOString()]
                );
            }
            if (current < 10)
                for (const statement of billingOps.BILLING_SCHEMA) await tx.query(statement);
            if (current < 11)
                for (const statement of planOps.PLAN_SCHEMA) await tx.query(statement);
            if (current < 12) {
                await tx.query(
                    "ALTER TABLE notato.tokens ADD COLUMN IF NOT EXISTS purpose TEXT CHECK(purpose IN ('app','agent'))"
                );
                await tx.query(
                    "UPDATE notato.tokens SET purpose=CASE WHEN permission='capture' THEN 'app' ELSE 'agent' END WHERE purpose IS NULL"
                );
            }
            if (current < 13) {
                await tx.query(
                    "ALTER TABLE notato.tokens ADD COLUMN IF NOT EXISTS ownership TEXT CHECK(ownership IN ('user','service','project'))"
                );
                await tx.query(
                    "ALTER TABLE notato.tokens ADD COLUMN IF NOT EXISTS owner_username TEXT REFERENCES notato.users(username) ON DELETE CASCADE"
                );
                await tx.query(
                    "UPDATE notato.tokens SET ownership=CASE WHEN purpose='agent' THEN 'project' WHEN created_by IS NOT NULL THEN 'user' ELSE 'service' END, owner_username=CASE WHEN purpose='app' THEN created_by ELSE NULL END WHERE ownership IS NULL"
                );
                await tx.query(
                    "ALTER TABLE notato.tokens ADD COLUMN IF NOT EXISTS identity_namespace TEXT"
                );
                await tx.query(
                    "UPDATE notato.tokens t SET identity_namespace=coalesce((SELECT identity_provider FROM notato.users WHERE username=t.created_by),(SELECT min(u.identity_provider) FROM notato.memberships m JOIN notato.users u ON u.username=m.username WHERE m.workspace_id=t.workspace_id AND m.role='owner' HAVING count(DISTINCT u.identity_provider)=1)) WHERE identity_namespace IS NULL"
                );
                await tx.query(
                    "CREATE INDEX IF NOT EXISTS idx_tokens_owner ON notato.tokens(workspace_id,owner_username)"
                );
            }
            if (current < 14)
                for (const statement of betaOps.BETA_SCHEMA) await tx.query(statement);
            for (const statement of emailOps.EMAIL_PREFERENCE_SCHEMA) await tx.query(statement);
            for (const statement of COLLABORATION_SCHEMA) await tx.query(statement);
            for (const statement of PLUGIN_SCHEMA) await tx.query(statement);
            for (const table of POSTGRES_TABLES) {
                await tx.query(`ALTER TABLE notato.${table} ENABLE ROW LEVEL SECURITY`);
                await tx.query(`REVOKE ALL ON TABLE notato.${table} FROM PUBLIC`);
            }
            await tx.query("REVOKE ALL ON ALL SEQUENCES IN SCHEMA notato FROM PUBLIC");
            // Refuse database access to legacy browser-facing roles if they happen to exist.
            await tx.query(`DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
                    REVOKE ALL ON SCHEMA notato FROM anon;
                    REVOKE ALL ON ALL TABLES IN SCHEMA notato FROM anon;
                    REVOKE ALL ON ALL SEQUENCES IN SCHEMA notato FROM anon;
                END IF;
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
                    REVOKE ALL ON SCHEMA notato FROM authenticated;
                    REVOKE ALL ON ALL TABLES IN SCHEMA notato FROM authenticated;
                    REVOKE ALL ON ALL SEQUENCES IN SCHEMA notato FROM authenticated;
                END IF;
            END $$`);
        });
    }

    async checkIngestBudget(a: Annotation, assetBytes: number): Promise<void> {
        await this.assertBudget(this.db, a, assetBytes);
    }
    private async workspaceLimits(
        tx: PgConnection,
        workspace: string
    ): Promise<HostedLimits | undefined> {
        if (!this.limits) return undefined;
        await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [workspace]);
        if (this.planRules) {
            const access = await this.operation(
                tx,
                planOps.entitlement(workspace, this.workspacePlans)
            );
            return access.locked ? lockedPlanLimits() : planLimits(access.plan);
        }
        const row = (
            await tx.query<{ limits: string }>(
                "SELECT limits FROM notato.workspace_billing WHERE workspace_id=$1 AND period_end>$2 AND limits IS NOT NULL",
                [workspace, new Date().toISOString()]
            )
        )[0];
        return row ? { ...this.limits, ...JSON.parse(row.limits) } : this.limits;
    }
    private async assertBudget(
        tx: PgConnection,
        a: Annotation,
        assetBytes: number,
        exclude?: string
    ) {
        if (!this.limits) return;
        const project = (
            await tx.query<{ workspace_id: string }>(
                "SELECT workspace_id FROM notato.projects WHERE id=$1",
                [a.projectId]
            )
        )[0];
        if (!project) return;
        await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
            project.workspace_id,
        ]);
        const limits = (await this.workspaceLimits(tx, project.workspace_id)) ?? this.limits;
        if (!exclude && this.planRules) {
            const access = await this.operation(
                tx,
                planOps.entitlement(project.workspace_id, this.workspacePlans)
            );
            if (access.locked)
                throw new QuotaError(
                    "Activate this workspace's subscription or convert it to Free before sending new notes."
                );
            await this.operation(tx, planOps.assertActiveCapacity(project.workspace_id, limits));
        }
        if (!exclude && limits.notesPerMonth !== undefined)
            await this.operation(
                tx,
                planOps.assertMonthly(
                    project.workspace_id,
                    limits.notesPerMonth,
                    this.planRules &&
                        (
                            await this.operation(
                                tx,
                                planOps.entitlement(project.workspace_id, this.workspacePlans)
                            )
                        ).plan.id === "free",
                    true
                )
            );
        const usage = (
            await tx.query<{ n: string; bytes: string; json_bytes: string }>(
                "SELECT count(*) AS n, coalesce(sum(octet_length(a.json) + a.asset_bytes),0) AS bytes, coalesce(sum(octet_length(a.json)),0) AS json_bytes FROM notato.annotations a JOIN notato.projects p ON p.id=a.project_id WHERE p.workspace_id=$1 AND a.id != $2",
                [project.workspace_id, exclude ?? ""]
            )
        )[0];
        const bundles = await this.bundleUsage(tx, project.workspace_id);
        if (
            Number(usage?.n) >= limits.notes ||
            Number(usage?.json_bytes) + bundles.bytes + Buffer.byteLength(JSON.stringify(a)) >
                (limits.jsonBytes ?? 16 * 1024 * 1024) ||
            Number(usage?.bytes) +
                bundles.bytes +
                Buffer.byteLength(JSON.stringify(a)) +
                assetBytes >
                limits.bytes
        )
            throw new QuotaError(
                "This workspace's storage allowance is full. Delete unneeded feedback to free space or ask the owner to select a larger plan."
            );
    }
    async insertAnnotation(
        a: Annotation,
        assetBytes = 0,
        receipt?: CaptureReceipt
    ): Promise<StoredAnnotation> {
        return this.db.transaction(async (tx) => {
            await this.assertBudget(tx, a, assetBytes);
            const d = annotationColumns(a);
            const values = [
                a.id,
                a.projectId,
                a.bundleId,
                a.status,
                a.severity ?? null,
                a.route,
                a.author.kind,
                a.createdAt,
                JSON.stringify(a),
                ...Object.values(d),
                assetBytes,
                new Date().toISOString(),
                receipt?.scope ?? null,
                receipt?.fingerprint ?? null,
            ];
            const row = (
                await tx.query<AnnotationRow>(
                    `INSERT INTO notato.annotations (id,project_id,bundle_id,status,severity,route,author_kind,created_at,json,${derivedNames.join(",")},asset_bytes,activity_received_at,capture_scope,capture_fingerprint) VALUES (${placeholders(values.length)}) RETURNING seq,json`,
                    values
                )
            )[0];
            if (this.limits) {
                const project = (
                    await tx.query<{ workspace_id: string }>(
                        "SELECT workspace_id FROM notato.projects WHERE id=$1",
                        [a.projectId]
                    )
                )[0];
                if (!project) throw new DataControlError("project not found", 404);
                await this.operation(
                    tx,
                    planOps.receipt(
                        project.workspace_id,
                        this.planRules &&
                            (
                                await this.operation(
                                    tx,
                                    planOps.entitlement(project.workspace_id, this.workspacePlans)
                                )
                            ).plan.id === "free"
                    )
                );
            }
            await PluginStore.capture(tx, a, "created");
            return parse(row as AnnotationRow);
        });
    }
    private async operation<T>(tx: PgConnection, operation: lifecycle.Operation<T>): Promise<T> {
        let step = operation.next();
        while (!step.done) {
            const rows = await tx.query<Record<string, unknown>>(step.value.sql, step.value.params);
            step = operation.next(rows);
        }
        return step.value;
    }
    private async lifecycle<T>(operation: lifecycle.Operation<T>): Promise<T> {
        return this.db.transaction((tx) => this.operation(tx, operation));
    }
    getWorkspaceLimits(id: string) {
        return this.workspaceLimits(this.db, id);
    }
    async getWorkspacePlan(id: string) {
        return this.planRules ? (await this.getWorkspaceEntitlement(id)).plan : null;
    }
    getWorkspaceEntitlement(id: string) {
        return this.lifecycle(planOps.entitlement(id, this.workspacePlans));
    }
    workspaceCleanup(id: string, actor: string, project?: string, before?: number) {
        return this.lifecycle(
            cleanupOps.workspaceCleanup(id, actor, true, this.workspacePlans, project, before)
        );
    }
    async monthlyNoteUsage(id: string) {
        return this.lifecycle(
            planOps.monthly(
                id,
                this.planRules && ((await this.getWorkspacePlan(id)) ?? FREE_PLAN).id === "free"
            )
        );
    }
    async selectWorkspacePlan(
        id: string,
        actor: string,
        plan: import("./storage.ts").PlanId,
        extraSeats: number
    ) {
        if (!this.planRules) throw new DataControlError("test plan selection is disabled", 403);
        return this.lifecycle(
            planOps.changePlan(id, actor, { id: plan, extraSeats }, true, this.workspacePlans)
        );
    }
    getBilling(id: string) {
        return this.lifecycle(billingOps.billing(id));
    }
    billingWorkspace(id: string) {
        return this.lifecycle(billingOps.billingWorkspace(id));
    }
    setBillingCustomer(id: string, customer: string) {
        return this.lifecycle(billingOps.setCustomer(id, customer));
    }
    applyBillingEvent(id: string, state: import("./storage.ts").WorkspaceBilling, at: string) {
        return this.lifecycle(billingOps.applyEvent(id, state, at, true));
    }
    saveCheckout(
        id: string,
        checkout: NonNullable<import("./storage.ts").WorkspaceBilling["checkout"]> | null
    ) {
        return this.lifecycle(billingOps.saveCheckout(id, checkout));
    }
    workspaceUsage(id: string) {
        return this.lifecycle(billingOps.usage(id, true));
    }
    getWorkspacePolicy(id: string) {
        return this.lifecycle(lifecycle.workspacePolicy(id));
    }
    setWorkspacePolicy(id: string, actor: string, days: number | null) {
        return this.lifecycle(lifecycle.saveWorkspacePolicy(id, actor, days, true));
    }
    deleteWorkspace(id: string, actor: string) {
        return this.lifecycle(lifecycle.removeWorkspace(id, actor, true));
    }
    deleteAccount(username: string, at: string, deletePrivateWorkspaces = false) {
        return this.lifecycle(lifecycle.removeAccount(username, at, true, deletePrivateWorkspaces));
    }
    pendingIdentityDeletions(now: string) {
        return this.lifecycle(lifecycle.pendingIdentityDeletions(now));
    }
    identityDeletionResult(provider: string, subject: string, success: boolean, next: string) {
        return this.lifecycle(lifecycle.identityDeletionResult(provider, subject, success, next));
    }
    expiredAnnotations(now: string, limit = 100) {
        return this.lifecycle(lifecycle.expiredAnnotations(now, limit, true));
    }
    deleteExpiredAnnotation(id: string, now: string) {
        return this.lifecycle(lifecycle.deleteExpiredAnnotation(id, now, true));
    }

    async getCaptureReceipt(id: string): Promise<CaptureReceipt | null> {
        const row = (
            await this.db.query<CaptureReceipt>(
                "SELECT capture_scope AS scope,capture_fingerprint AS fingerprint FROM notato.annotations WHERE id=$1",
                [id]
            )
        )[0];
        return row?.scope && row.fingerprint ? row : null;
    }

    async getAnnotation(id: string): Promise<StoredAnnotation | null> {
        const row = (
            await this.db.query<AnnotationRow>(
                "SELECT seq,json FROM notato.annotations WHERE id = $1",
                [id]
            )
        )[0];
        return row ? parse(row) : null;
    }
    async listAnnotations(filter: AnnotationFilter = {}): Promise<StoredAnnotation[]> {
        const where: string[] = [];
        const values: unknown[] = [];
        const bind = (value: unknown) => {
            values.push(value);
            return `$${values.length}`;
        };
        const any = (column: string, value: string | string[]) => {
            const items = Array.isArray(value) ? value : [value];
            where.push(items.length ? `${column} IN (${items.map(bind).join(",")})` : "FALSE");
        };
        if (filter.projectId !== undefined) any("project_id", filter.projectId);
        const workKey =
            "COALESCE(notato.annotations.json::jsonb->>'workId','work:' || notato.annotations.project_id || ':' || COALESCE(notato.annotations.json::jsonb #>> '{review,id}',notato.annotations.id))";
        if (filter.workId) where.push(`${workKey}=${bind(filter.workId)}`);
        if (filter.workContext)
            where.push(
                `EXISTS(SELECT 1 FROM notato.team_records t WHERE t.id=${workKey} AND t.kind='work' AND t.json::jsonb->>'contextId'=${bind(filter.workContext)})`
            );
        if (filter.workSession)
            where.push(
                `EXISTS(SELECT 1 FROM notato.team_records t WHERE t.id=${workKey} AND (t.json::jsonb #>> '{claim,session}' IS NULL OR t.json::jsonb #>> '{claim,session}'=${bind(filter.workSession)}))`
            );
        if (filter.legacyOnly)
            where.push(
                `NOT EXISTS(SELECT 1 FROM notato.team_records t WHERE t.id=${workKey} AND t.kind='work' AND t.json::jsonb->>'contextId' IS NOT NULL)`
            );
        if (filter.reviewId !== undefined)
            where.push(`(json::jsonb #>> '{review,id}') = ${bind(filter.reviewId)}`);
        if (filter.status !== undefined) any("status", filter.status);
        if (filter.intent !== undefined) any("intent", filter.intent);
        for (const [column, value] of [
            ["route", filter.route],
            ["severity", filter.severity],
            ["author_kind", filter.authorKind],
            ["bundle_id", filter.bundleId],
            ["author_name", filter.authorName],
        ] as const) {
            if (value === null) where.push(`${column} IS NULL`);
            else if (value !== undefined) where.push(`${column} = ${bind(value)}`);
        }
        if (filter.afterSeq !== undefined) where.push(`seq > ${bind(filter.afterSeq)}`);
        if (filter.lastReplyBy === "human") where.push("awaits_agent = 1");
        if (filter.peopleOnly === false) where.push("people_only = 0");
        if (filter.sessionId) {
            const ids = filter.sessionAnnotationIds ?? [];
            where.push(
                `(json::jsonb->>'sessionId'=${bind(filter.sessionId)}${ids.length ? ` OR id IN (${ids.map(bind).join(",")})` : ""})`
            );
        }
        if (filter.feedbackScope === "mine")
            where.push(
                `(json::jsonb->>'visibility'='personal' AND json::jsonb->>'createdBy'=${bind(filter.feedbackActorId ?? "")})`
            );
        else if (filter.feedbackScope === "shared")
            where.push(`COALESCE(json::jsonb->>'visibility','shared')='shared'`);
        else if (filter.feedbackScope === "all")
            where.push(
                `(COALESCE(json::jsonb->>'visibility','shared')='shared' OR (json::jsonb->>'visibility'='personal' AND json::jsonb->>'createdBy'=${bind(filter.feedbackActorId ?? "")}))`
            );
        if (filter.diagnostic === false) where.push("diagnostic = 0");
        if (filter.unhanded) where.push("handed_reply_id IS DISTINCT FROM last_word_id");
        if (filter.excludeIds?.length)
            where.push(`id NOT IN (${filter.excludeIds.map(bind).join(",")})`);
        const limit = filter.limit ? ` LIMIT ${bind(Math.max(1, Math.floor(filter.limit)))}` : "";
        const json = filter.summary
            ? `((json::jsonb - 'steps') || jsonb_build_object('context', CASE
                WHEN json::jsonb #> '{context,screenshot}' IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('screenshot', json::jsonb #> '{context,screenshot}') END))::text`
            : "json";
        return (
            await this.db.query<AnnotationRow>(
                `SELECT seq,${json} AS json FROM notato.annotations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq${limit}`,
                values
            )
        ).map(parse);
    }
    async updateAnnotation(
        id: string,
        mutate: (current: Annotation) => Annotation
    ): Promise<StoredAnnotation | null> {
        return this.db.transaction(async (tx) => {
            if (this.limits || currentWorkPermit())
                await tx.query(
                    "SELECT w.id FROM notato.workspaces w JOIN notato.projects p ON p.workspace_id=w.id JOIN notato.annotations a ON a.project_id=p.id WHERE a.id=$1 FOR UPDATE OF w",
                    [id]
                );
            const permit = currentWorkPermit();
            if (permit)
                await tx.query(
                    "SELECT p.id FROM notato.projects p JOIN notato.annotations a ON a.project_id=p.id WHERE a.id=$1 FOR UPDATE OF p",
                    [id]
                );
            const row = (
                await tx.query<AnnotationRow>(
                    "SELECT seq,json,asset_bytes FROM notato.annotations WHERE id = $1 FOR UPDATE",
                    [id]
                )
            )[0];
            if (!row) return null;
            if (permit) {
                await validatePermitCredential(tx, permit, parse(row).annotation.projectId);
                const read = async (key: string) => {
                    const r = (
                        await tx.query<{ json: string }>(
                            "SELECT json FROM notato.team_records WHERE id=$1 FOR UPDATE",
                            [key]
                        )
                    )[0];
                    return r ? JSON.parse(r.json) : null;
                };
                assertWorkPermit(
                    parse(row).annotation,
                    (await read(workId(parse(row).annotation))) as WorkRecord | null,
                    (await read(permit.contextId)) as DevelopmentContext | null,
                    permit
                );
            }
            const next = Annotation.parse(mutate(parse(row).annotation));
            const charged = row as AnnotationRow & { asset_bytes: string };
            await this.assertBudget(tx, next, Number(charged.asset_bytes), id);
            const values = [
                next.status,
                next.severity ?? null,
                next.route,
                JSON.stringify(next),
                ...Object.values(annotationColumns(next)),
                new Date().toISOString(),
                id,
            ];
            await tx.query(
                `UPDATE notato.annotations SET status=$1,severity=$2,route=$3,json=$4,${derivedNames.map((name, i) => `${name}=$${i + 5}`).join(",")},activity_received_at=$${values.length - 1} WHERE id=$${values.length}`,
                values
            );
            const previous = parse(row).annotation;
            if (
                next.comment !== previous.comment ||
                next.visibility !== previous.visibility ||
                next.severity !== previous.severity ||
                next.intent !== previous.intent ||
                next.peopleOnly !== previous.peopleOnly ||
                next.review?.draft !== previous.review?.draft
            )
                await PluginStore.capture(tx, next, "created", previous);
            if (next.status !== parse(row).annotation.status)
                await PluginStore.capture(tx, next, next.status);
            return { seq: Number(row.seq), annotation: next };
        });
    }
    async deleteAnnotation(id: string): Promise<boolean> {
        return (
            (await this.db.query("DELETE FROM notato.annotations WHERE id = $1 RETURNING id", [id]))
                .length > 0
        );
    }
    async markHanded(entries: HandedEntry[]) {
        await this.db.transaction(async (tx) => {
            for (const entry of entries)
                await tx.query("UPDATE notato.annotations SET handed_reply_id = $1 WHERE id = $2", [
                    entry.replyId,
                    entry.id,
                ]);
        });
    }
    async listProjects(workspaceId?: string, username?: string): Promise<ProjectSummary[]> {
        const records = await this.db.query<ProjectRecord>(
            `SELECT ${PROJECT} FROM notato.projects ${workspaceId === undefined ? "" : "WHERE workspace_id = $1"} ORDER BY id`,
            workspaceId === undefined ? [] : [workspaceId]
        );
        const projects = new Map<string, ProjectSummary>(
            records.map((p) => [
                p.id,
                { ...p, annotations: 0, open: 0, statuses: {}, lastActivityAt: p.createdAt },
            ])
        );
        const rows = await this.db.query<{
            id: string;
            status: Status;
            n: string;
            first: string;
            last: string;
        }>(
            `SELECT a.project_id AS id,a.status,COUNT(*) AS n,MIN(a.created_at) AS first,MAX(coalesce(a.last_activity_at,a.created_at)) AS last FROM notato.annotations a ${workspaceId === undefined ? "" : "LEFT JOIN notato.projects p ON p.id = a.project_id WHERE coalesce(p.workspace_id,$1) = $2"} GROUP BY a.project_id,a.status ORDER BY a.project_id`,
            workspaceId === undefined ? [] : [DEFAULT_WORKSPACE_ID, workspaceId]
        );
        const recorded = new Set(projects.keys());
        for (const row of rows) {
            const p = projects.get(row.id) ?? {
                id: row.id,
                name: row.id,
                createdAt: row.first,
                workspaceId: DEFAULT_WORKSPACE_ID,
                annotations: 0,
                open: 0,
                statuses: {},
                lastActivityAt: row.last,
            };
            if (!recorded.has(row.id) && Date.parse(row.first) < Date.parse(p.createdAt))
                p.createdAt = row.first;
            const n = Number(row.n);
            p.annotations += n;
            if (waiting.has(row.status)) p.open += n;
            p.statuses[row.status] = n;
            if (Date.parse(row.last) > Date.parse(p.lastActivityAt)) p.lastActivityAt = row.last;
            projects.set(row.id, p);
        }
        if (username) {
            const reads = await this.db.query<{
                id: string;
                read_at: string | null;
                unread: string;
            }>(
                `SELECT p.id,r.read_at,COUNT(a.id) AS unread FROM notato.projects p
                LEFT JOIN notato.project_reads r ON r.project_id=p.id AND r.username=$1
                LEFT JOIN notato.annotations a ON a.project_id=p.id
                    AND (r.read_at IS NULL OR coalesce(a.last_activity_at,a.created_at)>r.read_at)
                ${workspaceId === undefined ? "" : "WHERE p.workspace_id=$2"}
                GROUP BY p.id,r.read_at`,
                workspaceId === undefined ? [username] : [username, workspaceId]
            );
            for (const row of reads) {
                const project = projects.get(row.id);
                if (project) {
                    project.unread = Number(row.unread);
                    if (row.read_at) project.readAt = row.read_at;
                }
            }
        }
        return [...projects.values()];
    }
    async markProjectRead(projectId: string, username: string, at: string): Promise<void> {
        await this.db.query(
            `INSERT INTO notato.project_reads (project_id,username,read_at) VALUES ($1,$2,$3)
            ON CONFLICT(project_id,username) DO UPDATE SET read_at=greatest(project_reads.read_at,excluded.read_at)`,
            [projectId, username, at]
        );
    }
    async getProject(id: string): Promise<ProjectRecord | null> {
        return (
            (
                await this.db.query<ProjectRecord>(
                    `SELECT ${PROJECT} FROM notato.projects WHERE id=$1`,
                    [id]
                )
            )[0] ?? null
        );
    }
    async createProject(p: ProjectRecord): Promise<boolean> {
        return this.db.transaction(async (tx) => {
            const workspace = p.workspaceId ?? DEFAULT_WORKSPACE_ID;
            const limits = await this.workspaceLimits(tx, workspace);
            if (limits) {
                await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
                    workspace,
                ]);
                const count = (
                    await tx.query<{ n: string }>(
                        "SELECT count(*) AS n FROM notato.projects WHERE workspace_id=$1",
                        [workspace]
                    )
                )[0];
                if (Number(count?.n) >= limits.projects) throw new QuotaError();
            }
            return (
                (
                    await tx.query(
                        "INSERT INTO notato.projects (id,name,created_at,workspace_id) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id",
                        [p.id, p.name, p.createdAt, p.workspaceId ?? DEFAULT_WORKSPACE_ID]
                    )
                ).length > 0
            );
        });
    }
    async transferProject(
        project: string,
        workspace: string,
        actor: string
    ): Promise<ProjectRecord> {
        return this.db.transaction(async (tx) => {
            const source = (
                await tx.query<ProjectRecord>(
                    `SELECT ${PROJECT} FROM notato.projects WHERE id=$1`,
                    [project]
                )
            )[0];
            if (!source?.workspaceId) throw new DataControlError("Project not found.", 404);
            for (const id of [...new Set([source.workspaceId, workspace])].sort())
                if (
                    !(
                        await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
                            id,
                        ])
                    ).length
                )
                    throw new DataControlError("Workspace not found.", 404);
            const current = (
                await tx.query<ProjectRecord>(
                    `SELECT ${PROJECT} FROM notato.projects WHERE id=$1 FOR UPDATE`,
                    [project]
                )
            )[0];
            if (current?.workspaceId !== source.workspaceId)
                throw new DataControlError("The project moved. Reload and try again.");
            const target = (
                await tx.query<{ role: string }>(
                    "SELECT role FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
                    [workspace, actor]
                )
            )[0];
            if (
                !(await this.mayManageProject(tx, source.workspaceId, project, actor)) ||
                !target ||
                target.role === "member"
            )
                throw new DataControlError(
                    "Manage the source project and be an owner or admin of the destination workspace.",
                    403
                );

            const limits = (await this.workspaceLimits(tx, workspace)) ?? this.limits;
            if (limits) {
                const usage = (
                    await tx.query<{ projects: string; notes: string; bytes: string }>(
                        "SELECT (SELECT count(*) FROM notato.projects WHERE workspace_id=$1) AS projects, count(a.id) AS notes, coalesce(sum(octet_length(a.json)+a.asset_bytes),0) AS bytes FROM notato.annotations a JOIN notato.projects p ON p.id=a.project_id WHERE p.workspace_id=$1 OR p.id=$2",
                        [workspace, project]
                    )
                )[0]!;
                const bundleBytes = (
                    await tx.query<{ bytes: string }>(
                        "SELECT coalesce(sum(octet_length(b.json)),0) AS bytes FROM notato.bundles b JOIN notato.projects p ON p.id=b.project_id WHERE p.workspace_id=$1 OR p.id=$2",
                        [workspace, project]
                    )
                )[0];
                if (
                    (source.workspaceId !== workspace &&
                        Number(usage.projects) >= limits.projects) ||
                    Number(usage.notes) > limits.notes ||
                    Number(usage.bytes) + Number(bundleBytes?.bytes ?? 0) > limits.bytes
                )
                    throw new QuotaError(
                        "The destination workspace needs capacity for this project and its history."
                    );
            }
            // Lock queued deliveries as well, so a worker cannot start one between this check
            // and cancellation while the project's workspace is changing.
            const deliveries = await tx.query<{ status: string }>(
                "SELECT j.status FROM notato.plugin_jobs j JOIN notato.plugin_actions a ON a.id=j.action_id WHERE a.project_id=$1 AND j.status IN ('running','review','queued','paused') FOR UPDATE OF j",
                [project]
            );
            if (deliveries.some((job) => job.status === "running" || job.status === "review"))
                throw new DataControlError(
                    "Finish or reconcile this project's running plugin jobs before transferring it."
                );
            if (
                (
                    await tx.query(
                        "SELECT id FROM notato.team_records WHERE project_id=$1 AND kind='work' AND json::jsonb #>> '{publication,status}' IN ('sending','uncertain')",
                        [project]
                    )
                ).length
            )
                throw new DataControlError(
                    "Reconcile active or uncertain PR publications before moving the project."
                );
            const at = new Date().toISOString();
            await tx.query(
                "UPDATE notato.team_records SET json=(json::jsonb || '{\"archived\":true}'::jsonb)::text WHERE project_id=$1 AND kind='context'",
                [project]
            );
            const workRecords = await tx.query<{ id: string; json: string }>(
                "SELECT id,json FROM notato.team_records WHERE project_id=$1 AND kind='work' FOR UPDATE",
                [project]
            );
            for (const record of workRecords) {
                const work = JSON.parse(record.json) as WorkRecord;
                delete work.claim;
                work.contextId = null;
                work.recoveryRequired = true;
                work.version += 1;
                work.updatedAt = at;
                await tx.query("UPDATE notato.team_records SET json=$1 WHERE id=$2", [
                    JSON.stringify(work),
                    record.id,
                ]);
            }
            await tx.query(
                "UPDATE notato.tokens SET revoked_at=$1 WHERE project_id=$2 AND revoked_at IS NULL",
                [at, project]
            );
            await tx.query(
                "UPDATE notato.invitations SET revoked_at=$1 WHERE project_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
                [at, project]
            );
            await tx.query(
                "UPDATE notato.plugin_workflows SET json=(json::jsonb || '{\"enabled\":false}'::jsonb)::text WHERE action_id IN (SELECT id FROM notato.plugin_actions WHERE project_id=$1)",
                [project]
            );
            await tx.query(
                "UPDATE notato.plugin_jobs SET status='canceled',payload=CASE WHEN payload::jsonb->>'personalActor' IS NOT NULL THEN json_build_object('personalActor',payload::jsonb->>'personalActor')::text ELSE NULL END,error='Project transferred' WHERE action_id IN (SELECT id FROM notato.plugin_actions WHERE project_id=$1) AND status IN ('queued','paused')",
                [project]
            );
            await tx.query(
                "UPDATE notato.plugin_actions SET json=(json::jsonb || '{\"archived\":true}'::jsonb)::text WHERE project_id=$1",
                [project]
            );
            const record = (
                await tx.query<{ json: string }>(
                    "SELECT json FROM notato.team_records WHERE id=$1 FOR UPDATE",
                    ["project-access:" + project]
                )
            )[0];
            const access = record
                ? JSON.parse(record.json)
                : {
                      recordKind: "project",
                      id: "project-access:" + project,
                      projectId: project,
                      members: { [actor]: "admin" },
                  };
            access.owner = { kind: "workspace", id: workspace };
            access.access = "members";
            access.updatedAt = at;
            await tx.query(
                "INSERT INTO notato.team_records (id,project_id,kind,json) VALUES ($1,$2,'project',$3) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
                [access.id, project, JSON.stringify(access)]
            );
            await tx.query("UPDATE notato.projects SET workspace_id=$1 WHERE id=$2", [
                workspace,
                project,
            ]);
            return { ...current, workspaceId: workspace };
        });
    }
    async renameProject(id: string, name: string): Promise<ProjectRecord | null> {
        return (
            (
                await this.db.query<ProjectRecord>(
                    `UPDATE notato.projects SET name=$1 WHERE id=$2 RETURNING ${PROJECT}`,
                    [name, id]
                )
            )[0] ?? null
        );
    }
    async deleteProject(id: string): Promise<StoredAnnotation[] | null> {
        return this.db.transaction(async (tx) => {
            const known = await tx.query("SELECT id FROM notato.projects WHERE id=$1 FOR UPDATE", [
                id,
            ]);
            const removed = (
                await tx.query<AnnotationRow>(
                    "DELETE FROM notato.annotations WHERE project_id=$1 RETURNING seq,json",
                    [id]
                )
            )
                .map(parse)
                .sort((a, b) => a.seq - b.seq);
            if (!known.length && !removed.length) return null;
            await tx.query("DELETE FROM notato.bundles WHERE project_id=$1", [id]);
            await tx.query("DELETE FROM notato.projects WHERE id=$1", [id]);
            return removed;
        });
    }

    async getProjectOrigins(id: string): Promise<string[]> {
        const row = (
            await this.db.query<{ allowed_origins: string }>(
                "SELECT allowed_origins FROM notato.projects WHERE id=$1",
                [id]
            )
        )[0];
        return row ? (JSON.parse(row.allowed_origins) as string[]) : [];
    }
    async setProjectOrigins(id: string, origins: string[]): Promise<boolean> {
        return (
            (
                await this.db.query(
                    "UPDATE notato.projects SET allowed_origins=$1 WHERE id=$2 RETURNING id",
                    [JSON.stringify(origins), id]
                )
            ).length > 0
        );
    }
    async projectsWithAsset(
        id: string,
        filter: Pick<AnnotationFilter, "peopleOnly" | "feedbackScope" | "feedbackActorId"> = {}
    ): Promise<string[]> {
        const values: unknown[] = [id];
        const bind = (value: unknown) => {
            values.push(value);
            return `$${values.length}`;
        };
        const where = [
            filter.peopleOnly === false ? "people_only = 0" : "TRUE",
            filter.feedbackScope === "mine"
                ? `(json::jsonb->>'visibility'='personal' AND json::jsonb->>'createdBy'=${bind(filter.feedbackActorId ?? "")})`
                : filter.feedbackScope === "shared"
                  ? `COALESCE(json::jsonb->>'visibility','shared')='shared'`
                  : filter.feedbackScope === "all"
                    ? `(COALESCE(json::jsonb->>'visibility','shared')='shared' OR (json::jsonb->>'visibility'='personal' AND json::jsonb->>'createdBy'=${bind(filter.feedbackActorId ?? "")}) )`
                    : "TRUE",
            `((json::jsonb #>> '{screenshots,full,id}') = $1 OR (json::jsonb #>> '{screenshots,crop,id}') = $1 OR (json::jsonb #>> '{screenshots,thumbnail,id}') = $1 OR (json::jsonb->'references') @> jsonb_build_array(jsonb_build_object('id', $1::text)))`,
        ];
        return (
            await this.db.query<{ id: string }>(
                `SELECT DISTINCT project_id AS id FROM notato.annotations WHERE ${where.join(" AND ")}`,
                values
            )
        ).map((row) => row.id);
    }
    /** Refuses a bundle its workspace has no room for, before any of its notes is stored (the import's own hook). */
    async checkBundleBudget(b: BundleRecord): Promise<void> {
        const json = bundleJson(b);
        await this.db.transaction((tx) => this.assertBundleBudget(tx, b, json));
    }
    async insertBundle(b: BundleRecord): Promise<boolean> {
        const json = bundleJson(b);
        return this.db.transaction(async (tx) => {
            // Checked again as it is recorded, under the workspace's lock: imports running together all passed the hook.
            if (!(await tx.query("SELECT 1 FROM notato.bundles WHERE id=$1", [b.id])).length)
                await this.assertBundleBudget(tx, b, json);
            return (
                (
                    await tx.query(
                        "INSERT INTO notato.bundles (id,project_id,created_at,imported_at,json) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id",
                        [b.id, b.projectId, b.createdAt, b.importedAt, json]
                    )
                ).length > 0
            );
        });
    }
    /** Bundles are kept for as long as their project: on a hosted service they count toward it like its notes do. */
    private async assertBundleBudget(tx: PgConnection, b: BundleRecord, json: string) {
        if (!this.limits) return;
        const project = (
            await tx.query<{ workspace_id: string }>(
                "SELECT workspace_id FROM notato.projects WHERE id=$1",
                [b.projectId]
            )
        )[0];
        if (!project) return;
        const limits = (await this.workspaceLimits(tx, project.workspace_id)) ?? this.limits;
        const notes = (
            await tx.query<{ bytes: string; json_bytes: string }>(
                "SELECT coalesce(sum(octet_length(a.json) + a.asset_bytes),0) AS bytes, coalesce(sum(octet_length(a.json)),0) AS json_bytes FROM notato.annotations a JOIN notato.projects p ON p.id=a.project_id WHERE p.workspace_id=$1",
                [project.workspace_id]
            )
        )[0];
        const bundles = await this.bundleUsage(tx, project.workspace_id);
        const size = Buffer.byteLength(json);
        if (
            bundles.count >= BUNDLES_PER_WORKSPACE ||
            Number(notes?.json_bytes) + bundles.bytes + size >
                (limits.jsonBytes ?? 16 * 1024 * 1024) ||
            Number(notes?.bytes) + bundles.bytes + size > limits.bytes
        )
            throw new QuotaError(
                "This workspace's storage allowance is full. Delete unneeded feedback to free space or ask the owner to select a larger plan."
            );
    }
    /** How many bundles a workspace keeps, and the bytes their details take. */
    private async bundleUsage(tx: PgConnection, workspace: string) {
        const row = (
            await tx.query<{ n: string; bytes: string }>(
                "SELECT count(*) AS n, coalesce(sum(octet_length(b.json)),0) AS bytes FROM notato.bundles b JOIN notato.projects p ON p.id=b.project_id WHERE p.workspace_id=$1",
                [workspace]
            )
        )[0];
        return { count: Number(row?.n), bytes: Number(row?.bytes) };
    }
    async serviceCapacity() {
        const row = (
            await this.db.query<{ database_bytes: string; stored_bytes: string }>(
                "SELECT pg_database_size(current_database()) AS database_bytes, (SELECT coalesce(sum(octet_length(json) + asset_bytes),0) FROM notato.annotations) + (SELECT coalesce(sum(octet_length(json)),0) FROM notato.bundles) AS stored_bytes"
            )
        )[0];
        return {
            databaseBytes: Number(row?.database_bytes),
            storedBytes: Number(row?.stored_bytes),
        };
    }
    async getBundle(id: string): Promise<BundleRecord | null> {
        const row = (
            await this.db.query<{ json: string }>("SELECT json FROM notato.bundles WHERE id=$1", [
                id,
            ])
        )[0];
        return row ? (JSON.parse(row.json) as BundleRecord) : null;
    }
    async listBundles(projectId?: string, limit?: number): Promise<BundleRecord[]> {
        const params: unknown[] = projectId === undefined ? [] : [projectId];
        const most =
            limit !== undefined && Number.isFinite(limit)
                ? ` LIMIT $${params.push(Math.max(0, Math.floor(limit)))}`
                : "";
        return (
            await this.db.query<{ json: string }>(
                `SELECT json FROM notato.bundles ${projectId === undefined ? "" : "WHERE project_id=$1"} ORDER BY imported_at DESC${most}`,
                params
            )
        ).map((row) => JSON.parse(row.json) as BundleRecord);
    }

    async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
        return (
            (
                await this.db.query<WorkspaceRecord>(
                    `SELECT ${WORKSPACE} FROM notato.workspaces WHERE id=$1`,
                    [id]
                )
            )[0] ?? null
        );
    }
    async listWorkspaces(): Promise<WorkspaceRecord[]> {
        return this.db.query<WorkspaceRecord>(
            `SELECT ${WORKSPACE} FROM notato.workspaces ORDER BY id`
        );
    }
    /** Pull request reviews in any workspace for a repository, by pull request number or by reviewed/latest commit. */
    async pullRequestWorks(
        repository: string,
        match: { number: number } | { sha: string }
    ): Promise<import("@notato/server").WorkRecord[]> {
        const repo = "lower(json::jsonb #>> '{pullRequest,repository}')=$1";
        const rows =
            "number" in match
                ? await this.db.query<{ json: string }>(
                      `SELECT json FROM notato.team_records WHERE kind='work' AND ${repo} AND (json::jsonb #>> '{pullRequest,number}')=$2 ORDER BY id LIMIT 200`,
                      [repository.toLowerCase(), String(match.number)]
                  )
                : await this.db.query<{ json: string }>(
                      `SELECT json FROM notato.team_records WHERE kind='work' AND ${repo} AND ((json::jsonb #>> '{pullRequest,headSha}')=$2 OR (json::jsonb #>> '{pullRequest,latestHeadSha}')=$2) ORDER BY id LIMIT 200`,
                      [repository.toLowerCase(), match.sha]
                  );
        return rows.map((row) => JSON.parse(row.json));
    }
    getMarketingPreference(username: string, fingerprint: string) {
        return this.operation(this.db, emailOps.preference(username, fingerprint));
    }
    setMarketingPreference(input: {
        username: string;
        fingerprint: string;
        enabled: boolean;
        expectedRevision: number;
        source: "onboarding" | "settings";
        copyVersion: string;
    }) {
        return this.lifecycle(
            emailOps.setPreference({
                ...input,
                eventId: ulid(),
                at: new Date().toISOString(),
            })
        );
    }
    suppressEmail(
        fingerprint: string,
        reason: emailOps.SuppressionReason,
        source: emailOps.PreferenceSource
    ) {
        return this.lifecycle(
            emailOps.suppress({
                fingerprint,
                reason,
                source,
                eventId: ulid(),
                at: new Date().toISOString(),
            })
        );
    }
    marketingEligible(username: string, fingerprint: string) {
        return this.operation(this.db, emailOps.eligible(username, fingerprint));
    }
    exportMarketingRecords(username: string, fingerprint: string) {
        return this.operation(this.db, emailOps.records(username, fingerprint));
    }
    purgeEmailRecords(cutoff: string) {
        return this.lifecycle(emailOps.purge(cutoff));
    }
    marketingSendHeld() {
        return this.operation(this.db, emailOps.sendHeld());
    }
    setMarketingSendHold(held: boolean) {
        return this.lifecycle(emailOps.setSendHold(held));
    }
    getBetaRequest(id: string) {
        return this.operation(this.db, betaOps.get(id));
    }
    betaSettings() {
        return this.operation(this.db, betaOps.settings());
    }
    requestBeta(request: Omit<betaOps.BetaRequest, "state" | "updatedAt">) {
        return this.db.transaction((tx) => this.operation(tx, betaOps.request(request)));
    }
    listBetaRequests(state?: betaOps.BetaState, cursor?: string) {
        return this.operation(this.db, betaOps.list(state, cursor));
    }
    betaOverview() {
        return this.operation(this.db, betaOps.overview());
    }
    configureBeta(config: betaOps.BetaSettings) {
        return this.db.transaction((tx) =>
            this.operation(tx, betaOps.configure(config, new Date().toISOString()))
        );
    }
    inviteBeta(id: string, actor: string, hash: string, expires: string) {
        return this.db.transaction((tx) =>
            this.operation(tx, betaOps.invite(id, actor, hash, new Date().toISOString(), expires))
        );
    }
    revokeBeta(id: string) {
        return this.db.transaction((tx) =>
            this.operation(tx, betaOps.revoke(id, new Date().toISOString()))
        );
    }
    betaInvitation(hash: string) {
        return this.operation(this.db, betaOps.invitation(hash, new Date().toISOString()));
    }
    betaAccountBlocked(username: string) {
        return this.operation(this.db, betaOps.blocked(username));
    }
    betaWorkspaceBlocked(workspace: string) {
        return this.operation(this.db, betaOps.workspaceBlocked(workspace));
    }
    async ownedFreeWorkspace(username: string) {
        if (!this.planRules) return null;
        return this.operation(
            this.db,
            planOps.freeWorkspaceConflict("", username, this.workspacePlans)
        );
    }
    async createWorkspace(
        w: WorkspaceRecord,
        owner: string,
        plan?: import("./storage.ts").WorkspacePlan
    ): Promise<boolean> {
        return this.db.transaction(async (tx) => {
            if (plan && !this.planRules)
                throw new DataControlError("test plan selection is disabled", 403);
            const selected = plan ?? FREE_PLAN;
            if (this.planRules) {
                planLimits(selected);
                await tx.query("SELECT username FROM notato.users WHERE username=$1 FOR UPDATE", [
                    owner,
                ]);
                if ((await tx.query("SELECT id FROM notato.workspaces WHERE id=$1", [w.id])).length)
                    return false;
                if (selected.id === "free")
                    await this.operation(
                        tx,
                        planOps.assertFreeOwner(w.id, owner, this.workspacePlans)
                    );
            }
            if (this.limits) {
                await tx.query("SELECT username FROM notato.users WHERE username=$1 FOR UPDATE", [
                    owner,
                ]);
                const count = (
                    await tx.query<{ n: string }>(
                        "SELECT count(*) AS n FROM notato.memberships WHERE username=$1 AND role='owner'",
                        [owner]
                    )
                )[0];
                if (Number(count?.n) >= (this.planRules ? 100 : this.limits.workspaces))
                    throw new QuotaError();
            }
            const created = await tx.query(
                "INSERT INTO notato.workspaces (id,name,created_at) VALUES ($1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING id",
                [w.id, w.name, w.createdAt]
            );
            if (!created.length) return false;
            await tx.query(
                "INSERT INTO notato.memberships (workspace_id,username,role,created_at) VALUES ($1,$2,'owner',$3)",
                [w.id, owner, w.createdAt]
            );
            if (this.planRules) await this.operation(tx, planOps.saveSelection(w.id, selected));
            return true;
        });
    }
    async renameWorkspace(id: string, name: string): Promise<WorkspaceRecord | null> {
        return (
            (
                await this.db.query<WorkspaceRecord>(
                    `UPDATE notato.workspaces SET name=$1 WHERE id=$2 RETURNING ${WORKSPACE}`,
                    [name, id]
                )
            )[0] ?? null
        );
    }
    async getMembership(workspace: string, username: string): Promise<MembershipRecord | null> {
        const row = (
            await this.db.query<MembershipRecord>(
                `SELECT ${MEMBER} FROM notato.memberships WHERE workspace_id=$1 AND username=$2`,
                [workspace, username]
            )
        )[0];
        return row ? clean(row) : null;
    }
    async listMemberships(username: string): Promise<MembershipRecord[]> {
        return (
            await this.db.query<MembershipRecord>(
                `SELECT ${MEMBER} FROM notato.memberships WHERE username=$1 ORDER BY workspace_id`,
                [username]
            )
        ).map(clean);
    }
    async listWorkspaceMembers(workspace: string): Promise<MembershipRecord[]> {
        return (
            await this.db.query<MembershipRecord>(
                `SELECT ${MEMBER} FROM notato.memberships WHERE workspace_id=$1 ORDER BY username`,
                [workspace]
            )
        ).map(clean);
    }
    private async assertOwnerRemains(tx: PgConnection, workspace: string, username: string) {
        // Serialise changes per workspace so two owners cannot both remove the other concurrently.
        await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [workspace]);
        const row = (
            await tx.query<{ role: string }>(
                "SELECT role FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
                [workspace, username]
            )
        )[0];
        if (row?.role !== "owner") return;
        if (
            !(
                await tx.query(
                    "SELECT 1 FROM notato.memberships WHERE workspace_id=$1 AND username<>$2 AND role='owner' LIMIT 1",
                    [workspace, username]
                )
            ).length
        )
            throw new WorkspaceOwnershipError();
    }
    async setMembership(m: MembershipRecord) {
        await this.db.transaction(async (tx) => {
            if (m.role !== "owner") await this.assertOwnerRemains(tx, m.workspaceId, m.username);
            else
                await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
                    m.workspaceId,
                ]);
            if (m.role === "owner" && this.planRules) {
                await tx.query("SELECT username FROM notato.users WHERE username=$1 FOR UPDATE", [
                    m.username,
                ]);
                if (
                    await this.operation(
                        tx,
                        planOps.isFreeWorkspace(m.workspaceId, this.workspacePlans)
                    )
                )
                    await this.operation(
                        tx,
                        planOps.assertFreeOwner(m.workspaceId, m.username, this.workspacePlans)
                    );
            }
            await this.assertMemberCapacity(tx, m.workspaceId, m.username);
            await tx.query(
                "INSERT INTO notato.memberships (workspace_id,username,role,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT(workspace_id,username) DO UPDATE SET role=excluded.role",
                [m.workspaceId, m.username, m.role, m.createdAt]
            );
            if (m.role !== "owner")
                await tx.query(
                    "UPDATE notato.invitations SET revoked_at=$1 WHERE workspace_id=$2 AND created_by=$3 AND accepted_at IS NULL AND revoked_at IS NULL AND ($4='member' OR role IN ('admin','owner'))",
                    [new Date().toISOString(), m.workspaceId, m.username, m.role]
                );
        });
    }
    async removeMembership(workspace: string, username: string): Promise<boolean> {
        return this.db.transaction(async (tx) => {
            await this.assertOwnerRemains(tx, workspace, username);
            const projects = await tx.query<{ id: string; json: string }>(
                "SELECT t.id,t.json FROM notato.team_records t JOIN notato.projects p ON p.id=t.project_id WHERE p.workspace_id=$1 AND t.kind='project' FOR UPDATE OF t",
                [workspace]
            );
            for (const project of projects) {
                const access = JSON.parse(project.json) as import("@notato/server").ProjectAccess;
                delete access.members[username];
                if (access.owner.kind === "user" && access.owner.id === username)
                    access.owner = { kind: "workspace", id: workspace };
                access.updatedAt = new Date().toISOString();
                await tx.query("UPDATE notato.team_records SET json=$1 WHERE id=$2", [
                    JSON.stringify(access),
                    project.id,
                ]);
            }
            await tx.query("DELETE FROM notato.sessions WHERE username=$1 AND workspace_id=$2", [
                username,
                workspace,
            ]);
            await tx.query(
                "UPDATE notato.tokens SET revoked_at=$1 WHERE workspace_id=$2 AND owner_username=$3 AND ownership='user' AND revoked_at IS NULL",
                [new Date().toISOString(), workspace, username]
            );
            await tx.query(
                "UPDATE notato.invitations SET revoked_at=$1 WHERE workspace_id=$2 AND created_by=$3 AND accepted_at IS NULL AND revoked_at IS NULL",
                [new Date().toISOString(), workspace, username]
            );
            return (
                (
                    await tx.query(
                        "DELETE FROM notato.memberships WHERE workspace_id=$1 AND username=$2 RETURNING username",
                        [workspace, username]
                    )
                ).length > 0
            );
        });
    }

    async createInvitation(i: InvitationRecord) {
        await this.db.transaction(async (tx) => {
            await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
                i.workspaceId,
            ]);
            if (
                !(i.projectId && i.role === "member"
                    ? await this.mayManageProject(tx, i.workspaceId, i.projectId, i.createdBy)
                    : await this.mayGrant(tx, i.workspaceId, i.createdBy, i.role))
            )
                throw new DataControlError(
                    "only a current workspace owner or admin can invite people",
                    403
                );
            const limits = await this.workspaceLimits(tx, i.workspaceId);
            if (
                this.planRules &&
                (await this.operation(tx, planOps.entitlement(i.workspaceId, this.workspacePlans)))
                    .plan.id === "free"
            )
                throw new DataControlError(
                    "Free workspaces are private. Select Pro or Team to invite people."
                );
            if (limits) {
                await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
                    i.workspaceId,
                ]);
                const count = (
                    await tx.query<{ n: string }>(
                        "SELECT count(*) AS n FROM notato.invitations WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>$2",
                        [i.workspaceId, new Date().toISOString()]
                    )
                )[0];
                if (Number(count?.n) >= (limits.invitations ?? 100)) throw new QuotaError();
            }
            await tx.query(
                "INSERT INTO notato.invitations (id,workspace_id,email,role,token_hash,created_by,created_at,expires_at,project_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                [
                    i.id,
                    i.workspaceId,
                    i.email,
                    i.role,
                    i.tokenHash,
                    i.createdBy,
                    i.createdAt,
                    i.expiresAt,
                    i.projectId ?? null,
                ]
            );
        });
    }
    async getInvitation(hash: string): Promise<InvitationRecord | null> {
        const row = (
            await this.db.query<InvitationRecord>(
                `SELECT ${INVITE} FROM notato.invitations WHERE token_hash=$1`,
                [hash]
            )
        )[0];
        return row ? clean(row) : null;
    }
    async listInvitations(workspace: string): Promise<InvitationRecord[]> {
        return (
            await this.db.query<InvitationRecord>(
                `SELECT ${INVITE} FROM notato.invitations WHERE workspace_id=$1 ORDER BY created_at DESC`,
                [workspace]
            )
        ).map(clean);
    }
    async revokeInvitation(workspace: string, id: string, at: string): Promise<boolean> {
        return (
            (
                await this.db.query(
                    "UPDATE notato.invitations SET revoked_at=$1 WHERE workspace_id=$2 AND id=$3 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id",
                    [at, workspace, id]
                )
            ).length > 0
        );
    }
    /**
     * Whether someone may grant a role in a workspace now: an owner any role, an admin membership only. Asked under the
     * workspace's lock, which every membership change takes too, so a manager removed or demoted while a request of
     * theirs was still arriving grants nothing once it lands.
     */
    private async mayManageProject(
        tx: PgConnection,
        workspace: string,
        project: string,
        actor: string
    ) {
        const row = (
            await tx.query<{ role: string }>(
                "SELECT m.role FROM notato.memberships m JOIN notato.projects p ON p.workspace_id=m.workspace_id WHERE p.id=$1 AND m.workspace_id=$2 AND m.username=$3",
                [project, workspace, actor]
            )
        )[0];
        if (!row) return false;
        if (row.role === "owner" || row.role === "admin") return true;
        const record = (
            await tx.query<{ json: string }>("SELECT json FROM notato.team_records WHERE id=$1", [
                "project-access:" + project,
            ])
        )[0];
        if (!record) return false;
        const access = JSON.parse(record.json) as import("@notato/server").ProjectAccess;
        return (
            access.members[actor] === "owner" ||
            access.members[actor] === "admin" ||
            (access.owner.kind === "user" && access.owner.id === actor)
        );
    }
    private async mayGrant(
        tx: PgConnection,
        workspace: string,
        username: string,
        role: WorkspaceRole
    ): Promise<boolean> {
        const held = (
            await tx.query<{ role: WorkspaceRole }>(
                "SELECT role FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
                [workspace, username]
            )
        )[0]?.role;
        return held === "owner" || (held === "admin" && role === "member");
    }
    private async assertMemberCapacity(tx: PgConnection, workspace: string, username: string) {
        const limits = await this.workspaceLimits(tx, workspace);
        if (
            !limits ||
            (
                await tx.query(
                    "SELECT 1 FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
                    [workspace, username]
                )
            ).length
        )
            return;
        const count = (
            await tx.query<{ n: string }>(
                "SELECT count(*) AS n FROM notato.memberships WHERE workspace_id=$1",
                [workspace]
            )
        )[0];
        if (Number(count?.n) >= (limits.members ?? 100)) throw new QuotaError();
    }
    async acceptInvitation(
        hash: string,
        username: string,
        at: string
    ): Promise<MembershipRecord | null> {
        return this.db.transaction(async (tx) => {
            const invite = (
                await tx.query<InvitationRecord>(
                    `SELECT ${INVITE} FROM notato.invitations WHERE token_hash=$1 FOR UPDATE`,
                    [hash]
                )
            )[0];
            if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= at)
                return null;
            const user = (
                await tx.query<UserRecord>(`SELECT ${USER} FROM notato.users WHERE username=$1`, [
                    username,
                ])
            )[0];
            if (!user?.identityProvider || user.email !== invite.email) return null;
            await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
                invite.workspaceId,
            ]);
            // An invitation is only as good as the authority of whoever sent it, now.
            if (
                !(invite.projectId && invite.role === "member"
                    ? await this.mayManageProject(
                          tx,
                          invite.workspaceId,
                          invite.projectId,
                          invite.createdBy
                      )
                    : await this.mayGrant(tx, invite.workspaceId, invite.createdBy, invite.role))
            )
                return null;
            await this.assertMemberCapacity(tx, invite.workspaceId, username);
            await tx.query(
                "INSERT INTO notato.memberships (workspace_id,username,role,created_at,project_only) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,username) DO UPDATE SET project_only=memberships.project_only AND excluded.project_only",
                [invite.workspaceId, username, invite.role, at, Boolean(invite.projectId)]
            );
            if (invite.projectId) {
                const id = "project-access:" + invite.projectId;
                const row = (
                    await tx.query<{ json: string }>(
                        "SELECT json FROM notato.team_records WHERE id=$1 FOR UPDATE",
                        [id]
                    )
                )[0];
                const access = row
                    ? JSON.parse(row.json)
                    : {
                          recordKind: "project",
                          id,
                          projectId: invite.projectId,
                          owner: { kind: "user", id: invite.createdBy },
                          access: "workspace",
                          members: { [invite.createdBy]: "owner" },
                      };
                if (!Object.hasOwn(access.members, username)) access.members[username] = "member";
                access.updatedAt = at;
                await tx.query(
                    "INSERT INTO notato.team_records (id,project_id,kind,json) VALUES ($1,$2,'project',$3) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
                    [id, invite.projectId, JSON.stringify(access)]
                );
            }
            await tx.query("UPDATE notato.invitations SET accepted_at=$1 WHERE id=$2", [
                at,
                invite.id,
            ]);
            return (
                await tx.query<MembershipRecord>(
                    `SELECT ${MEMBER} FROM notato.memberships WHERE workspace_id=$1 AND username=$2`,
                    [invite.workspaceId, username]
                )
            )[0] as MembershipRecord;
        });
    }
    async getUser(username: string): Promise<UserRecord | null> {
        const row = (
            await this.db.query<UserRecord>(`SELECT ${USER} FROM notato.users WHERE username=$1`, [
                username,
            ])
        )[0];
        return row ? clean(row) : null;
    }
    async createUser(u: UserRecord): Promise<boolean> {
        return (
            (
                await this.db.query(
                    "INSERT INTO notato.users (username,password_hash,created_at,is_admin) VALUES ($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING RETURNING username",
                    [u.username, u.passwordHash, u.createdAt, u.isAdmin ?? false]
                )
            ).length > 0
        );
    }
    async provisionIdentity(
        a: ExternalAccount,
        allowNewAccount = true,
        beta?: { invitationHash?: string; bypass: boolean }
    ): Promise<UserRecord> {
        return this.db.transaction(async (tx) => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
                a.provider,
                a.subject,
            ]);
            if (
                (
                    await tx.query(
                        "SELECT 1 FROM notato.deleted_identities WHERE provider=$1 AND subject=$2",
                        [a.provider, a.subject]
                    )
                ).length
            )
                throw new DataControlError("this account was deleted", 410);
            const existing = (
                await tx.query<{ username: string }>(
                    "SELECT username FROM notato.users WHERE identity_provider=$1 AND identity_subject=$2",
                    [a.provider, a.subject]
                )
            )[0];
            const admission = beta
                ? await this.operation(
                      tx,
                      betaOps.admit(
                          a.email.toLowerCase(),
                          existing?.username,
                          beta.invitationHash,
                          beta.bypass,
                          a.createdAt
                      )
                  )
                : null;
            if (!existing && !allowNewAccount && !admission && !beta?.bypass)
                throw new DataControlError(
                    "New registrations are currently closed. Contact the service owner for access.",
                    403
                );
            // The unique provider subject coordinates simultaneous first logins without linking to an email match.
            const user = (
                await tx.query<UserRecord>(
                    `INSERT INTO notato.users (username,password_hash,created_at,is_admin,email,display_name,identity_provider,identity_subject) VALUES ($1,'!',$2,FALSE,$3,$4,$5,$6) ON CONFLICT(identity_provider,identity_subject) DO UPDATE SET email=excluded.email,display_name=excluded.display_name RETURNING ${USER}`,
                    [a.username, a.createdAt, a.email, a.displayName, a.provider, a.subject]
                )
            )[0] as UserRecord;
            if (user.username === a.username) {
                await tx.query(
                    "INSERT INTO notato.workspaces (id,name,created_at) VALUES ($1,$2,$3)",
                    [a.workspace.id, a.workspace.name, a.workspace.createdAt]
                );
                await tx.query(
                    "INSERT INTO notato.memberships (workspace_id,username,role,created_at) VALUES ($1,$2,'owner',$3)",
                    [a.workspace.id, a.username, a.createdAt]
                );
            }
            if (admission)
                await this.operation(tx, betaOps.claim(admission, user.username, a.createdAt));
            return clean(user);
        });
    }
    async upsertUser(u: UserRecord) {
        await this.db.query(
            "INSERT INTO notato.users (username,password_hash,created_at,is_admin) VALUES ($1,$2,$3,$4) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash",
            [u.username, u.passwordHash, u.createdAt, u.isAdmin ?? false]
        );
    }
    async createSession(s: SessionRecord) {
        await this.db.query(
            "INSERT INTO notato.sessions (id,username,created_at,expires_at,workspace_id,identity_session_id,assurance_level) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at",
            [
                s.id,
                s.username,
                s.createdAt,
                s.expiresAt,
                s.workspaceId ?? null,
                s.identitySessionId ?? null,
                s.assuranceLevel ?? null,
            ]
        );
    }
    async getSession(id: string): Promise<SessionRecord | null> {
        const row = (
            await this.db.query<SessionRecord>(
                `SELECT ${SESSION} FROM notato.sessions WHERE id=$1`,
                [id]
            )
        )[0];
        return row ? clean(row) : null;
    }
    async setSessionWorkspace(id: string, workspace: string) {
        await this.db.query("UPDATE notato.sessions SET workspace_id=$1 WHERE id=$2", [
            workspace,
            id,
        ]);
    }
    async deleteSession(id: string) {
        await this.db.query("DELETE FROM notato.sessions WHERE id=$1", [id]);
    }
    async purgeSessions(now: string) {
        await this.db.query("DELETE FROM notato.sessions WHERE expires_at<=$1", [now]);
    }
    async deleteSessionsFor(username: string) {
        await this.db.query("DELETE FROM notato.sessions WHERE username=$1", [username]);
    }
    async listSessionsFor(username: string): Promise<SessionRecord[]> {
        return (
            await this.db.query<SessionRecord>(
                `SELECT ${SESSION} FROM notato.sessions WHERE username=$1 ORDER BY created_at DESC`,
                [username]
            )
        ).map(clean);
    }
    async revokeIdentitySession(provider: string, subject: string, sessionId: string, at: string) {
        await this.db.query(
            "INSERT INTO notato.identity_revocations (provider,subject,session_id,revoked_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [provider, subject, sessionId, at]
        );
    }
    async identitySessionRevoked(
        provider: string,
        subject: string,
        sessionId: string
    ): Promise<boolean> {
        return (
            (
                await this.db.query(
                    "SELECT 1 FROM notato.identity_revocations WHERE provider=$1 AND subject=$2 AND session_id=$3",
                    [provider, subject, sessionId]
                )
            ).length > 0
        );
    }
    async registerIdentitySession(
        provider: string,
        subject: string,
        sessionId: string,
        at: string
    ) {
        await this.db.query(
            "INSERT INTO notato.identity_devices (provider,subject,session_id,last_seen_at) VALUES ($1,$2,$3,$4) ON CONFLICT(provider,subject,session_id) DO UPDATE SET last_seen_at=excluded.last_seen_at",
            [provider, subject, sessionId, at]
        );
    }
    async listIdentitySessions(provider: string, subject: string): Promise<string[]> {
        return (
            await this.db.query<{ session_id: string }>(
                "SELECT d.session_id FROM notato.identity_devices d LEFT JOIN notato.identity_revocations r ON r.provider=d.provider AND r.subject=d.subject AND r.session_id=d.session_id WHERE d.provider=$1 AND d.subject=$2 AND r.session_id IS NULL",
                [provider, subject]
            )
        ).map((r) => r.session_id);
    }
    /** Whether a key's issuer may still issue it: the operator, a member for their own key, an owner or admin otherwise. */
    private async mayIssue(tx: PgConnection, t: TokenRecord): Promise<boolean> {
        const issuer = (
            await tx.query<{ isAdmin: boolean; role: WorkspaceRole | null }>(
                'SELECT u.is_admin AS "isAdmin", m.role FROM notato.users u LEFT JOIN notato.memberships m ON m.workspace_id=$1 AND m.username=u.username WHERE u.username=$2',
                [t.workspaceId, t.createdBy]
            )
        )[0];
        if (!issuer) return false;
        if (issuer.isAdmin) return true;
        const ownership = t.ownership ?? (tokenPurpose(t) === "agent" ? "project" : "user");
        return ownership === "user"
            ? Boolean(issuer.role) &&
                  (t.ownerUsername === t.createdBy ||
                      issuer.role === "owner" ||
                      issuer.role === "admin")
            : issuer.role === "owner" || issuer.role === "admin";
    }
    async createToken(t: TokenRecord) {
        assertTokenPurpose(t);
        if (t.ownership === "user" && (!t.ownerUsername || !t.workspaceId))
            throw new DataControlError(
                "personal credentials require an account and workspace",
                400
            );
        if (t.ownership === "project" && (tokenPurpose(t) !== "agent" || t.projectId === "*"))
            throw new DataControlError("agent tokens must name one project", 400);
        if (t.ownership === "service" && tokenPurpose(t) !== "app")
            throw new DataControlError("service tokens are app credentials", 400);
        await this.db.transaction(async (tx) => {
            if (t.workspaceId)
                await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
                    t.workspaceId,
                ]);
            if (t.developmentContextId) {
                const row = (
                    await tx.query<{ json: string }>(
                        "SELECT json FROM notato.team_records WHERE id=$1",
                        [t.developmentContextId]
                    )
                )[0];
                const context = row ? JSON.parse(row.json) : null;
                if (
                    !context ||
                    context.archived ||
                    context.projectId !== t.projectId ||
                    context.owner !== t.ownerUsername
                )
                    throw new DataControlError(
                        "Checkout credential ownership does not match.",
                        403
                    );
            }
            if (t.captureWorkId) {
                const row = (
                    await tx.query<{ json: string }>(
                        "SELECT json FROM notato.team_records WHERE id=$1",
                        [t.captureWorkId]
                    )
                )[0];
                const work = row ? JSON.parse(row.json) : null;
                if (
                    !work?.pullRequest ||
                    work.projectId !== t.projectId ||
                    tokenPurpose(t) !== "app" ||
                    t.permission !== "capture"
                )
                    throw new DataControlError(
                        "PR credentials must be capture-only and bound to this project.",
                        403
                    );
            }
            // The issuer's role was checked when the request began; a key that lands after they were removed or
            // demoted is refused here, under the lock membership changes take. Shared keys outlive their issuer.
            if (t.workspaceId && t.createdBy && !(await this.mayIssue(tx, t)))
                throw new DataControlError(
                    "only a current workspace owner or admin can issue this key",
                    403
                );
            if (
                t.ownership === "user" &&
                !(
                    await tx.query(
                        "SELECT 1 FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
                        [t.workspaceId, t.ownerUsername]
                    )
                ).length
            )
                throw new DataControlError("token owner must belong to this workspace", 403);
            const limits = t.workspaceId
                ? await this.workspaceLimits(tx, t.workspaceId)
                : this.limits;
            if (limits && t.workspaceId) {
                await tx.query("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", [
                    t.workspaceId,
                ]);
                const count = (
                    await tx.query<{ n: string }>(
                        "SELECT count(*) AS n FROM notato.tokens WHERE workspace_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2)",
                        [t.workspaceId, new Date().toISOString()]
                    )
                )[0];
                if (Number(count?.n) >= limits.tokens) throw new QuotaError();
            }
            await tx.query(
                "INSERT INTO notato.tokens (id,project_id,name,token_hash,created_at,workspace_id,permission,expires_at,created_by,purpose,ownership,owner_username,identity_namespace,development_context_id,capture_work_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
                [
                    t.id,
                    t.projectId,
                    t.name,
                    t.tokenHash,
                    t.createdAt,
                    t.workspaceId ?? null,
                    t.permission ?? null,
                    t.expiresAt ?? null,
                    t.createdBy ?? null,
                    tokenPurpose(t),
                    t.ownership ?? null,
                    t.ownerUsername ?? null,
                    t.identityNamespace ?? null,
                    t.developmentContextId ?? null,
                    t.captureWorkId ?? null,
                ]
            );
        });
    }
    async appendAudit(r: AuditRecord) {
        await this.db.transaction(async (tx) => {
            await tx.query(
                "INSERT INTO notato.audit (id,workspace_id,actor,action,outcome,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome",
                [r.id, r.workspaceId, r.actor, r.action, r.outcome, r.createdAt]
            );
            await tx.query(
                "DELETE FROM notato.audit WHERE workspace_id=$1 AND (created_at<$2 OR id NOT IN (SELECT id FROM notato.audit WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 10000))",
                [r.workspaceId, new Date(Date.now() - 90 * 86400_000).toISOString()]
            );
        });
    }
    async listAudit(workspaceId: string, limit = 100): Promise<AuditRecord[]> {
        return await this.db.query<AuditRecord>(
            'SELECT id, workspace_id AS "workspaceId", actor, action, outcome, created_at AS "createdAt" FROM notato.audit WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2',
            [workspaceId, Math.min(500, Math.max(1, limit))]
        );
    }
    async findToken(hash: string): Promise<TokenRecord | null> {
        const row = (
            await this.db.query<TokenRecord>(
                `SELECT ${TOKEN} FROM notato.tokens WHERE token_hash=$1`,
                [hash]
            )
        )[0];
        return row ? clean(row) : null;
    }
    async listTokens(workspaceId?: string): Promise<TokenRecord[]> {
        return (
            await this.db.query<TokenRecord>(
                `SELECT ${TOKEN} FROM notato.tokens${workspaceId === undefined ? "" : " WHERE workspace_id=$1"} ORDER BY created_at DESC`,
                workspaceId === undefined ? [] : [workspaceId]
            )
        ).map(clean);
    }
    async revokeToken(id: string, at: string): Promise<boolean> {
        return (
            (
                await this.db.query(
                    "UPDATE notato.tokens SET revoked_at=$1 WHERE id=$2 AND revoked_at IS NULL RETURNING id",
                    [at, id]
                )
            ).length > 0
        );
    }
    async touchToken(id: string, at: string) {
        await this.db.query("UPDATE notato.tokens SET last_used_at=$1 WHERE id=$2", [at, id]);
    }
    async revokeProjectTokens(project: string, at: string) {
        await this.db.query(
            "UPDATE notato.tokens SET revoked_at=$1 WHERE project_id=$2 AND revoked_at IS NULL",
            [at, project]
        );
    }
    async close() {
        await this.db.close();
    }
}
