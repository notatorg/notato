import type { Annotation } from "@notato/schema";
import {
    type BundleRecord,
    type AuthStore as CoreAuthStore,
    type ProjectRecord as CoreProjectRecord,
    type ProjectSummary as CoreProjectSummary,
    type SessionRecord as CoreSessionRecord,
    type Store as CoreStore,
    type TokenRecord as CoreTokenRecord,
    type UserRecord as CoreUserRecord,
    type StoredAnnotation,
    tokenPurpose,
} from "@notato/server";
import type { BetaOverview, BetaRequest, BetaSettings, BetaState } from "./beta-store.ts";
import type {
    MarketingPreference,
    MarketingRecords,
    PreferenceSource,
    SuppressionReason,
} from "./email-preferences-store.ts";
import type { PluginStore } from "./plugins/store.ts";

// The open server's records and stores, with what a hosted service keeps beyond them: every project belongs to a
// workspace, accounts sign in through an identity provider, and tokens say who owns them. The rest (filters, notes,
// bundles, screenshots) are the open server's own, imported from it.

/** A project, in the workspace it belongs to. */
export interface ProjectRecord extends CoreProjectRecord {
    /** Defaults to the local/shared server's workspace for callers predating workspaces. */
    workspaceId?: string;
}

export interface ProjectSummary extends CoreProjectSummary {
    workspaceId?: string;
    /** This signed-in user's last visit, and notes created or updated since then. */
    readAt?: string;
    unread?: number;
}

/** The closed beta's waitlist, invitations and suspensions. */
export interface BetaStore {
    getBetaRequest(id: string): Promise<BetaRequest | null>;
    betaSettings(): Promise<BetaSettings>;
    requestBeta(request: Omit<BetaRequest, "state" | "updatedAt">): Promise<void>;
    listBetaRequests(
        state?: BetaState,
        cursor?: string
    ): Promise<{ items: BetaRequest[]; nextCursor?: string }>;
    betaOverview(): Promise<BetaOverview>;
    configureBeta(config: BetaSettings): Promise<BetaSettings>;
    inviteBeta(id: string, actor: string, hash: string, expires: string): Promise<BetaRequest>;
    revokeBeta(id: string): Promise<void>;
    betaInvitation(hash: string): Promise<BetaRequest | null>;
    betaAccountBlocked(username: string): Promise<boolean>;
    betaWorkspaceBlocked(workspace: string): Promise<boolean>;
}

/** Personal marketing-email choices, their evidence and the suppressions that outlive an account. */
export interface EmailPreferenceStore {
    getMarketingPreference(username: string, fingerprint: string): Promise<MarketingPreference>;
    setMarketingPreference(input: {
        username: string;
        fingerprint: string;
        enabled: boolean;
        expectedRevision: number;
        source: "onboarding" | "settings";
        copyVersion: string;
    }): Promise<MarketingPreference>;
    /** Withdraws consent for an address without a sign-in. Never grants consent. */
    suppressEmail(
        fingerprint: string,
        reason: SuppressionReason,
        source: PreferenceSource
    ): Promise<{ changed: boolean }>;
    /** The last check before a marketing message goes to a provider. False while sending is held. */
    marketingEligible(username: string, fingerprint: string): Promise<boolean>;
    exportMarketingRecords(username: string, fingerprint: string): Promise<MarketingRecords>;
    /** Removes detached evidence and suppressions recorded before `cutoff`; returns how many rows went. */
    purgeEmailRecords(cutoff: string): Promise<number>;
    marketingSendHeld(): Promise<boolean>;
    setMarketingSendHold(held: boolean): Promise<void>;
}

/** The open server's record storage, with workspaces, plans, billing and data controls. */
export interface Store extends CoreStore, BetaStore, EmailPreferenceStore {
    pullRequestWorks(
        repository: string,
        match: { number: number } | { sha: string }
    ): Promise<import("@notato/server").WorkRecord[]>;
    transferProject?(project: string, workspace: string, actor: string): Promise<ProjectRecord>;
    plugins?: PluginStore;
    getWorkspace(id: string): Promise<WorkspaceRecord | null>;
    ownedFreeWorkspace(username: string): Promise<WorkspaceRecord | null>;
    getBilling(workspaceId: string): Promise<WorkspaceBilling | null>;
    billingWorkspace(customerId: string): Promise<string | null>;
    setBillingCustomer(workspaceId: string, customerId: string): Promise<WorkspaceBilling>;
    applyBillingEvent(eventId: string, state: WorkspaceBilling, at: string): Promise<boolean>;
    saveCheckout(
        workspaceId: string,
        checkout: NonNullable<WorkspaceBilling["checkout"]> | null
    ): Promise<void>;
    workspaceUsage(workspaceId: string): Promise<WorkspaceUsage>;
    getWorkspaceLimits(workspaceId: string): Promise<HostedLimits | undefined>;
    getWorkspacePlan(workspaceId: string): Promise<WorkspacePlan | null>;
    selectWorkspacePlan(
        workspaceId: string,
        actor: string,
        plan: PlanId,
        extraSeats: number
    ): Promise<WorkspacePlan>;
    monthlyNoteUsage(workspaceId: string): Promise<MonthlyNoteUsage>;
    getWorkspacePolicy(id: string): Promise<WorkspacePolicy>;
    setWorkspacePolicy(id: string, actor: string, days: number | null): Promise<WorkspacePolicy>;
    deleteWorkspace(id: string, actor: string): Promise<StoredAnnotation[] | null>;
    deleteAccount(
        username: string,
        at: string,
        deletePrivateWorkspaces?: boolean
    ): Promise<StoredAnnotation[] | null>;
    expiredAnnotations(now: string, limit?: number): Promise<StoredAnnotation[]>;
    deleteExpiredAnnotation(id: string, now: string): Promise<StoredAnnotation | null>;
    setHostedLimits?(limits: HostedLimits): void;
    setTestPlans?(enabled: boolean): void;
    setWorkspacePlans?(enabled: boolean): void | Promise<void>;
    getWorkspaceEntitlement(workspaceId: string): Promise<WorkspaceEntitlement>;
    workspaceCleanup(
        workspaceId: string,
        actor: string,
        project?: string,
        before?: number
    ): Promise<WorkspaceCleanup>;
    checkIngestBudget?(annotation: Annotation, assetBytes: number): Promise<void>;
    /** Refuses a new bundle its workspace has no room for, before any of its notes is stored. */
    checkBundleBudget?(bundle: BundleRecord): Promise<void>;
    /**
     * The whole service's size, for capacity alerts: the database as its provider measures it, and the bytes every
     * workspace's notes, screenshots and bundles are charged for. No workspace is named.
     */
    serviceCapacity?(): Promise<{ databaseBytes: number; storedBytes: number }>;
    /**
     * Every project, with its counts; a project with no notes yet is listed too. Only a workspace's, when one is
     * given, and with `username`'s read state.
     */
    listProjects(workspaceId?: string, username?: string): Promise<ProjectSummary[]>;
    /** Only moves forwards. The HTTP layer checks access and uses a time reported by the server. */
    markProjectRead(projectId: string, username: string, at: string): Promise<void>;
    getProject(id: string): Promise<ProjectRecord | null>;
    /** Returns false when a project with that id already exists. */
    createProject(project: ProjectRecord): Promise<boolean>;
    renameProject(id: string, name: string): Promise<ProjectRecord | null>;
    getProjectOrigins(id: string): Promise<string[]>;
    setProjectOrigins(id: string, origins: string[]): Promise<boolean>;
    close(): void | Promise<void>;
}

export interface UserRecord extends CoreUserRecord {
    /** Server operator privileges. New accounts default to false; workspace roles never grant them. */
    isAdmin?: boolean;
    email?: string;
    displayName?: string;
    identityProvider?: string;
    identitySubject?: string;
}

export interface ExternalAccount {
    provider: string;
    subject: string;
    email: string;
    displayName: string;
    createdAt: string;
    username: string;
    workspace: WorkspaceRecord;
}

/** Existing local and shared-server projects belong here after migration. */
export const DEFAULT_WORKSPACE_ID = "default";

export interface WorkspaceRecord {
    id: string;
    name: string;
    createdAt: string;
}
export interface WorkspacePolicy {
    retentionDays: number | null;
}
export interface WorkspaceBilling {
    workspaceId: string;
    customerId: string;
    subscriptionId?: string;
    plan?: string;
    status: string;
    /** Assigned only from a verified subscription's configured base and seat price quantities. */
    entitlement?: WorkspacePlan;
    periodEnd?: string;
    limits?: HostedLimits;
    checkout?: { id: string; url: string; plan: string; expiresAt: string; extraSeats?: number };
}
export interface WorkspaceUsage {
    notes: number;
    bytes: number;
    projects: number;
    members: number;
    tokens: number;
}
export type PlanId = "free" | "plus" | "pro" | "team";
export interface WorkspaceEntitlement {
    plan: WorkspacePlan;
    /** Normal data access is blocked; owners can use the recovery wizard to restore payment or clean up. */
    locked: boolean;
    requestedPlan?: WorkspacePlan;
}
export interface WorkspaceCleanup {
    projects: Array<{ id: string; name: string; notes: number; bytes: number }>;
    notes: Array<{
        id: string;
        seq: number;
        projectId: string;
        route: string;
        createdAt: string;
        bytes: number;
    }>;
    next?: number;
    otherFreeWorkspace: WorkspaceRecord | null;
}
export interface WorkspacePlan {
    id: PlanId;
    extraSeats: number;
}
export interface MonthlyNoteUsage {
    notes: number;
    periodStart: string;
    periodEnd: string;
}
export interface IdentityDeletion {
    provider: string;
    subject: string;
}
export class DataControlError extends Error {
    constructor(
        message: string,
        readonly status = 409
    ) {
        super(message);
    }
}

export type WorkspaceRole = "owner" | "admin" | "member";

export interface MembershipRecord {
    projectOnly?: boolean;
    workspaceId: string;
    username: string;
    role: WorkspaceRole;
    createdAt: string;
}

export interface InvitationRecord {
    projectId?: string;
    id: string;
    workspaceId: string;
    email: string;
    role: WorkspaceRole;
    tokenHash: string;
    createdBy: string;
    createdAt: string;
    expiresAt: string;
    acceptedAt?: string;
    revokedAt?: string;
}

export class WorkspaceOwnershipError extends Error {
    constructor() {
        super("a workspace must keep at least one owner");
    }
}
export interface HostedLimits {
    notes: number;
    bytes: number;
    projects: number;
    workspaces: number;
    tokens: number;
    members?: number;
    invitations?: number;
    jsonBytes?: number;
    notesPerMonth?: number;
}
export const HOSTED_LIMITS: HostedLimits = {
    notes: 10_000,
    bytes: 1024 * 1024 * 1024,
    projects: 50,
    workspaces: 5,
    tokens: 100,
};
export class QuotaError extends Error {
    constructor(
        message = "Workspace capacity reached. Remove unused data or ask the instance administrator to adjust resource limits."
    ) {
        super(message);
    }
}
export interface AuditRecord {
    id: string;
    workspaceId: string;
    actor: string;
    action: string;
    outcome: number;
    createdAt: string;
}

/** Workspace ownership and membership, separate from server operator privileges. */
export interface WorkspaceStore extends BetaStore {
    getWorkspace(id: string): Promise<WorkspaceRecord | null>;
    ownedFreeWorkspace(username: string): Promise<WorkspaceRecord | null>;
    listWorkspaces(): Promise<WorkspaceRecord[]>;
    /** Creates the workspace and its first owner atomically. False when its id already exists. */
    createWorkspace(
        workspace: WorkspaceRecord,
        owner: string,
        plan?: WorkspacePlan
    ): Promise<boolean>;
    renameWorkspace(id: string, name: string): Promise<WorkspaceRecord | null>;
    getMembership(workspaceId: string, username: string): Promise<MembershipRecord | null>;
    listMemberships(username: string): Promise<MembershipRecord[]>;
    listWorkspaceMembers(workspaceId: string): Promise<MembershipRecord[]>;
    /** Adding or changing a member cannot demote the workspace's last owner. */
    setMembership(membership: MembershipRecord): Promise<void>;
    /** Removing a member cannot remove the workspace's last owner. */
    removeMembership(workspaceId: string, username: string): Promise<boolean>;
    createInvitation(invitation: InvitationRecord): Promise<void>;
    getInvitation(tokenHash: string): Promise<InvitationRecord | null>;
    listInvitations(workspaceId: string): Promise<InvitationRecord[]>;
    revokeInvitation(workspaceId: string, id: string, at: string): Promise<boolean>;
    /** Single-use, unexpired invitations may be redeemed only by their verified email. Never replaces an existing role. */
    acceptInvitation(
        tokenHash: string,
        username: string,
        at: string
    ): Promise<MembershipRecord | null>;
}

export interface SessionRecord extends CoreSessionRecord {
    /** Selected workspace for an ordinary account. Operators keep their server-wide session. */
    workspaceId?: string;
    identitySessionId?: string;
    assuranceLevel?: "aal1" | "aal2";
}

export interface TokenRecord extends CoreTokenRecord {
    /** When present, even `*` is restricted to this workspace. Legacy operator tokens remain supported. */
    workspaceId?: string;
    /** Personal app credentials follow their owner; service and agent credentials belong to the project. */
    ownership?: "user" | "service" | "project";
    ownerUsername?: string;
    identityNamespace?: string;
}

/**
 * The open server's rule for what a token is for (`assertTokenPurpose` there), refused as the hosted service words it:
 * a `DataControlError` its routes answer with 400.
 */
export function assertTokenPurpose(
    token: Pick<TokenRecord, "purpose" | "permission" | "projectId">
): void {
    const purpose = tokenPurpose(token);
    if (purpose === "app" && token.projectId === "*")
        throw new DataControlError("app/tester tokens must name one project", 400);
    if (purpose === "agent" && token.permission === "capture")
        throw new DataControlError("agent tokens require read and write feedback access", 400);
}

/** The open server's accounts, sessions and API tokens, with workspaces, identities and the activity log. */
export interface AuthStore extends CoreAuthStore, WorkspaceStore {
    coordination?: import("@notato/server").CoordinationStore;
    deleteAccount(
        username: string,
        at: string,
        deletePrivateWorkspaces?: boolean
    ): Promise<StoredAnnotation[] | null>;
    pendingIdentityDeletions(now: string): Promise<IdentityDeletion[]>;
    identityDeletionResult(
        provider: string,
        subject: string,
        success: boolean,
        next: string
    ): Promise<void>;
    appendAudit(record: AuditRecord): Promise<void>;
    listAudit(workspaceId: string, limit?: number): Promise<AuditRecord[]>;
    getUser(username: string): Promise<UserRecord | null>;
    /** False for an existing username; never changes that account's password or privileges. */
    createUser(user: UserRecord): Promise<boolean>;
    /** Verified identities get one ordinary account and its first workspace atomically. Never links by email.
     * When allowNewAccount is false, only an already-provisioned provider/subject can sign in. */
    provisionIdentity(
        account: ExternalAccount,
        allowNewAccount?: boolean,
        beta?: { invitationHash?: string; bypass: boolean }
    ): Promise<UserRecord>;
    upsertUser(user: UserRecord): Promise<void>;
    createSession(session: SessionRecord): Promise<void>;
    getSession(id: string): Promise<SessionRecord | null>;
    listSessionsFor(username: string): Promise<SessionRecord[]>;
    revokeIdentitySession(
        provider: string,
        subject: string,
        sessionId: string,
        at: string
    ): Promise<void>;
    identitySessionRevoked(provider: string, subject: string, sessionId: string): Promise<boolean>;
    registerIdentitySession(
        provider: string,
        subject: string,
        sessionId: string,
        at: string
    ): Promise<void>;
    listIdentitySessions(provider: string, subject: string): Promise<string[]>;
    setSessionWorkspace(id: string, workspaceId: string): Promise<void>;
    deleteSession(id: string): Promise<void>;
    purgeSessions(now: string): Promise<void>;
    createToken(token: TokenRecord): Promise<void>;
    findToken(tokenHash: string): Promise<TokenRecord | null>;
    listTokens(workspaceId?: string): Promise<TokenRecord[]>;
    /** Returns false when the id is unknown or already revoked. */
    revokeToken(id: string, at: string): Promise<boolean>;
    touchToken(id: string, at: string): Promise<void>;
    /** Stops every token for this project working (the project is being deleted). */
    revokeProjectTokens(projectId: string, at: string): Promise<void>;
    /** Sessions die with a password change, so a stolen cookie stops working. */
    deleteSessionsFor(username: string): Promise<void>;
    getProject(id: string): Promise<ProjectRecord | null>;
    listProjects(workspaceId?: string): Promise<ProjectSummary[]>;
}
