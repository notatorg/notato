import type { Operation, Statement } from "./lifecycle-store.ts";
import { saveSelection } from "./plan-store.ts";
import { paidPlan } from "./plans.ts";
import { DataControlError, type WorkspaceBilling, type WorkspaceUsage } from "./storage.ts";

const q = (sql: string, ...params: Statement["params"]): Statement => ({ sql, params });
export const BILLING_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS notato.workspace_billing (workspace_id TEXT PRIMARY KEY REFERENCES notato.workspaces(id) ON DELETE CASCADE, customer_id TEXT NOT NULL UNIQUE, json TEXT NOT NULL, limits TEXT, period_end TEXT)`,
    `CREATE TABLE IF NOT EXISTS notato.billing_events (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
];
export function* billing(workspace: string): Operation<WorkspaceBilling | null> {
    const rows = yield q(
        "SELECT json FROM notato.workspace_billing WHERE workspace_id=$1",
        workspace
    );
    return rows[0] ? (JSON.parse(String(rows[0].json)) as WorkspaceBilling) : null;
}
export function* billingWorkspace(customer: string): Operation<string | null> {
    const rows = yield q(
        "SELECT workspace_id FROM notato.workspace_billing WHERE customer_id=$1",
        customer
    );
    return rows[0] ? String(rows[0].workspace_id) : null;
}
export function* setCustomer(workspace: string, customer: string): Operation<WorkspaceBilling> {
    const state: WorkspaceBilling = {
        workspaceId: workspace,
        customerId: customer,
        status: "free",
    };
    yield q(
        "INSERT INTO notato.workspace_billing (workspace_id,customer_id,json) VALUES ($1,$2,$3) ON CONFLICT(workspace_id) DO NOTHING",
        workspace,
        customer,
        JSON.stringify(state)
    );
    const current = yield* billing(workspace);
    if (!current || current.customerId !== customer)
        throw new DataControlError("billing setup changed; try again");
    return current;
}
export function* applyEvent(
    id: string,
    state: WorkspaceBilling,
    at: string,
    postgres = false
): Operation<boolean> {
    if (postgres)
        yield q("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", state.workspaceId);
    const inserted = yield q(
        "INSERT INTO notato.billing_events (id,created_at) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING RETURNING id",
        id,
        at
    );
    if (!inserted.length) return false;
    const changed = yield q(
        "UPDATE notato.workspace_billing SET json=$1,limits=$2,period_end=$3 WHERE workspace_id=$4 AND customer_id=$5 RETURNING workspace_id",
        JSON.stringify(state),
        state.limits ? JSON.stringify(state.limits) : null,
        state.periodEnd ?? null,
        state.workspaceId,
        state.customerId
    );
    const entitlement = paidPlan(state);
    if (changed.length && entitlement) yield* saveSelection(state.workspaceId, entitlement);
    return changed.length > 0;
}
export function* saveCheckout(
    workspace: string,
    checkout: NonNullable<WorkspaceBilling["checkout"]> | null
): Operation<void> {
    const current = yield* billing(workspace);
    if (!current) throw new DataControlError("billing account not found", 404);
    const { checkout: _previous, ...rest } = current;
    const next = checkout ? { ...rest, checkout } : rest;
    yield q(
        "UPDATE notato.workspace_billing SET json=$1 WHERE workspace_id=$2",
        JSON.stringify(next),
        workspace
    );
}
export function* usage(workspace: string, postgres: boolean): Operation<WorkspaceUsage> {
    const counted = (yield q(
        `SELECT count(*) AS notes,coalesce(sum(${postgres ? "octet_length(a.json)" : "length(CAST(a.json AS BLOB))"}+a.asset_bytes),0) AS bytes FROM notato.annotations a JOIN notato.projects p ON p.id=a.project_id WHERE p.workspace_id=$1`,
        workspace
    ))[0];
    const projects = (yield q(
        "SELECT count(*) AS n FROM notato.projects WHERE workspace_id=$1",
        workspace
    ))[0];
    const members = (yield q(
        "SELECT count(*) AS n FROM notato.memberships WHERE workspace_id=$1",
        workspace
    ))[0];
    const tokens = (yield q(
        "SELECT count(*) AS n FROM notato.tokens WHERE workspace_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2)",
        workspace,
        new Date().toISOString()
    ))[0];
    return {
        notes: Number(counted?.notes ?? 0),
        bytes: Number(counted?.bytes ?? 0),
        projects: Number(projects?.n ?? 0),
        members: Number(members?.n ?? 0),
        tokens: Number(tokens?.n ?? 0),
    };
}
