import type { Operation, Statement } from "./lifecycle-store.ts";
import { FREE_PLAN, notePeriod, paidPlan, planLimits } from "./plans.ts";
import {
    DataControlError,
    type HostedLimits,
    type MonthlyNoteUsage,
    QuotaError,
    type WorkspaceBilling,
    type WorkspaceEntitlement,
    type WorkspacePlan,
    type WorkspaceRecord,
} from "./storage.ts";

const q = (sql: string, ...params: Statement["params"]): Statement => ({ sql, params });
export const PLAN_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS notato.workspace_plans (workspace_id TEXT PRIMARY KEY REFERENCES notato.workspaces(id) ON DELETE CASCADE, plan TEXT NOT NULL CHECK (plan IN ('free','plus','pro','team')), extra_seats INTEGER NOT NULL CHECK (extra_seats>=0 AND extra_seats<=99))`,
    // Receipt counters survive note/project deletion. User scopes also survive recreating a free workspace.
    `CREATE TABLE IF NOT EXISTS notato.monthly_note_usage (scope TEXT NOT NULL, period_start TEXT NOT NULL, notes INTEGER NOT NULL CHECK (notes>=0), PRIMARY KEY(scope,period_start))`,
];
export function* selection(workspace: string): Operation<WorkspacePlan | null> {
    const row = (yield q(
        "SELECT plan,extra_seats FROM notato.workspace_plans WHERE workspace_id=$1",
        workspace
    ))[0];
    if (!row) return null;
    const result: WorkspacePlan = {
        id: row.plan as WorkspacePlan["id"],
        extraSeats: Number(row.extra_seats),
    };
    planLimits(result);
    return result;
}
/** Whether the selected workspace consumes a Free slot; an unpaid paid plan still needs recovery, not a second slot. */
export function* isFreeWorkspace(workspace: string, production: boolean): Operation<boolean> {
    const selected = yield* selection(workspace);
    if (!production) return !selected || selected.id === "free";
    const row = (yield q(
        "SELECT json FROM notato.workspace_billing WHERE workspace_id=$1",
        workspace
    ))[0];
    const billing = row?.json ? (JSON.parse(String(row.json)) as WorkspaceBilling) : null;
    return !paidPlan(billing) && (selected?.id === "free" || (!selected && !billing?.plan));
}
export function* freeWorkspaceConflict(
    workspace: string,
    actor: string,
    production = false
): Operation<WorkspaceRecord | null> {
    const rows = yield q(
        "SELECT w.id,w.name,w.created_at,p.plan,b.json,(SELECT count(*) FROM notato.memberships x WHERE x.workspace_id=m.workspace_id) AS members FROM notato.memberships m JOIN notato.workspaces w ON w.id=m.workspace_id LEFT JOIN notato.workspace_plans p ON p.workspace_id=m.workspace_id LEFT JOIN notato.workspace_billing b ON b.workspace_id=m.workspace_id WHERE m.username=$1 AND m.role='owner' AND m.workspace_id!=$2 ORDER BY w.created_at,w.id",
        actor,
        workspace
    );
    for (const row of rows) {
        const state = row.json ? (JSON.parse(String(row.json)) as WorkspaceBilling) : null;
        const free = production
            ? !paidPlan(state) && (row.plan === "free" || (!row.plan && !state?.plan))
            : !row.plan || row.plan === "free";
        if (free)
            return {
                id: String(row.id),
                name: String(row.name),
                createdAt: String(row.created_at),
            };
    }
    return null;
}
export function* assertFreeOwner(
    workspace: string,
    actor: string,
    production = false
): Operation<void> {
    if (yield* freeWorkspaceConflict(workspace, actor, production))
        throw new DataControlError(
            "Your account already has a free personal workspace. Select Plus, Pro or Team for another workspace."
        );
}
export function* saveSelection(workspace: string, plan: WorkspacePlan): Operation<WorkspacePlan> {
    planLimits(plan);
    yield q(
        "INSERT INTO notato.workspace_plans (workspace_id,plan,extra_seats) VALUES ($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET plan=excluded.plan,extra_seats=excluded.extra_seats",
        workspace,
        plan.id,
        plan.extraSeats
    );
    return plan;
}
export function* changePlan(
    workspace: string,
    actor: string,
    plan: WorkspacePlan,
    postgres: boolean,
    production = false
): Operation<WorkspacePlan> {
    const limits = planLimits(plan);
    if (postgres) {
        yield q("SELECT id FROM notato.workspaces WHERE id=$1 FOR UPDATE", workspace);
        yield q("SELECT username FROM notato.users WHERE username=$1 FOR UPDATE", actor);
    }
    const role = (yield q(
        "SELECT role FROM notato.memberships WHERE workspace_id=$1 AND username=$2",
        workspace,
        actor
    ))[0];
    if (role?.role !== "owner") throw new DataControlError("workspace owner required", 403);
    if (production) {
        if (plan.id !== "free")
            throw new DataControlError("Paid plans require a verified subscription", 403);
        const current = (yield q(
            "SELECT json FROM notato.workspace_billing WHERE workspace_id=$1",
            workspace
        ))[0];
        const state = current?.json ? (JSON.parse(String(current.json)) as WorkspaceBilling) : null;
        if (
            state?.subscriptionId &&
            !["free", "canceled", "incomplete_expired"].includes(state.status)
        )
            throw new DataControlError(
                "Cancel the subscription in the billing portal before selecting Free"
            );
    }
    if (plan.id === "free") yield* assertFreeOwner(workspace, actor, production);
    const members = (yield q(
        "SELECT count(*) AS n FROM notato.memberships WHERE workspace_id=$1",
        workspace
    ))[0];
    const projects = (yield q(
        "SELECT count(*) AS n FROM notato.projects WHERE workspace_id=$1",
        workspace
    ))[0];
    const tokens = yield q(
        "SELECT coalesce(purpose,CASE WHEN permission='capture' THEN 'app' ELSE 'agent' END) AS purpose,count(*) AS n FROM notato.tokens WHERE workspace_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2) GROUP BY coalesce(purpose,CASE WHEN permission='capture' THEN 'app' ELSE 'agent' END)",
        workspace,
        new Date().toISOString()
    );
    const bytes = (yield q(
        `SELECT coalesce(sum(${postgres ? "octet_length(a.json)" : "length(CAST(a.json AS BLOB))"}+a.asset_bytes),0) AS n FROM notato.annotations a JOIN notato.projects p ON p.id=a.project_id WHERE p.workspace_id=$1`,
        workspace
    ))[0];
    if (
        Number(members?.n) > (limits.members ?? 1) ||
        Number(projects?.n) > limits.projects ||
        tokens.reduce((sum, t) => sum + Number(t.n), 0) > limits.tokens ||
        Number(bytes?.n) > limits.bytes
    )
        throw new DataControlError(
            "This workspace exceeds that plan's projects, seats, keys or storage. Remove excess usage or choose a larger plan; your data has not been changed."
        );
    if (plan.id === "free")
        yield q(
            "UPDATE notato.invitations SET revoked_at=$1 WHERE workspace_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
            new Date().toISOString(),
            workspace
        );
    return yield* saveSelection(workspace, plan);
}
export function* freeOwner(workspace: string): Operation<string | null> {
    const owners = yield q(
        "SELECT username FROM notato.memberships WHERE workspace_id=$1 AND role='owner'",
        workspace
    );
    return owners.length === 1 ? String(owners[0]?.username) : null;
}
export function* monthly(workspace: string, personal: boolean): Operation<MonthlyNoteUsage> {
    const period = notePeriod();
    const owner = personal ? yield* freeOwner(workspace) : null;
    const rows = yield q(
        "SELECT notes FROM notato.monthly_note_usage WHERE period_start=$1 AND (scope=$2 OR scope=$3)",
        period.periodStart,
        `workspace:${workspace}`,
        owner ? `user:${owner}` : `workspace:${workspace}`
    );
    return { ...period, notes: Math.max(0, ...rows.map((r) => Number(r.notes))) };
}
export function* assertMonthly(
    workspace: string,
    maximum: number,
    personal: boolean,
    postgres: boolean
): Operation<void> {
    if (personal && postgres) {
        const owner = yield* freeOwner(workspace);
        if (owner) yield q("SELECT username FROM notato.users WHERE username=$1 FOR UPDATE", owner);
    }
    if ((yield* monthly(workspace, personal)).notes >= maximum)
        throw new QuotaError(
            "This workspace's monthly note allowance is used up. It resets next month, or the owner can select a larger plan. Deleting notes does not reset this allowance."
        );
}
export function* receipt(workspace: string, personal: boolean): Operation<void> {
    const scopes = [`workspace:${workspace}`];
    const owner = personal ? yield* freeOwner(workspace) : null;
    if (owner) scopes.push(`user:${owner}`);
    for (const scope of scopes)
        yield q(
            "INSERT INTO notato.monthly_note_usage (scope,period_start,notes) VALUES ($1,$2,1) ON CONFLICT(scope,period_start) DO UPDATE SET notes=notato.monthly_note_usage.notes+1",
            scope,
            notePeriod().periodStart
        );
}
export function* defaultSelection(workspace: string): Operation<WorkspacePlan> {
    return (yield* selection(workspace)) ?? FREE_PLAN;
}

export function* entitlement(
    workspace: string,
    production: boolean
): Operation<WorkspaceEntitlement> {
    const requested = yield* selection(workspace);
    if (!production) return { plan: requested ?? FREE_PLAN, locked: false };
    const row = (yield q(
        "SELECT json FROM notato.workspace_billing WHERE workspace_id=$1",
        workspace
    ))[0];
    const state = row?.json ? (JSON.parse(String(row.json)) as WorkspaceBilling) : null;
    const paid = paidPlan(state);
    if (paid) return { plan: paid, locked: false };
    let locked = requested
        ? requested.id !== "free"
        : Boolean(state?.plan && state.plan !== "free");
    if (!locked) {
        const members = yield q(
            "SELECT username,role FROM notato.memberships WHERE workspace_id=$1",
            workspace
        );
        if (members.length !== 1 || members[0]?.role !== "owner") locked = true;
        else {
            const rows = yield q(
                "SELECT w.id,p.plan,b.json,(SELECT count(*) FROM notato.memberships x WHERE x.workspace_id=w.id) AS members FROM notato.memberships m JOIN notato.workspaces w ON w.id=m.workspace_id LEFT JOIN notato.workspace_plans p ON p.workspace_id=w.id LEFT JOIN notato.workspace_billing b ON b.workspace_id=w.id WHERE m.username=$1 AND m.role='owner' ORDER BY w.created_at,w.id",
                String(members[0].username)
            );
            const first = rows.find((row) => {
                const billing = row.json
                    ? (JSON.parse(String(row.json)) as WorkspaceBilling)
                    : null;
                return !paidPlan(billing) && (row.plan === "free" || (!row.plan && !billing?.plan));
            });
            locked = first?.id !== workspace;
        }
    }
    return {
        plan: FREE_PLAN,
        locked,
        ...(locked && requested && requested.id !== "free" ? { requestedPlan: requested } : {}),
    };
}

/** Preserve already-metered legacy Free usage when enabling canonical rules. Never lower an account counter. */
export function* seedFreeMeters(): Operation<void> {
    const period = notePeriod().periodStart;
    const rows = yield q(
        "SELECT m.username,p.plan,b.json,u.notes FROM notato.memberships m LEFT JOIN notato.workspace_plans p ON p.workspace_id=m.workspace_id LEFT JOIN notato.workspace_billing b ON b.workspace_id=m.workspace_id JOIN notato.monthly_note_usage u ON u.scope='workspace:' || m.workspace_id AND u.period_start=$1 WHERE m.role='owner'",
        period
    );
    const totals = new Map<string, number>();
    for (const row of rows) {
        const state = row.json ? (JSON.parse(String(row.json)) as WorkspaceBilling) : null;
        if (!paidPlan(state) && (row.plan === "free" || (!row.plan && !state?.plan)))
            totals.set(
                String(row.username),
                (totals.get(String(row.username)) ?? 0) + Number(row.notes)
            );
    }
    for (const [owner, notes] of totals) {
        yield q(
            "INSERT INTO notato.monthly_note_usage (scope,period_start,notes) VALUES ($1,$2,$3) ON CONFLICT(scope,period_start) DO NOTHING",
            `user:${owner}`,
            period,
            notes
        );
        yield q(
            "UPDATE notato.monthly_note_usage SET notes=CASE WHEN notes<$3 THEN $3 ELSE notes END WHERE scope=$1 AND period_start=$2",
            `user:${owner}`,
            period,
            notes
        );
    }
}
export function* assertActiveCapacity(workspace: string, limits: HostedLimits): Operation<void> {
    const row = (yield q(
        "SELECT (SELECT count(*) FROM notato.projects WHERE workspace_id=$1) AS projects,(SELECT count(*) FROM notato.memberships WHERE workspace_id=$1) AS members,(SELECT count(*) FROM notato.tokens WHERE workspace_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2)) AS tokens",
        workspace,
        new Date().toISOString()
    ))[0];
    if (
        Number(row?.projects) > limits.projects ||
        Number(row?.members) > (limits.members ?? 1) ||
        Number(row?.tokens) > limits.tokens
    )
        throw new QuotaError(
            "This workspace exceeds its project, key or seat allowance. The owner must remove excess usage or upgrade before new notes can be sent."
        );
}
