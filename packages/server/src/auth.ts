import { ulid } from "ulid";
import { sha256Hex } from "./blob-store.ts";
import type { AuthStore, TokenRecord } from "./storage.ts";

/**
 * Who a request is from. An admin session can do everything; a token can read and write the one project
 * it was issued for, or every project when issued for `*` (an agent or MCP connection).
 */
export type Principal =
    | { kind: "admin"; username: string }
    | { kind: "token"; tokenId: string; projectId: string | "*" };

export const TOKEN_PREFIX = "pft_";

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

export interface IssuedToken {
    record: TokenRecord;
    /** The only time the plaintext exists outside the person it was handed to. */
    token: string;
}

/** Admins and `*` tokens see everything; any other token only its own project. */
export function canAccessProject(principal: Principal, projectId: string): boolean {
    if (principal.kind === "admin") return true;
    return principal.projectId === "*" || principal.projectId === projectId;
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

export class Authenticator {
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
        if (!token.startsWith(TOKEN_PREFIX)) return null;
        const record = await this.store.findToken(await sha256Hex(new TextEncoder().encode(token)));
        if (!record || record.revokedAt) return null;
        // Recording use is for the admin's benefit; a failure to record must never fail the request. Once a minute is
        // plenty: an SDK paging through a project would otherwise write to the database on every page.
        const now = this.now();
        if (now.getTime() - (this.touched.get(record.id) ?? 0) >= 60_000) {
            this.touched.set(record.id, now.getTime());
            void this.store.touchToken(record.id, now.toISOString()).catch(() => {});
        }
        return { kind: "token", tokenId: record.id, projectId: record.projectId };
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

    /** Throws `UnknownProjectError` unless `projectId` is `*` or a project this server has. */
    async issueToken(projectId: string, name: string): Promise<IssuedToken> {
        if (projectId !== "*" && !(await this.store.getProject(projectId)))
            throw new UnknownProjectError(projectId);
        const token = generateSecret(TOKEN_PREFIX);
        const record: TokenRecord = {
            id: ulid(),
            projectId,
            name,
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
