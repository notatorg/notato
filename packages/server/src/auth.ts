import { ulid } from "ulid";
import { sha256Hex } from "./blob-store.ts";
import { type AuthStore, assertTokenPurpose, type TokenRecord, tokenPurpose } from "./storage.ts";

/**
 * What an extension may add to a signed-in person or a token, so routes it supplies can read it back typed:
 * `declare module "@notato/server" { interface PrincipalExtras { workspaceId?: string } }`. The server itself
 * only ever compares `scope`.
 */
export interface PrincipalExtras {
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
          /** Valid, but suspended: nothing is reachable until it is lifted (an unpaid workspace, say). */
          locked?: boolean;
      } & PrincipalExtras)
    | ({
          kind: "token";
          tokenId: string;
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
        | { ok: false; status: 401 | 429; error: string; retryAfter?: number }
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

export interface AuthenticatorOptions {
    sessionTtlMs?: number;
    limiter?: LoginLimiter;
    now?: () => Date;
}

export class Authenticator implements AuthProvider {
    private readonly ttl: number;
    private readonly limiter: LoginLimiter;
    private readonly now: () => Date;
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
            (req.method === "GET" ? url.searchParams.get("token") : null);
        if (presented) return this.identifyToken(presented);

        const cookie = this.cookieValue(req);
        return cookie ? this.identifySession(cookie) : null;
    }

    private async identifyToken(token: string): Promise<Principal | null> {
        if (!token.startsWith(TOKEN_PREFIX) && !token.startsWith(OLD_TOKEN_PREFIX)) return null;
        const record = await this.store.findToken(await sha256Hex(new TextEncoder().encode(token)));
        if (!record || record.revokedAt) return null;
        if (record.expiresAt && record.expiresAt <= this.now().toISOString()) return null;
        // Recording use is for the admin's benefit; a failure to record must never fail the request. Once a minute is
        // plenty: an SDK paging through a project would otherwise write to the database on every page.
        const now = this.now();
        if (now.getTime() - (this.touched.get(record.id) ?? 0) >= 60_000) {
            this.touched.set(record.id, now.getTime());
            void this.store.touchToken(record.id, now.toISOString()).catch(() => {});
        }
        return {
            kind: "token",
            tokenId: record.id,
            projectId: record.projectId,
            ...(record.permission ? { permission: record.permission } : {}),
            ...(record.purpose ? { purpose: record.purpose } : {}),
        };
    }

    private async identifySession(cookie: string): Promise<Principal | null> {
        const id = await sha256Hex(new TextEncoder().encode(cookie));
        const session = await this.store.getSession(id);
        if (!session) return null;
        if (session.expiresAt <= this.now().toISOString()) {
            await this.store.deleteSession(id);
            return null;
        }
        return { kind: "admin", username: session.username };
    }

    private cookieValue(req: Request): string | null {
        for (const part of (req.headers.get("cookie") ?? "").split(";")) {
            const [name, ...rest] = part.trim().split("=");
            if (name === SESSION_COOKIE) return rest.join("=") || null;
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
        | { ok: false; status: 401 | 429; error: string; retryAfter?: number }
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
        const valid = await Bun.password
            .verify(password, user?.passwordHash ?? (await this.dummyHash))
            .catch(() => false);
        if (!user || !valid) {
            this.limiter.fail(clientKey);
            return { ok: false, status: 401, error: "wrong username or password" };
        }
        this.limiter.succeed(clientKey);

        const value = generateSecret();
        const now = this.now();
        await this.store.purgeSessions(now.toISOString());
        await this.store.createSession({
            id: await sha256Hex(new TextEncoder().encode(value)),
            username: user.username,
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + this.ttl).toISOString(),
        });
        return { ok: true, cookie: this.cookie(value, Math.floor(this.ttl / 1000), secure) };
    }

    async logout(req: Request, secure = false): Promise<string> {
        const value = this.cookieValue(req);
        if (value) await this.store.deleteSession(await sha256Hex(new TextEncoder().encode(value)));
        return this.cookie("", 0, secure);
    }

    private cookie(value: string, maxAge: number, secure: boolean): string {
        return [
            `${SESSION_COOKIE}=${value}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            `Max-Age=${maxAge}`,
            ...(secure ? ["Secure"] : []),
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
        await this.store.upsertUser({
            username,
            passwordHash: await Bun.password.hash(chosen, { algorithm: "argon2id" }),
            createdAt: this.now().toISOString(),
        });
        return { created: true, ...(password ? {} : { generatedPassword: chosen }) };
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
        const token = generateSecret(TOKEN_PREFIX);
        const record: TokenRecord = {
            id: ulid(),
            projectId,
            name,
            tokenHash: await sha256Hex(new TextEncoder().encode(token)),
            createdAt: this.now().toISOString(),
            permission,
            purpose,
            ...(options.createdBy ? { createdBy: options.createdBy } : {}),
            ...(days
                ? { expiresAt: new Date(this.now().getTime() + days * DAY).toISOString() }
                : {}),
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
