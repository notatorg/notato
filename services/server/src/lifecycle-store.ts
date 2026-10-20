import { Annotation } from "@notato/schema";
import type { StoredAnnotation } from "@notato/server";
import { onAccountDeleted } from "./email-preferences-store.ts";
import {
    DataControlError,
    DEFAULT_WORKSPACE_ID,
    type IdentityDeletion,
    type WorkspacePolicy,
} from "./storage.ts";

export interface Statement {
    sql: string;
    params: Array<string | number | boolean | null>;
}
export type Rows = Array<Record<string, unknown>>;
export type Operation<T> = Generator<Statement, T, Rows>;
const q = (sql: string, ...params: Statement["params"]): Statement => ({ sql, params });
const records = (rows: Rows): StoredAnnotation[] =>
    rows.map((row) => ({
        seq: Number(row.seq),
        annotation: Annotation.parse(JSON.parse(String(row.json))),
    }));

/** Each workflow runs inside one database transaction, synchronously on SQLite and asynchronously on Postgres. */
export const LIFECYCLE_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS notato.workspace_policy (workspace_id TEXT PRIMARY KEY REFERENCES notato.workspaces(id) ON DELETE CASCADE, retention_days INTEGER CHECK(retention_days BETWEEN 1 AND 3650))`,
    `CREATE TABLE IF NOT EXISTS notato.deleted_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, next_attempt TEXT NOT NULL DEFAULT '', PRIMARY KEY(provider,subject))`,
];

export function* workspacePolicy(id: string): Operation<WorkspacePolicy> {
    const rows = yield q(
        "SELECT retention_days FROM notato.workspace_policy WHERE workspace_id=$1",
        id
    );
    return {
        retentionDays: rows[0]?.retention_days == null ? null : Number(rows[0].retention_days),
    };
}
export function* saveWorkspacePolicy(
    id: string,
    actor: string,
    days: number | null,
    postgres = false
): Operation<WorkspacePolicy> {
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650))
        throw new DataControlError("retention must be 1–3650 days, or disabled", 400);
    if (postgres) yield q("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", id);
    const membership = yield q(
        "SELECT role FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
        id,
        actor
    );
    if (membership[0]?.role !== "owner")
        throw new DataControlError("workspace owner required", 403);
    yield q(
        "INSERT INTO notato.workspace_policy (workspace_id,retention_days) VALUES ($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET retention_days=excluded.retention_days",
        id,
        days
    );
    return { retentionDays: days };
}

export function* removeWorkspace(
    id: string,
    actor: string,
    postgres: boolean,
    rehome = true
): Operation<StoredAnnotation[] | null> {
    if (id === DEFAULT_WORKSPACE_ID)
        throw new DataControlError("the server's default workspace cannot be deleted");
    const found = yield q(
        `SELECT id FROM notato.workspaces WHERE id=$1${postgres ? " FOR UPDATE" : ""}`,
        id
    );
    if (!found.length) return null;
    const paid = (yield q(
        "SELECT json FROM notato.workspace_billing WHERE workspace_id=$1",
        id
    ))[0];
    if (paid) {
        const state = JSON.parse(String(paid.json)) as { subscriptionId?: string; status: string };
        if (
            state.subscriptionId &&
            !["canceled", "incomplete_expired", "free"].includes(state.status)
        )
            throw new DataControlError(
                "cancel the subscription in the billing portal before deleting this workspace"
            );
    }
    const members = yield q(
        "SELECT username,role FROM notato.memberships WHERE workspace_id=$1",
        id
    );
    if (!members.some((row) => row.username === actor && row.role === "owner"))
        throw new DataControlError("workspace owner required", 403);
    const gone = records(
        yield q(
            "SELECT a.seq,a.json FROM notato.annotations a JOIN notato.projects p ON p.id=a.project_id WHERE p.workspace_id=$1",
            id
        )
    );
    yield q(
        "DELETE FROM notato.annotations WHERE project_id IN (SELECT id FROM notato.projects WHERE workspace_id=$1)",
        id
    );
    yield q(
        "DELETE FROM notato.bundles WHERE project_id IN (SELECT id FROM notato.projects WHERE workspace_id=$1)",
        id
    );
    yield q(
        "DELETE FROM notato.tokens WHERE workspace_id=$1 OR project_id IN (SELECT id FROM notato.projects WHERE workspace_id=$1)",
        id
    );
    yield q("DELETE FROM notato.invitations WHERE workspace_id=$1", id);
    yield q("UPDATE notato.sessions SET workspace_id=NULL WHERE workspace_id=$1", id);
    yield q("DELETE FROM notato.projects WHERE workspace_id=$1", id);
    yield q("DELETE FROM notato.audit WHERE workspace_id=$1", id);
    yield q("DELETE FROM notato.monthly_note_usage WHERE scope=$1", `workspace:${id}`);
    yield q("DELETE FROM notato.workspaces WHERE id=$1", id);
    // Nobody is locked out because their last company was deleted. They retain an empty personal workspace.
    for (const member of rehome ? members : []) {
        const username = String(member.username);
        const memberships = yield q(
            "SELECT workspace_id FROM notato.memberships WHERE username=$1 ORDER BY workspace_id",
            username
        );
        let next = memberships[0]?.workspace_id;
        if (!next) {
            const user = (yield q(
                "SELECT is_admin,display_name FROM notato.users WHERE username=$1",
                username
            ))[0];
            if (!user || user.is_admin) continue;
            next = `ws_${crypto.randomUUID()}`;
            const at = new Date().toISOString();
            yield q(
                "INSERT INTO notato.workspaces (id,name,created_at) VALUES ($1,$2,$3)",
                String(next),
                `${user.display_name ?? username}'s workspace`,
                at
            );
            yield q(
                "INSERT INTO notato.memberships (workspace_id,username,role,created_at) VALUES ($1,$2,'owner',$3)",
                String(next),
                username,
                at
            );
        }
        yield q(
            "UPDATE notato.sessions SET workspace_id=$1 WHERE username=$2 AND workspace_id IS NULL",
            String(next),
            username
        );
    }
    return gone;
}

export function* removeAccount(
    username: string,
    at: string,
    postgres: boolean,
    deletePrivateWorkspaces: boolean
): Operation<StoredAnnotation[] | null> {
    // Coordinate deletion with identity provisioning before either locks a user row.
    if (postgres) {
        const identity = (yield q(
            "SELECT identity_provider,identity_subject FROM notato.users WHERE username=$1",
            username
        ))[0];
        if (identity?.identity_provider && identity.identity_subject)
            yield q(
                "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
                String(identity.identity_provider),
                String(identity.identity_subject)
            );
    }
    const user = (yield q(
        `SELECT username,is_admin,identity_provider,identity_subject FROM notato.users WHERE username=$1${postgres ? " FOR UPDATE" : ""}`,
        username
    ))[0];
    if (!user) return null;
    if (user.is_admin)
        throw new DataControlError("operator accounts cannot delete themselves", 403);
    if (postgres)
        yield q(
            "SELECT w.id FROM notato.workspaces w JOIN notato.memberships m ON m.workspace_id=w.id WHERE m.username=$1 AND m.role='owner' ORDER BY w.id FOR UPDATE OF w",
            username
        );
    const lastOwner = yield q(
        "SELECT m.workspace_id FROM notato.memberships m WHERE m.username=$1 AND m.role='owner' AND (SELECT count(*) FROM notato.memberships others WHERE others.workspace_id=m.workspace_id AND others.role='owner')=1",
        username
    );
    const gone: StoredAnnotation[] = [];
    for (const row of lastOwner) {
        const id = String(row.workspace_id);
        const members = yield q(
            "SELECT username FROM notato.memberships WHERE workspace_id=$1",
            id
        );
        if (!deletePrivateWorkspaces || members.length !== 1)
            throw new DataControlError(
                "transfer ownership of shared workspaces first, and confirm deletion of your private workspaces"
            );
        gone.push(...((yield* removeWorkspace(id, username, postgres, false)) ?? []));
    }
    if (user.identity_provider && user.identity_subject)
        yield q(
            "INSERT INTO notato.deleted_identities (provider,subject,created_at) VALUES ($1,$2,$3) ON CONFLICT(provider,subject) DO NOTHING",
            String(user.identity_provider),
            String(user.identity_subject),
            at
        );
    yield q(
        "UPDATE notato.tokens SET revoked_at=CASE WHEN ownership='user' OR ownership IS NULL THEN coalesce(revoked_at,$1) ELSE revoked_at END,created_by=NULL WHERE created_by=$2",
        at,
        username
    );
    yield q("DELETE FROM notato.invitations WHERE created_by=$1", username);
    yield q("DELETE FROM notato.monthly_note_usage WHERE scope=$1", `user:${username}`);
    if (postgres) yield* onAccountDeleted(username, at);
    yield q("DELETE FROM notato.users WHERE username=$1", username);
    return gone;
}

export function* pendingIdentityDeletions(now: string): Operation<IdentityDeletion[]> {
    const rows = yield q(
        "SELECT provider,subject FROM notato.deleted_identities WHERE complete=0 AND next_attempt<=$1 ORDER BY created_at LIMIT 20",
        now
    );
    return rows.map((row) => ({ provider: String(row.provider), subject: String(row.subject) }));
}
export function* identityDeletionResult(
    provider: string,
    subject: string,
    success: boolean,
    next: string
): Operation<void> {
    yield q(
        "UPDATE notato.deleted_identities SET complete=$1,next_attempt=$2 WHERE provider=$3 AND subject=$4",
        success ? 1 : 0,
        next,
        provider,
        subject
    );
}

const expired = (postgres: boolean) =>
    postgres
        ? "a.activity_received_at::timestamptz + make_interval(days=>r.retention_days) <= $1::timestamptz"
        : "datetime(a.activity_received_at,'+' || r.retention_days || ' days') <= datetime($1)";
export function* expiredAnnotations(
    now: string,
    limit: number,
    postgres: boolean
): Operation<StoredAnnotation[]> {
    const rows = yield q(
        `SELECT a.seq,a.json FROM notato.annotations a JOIN notato.projects p ON p.id=a.project_id JOIN notato.workspace_policy r ON r.workspace_id=p.workspace_id WHERE r.retention_days IS NOT NULL AND ${expired(postgres)} ORDER BY a.seq LIMIT $2`,
        now,
        Math.max(1, Math.min(500, Math.floor(limit)))
    );
    return records(rows);
}
export function* deleteExpiredAnnotation(
    id: string,
    now: string,
    postgres: boolean
): Operation<StoredAnnotation | null> {
    const rows = yield q(
        `SELECT a.seq,a.json FROM notato.annotations a JOIN notato.projects p ON p.id=a.project_id JOIN notato.workspace_policy r ON r.workspace_id=p.workspace_id WHERE a.id=$2 AND r.retention_days IS NOT NULL AND ${expired(postgres)}${postgres ? " FOR UPDATE OF a,r" : ""}`,
        now,
        id
    );
    if (!rows.length) return null;
    yield q("DELETE FROM notato.annotations WHERE id=$1", id);
    return records(rows)[0] ?? null;
}
