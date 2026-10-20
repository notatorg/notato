import type { HostedLimits, PlanId, WorkspaceBilling, WorkspacePlan } from "./storage.ts";
import { DataControlError } from "./storage.ts";

export const AUTOMATION_LIMITS = {
    free: { workflows: 0, actions: 0 },
    plus: { workflows: 3, actions: 250 },
    pro: { workflows: 20, actions: 2000 },
    team: { workflows: 100, actions: 10000 },
} as const;

export const TEST_PLANS = [
    {
        id: "free",
        automation: AUTOMATION_LIMITS.free,
        name: "Free",
        includedSeats: 1,
        limits: { projects: 1, notesPerMonth: 100, bytes: 250 * 1024 ** 2, tokens: 6 },
    },
    {
        id: "plus",
        automation: AUTOMATION_LIMITS.plus,
        name: "Plus",
        includedSeats: 1,
        limits: { projects: 5, notesPerMonth: 500, bytes: 1024 ** 3, tokens: 20 },
    },
    {
        id: "pro",
        automation: AUTOMATION_LIMITS.pro,
        name: "Pro",
        includedSeats: 3,
        limits: { projects: 10, notesPerMonth: 1_000, bytes: 2 * 1024 ** 3, tokens: 100 },
    },
    {
        id: "team",
        automation: AUTOMATION_LIMITS.team,
        name: "Team",
        includedSeats: 10,
        limits: { projects: 50, notesPerMonth: 10_000, bytes: 10 * 1024 ** 3, tokens: 200 },
    },
] as const;

export function planLimits(selection: WorkspacePlan): HostedLimits {
    const plan = TEST_PLANS.find((p) => p.id === selection.id);
    if (
        !plan ||
        !Number.isInteger(selection.extraSeats) ||
        selection.extraSeats < 0 ||
        plan.includedSeats + selection.extraSeats > 100 ||
        (["free", "plus"].includes(plan.id) && selection.extraSeats)
    )
        throw new DataControlError("invalid plan or seat allowance", 400);
    return {
        ...plan.limits,
        notes: 1_000_000,
        jsonBytes: plan.limits.bytes,
        workspaces: 100,
        members: plan.includedSeats + selection.extraSeats,
    };
}

export function notePeriod(now = new Date()) {
    return {
        periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
        periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    };
}
export const FREE_PLAN: { id: PlanId; extraSeats: number } = { id: "free", extraSeats: 0 };

export function paidPlan(state: WorkspaceBilling | null): WorkspacePlan | null {
    const plan = state?.entitlement;
    if (
        !state ||
        !plan ||
        plan.id === "free" ||
        !["active", "trialing"].includes(state.status) ||
        !state.periodEnd ||
        Date.parse(state.periodEnd) <= Date.now() ||
        !Number.isFinite(Date.parse(state.periodEnd))
    )
        return null;
    try {
        planLimits(plan);
        return plan;
    } catch {
        return null;
    }
}
export function lockedPlanLimits(): HostedLimits {
    return {
        ...planLimits(FREE_PLAN),
        projects: 0,
        notes: 0,
        notesPerMonth: 0,
        bytes: 0,
        tokens: 0,
    };
}
