import {
    assertWorkPermit,
    type CoordinationStore,
    currentWorkPermit,
    type DevelopmentContext,
    RequestError,
    type WorkPermit,
    type WorkRecord,
} from "@notato/server";
import type { PgConnection, PgDatabase } from "./postgres-store.ts";
export const COLLABORATION_SCHEMA = [
    "CREATE TABLE IF NOT EXISTS notato.team_records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES notato.projects(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('context','work','project','review-session')), json TEXT NOT NULL)",
    "ALTER TABLE notato.team_records DROP CONSTRAINT IF EXISTS team_records_kind_check",
    "ALTER TABLE notato.team_records ADD CONSTRAINT team_records_kind_check CHECK(kind IN ('context','work','project','review-session'))",
    "ALTER TABLE notato.memberships ADD COLUMN IF NOT EXISTS project_only BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE notato.invitations ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES notato.projects(id) ON DELETE CASCADE",
    "CREATE INDEX IF NOT EXISTS idx_team_records_project ON notato.team_records(project_id,kind)",
    "ALTER TABLE notato.tokens ADD COLUMN IF NOT EXISTS development_context_id TEXT",
    "ALTER TABLE notato.tokens ADD COLUMN IF NOT EXISTS capture_work_id TEXT",
];
export async function validatePermitCredential(
    tx: PgConnection,
    permit: WorkPermit,
    project: string
) {
    if (!permit.credentialId) return;
    const rows = await tx.query(
        "SELECT t.id FROM notato.tokens t JOIN notato.projects p ON p.id=t.project_id JOIN notato.memberships m ON m.workspace_id=p.workspace_id AND m.username=t.owner_username WHERE t.id=$1 AND t.development_context_id=$2 AND t.project_id=$3 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>$4)",
        [permit.credentialId, permit.contextId, project, new Date().toISOString()]
    );
    if (!rows.length) throw new RequestError("Checkout credential or membership revoked.", 403);
}
export function coordinationFor(db: PgDatabase): CoordinationStore {
    return {
        get: async (id) => {
            const row = (
                await db.query<{ json: string }>(
                    "SELECT json FROM notato.team_records WHERE id=$1",
                    [id]
                )
            )[0];
            return row ? JSON.parse(row.json) : null;
        },
        list: async (project, kind) =>
            (
                await db.query<{ json: string }>(
                    "SELECT json FROM notato.team_records WHERE project_id=$1 AND kind=$2 ORDER BY id",
                    [project, kind]
                )
            ).map((r) => JSON.parse(r.json)),
        change: async (id, project, kind, mutate) =>
            db.transaction(async (tx) => {
                const permit = currentWorkPermit();
                if (permit)
                    await tx.query(
                        "SELECT w.id FROM notato.workspaces w JOIN notato.projects p ON p.workspace_id=w.id WHERE p.id=$1 FOR UPDATE OF w",
                        [project]
                    );
                // Context archiving, assignment, claims and fenced note mutations share this lock.
                if (
                    !(
                        await tx.query("SELECT id FROM notato.projects WHERE id=$1 FOR UPDATE", [
                            project,
                        ])
                    ).length
                )
                    throw new Error("Project no longer exists.");
                const row = (
                    await tx.query<{ json: string; project_id: string; kind: string }>(
                        "SELECT json,project_id,kind FROM notato.team_records WHERE id=$1 FOR UPDATE",
                        [id]
                    )
                )[0];
                if (row && (row.project_id !== project || row.kind !== kind))
                    throw new Error("Coordination scope conflict.");
                if (permit && kind === "work") {
                    await validatePermitCredential(tx, permit, project);
                    const c = (
                        await tx.query<{ json: string }>(
                            "SELECT json FROM notato.team_records WHERE id=$1 FOR UPDATE",
                            [permit.contextId]
                        )
                    )[0];
                    assertWorkPermit(
                        { projectId: project },
                        row ? (JSON.parse(row.json) as WorkRecord) : null,
                        c ? (JSON.parse(c.json) as DevelopmentContext) : null,
                        permit
                    );
                }
                const next = mutate(row ? JSON.parse(row.json) : null);
                if (kind === "work" && "contextId" in next && next.contextId) {
                    const c = (
                        await tx.query<{ json: string }>(
                            "SELECT json FROM notato.team_records WHERE id=$1 FOR UPDATE",
                            [next.contextId]
                        )
                    )[0];
                    const context = c ? (JSON.parse(c.json) as DevelopmentContext) : null;
                    if (!context || context.archived || context.projectId !== project)
                        throw new RequestError("Checkout connection revoked.", 403);
                }
                await tx.query(
                    "INSERT INTO notato.team_records VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
                    [id, project, kind, JSON.stringify(next)]
                );
                return next;
            }),
    };
}
