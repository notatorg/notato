import {
    type Me as CoreMe,
    json,
    type ProjectSummary,
    request,
    setFailureHandler,
} from "@notato/board";

export * from "@notato/board";

/** What `/auth/me` says on Notato Cloud, beyond what the open board reads. */
export type Me = CoreMe & {
    isAdmin?: boolean;
    instanceAdmin?: boolean;
    /** A hosted deployment can name the same permission-controlled area for its platform operators. */
    administration?: { title: string };
    /** The instance administrator still signs in with the generated password from the settings file. */
    bootstrapPasswordInUse?: boolean;
    billingEnabled?: boolean;
    betaEnabled?: boolean;
    emailPreferencesEnabled?: boolean;
    betaAdmin?: boolean;
    workspace?: {
        id: string;
        name: string;
        role: "owner" | "admin" | "member";
        recoveryRequired?: boolean;
        /** How many people belong to it: one means a person working alone. */
        memberCount?: number;
        /** A guest of one project, not a member of the workspace's own pages. */
        projectOnly?: boolean;
    };
    ownedFreeWorkspace?: { id: string; name: string } | null;
    workspaces?: Array<{ id: string; name: string; role: "owner" | "admin" | "member" }>;
    name?: string;
    email?: string;
    identity?: {
        provider: "better-auth";
        url: string;
        requireMfa?: boolean;
        operatorLogin?: boolean;
        signupMode?: "closed" | "allowlist" | "open";
    };
    accountDeletionAvailable?: boolean;
};

/** The service's own say on who may manage projects: the operator, or a workspace owner or admin. */
export const isOperator = (me: Me) =>
    me.mode === "dev" || (me.isAdmin ?? Boolean(me.username && !me.workspace));
export const canManageProjects = (me: Me) =>
    isOperator(me) || Boolean(me.workspace && me.workspace.role !== "member");

/** Called when a request is refused because the workspace needs putting right (an unpaid plan). */
let onRecoveryRequired: (workspaceId: string) => void = () => {};
export const setRecoveryHandler = (fn: (workspaceId: string) => void) => {
    onRecoveryRequired = fn;
    setFailureHandler((status, body) => {
        if (status === 402 && body?.code === "workspace_recovery_required" && body.workspaceId)
            onRecoveryRequired(String(body.workspaceId));
    });
};

const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;

export const markProjectRead = (project: string, at: string) =>
    request<ProjectSummary>(`${projectPath(project)}/read`, json("PUT", { at }));

export interface AccountSession {
    id: string;
    createdAt: string;
    expiresAt: string;
    current: boolean;
}

export const listAccountSessions = async () =>
    (await request<{ items: AccountSession[] }>("/auth/sessions")).items;

export const revokeAccountSession = (id: string) =>
    request<void>(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

export const revokeOtherAccountSessions = () =>
    request<void>("/auth/sessions/revoke-others", json("POST", {}));

export interface AuditEntry {
    id: string;
    actor: string;
    action: string;
    outcome: number;
    createdAt: string;
}

export const listAudit = async () =>
    (await request<{ items: AuditEntry[] }>("/workspace/audit")).items;

export const selectWorkspace = (workspaceId: string) =>
    request<{ ok: true }>("/auth/workspace", json("POST", { workspaceId }));

export const exchangeIdentity = (accessToken: string, revokeOtherSessions = false) =>
    request<{ ok: true }>("/auth/session", json("POST", { accessToken, revokeOtherSessions }));

export type WorkspaceRole = "owner" | "admin" | "member";

export interface WorkspaceInfo {
    workspace: { id: string; name: string };
    role: WorkspaceRole;
    private?: boolean;
    members: Array<{ username: string; name: string; email?: string; role: WorkspaceRole }>;
}

export interface WorkspaceInvite {
    id: string;
    email: string;
    role: WorkspaceRole;
    expiresAt: string;
    acceptedAt?: string;
    revokedAt?: string;
}

export const getWorkspace = () => request<WorkspaceInfo>("/workspace");

export const getWorkspacePolicy = () =>
    request<{ retentionDays: number | null }>("/workspace/policy");

export const setWorkspacePolicy = (retentionDays: number | null) =>
    request<{ retentionDays: number | null }>("/workspace/policy", json("PUT", { retentionDays }));

export const deleteWorkspace = (
    confirm: string,
    verification: { password?: string; accessToken?: string }
) => request<void>("/workspace", json("DELETE", { confirm, ...verification }));

export const deleteAccount = (body: {
    confirm: string;
    password?: string;
    accessToken?: string;
    deletePrivateWorkspaces: boolean;
}) =>
    request<{ deleted: boolean; identityCleanupPending: boolean }>(
        "/auth/account",
        json("DELETE", body)
    );

export const renameWorkspace = (name: string) => request("/workspace", json("PATCH", { name }));

export const createWorkspace = (name: string, plan?: "free" | "plus" | "pro" | "team") =>
    request("/workspaces", json("POST", { name, ...(plan ? { plan } : {}) }));

export const setMemberRole = (username: string, role: WorkspaceRole) =>
    request(`/workspace/members/${encodeURIComponent(username)}`, json("PATCH", { role }));

export const removeMember = (username: string) =>
    request(`/workspace/members/${encodeURIComponent(username)}`, { method: "DELETE" });

export const listInvitations = async () =>
    (await request<{ items: WorkspaceInvite[] }>("/workspace/invitations")).items;

export const inviteMember = (email: string, role: WorkspaceRole) =>
    request<{ url: string }>("/workspace/invitations", json("POST", { email, role }));

export const revokeInvitation = (id: string) =>
    request(`/workspace/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });

export const getInvitation = (token: string) =>
    request<{ workspace: { id: string; name: string }; email: string; role: WorkspaceRole }>(
        `/invitations/${encodeURIComponent(token)}`
    );

export const acceptInvitation = (token: string) =>
    request(`/invitations/${encodeURIComponent(token)}/accept`, { method: "POST" });

export interface RecoveryInfo {
    owner: boolean;
    locked: boolean;
    workspace: { id: string; name: string };
    testPlans: boolean;
    billingEnabled: boolean;
    hasCustomer: boolean;
    status: string;
    periodEnd?: string;
    freeLimits: {
        projects: number;
        bytes: number;
        members: number;
        tokens: number;
        notesPerMonth: number;
    };
    usage?: { projects: number; bytes: number; members: number; tokens: number };
    projects?: Array<{ id: string; name: string; notes: number; bytes: number }>;
    notes?: Array<{
        id: string;
        seq: number;
        projectId: string;
        route: string;
        createdAt: string;
        bytes: number;
    }>;
    next?: number;
    otherFreeWorkspace?: { id: string; name: string } | null;
    members?: Array<{ username: string; name: string; role: WorkspaceRole }>;
    tokens?: Array<{
        id: string;
        name: string;
        permission: "capture" | "full";
        purpose?: "app" | "agent";
        projectId: string;
    }>;
    monthlyNotes?: { notes: number; periodEnd: string };
    blockers?: string[];
    canConvert?: boolean;
    requirements?: Array<{
        id: string;
        step: number;
        label: string;
        met: boolean;
        message: string;
        current?: number;
        limit?: number;
    }>;
    deletionChoices?: Array<{ id: string; name: string; canDelete: boolean; reason?: string }>;
}

export const getRecovery = (project?: string, before?: number) => {
    const query = new URLSearchParams();
    if (project) query.set("project", project);
    if (before !== undefined) query.set("before", String(before));
    return request<RecoveryInfo>(`/billing/recovery?${query}`);
};

export const cleanupRecovery = (kind: "project" | "note" | "token" | "member", ids: string[]) =>
    request<{ ok: boolean; completed: string[]; failed: string[] }>(
        "/billing/recovery/cleanup",
        json("POST", { kind, ids, confirm: "DELETE" })
    );

export const deleteRecoveryWorkspace = (
    workspaceId: string,
    confirm: string,
    verification: { password?: string; accessToken?: string }
) =>
    request<{ ok: true; currentDeleted: boolean }>(
        "/billing/recovery/delete-workspace",
        json("POST", { workspaceId, confirm, ...verification })
    );

export const completeRecovery = (confirm: string) =>
    request("/billing/recovery/complete", json("POST", { confirm }));

export const getProjectOrigins = (id: string) =>
    request<{ origins: string[] }>(`${projectPath(id)}/origins`);

export const setProjectOrigins = (id: string, origins: string[]) =>
    request<{ origins: string[] }>(`${projectPath(id)}/origins`, json("PUT", { origins }));

export interface BillingInfo {
    enabled: boolean;
    testMode: boolean;
    selfServicePlans?: boolean;
    workspacePlans?: boolean;
    locked?: boolean;
    pricesUnavailable?: boolean;
    pricing?: Record<
        string,
        {
            currency: string;
            baseAmount: number;
            seatAmount: number;
            interval: string;
            intervalCount: number;
            divisor: number;
            version: string;
        }
    >;
    requestedPlan?: { id: "free" | "plus" | "pro" | "team"; extraSeats: number };
    selection?: { id: "free" | "plus" | "pro" | "team"; extraSeats: number } | null;
    monthlyNotes?: { notes: number; periodStart: string; periodEnd: string };
    owner: boolean;
    usage: Record<"notes" | "bytes" | "projects" | "members" | "tokens", number>;
    limits: Record<string, number> | null;
    subscription: { plan?: string; status: string; periodEnd?: string } | null;
    hasCustomer: boolean;
    plans: Array<{
        id: string;
        name: string;
        includedSeats?: number;
        automation?: { workflows: number; actions: number };
        limits: Record<string, number>;
    }>;
}

export const selectTestPlan = (plan: string, extraSeats: number) =>
    request("/billing/plan", json("POST", { plan, extraSeats }));

export const getBilling = () => request<BillingInfo>("/billing");

export const checkoutBilling = (plan: string, extraSeats = 0) =>
    request<{ url: string }>("/billing/checkout", json("POST", { plan, extraSeats }));

export const changeBillingSubscription = (
    plan: string,
    extraSeats: number,
    priceVersion: string,
    expectedAmount: number
) =>
    request<{ pendingPayment: boolean }>(
        "/billing/subscription",
        json("POST", { plan, extraSeats, confirmed: true, priceVersion, expectedAmount })
    );

export const convertToFreePlan = () => request("/billing/free", json("POST", {}));

export const portalBilling = () => request<{ url: string }>("/billing/portal", json("POST", {}));

export interface MarketingPreference {
    enabled: boolean;
    /** Whether the person has chosen, either way, for their current address. */
    decided: boolean;
    revision: number;
    blocked?: "complaint" | "hard_bounce";
}

export type EmailPreferences =
    | { available: false }
    | {
          available: true;
          marketing: MarketingPreference;
          copy: { version: string; label: string; note: string };
          privacyUrl: string;
          controller: string;
      };

export const getEmailPreferences = () => request<EmailPreferences>("/account/email-preferences");

export const saveEmailPreference = (input: {
    enabled: boolean;
    expectedRevision: number;
    copyVersion: string;
    source: "onboarding" | "settings";
}) => request<{ marketing: MarketingPreference }>("/account/email-preferences", json("PUT", input));
