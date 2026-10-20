import {
    Authenticator as CoreAuthenticator,
    type AuthenticatorOptions as CoreAuthenticatorOptions,
    type Principal as CorePrincipal,
    type IssuedToken,
    type IssueTokenOptions,
    type NewSession,
    projectAccessible,
    sha256Hex,
    tokenPurpose,
    UnknownProjectError,
} from "@notato/server";
import { ulid } from "ulid";
import { BETA_TOKEN, type BetaPolicy, betaAdmin, betaCookie } from "./beta.ts";
import { clientAddress } from "./hosted-guard.ts";
import type { ManagedAuth } from "./managed-auth.ts";
import {
    type AuthStore,
    assertTokenPurpose,
    DataControlError,
    DEFAULT_WORKSPACE_ID,
    type SessionRecord,
    type TokenRecord,
    type UserRecord,
    type WorkspaceRole,
} from "./storage.ts";

const DAY = 24 * 60 * 60 * 1000;

/**
 * What Notato Cloud knows about whoever is signed in, beyond what the open server needs: which workspace they act
 * in, their role there, and whether the workspace is waiting for payment to be put right. The open server sees the
 * same object as a `Principal` that reaches only `projectIds`.
 */
export type Principal =
    | Extract<CorePrincipal, { kind: "admin" }>
    | (Extract<CorePrincipal, { kind: "member" }> & {
          workspaceId: string;
          role: WorkspaceRole;
          email?: string;
          instanceAdmin?: boolean;
          recoveryRequired?: boolean;
      })
    | (Extract<CorePrincipal, { kind: "token" }> & {
          workspaceId?: string;
          recoveryRequired?: boolean;
      });

export { accessibleProjects, canAccessProject, isAdmin, samePrincipal } from "@notato/server";

export function canManageProjects(principal: Principal): boolean {
    return (
        principal.kind === "admin" || (principal.kind === "member" && principal.role !== "member")
    );
}

export interface AuthenticatorOptions
    extends Pick<CoreAuthenticatorOptions, "sessionTtlMs" | "limiter" | "now"> {
    secureCookies?: boolean;
    managed?: ManagedAuth;
    beta?: BetaPolicy;
    workspaceRestricted?: (workspaceId: string) => Promise<boolean>;
}

/** What the cloud's tokens may be issued with, beyond the open server's options. */
export interface HostedTokenOptions extends IssueTokenOptions {
    workspaceId?: string;
    ownership?: "user" | "service" | "project";
    ownerUsername?: string;
}

/**
 * The open server's accounts, with the hosted service's rules on top: members of workspaces, sign-in through the
 * identity provider (verified, with MFA and per-device revocation where it is required), tokens that belong to a
 * person, a service or a project, and workspaces suspended until payment is put right. How credentials are read,
 * rate-limited, minted and stored is the open server's.
 */
export class Authenticator extends CoreAuthenticator {
    declare readonly store: AuthStore;
    readonly managed?: ManagedAuth;
    readonly beta?: BetaPolicy;
    private readonly workspaceRestricted?: AuthenticatorOptions["workspaceRestricted"];

    constructor(store: AuthStore, options: AuthenticatorOptions = {}) {
        super(store, {
            sessionTtlMs: options.sessionTtlMs,
            limiter: options.limiter,
            now: options.now,
            // A `__Host-` cookie is always Secure and never shared with another host.
            ...(options.secureCookies ? { cookieName: "__Host-notato_session" } : {}),
            // Hosted tokens never travel in a URL, where a proxy's logs would keep them.
            queryTokens: !options.managed,
        });
        this.managed = options.managed;
        this.beta = options.beta;
        this.workspaceRestricted = options.workspaceRestricted;
    }

    // ---- identifying requests -------------------------------------------------------------------------

    /** Every credential this finds is one of the cloud's own (see `tokenPrincipal` and `sessionPrincipal`). */
    override async identify(req: Request, url: URL): Promise<Principal | null> {
        if (!this.managed?.verifyRequest)
            return super.identify(req, url) as Promise<Principal | null>;
        if (req.headers.has("authorization")) {
            const token = await super.identify(req, url);
            if (token?.kind === "token") return token as Principal;
        }
        const identity = await this.managed.verifyRequest(req);
        if (!identity?.sessionId) return null;
        const now = this.now().toISOString();
        const user = await this.store.provisionIdentity(
            {
                ...identity,
                createdAt: now,
                username: `user_${ulid()}`,
                workspace: {
                    id: `ws_${ulid()}`,
                    name: `${identity.displayName}'s workspace`,
                    createdAt: now,
                },
            },
            !this.beta,
            this.beta
                ? {
                      invitationHash: betaCookie(req, this.managed.config.url.startsWith("https:"))
                          ? await sha256Hex(
                                new TextEncoder().encode(
                                    betaCookie(req, this.managed.config.url.startsWith("https:"))!
                                )
                            )
                          : undefined,
                      bypass: identity.instanceAdmin || betaAdmin(this.beta, identity.email),
                  }
                : undefined
        );
        const id = await sha256Hex(new TextEncoder().encode(`better-auth:${identity.sessionId}`));
        let session = await this.store.getSession(id);
        if (!session) {
            const membership = (await this.store.listMemberships(user.username))[0];
            if (!membership) return null;
            session = {
                id,
                username: user.username,
                createdAt: identity.issuedAt ?? now,
                expiresAt: identity.expiresAt,
                workspaceId: membership.workspaceId,
                identitySessionId: identity.sessionId,
                assuranceLevel: identity.assuranceLevel,
            };
            await this.store.createSession(session);
            await this.store.registerIdentitySession(
                identity.provider,
                identity.subject,
                identity.sessionId,
                now
            );
        }
        if (session.expiresAt !== identity.expiresAt) {
            session.expiresAt = identity.expiresAt;
            await this.store.createSession(session);
        }
        const principal = await this.sessionPrincipal(session);
        return principal?.kind === "member"
            ? { ...principal, instanceAdmin: identity.instanceAdmin }
            : principal;
    }

    override async sessionId(req: Request): Promise<string | undefined> {
        if (!this.managed?.verifyRequest) return super.sessionId(req);
        const identity = await this.managed.verifyRequest(req);
        return identity?.sessionId
            ? sha256Hex(new TextEncoder().encode(`better-auth:${identity.sessionId}`))
            : undefined;
    }

    protected override async tokenPrincipal(record: TokenRecord): Promise<Principal | null> {
        if (record.developmentContextId) {
            const context = await this.store.coordination?.get(record.developmentContextId);
            if (
                !context ||
                !("owner" in context) ||
                !("archived" in context) ||
                context.archived ||
                context.projectId !== record.projectId ||
                context.owner !== (record.ownerUsername ?? record.createdBy)
            )
                return null;
        }
        if (this.managed && (!record.workspaceId || !record.expiresAt)) return null;
        if (
            this.managed?.config.identityNamespace &&
            record.identityNamespace !== this.managed.config.identityNamespace
        )
            return null;
        const ownership =
            record.ownership ??
            (tokenPurpose(record) === "agent" ? "project" : record.createdBy ? "user" : "service");
        if (this.managed && ownership === "project" && record.projectId === "*") return null;
        let authorName: string | undefined;
        if (ownership === "user") {
            const owner = record.ownerUsername ?? record.createdBy;
            if (!owner || !record.workspaceId || (await this.store.betaAccountBlocked(owner)))
                return null;
            if (!(await this.store.getMembership(record.workspaceId, owner))) return null;
            const account = await this.store.getUser(owner);
            if (
                !account ||
                (this.managed?.config.identityNamespace &&
                    account.identityProvider !== this.managed.config.identityNamespace)
            )
                return null;
            if (
                account.identitySubject &&
                this.managed?.activeUser &&
                !(await this.managed.activeUser(account.identitySubject))
            )
                return null;
            authorName = account.displayName?.trim() || account.email || account.username;
        }
        if (record.workspaceId && (await this.store.betaWorkspaceBlocked(record.workspaceId)))
            return null;
        let projectIds: string[] | undefined;
        const restricted = record.workspaceId
            ? await this.workspaceRestricted?.(record.workspaceId)
            : false;
        if (record.workspaceId) {
            projectIds = restricted
                ? []
                : (await this.store.listProjects(record.workspaceId)).map((p) => p.id);
            if (ownership === "user") {
                const owner = record.ownerUsername ?? record.createdBy!;
                const member = await this.store.getMembership(record.workspaceId, owner);
                const permitted = await Promise.all(
                    projectIds.map(async (id) =>
                        (await projectAccessible(
                            this.store.coordination!,
                            id,
                            owner,
                            member?.role !== "member",
                            member?.projectOnly
                        ))
                            ? id
                            : null
                    )
                );
                projectIds = permitted.filter((id): id is string => id !== null);
            }
            if (record.projectId !== "*")
                projectIds = projectIds.filter((id) => id === record.projectId);
        }
        return {
            kind: "token",
            tokenId: record.id,
            feedbackActorId: record.ownerUsername ?? record.createdBy ?? `token:${record.id}`,
            developmentContextId: record.developmentContextId,
            captureWorkId: record.captureWorkId,
            ...(authorName ? { authorName } : {}),
            projectId: record.projectId,
            permission: record.permission ?? "full",
            purpose: tokenPurpose(record),
            ...(restricted ? { recoveryRequired: true, locked: true } : {}),
            ...(record.workspaceId
                ? { workspaceId: record.workspaceId, scope: record.workspaceId, projectIds }
                : {}),
        };
    }

    protected override async sessionPrincipal(session: SessionRecord): Promise<Principal | null> {
        const user = await this.store.getUser(session.username);
        if (!user || (await this.store.betaAccountBlocked(user.username))) return null;
        if (user.isAdmin && this.managed?.config.operatorLogin === false) return null;
        if (!user.isAdmin && this.managed) {
            if (
                this.managed.config.requireMfa &&
                (!user.identityProvider ||
                    session.assuranceLevel !== "aal2" ||
                    !session.identitySessionId)
            )
                return null;
            if (
                this.managed.config.identityNamespace &&
                user.identityProvider !== this.managed.config.identityNamespace
            )
                return null;
        }
        if (this.managed && user.identityProvider) {
            if (this.managed.config.requireMfa && session.assuranceLevel !== "aal2") return null;
            if (
                session.identitySessionId &&
                user.identitySubject &&
                (await this.store.identitySessionRevoked(
                    user.identityProvider,
                    user.identitySubject,
                    session.identitySessionId
                ))
            )
                return null;
        }
        if (user.isAdmin)
            return {
                kind: "admin",
                username: session.username,
                feedbackActorId: session.username,
            };
        if (!session.workspaceId) return null;
        const membership = await this.store.getMembership(session.workspaceId, session.username);
        if (!membership) return null;
        const restricted = await this.workspaceRestricted?.(session.workspaceId);
        const candidates = await this.store.listProjects(session.workspaceId);
        const permitted = await Promise.all(
            candidates.map(async (project) =>
                (await projectAccessible(
                    this.store.coordination!,
                    project.id,
                    session.username,
                    membership.role !== "member",
                    membership.projectOnly
                ))
                    ? project.id
                    : null
            )
        );
        return {
            kind: "member",
            username: session.username,
            feedbackActorId: session.username,
            workspaceId: session.workspaceId,
            role: membership.role,
            projectIds: restricted ? [] : permitted.filter((id): id is string => id !== null),
            ...(restricted ? { recoveryRequired: true, locked: true } : {}),
            scope: session.workspaceId,
            ...(user.displayName ? { name: user.displayName } : {}),
            ...(user.email ? { email: user.email } : {}),
        };
    }

    /** Native operators must prove their password again before granting a prepared identity workspace access. */
    async reauthenticateOperator(principal: Principal, password: string): Promise<boolean> {
        if (this.managed || principal.kind !== "admin") return false;
        const key = `identity-setup:${principal.username}`;
        if (this.limiter.retryAfter(key) > 0) return false;
        const user = await this.store.getUser(principal.username);
        const valid = Boolean(
            user?.isAdmin &&
                (await Bun.password.verify(password, user.passwordHash).catch(() => false))
        );
        if (valid) this.limiter.succeed(key);
        else this.limiter.fail(key);
        return valid;
    }

    /** Destructive account actions require a second credential, not only the board cookie. */
    async reauthenticate(
        principal: Principal,
        password?: string,
        accessToken?: string
    ): Promise<boolean> {
        if (principal.kind !== "member") return false;
        const user = await this.store.getUser(principal.username);
        if (!user) return false;
        const key = `account-delete:${principal.username}`;
        if (this.limiter.retryAfter(key) > 0) return false;
        let valid = false;
        if (user.identitySubject && this.managed?.reauthenticate) {
            valid = await this.managed.reauthenticate(user.identitySubject, password ?? "");
        } else if (user.identityProvider && user.identitySubject) {
            const identity = accessToken ? await this.managed?.verify(accessToken) : null;
            const age = identity?.issuedAt
                ? this.now().getTime() - Date.parse(identity.issuedAt)
                : Infinity;
            valid = Boolean(
                identity &&
                    identity.provider === user.identityProvider &&
                    identity.subject === user.identitySubject &&
                    age >= -60_000 &&
                    age <= 300_000 &&
                    (!this.managed?.config.requireMfa || identity.assuranceLevel === "aal2")
            );
        } else {
            valid = await Bun.password.verify(password ?? "", user.passwordHash).catch(() => false);
        }
        if (!valid) this.limiter.fail(key);
        else this.limiter.succeed(key);
        return valid;
    }

    // ---- sessions -------------------------------------------------------------------------------------

    /** Failed sign-ins are counted per client network (an IPv6 /64), not per address within it. */
    override login(username: string, password: string, clientKey: string, secure = false) {
        return super.login(username, password, clientAddress(clientKey), secure);
    }

    /** Customers sign in through the identity provider; where MFA is required, only an operator uses a password. */
    protected override async passwordRefusal(user: UserRecord | null): Promise<string | null> {
        return this.managed?.config.operatorLogin === false ||
            (this.managed?.config.requireMfa && !user?.isAdmin)
            ? "use verified customer sign-in; operator password sign-in is disabled"
            : null;
    }

    /** A member signs in to their first workspace; a hosted password session lasts an hour at most. */
    protected override async newSession(user: UserRecord): Promise<NewSession | string> {
        const membership = user.isAdmin
            ? undefined
            : (await this.store.listMemberships(user.username))[0];
        if (!user.isAdmin && !membership) return "this account has no workspace access";
        return {
            ttlMs: this.managed ? Math.min(this.ttl, 3600_000) : this.ttl,
            fields: membership ? { workspaceId: membership.workspaceId } : {},
        };
    }

    /** Exchange a verified provider token for a short-lived HttpOnly board session. */
    async managedLogin(
        accessToken: string,
        req: Request,
        clientKey: string,
        secure = false,
        revokeOtherSessions = false
    ) {
        if (!this.managed)
            return {
                ok: false as const,
                status: 404,
                error: "hosted registration is not configured",
            };
        const key = `managed:${clientKey}`;
        const retryAfter = this.limiter.retryAfter(key);
        if (retryAfter)
            return {
                ok: false as const,
                status: 429,
                error: "too many failed attempts; try again later",
                retryAfter,
            };
        const identity = await this.managed.verify(accessToken);
        const ttl = identity
            ? Math.min(this.ttl, Date.parse(identity.expiresAt) - this.now().getTime())
            : 0;
        if (
            !identity ||
            !Number.isFinite(ttl) ||
            ttl < 1000 ||
            (this.managed.config.requireMfa &&
                (identity.assuranceLevel !== "aal2" || !identity.sessionId))
        ) {
            this.limiter.fail(key);
            return {
                ok: false as const,
                status: 401,
                error: "a verified email and valid sign-in are required",
            };
        }
        if (
            identity.sessionId &&
            (await this.store.identitySessionRevoked(
                identity.provider,
                identity.subject,
                identity.sessionId
            ))
        )
            return {
                ok: false as const,
                status: 401,
                error: "this device session was revoked; sign in again",
            };
        const now = this.now().toISOString();
        const mode = this.managed.config.signupMode ?? "open";
        const allowNewAccount =
            mode === "open" ||
            (mode === "allowlist" && this.managed.allowsSignup?.(identity.email) === true);
        let user: UserRecord;
        const invitation = betaCookie(req, secure);
        const invitationHash =
            invitation && BETA_TOKEN.test(invitation)
                ? await sha256Hex(new TextEncoder().encode(invitation))
                : undefined;
        try {
            user = await this.store.provisionIdentity(
                {
                    ...identity,
                    createdAt: now,
                    username: `user_${ulid()}`,
                    workspace: {
                        id: `ws_${ulid()}`,
                        name: `${identity.displayName}'s workspace`,
                        createdAt: now,
                    },
                },
                this.beta ? false : allowNewAccount,
                this.beta
                    ? { invitationHash, bypass: betaAdmin(this.beta, identity.email) }
                    : undefined
            );
        } catch (error) {
            if (!(error instanceof DataControlError) || error.status !== 403) throw error;
            this.limiter.fail(key);
            return { ok: false as const, status: 403, error: error.message };
        }
        if (await this.store.betaAccountBlocked(user.username))
            return {
                ok: false as const,
                status: 403,
                error: "Your beta access is suspended. Contact the service owner.",
            };
        if (identity.sessionId)
            await this.store.registerIdentitySession(
                identity.provider,
                identity.subject,
                identity.sessionId,
                now
            );
        const memberships = await this.store.listMemberships(user.username);
        const current = await this.identify(req, new URL(req.url));
        const workspaceId =
            current?.kind === "member" && current.username === user.username
                ? current.workspaceId
                : memberships[0]?.workspaceId;
        if (!workspaceId)
            return {
                ok: false as const,
                status: 403,
                error: "this account has no workspace access",
            };
        this.limiter.succeed(key);
        if (revokeOtherSessions) {
            await this.revokeSessions(user.username, undefined, identity.sessionId);
            await this.store.deleteSessionsFor(user.username);
        }
        // Token refresh replaces the previous cookie instead of leaving an ever-growing set of active sessions.
        await this.logout(req, secure, false);
        return {
            ok: true as const,
            cookie: await this.startSession(user.username, secure, {
                ttlMs: ttl,
                fields: {
                    workspaceId,
                    ...(identity.sessionId ? { identitySessionId: identity.sessionId } : {}),
                    ...(identity.assuranceLevel ? { assuranceLevel: identity.assuranceLevel } : {}),
                },
            }),
        };
    }

    /** `revokeIdentity: false` ends only this session, not the sign-in at the identity provider it came from. */
    override async logout(req: Request, secure = false, revokeIdentity = true): Promise<string> {
        if (revokeIdentity) return super.logout(req, secure);
        const id = await this.sessionId(req);
        if (id) await this.store.deleteSession(id);
        return this.cookie("", 0, secure);
    }

    /** Signing out also revokes the identity provider's session it came from, so it cannot sign in again. */
    protected override async endSession(id: string): Promise<void> {
        const session = await this.store.getSession(id);
        if (session) await this.revokeSession(session.username, id);
        else await this.store.deleteSession(id);
    }

    async revokeSession(username: string, id: string): Promise<boolean> {
        const session = await this.store.getSession(id);
        if (!session || session.username !== username) return false;
        const user = await this.store.getUser(username);
        if (session.identitySessionId)
            await this.managed?.revokeIdentitySession?.(session.identitySessionId);
        if (session.identitySessionId && user?.identityProvider && user.identitySubject)
            await this.store.revokeIdentitySession(
                user.identityProvider,
                user.identitySubject,
                session.identitySessionId,
                this.now().toISOString()
            );
        await this.store.deleteSession(id);
        return true;
    }
    async revokeSessions(username: string, keepId?: string, keepIdentity?: string): Promise<void> {
        const user = await this.store.getUser(username);
        if (user?.identityProvider && user.identitySubject) {
            await this.managed?.revokeUserSessions?.(user.identitySubject, keepIdentity);
            for (const source of await this.store.listIdentitySessions(
                user.identityProvider,
                user.identitySubject
            ))
                if (source !== keepIdentity) {
                    await this.managed?.revokeIdentitySession?.(source);
                    await this.store.revokeIdentitySession(
                        user.identityProvider,
                        user.identitySubject,
                        source,
                        this.now().toISOString()
                    );
                }
        }
        const sessions = await this.store.listSessionsFor(username);
        for (const session of sessions) {
            if (session.id === keepId) continue;
            if (session.identitySessionId && session.identitySessionId === keepIdentity)
                await this.store.deleteSession(session.id);
            else await this.revokeSession(username, session.id);
        }
    }

    async selectWorkspace(req: Request, workspaceId: string): Promise<boolean> {
        const id = await this.sessionId(req);
        if (!id) return false;
        const session = await this.store.getSession(id);
        if (
            !session ||
            session.expiresAt <= this.now().toISOString() ||
            !(await this.store.getMembership(workspaceId, session.username))
        )
            return false;
        await this.store.setSessionWorkspace(id, workspaceId);
        return true;
    }

    // ---- accounts and tokens --------------------------------------------------------------------------

    /** The configured operator, never an ordinary account that happens to have the same name. */
    override async ensureAdmin(
        username: string,
        password?: string
    ): Promise<{ created: boolean; generatedPassword?: string }> {
        const existing = await this.store.getUser(username);
        if (existing && !existing.isAdmin)
            throw new Error(
                `the configured admin username "${username}" belongs to an ordinary account`
            );
        return super.ensureAdmin(username, password);
    }

    /** The operator account, an owner of the default workspace that pre-workspace projects belong to. */
    protected override async addAdmin(user: UserRecord): Promise<void> {
        await this.store.upsertUser({ ...user, isAdmin: true });
        await this.store.setMembership({
            workspaceId: DEFAULT_WORKSPACE_ID,
            username: user.username,
            role: "owner",
            createdAt: this.now().toISOString(),
        });
    }

    /** Provision an ordinary account without changing an existing account or granting operator privileges. */
    async createAccount(username: string, password: string): Promise<boolean> {
        return this.store.createUser({
            username,
            passwordHash: await Bun.password.hash(password, { algorithm: "argon2id" }),
            createdAt: this.now().toISOString(),
            isAdmin: false,
        });
    }

    /** Throws `UnknownProjectError` unless `projectId` is `*` or a project this server has. */
    override async issueToken(
        projectId: string,
        name: string,
        options: HostedTokenOptions = {}
    ): Promise<IssuedToken> {
        const workspaceId = options.workspaceId;
        const project = projectId === "*" ? null : await this.store.getProject(projectId);
        if (projectId !== "*" && !project) throw new UnknownProjectError(projectId);
        const workspace = workspaceId ?? project?.workspaceId;
        if (
            workspace &&
            (!(await this.store.getWorkspace(workspace)) ||
                (project && project.workspaceId !== workspace))
        )
            throw new Error("token workspace does not match its project");
        const permission =
            options.permission ??
            (options.purpose === "agent"
                ? "full"
                : this.managed && projectId !== "*"
                  ? "capture"
                  : "full");
        const purpose = tokenPurpose({ ...options, permission });
        assertTokenPurpose({ purpose, permission, projectId });
        if (permission === "capture" && projectId === "*")
            throw new Error("capture tokens must name one project");
        const days = options.expiresInDays ?? (this.managed ? 90 : undefined);
        if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365))
            throw new Error("token lifetime must be 1–365 days");
        const ownership =
            options.ownership ??
            (purpose === "agent" ? "project" : options.createdBy ? "user" : "service");
        const ownerUsername =
            ownership === "user" ? (options.ownerUsername ?? options.createdBy) : undefined;
        if (this.managed && ownership === "project" && projectId === "*")
            throw new Error("agent tokens must name one project");
        const fields: Omit<TokenRecord, "id" | "tokenHash" | "createdAt"> = {
            projectId,
            developmentContextId: options.developmentContextId,
            captureWorkId: options.captureWorkId,
            ...(workspace ? { workspaceId: workspace } : {}),
            name,
            permission,
            purpose,
            ...(this.managed?.config.identityNamespace
                ? { identityNamespace: this.managed.config.identityNamespace }
                : {}),
            ...(this.managed || options.ownership
                ? { ownership, ...(ownerUsername ? { ownerUsername } : {}) }
                : {}),
            ...(options.createdBy ? { createdBy: options.createdBy } : {}),
            ...(days
                ? { expiresAt: new Date(this.now().getTime() + days * DAY).toISOString() }
                : {}),
        };
        return this.mintToken(fields);
    }

    override listTokens(): Promise<TokenRecord[]> {
        return this.store.listTokens();
    }
}
