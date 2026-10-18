import { ulid } from "ulid";
import { sha256Hex } from "./blob-store.ts";
import {
    type AuthStore,
    assertTokenPurpose,
    type SessionRecord,
    type TokenRecord,
    tokenPurpose,
    type UserRecord,
} from "./storage.ts";

/**
 * What an extension may add to a signed-in person or a token, so routes it supplies can read it back typed:
 * `declare module "@notato/server" { interface PrincipalExtras { tenantId?: string } }`. The server itself
 * only ever compares `scope`.
 */
export interface PrincipalExtras {
    agentSession?: boolean;
    developmentContextId?: string;
    captureWorkId?: string;
    /**
     * An opaque tenant or context the credential is acting in. An event stream or MCP session is closed when the
     * same person turns up in another scope, so switching one never reuses what the previous one opened.
     */
    scope?: string;
}

/**
 * Who a request is from. An admin session can do everything; a token can read and write the one project
 * it was issued for, or every project when issued for `*` (an agent or MCP connection). A member is a signed-in
 * person who is not an admin, and who reaches only the projects an extension's accounts give them: the built-in
 * accounts make none, so on a plain server there are admins and tokens.
 */
export type Principal =
    | ({ kind: "admin"; username: string } & PrincipalExtras)
    | ({
          kind: "member";
          username: string;
          /** The projects this person reaches, and no others. */
          projectIds: string[];
          name?: string;
          /** Valid, but locked: nothing is reachable until the deployment lifts it. */
          locked?: boolean;
      } & PrincipalExtras)
    | ({
          kind: "token";
          tokenId: string;
          /** A fixed account identity for app feedback; supplied author names cannot override it. */
          authorName?: string;
          projectId: string | "*";
          /** Narrows even a `*` token to these projects. */
          projectIds?: string[];
          /** `capture` can only submit new notes. Absent on tokens made before 0.3: full access. */
          permission?: "capture" | "full";
          /** Absent on tokens made before 0.3, which can be used for both an app and an agent. */
          purpose?: "app" | "agent";
          locked?: boolean;
      } & PrincipalExtras);

/**
 * What the server asks of whatever knows its accounts and tokens. `Authenticator` is the built-in one, with an
 * admin login and project tokens in the data folder; an extension can supply its own.
 */
export interface AuthProvider {
    readonly store: AuthStore;
    /** Null for anonymous or invalid credentials. */
    identify(req: Request, url: URL): Promise<Principal | null>;
    login(
        username: string,
        password: string,
        clientKey: string,
        secure?: boolean
    ): Promise<
        | { ok: true; cookie: string }
        | { ok: false; status: 401 | 403 | 429; error: string; retryAfter?: number }
    >;
    /** The `Set-Cookie` value that signs the request's session out. */
    logout(req: Request, secure?: boolean): Promise<string>;
    issueToken(projectId: string, name: string, options?: IssueTokenOptions): Promise<IssuedToken>;
    listTokens(): Promise<TokenRecord[]>;
    revokeToken(id: string): Promise<boolean>;
}

/** Who a request is on a server without logins (`notato dev` on loopback): the person at this machine. */
export const LOCAL_PRINCIPAL: Principal = { kind: "admin", username: "local" };

/** How every project token starts, so a leaked one is easy to search for. */
export const TOKEN_PREFIX = "notato_";
/** How project tokens made by earlier versions start. They still work: a token is checked by its hash, not its prefix. */
const OLD_TOKEN_PREFIX = "pft_";

/** A token, note or bundle for a project this server does not have. */
export class UnknownProjectError extends Error {
    constructor(readonly projectId: string) {
        super(
            `project "${projectId}" does not exist on this server: create it first on the board (Projects) or with \`notato project create ${projectId}\``
        );
    }
}
export const SESSION_COOKIE = "notato_session";
const DAY = 24 * 60 * 60 * 1000;

export interface IssueTokenOptions {
    developmentContextId?: string;
    captureWorkId?: string;
    purpose?: "app" | "agent";
    permission?: "capture" | "full";
    expiresInDays?: number;
    createdBy?: string;
}

export interface IssuedToken {
    record: TokenRecord;
    /** The only time the plaintext exists outside the person it was handed to. */
    token: string;
}

/**
 * Admins and `*` tokens see everything; any other token only its own project; a member the projects they were
 * given. `*` asks for a stream across every project the credential has, and access to each is checked separately.
 */
export function canAccessProject(principal: Principal, projectId: string): boolean {
    if (principal.kind === "admin") return true;
    if (principal.locked) return false;
    if (principal.kind === "member")
        return projectId === "*" || principal.projectIds.includes(projectId);
    if (principal.projectIds && projectId !== "*") return principal.projectIds.includes(projectId);
    return principal.projectId === "*" || principal.projectId === projectId;
}

/** The projects a credential reaches, or undefined for all of them. An empty list is no project at all. */
export function accessibleProjects(principal: Principal): string[] | undefined {
    if (principal.kind === "admin") return undefined;
    if (principal.locked) return [];
    if (principal.kind === "member") return principal.projectIds;
    return (
        principal.projectIds ?? (principal.projectId === "*" ? undefined : [principal.projectId])
    );
}

/** Whether two requests are the same credential in the same scope, so a stream or session may carry on. */
export function samePrincipal(a: Principal, b: Principal): boolean {
    if (a.kind !== b.kind || a.scope !== b.scope) return false;
    if (a.kind === "token") return a.tokenId === (b as typeof a).tokenId;
    return a.username === (b as typeof a).username;
}

export function isAdmin(principal: Principal): boolean {
    return principal.kind === "admin";
}

/** 256 bits from the platform CSPRNG, base64url, with a prefix that makes leaked tokens greppable. */
export function generateSecret(prefix = ""): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return `${prefix}${Buffer.from(bytes).toString("base64url")}`;
}

/** Failed logins per client, so a password cannot be guessed at line speed. */
export class LoginLimiter {
    private failures = new Map<string, { count: number; first: number; blockedUntil: number }>();

    constructor(
        private max = 8,
        private windowMs = 10 * 60 * 1000,
        private now: () => number = Date.now
    ) {}

    /** Seconds the caller must wait, or 0 if it may try. */
    retryAfter(key: string): number {
        const entry = this.failures.get(key);
        if (!entry) return 0;
        const now = this.now();
        if (entry.blockedUntil > now) return Math.ceil((entry.blockedUntil - now) / 1000);
        if (now - entry.first > this.windowMs) this.failures.delete(key);
        return 0;
    }

    fail(key: string) {
        const now = this.now();
        const entry = this.failures.get(key);
        if (!entry || now - entry.first > this.windowMs) {
            if (this.failures.size >= MAX_TRACKED) this.prune(now);
            this.failures.set(key, { count: 1, first: now, blockedUntil: 0 });
            return;
        }
        entry.count += 1;
        if (entry.count >= this.max) entry.blockedUntil = now + this.windowMs;
    }

    succeed(key: string) {
        this.failures.delete(key);
    }

    /** Forgets finished windows, and then the oldest entries, so a flood of addresses cannot grow the map without end. */
    private prune(now: number) {
        for (const [key, entry] of this.failures) {
            if (now - entry.first > this.windowMs && entry.blockedUntil <= now)
                this.failures.delete(key);
        }
        for (const key of this.failures.keys()) {
            if (this.failures.size < MAX_TRACKED) break;
            this.failures.delete(key);
        }
    }
}

/** How many clients' failed logins are remembered at once. */
const MAX_TRACKED = 10_000;

/** How many tokens' last use is remembered at once, so it is written down once a minute each. */
const MAX_TOUCHED = 10_000;

export interface AuthenticatorOptions {
    sessionTtlMs?: number;
    limiter?: LoginLimiter;
    now?: () => Date;
    /**
     * The session cookie's name. Default: `notato_session`. A name that starts with `__Host-` is always sent `Secure`,
     * as browsers require of one, and so stays with this host.
     */
    cookieName?: string;
    /**
     * Whether a GET may carry its token as `?token=`, for an EventSource, which cannot set headers. Default: it may.
     * Turn it off where a token should never be part of a URL (and so of a proxy's logs).
     */
    queryTokens?: boolean;
}

/** A session a sign-in starts, beyond whose it is and when it begins and ends. */
export interface NewSession {
    /** How long it lasts. Default: the authenticator's `sessionTtlMs`. */
    ttlMs?: number;
    /** Kept in the session's record beside its id, owner and times, for accounts that keep more about one. */
    fields?: Record<string, unknown>;
}

/**
 * The built-in accounts: an admin login and project tokens, kept in an `AuthStore`. Accounts that are more than that
 * can extend it rather than start again: the protected methods are where a subclass says who a token or a session is,
 * who may sign in with a password, what a session holds and how one ends, while this keeps how credentials are read,
 * checked, rate-limited, minted and stored.
 */
export class Authenticator implements AuthProvider {
    protected readonly ttl: number;
    protected readonly limiter: LoginLimiter;
    protected readonly now: () => Date;
    /** The name of the cookie a session is carried in. */
    protected readonly cookieName: string;
    private readonly queryTokens: boolean;
    /** Verified against when the user is unknown, so response time does not reveal which names exist. */
    private dummyHash: Promise<string>;
    /** When each token's use was last written down. */
    private readonly touched = new Map<string, number>();

    constructor(
        readonly store: AuthStore,
        options: AuthenticatorOptions = {}
    ) {
        this.ttl = options.sessionTtlMs ?? 7 * DAY;
        this.limiter = options.limiter ?? new LoginLimiter();
        this.now = options.now ?? (() => new Date());
        this.cookieName = options.cookieName ?? SESSION_COOKIE;
        this.queryTokens = options.queryTokens ?? true;
        this.dummyHash = Bun.password.hash(generateSecret(), { algorithm: "argon2id" });
    }

    // ---- identifying requests -------------------------------------------------------------------------

    /**
     * Bearer token, `X-Notato-Token`, or (for GET only, because EventSource cannot set headers) `?token=`;
     * otherwise the session cookie. Returns null for anonymous or invalid credentials.
     */
    async identify(req: Request, url: URL): Promise<Principal | null> {
        const presented =
            /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ??
            req.headers.get("x-notato-token") ??
            (this.queryTokens && req.method === "GET" ? url.searchParams.get("token") : null);
        if (presented) return this.identifyToken(presented);

        const session = await this.sessionId(req);
        return session ? this.identifySession(session) : null;
    }

    private async identifyToken(token: string): Promise<Principal | null> {
        if (!token.startsWith(TOKEN_PREFIX) && !token.startsWith(OLD_TOKEN_PREFIX)) return null;
        const record = await this.store.findToken(await sha256Hex(new TextEncoder().encode(token)));
        if (!record || record.revokedAt) return null;
        if (record.expiresAt && record.expiresAt <= this.now().toISOString()) return null;
        const principal = await this.tokenPrincipal(record);
        if (principal) this.touch(record.id);
        return principal;
    }

    /**
     * Who a token is, once it is known to be one this server issued that is neither revoked nor expired; null refuses
     * it. The built-in: the token as it was issued.
     */
    protected async tokenPrincipal(record: TokenRecord): Promise<Principal | null> {
        if (record.developmentContextId) {
            const context = await (
                this.store as AuthStore & { coordination?: import("./team.ts").CoordinationStore }
            ).coordination?.get(record.developmentContextId);
            if (
                !context ||
                !("owner" in context) ||
                context.archived ||
                context.projectId !== record.projectId
            )
                return null;
        }
        return {
            kind: "token",
            tokenId: record.id,
            developmentContextId: record.developmentContextId,
            captureWorkId: record.captureWorkId,
            projectId: record.projectId,
            ...(record.permission ? { permission: record.permission } : {}),
            ...(record.purpose ? { purpose: record.purpose } : {}),
        };
    }

    /**
     * Writes down that a token was used, once a minute at most: an SDK paging through a project would otherwise write to
     * the database on every page. It is for the admin's benefit, so a failure to record it never fails the request, and
     * only so many tokens are remembered, so a flood of them cannot grow the record without end.
     */
    private touch(id: string): void {
        const now = this.now();
        if (now.getTime() - (this.touched.get(id) ?? 0) < 60_000) return;
        if (this.touched.size >= MAX_TOUCHED) {
            for (const [key, last] of this.touched)
                if (now.getTime() - last > 60_000) this.touched.delete(key);
            const oldest = this.touched.keys().next().value;
            if (this.touched.size >= MAX_TOUCHED && oldest !== undefined)
                this.touched.delete(oldest);
        }
        this.touched.set(id, now.getTime());
        void this.store.touchToken(id, now.toISOString()).catch(() => {});
    }

    private async identifySession(id: string): Promise<Principal | null> {
        const session = await this.store.getSession(id);
        if (!session) return null;
        if (session.expiresAt <= this.now().toISOString()) {
            await this.store.deleteSession(id);
            return null;
        }
        return this.sessionPrincipal(session);
    }

    /**
     * Who a session is, once it is known to be stored and unexpired; null refuses it. The built-in: the admin it was
     * started for, as only the admin signs in.
     */
    protected async sessionPrincipal(session: SessionRecord): Promise<Principal | null> {
        return { kind: "admin", username: session.username };
    }

    /** The id the request's session is stored under (the hash of its cookie), or undefined when it has none. */
    async sessionId(req: Request): Promise<string | undefined> {
        const value = this.cookieValue(req);
        return value ? sha256Hex(new TextEncoder().encode(value)) : undefined;
    }

    private cookieValue(req: Request): string | null {
        for (const part of (req.headers.get("cookie") ?? "").split(";")) {
            const [name, ...rest] = part.trim().split("=");
            if (name === this.cookieName) return rest.join("=") || null;
        }
        return null;
    }

    // ---- sessions -------------------------------------------------------------------------------------

    async login(
        username: string,
        password: string,
        clientKey: string,
        /** The request arrived over HTTPS (directly or via a trusted proxy), so the cookie can be `Secure`. */
        secure = false
    ): Promise<
        | { ok: true; cookie: string }
        | { ok: false; status: 401 | 403 | 429; error: string; retryAfter?: number }
    > {
        const wait = this.limiter.retryAfter(clientKey);
        if (wait > 0)
            return {
                ok: false,
                status: 429,
                error: "too many failed attempts; try again later",
                retryAfter: wait,
            };

        const user = await this.store.getUser(username);
        const refused = await this.passwordRefusal(user);
        if (refused) return { ok: false, status: 403, error: refused };
        const valid = await Bun.password
            .verify(password, user?.passwordHash ?? (await this.dummyHash))
            .catch(() => false);
        if (!user || !valid) {
            this.limiter.fail(clientKey);
            return { ok: false, status: 401, error: "wrong username or password" };
        }
        this.limiter.succeed(clientKey);

        const session = await this.newSession(user);
        if (typeof session === "string") return { ok: false, status: 403, error: session };
        return { ok: true, cookie: await this.startSession(user.username, secure, session) };
    }

    /**
     * Why a password sign-in is refused before the password is checked (answered 403), or null to check it: for
     * accounts that sign in some other way. `user` is null for a name nobody has. The built-in refuses none.
     */
    protected async passwordRefusal(_user: UserRecord | null): Promise<string | null> {
        return null;
    }

    /**
     * The session a right password starts, or why none is (answered 403): an account that may not use the board, say.
     * The built-in: one that lasts `sessionTtlMs` and holds nothing more.
     */
    protected async newSession(_user: UserRecord): Promise<NewSession | string> {
        return {};
    }

    /** Stores a new session for `username`, and returns the `Set-Cookie` value that carries it. */
    protected async startSession(
        username: string,
        secure: boolean,
        session: NewSession = {}
    ): Promise<string> {
        const ttl = session.ttlMs ?? this.ttl;
        const value = generateSecret();
        const now = this.now();
        await this.store.purgeSessions(now.toISOString());
        await this.store.createSession({
            ...session.fields,
            id: await sha256Hex(new TextEncoder().encode(value)),
            username,
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + ttl).toISOString(),
        });
        return this.cookie(value, Math.floor(ttl / 1000), secure);
    }

    async logout(req: Request, secure = false): Promise<string> {
        const id = await this.sessionId(req);
        if (id) await this.endSession(id);
        return this.cookie("", 0, secure);
    }

    /** Ends a stored session. A subclass that began something with it (a sign-in elsewhere, say) ends that too. */
    protected async endSession(id: string): Promise<void> {
        await this.store.deleteSession(id);
    }

    /** The `Set-Cookie` value for a session's cookie: `""` with a max age of 0 clears it. */
    protected cookie(value: string, maxAge: number, secure: boolean): string {
        return [
            `${this.cookieName}=${value}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            `Max-Age=${maxAge}`,
            ...(secure || this.cookieName.startsWith("__Host-") ? ["Secure"] : []),
        ].join("; ");
    }

    // ---- accounts and tokens --------------------------------------------------------------------------

    /**
     * Creates the admin, or updates the password when it changed. Returns a generated password when none
     * was supplied and the account is new, which the caller must show once.
     */
    async ensureAdmin(
        username: string,
        password?: string
    ): Promise<{ created: boolean; generatedPassword?: string }> {
        const existing = await this.store.getUser(username);
        if (existing) {
            if (password && !(await Bun.password.verify(password, existing.passwordHash))) {
                await this.store.upsertUser({
                    ...existing,
                    passwordHash: await Bun.password.hash(password, { algorithm: "argon2id" }),
                });
                // Whoever signed in with the old password is signed out.
                await this.store.deleteSessionsFor(username);
            }
            return { created: false };
        }
        const chosen = password ?? generateSecret().slice(0, 20);
        await this.addAdmin({
            username,
            passwordHash: await Bun.password.hash(chosen, { algorithm: "argon2id" }),
            createdAt: this.now().toISOString(),
        });
        return { created: true, ...(password ? {} : { generatedPassword: chosen }) };
    }

    /** Stores the admin account `ensureAdmin` creates. Accounts with more to them (a role, a team) add that here. */
    protected async addAdmin(user: UserRecord): Promise<void> {
        await this.store.upsertUser(user);
    }

    /**
     * Throws `UnknownProjectError` unless `projectId` is `*` or a project this server has. Without options a token
     * is an app token for one project, and an agent token for `*`.
     */
    async issueToken(
        projectId: string,
        name: string,
        options: IssueTokenOptions = {}
    ): Promise<IssuedToken> {
        if (projectId !== "*" && !(await this.store.getProject(projectId)))
            throw new UnknownProjectError(projectId);
        const permission = options.permission ?? "full";
        const purpose = tokenPurpose({
            purpose: options.purpose ?? (projectId === "*" ? "agent" : "app"),
            permission,
        });
        assertTokenPurpose({ purpose, permission, projectId });
        const days = options.expiresInDays;
        if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650))
            throw new Error("a token's lifetime is 1 to 3650 days");
        return this.mintToken({
            projectId,
            name,
            developmentContextId: options.developmentContextId,
            captureWorkId: options.captureWorkId,
            permission,
            purpose,
            ...(options.createdBy ? { createdBy: options.createdBy } : {}),
            ...(days
                ? { expiresAt: new Date(this.now().getTime() + days * DAY).toISOString() }
                : {}),
        });
    }

    /**
     * Makes a token and stores its record, with an id, the time and the token's hash: the token itself exists only in
     * what this returns. The one place a token comes into being, for a subclass that decides what else one holds.
     */
    protected async mintToken(
        fields: Omit<TokenRecord, "id" | "tokenHash" | "createdAt">
    ): Promise<IssuedToken> {
        const token = generateSecret(TOKEN_PREFIX);
        // What the server makes comes last, so nothing a subclass passes can stand in for it.
        const record: TokenRecord = {
            ...fields,
            id: ulid(),
            tokenHash: await sha256Hex(new TextEncoder().encode(token)),
            createdAt: this.now().toISOString(),
        };
        await this.store.createToken(record);
        return { record, token };
    }

    listTokens() {
        return this.store.listTokens();
    }

    revokeToken(id: string) {
        return this.store.revokeToken(id, this.now().toISOString());
    }
}
