import type { Operation, Statement } from "./lifecycle-store.ts";
import { freeWorkspaceConflict } from "./plan-store.ts";
import { DataControlError, type WorkspaceCleanup } from "./storage.ts";

const q = (sql: string, ...params: Statement["params"]): Statement => ({ sql, params });

/** Cleanup metadata only: no note bodies, screenshots, token hashes or private integration configuration. */
export function* workspaceCleanup(
    workspace: string,
    actor: string,
    postgres: boolean,
    production: boolean,
    project?: string,
    before?: number
): Operation<WorkspaceCleanup> {
    const role = (yield q(
        "SELECT role FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
        workspace,
        actor
    ))[0];
    if (role?.role !== "owner") throw new DataControlError("workspace owner required", 403);
    const size = postgres ? "octet_length(a.json)" : "length(CAST(a.json AS BLOB))";
    const projects = (yield q(
        `SELECT p.id,p.name,count(a.id) AS notes,coalesce(sum(${size}+a.asset_bytes),0) AS bytes FROM notato.projects p LEFT JOIN notato.annotations a ON a.project_id=p.id WHERE p.workspace_id=$1 GROUP BY p.id,p.name ORDER BY p.name,p.id`,
        workspace
    )).map((p) => ({
        id: String(p.id),
        name: String(p.name),
        notes: Number(p.notes),
        bytes: Number(p.bytes),
    }));
    if (project && !projects.some((p) => p.id === project))
        throw new DataControlError("project not found", 404);
    const rows = yield q(
        `SELECT a.id,a.seq,a.project_id,substr(a.route,1,160) AS route,a.created_at,${size}+a.asset_bytes AS bytes FROM notato.annotations a JOIN notato.projects p ON p.id=a.project_id WHERE p.workspace_id=$1 AND ($2='' OR a.project_id=$2) AND a.seq<$3 ORDER BY a.seq DESC LIMIT 51`,
        workspace,
        project ?? "",
        before ?? Number.MAX_SAFE_INTEGER
    );
    const notes = rows.slice(0, 50).map((a) => ({
        id: String(a.id),
        seq: Number(a.seq),
        projectId: String(a.project_id),
        route: String(a.route),
        createdAt: String(a.created_at),
        bytes: Number(a.bytes),
    }));
    return {
        projects,
        notes,
        ...(rows.length > 50 ? { next: notes.at(-1)?.seq } : {}),
        otherFreeWorkspace: yield* freeWorkspaceConflict(workspace, actor, production),
    };
}
