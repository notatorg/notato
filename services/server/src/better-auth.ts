import { createHash, randomBytes } from "node:crypto";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { admin, bearer, twoFactor } from "better-auth/plugins";
import type { Pool } from "pg";
import { z } from "zod";
import { betaCookie } from "./beta.ts";
import { databasePool } from "./database.ts";
import { type Mailer, mailerFromEnv } from "./mail.ts";
import {
    type ManagedAuth,
    type ManagedAuthConfig,
    signupPolicyFromEnv,
    type VerifiedIdentity,
} from "./managed-auth.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const displayName = z.string().trim().min(1).max(100);

/** Better Auth owns passwords, verification, reset links, two-factor challenges and browser sessions. */
export class InstanceAuth implements ManagedAuth {
    readonly config: ManagedAuthConfig;
    private readonly options;
    private service?: ReturnType<InstanceAuth["makeAuth"]>;
    private makeAuth() {
        return betterAuth(this.options);
    }
    get auth() {
        this.service ??= this.makeAuth();
        return this.service;
    }
    private initialized?: Promise<void>;
    private rootId = "";
    private readonly signup;

    constructor(
        private readonly pool: Pool,
        private readonly mail: Mailer,
        private readonly env: Record<string, string | undefined> = process.env
    ) {
        const origin = new URL(env.NOTATO_PUBLIC_URL ?? "http://localhost:4799");
        if (
            origin.username ||
            origin.password ||
            origin.search ||
            origin.hash ||
            origin.pathname !== "/" ||
            (origin.protocol !== "https:" &&
                !(
                    origin.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
                ))
        )
            throw new Error(
                "NOTATO_PUBLIC_URL must be an HTTPS origin (HTTP is supported on loopback)"
            );
        const secret = env.NOTATO_AUTH_SECRET;
        if (!secret || secret.length < 32)
            throw new Error("Set NOTATO_AUTH_SECRET to at least 32 random characters");
        this.signup = signupPolicyFromEnv(env);
        this.config = {
            provider: "better-auth",
            url: origin.origin,
            identityNamespace: "better-auth:instance",
            signupMode: this.signup.mode,
            requireMfa: false,
            operatorLogin: false,
        };
        this.options = {
            telemetry: { enabled: false },
            appName: "Notato",
            baseURL: origin.origin,
            basePath: "/api/auth",
            secret,
            database: pool,
            trustedOrigins: [origin.origin],
            user: { modelName: "notato_auth_user", deleteUser: { enabled: false } },
            session: {
                modelName: "notato_auth_session",
                expiresIn: 7 * 86400,
                cookieCache: { enabled: false },
            },
            account: { modelName: "notato_auth_account" },
            verification: { modelName: "notato_auth_verification" },
            emailAndPassword: {
                enabled: true,
                minPasswordLength: 12,
                maxPasswordLength: 256,
                requireEmailVerification: true,
                revokeSessionsOnPasswordReset: true,
                sendResetPassword: async ({ user, url }) =>
                    mail.send({
                        to: user.email,
                        subject: "Reset your Notato password",
                        text: `Set your password using this link:\n\n${url}\n\nIf you did not request this, ignore this message.`,
                    }),
            },
            emailVerification: {
                sendOnSignUp: true,
                sendOnSignIn: true,
                autoSignInAfterVerification: false,
                sendVerificationEmail: async ({ user, url }) =>
                    mail.send({
                        to: user.email,
                        subject: "Verify your Notato email",
                        text: `Verify your email address:\n\n${url}`,
                    }),
            },
            advanced: {
                useSecureCookies: origin.protocol === "https:",
                database: { generateId: () => crypto.randomUUID() },
            },
            rateLimit: { enabled: true, storage: "database", modelName: "notato_auth_rate_limit" },
            plugins: [
                admin(),
                bearer(),
                twoFactor({ issuer: "Notato", twoFactorTable: "notato_auth_two_factor" }),
            ],
            hooks: {
                before: createAuthMiddleware(async (context) => {
                    if (context.path === "/admin/remove-user")
                        throw new APIError("FORBIDDEN", {
                            message:
                                "Use account data controls to delete an account and its application data",
                        });
                    if (
                        ["/admin/remove-user", "/admin/ban-user", "/admin/set-role"].includes(
                            context.path
                        ) &&
                        context.body?.userId === this.rootId
                    )
                        throw new APIError("FORBIDDEN", {
                            message:
                                "The instance administrator cannot be deleted, suspended or demoted",
                        });
                    if (
                        context.path === "/sign-up/email" &&
                        !(await this.registrationAllowed(
                            String(context.body?.email ?? ""),
                            context.headers?.get("x-notato-invitation") ??
                                (context.request
                                    ? betaCookie(
                                          context.request,
                                          this.config.url.startsWith("https:")
                                      )
                                    : undefined)
                        ))
                    )
                        throw new APIError("FORBIDDEN", {
                            message:
                                "Registration is invitation-only. Contact the instance administrator.",
                        });
                }),
            },
            databaseHooks: {
                user: {
                    update: {
                        before: async (user) => {
                            if (user.name === undefined) return;
                            const parsed = displayName.safeParse(user.name);
                            if (!parsed.success)
                                throw new APIError("BAD_REQUEST", {
                                    message: "Display name must contain 1–100 characters",
                                });
                            return { data: { ...user, name: parsed.data } };
                        },
                    },
                    create: {
                        before: async (user, context) => {
                            if (context?.path === "/admin/create-user") return;
                            if (
                                await this.registrationAllowed(
                                    user.email,
                                    context?.headers?.get("x-notato-invitation") ??
                                        (context?.request
                                            ? betaCookie(
                                                  context.request,
                                                  this.config.url.startsWith("https:")
                                              )
                                            : undefined)
                                )
                            )
                                return;
                            throw new APIError("FORBIDDEN", {
                                message:
                                    "Registration is invitation-only. Contact the instance administrator.",
                            });
                        },
                    },
                },
            },
        } satisfies BetterAuthOptions;
    }

    private async registrationAllowed(email: string, token?: string | null): Promise<boolean> {
        if (this.env.NOTATO_BETA_ENABLED === "1") {
            const admins = (this.env.NOTATO_BETA_ADMIN_EMAILS ?? this.env.NOTATO_ADMIN_EMAIL ?? "")
                .split(",")
                .map((value) => value.trim().toLowerCase());
            if (admins.includes(email.toLowerCase())) return true;
            if (!token || !/^nbeta_[A-Za-z0-9_-]{43}$/.test(token)) return false;
            const result = await this.pool.query(
                "SELECT email FROM notato.beta_requests WHERE token_hash=$1 AND email=$2 AND state='invited' AND expires_at>$3 AND NOT (SELECT paused FROM notato.beta_settings WHERE id=TRUE)",
                [digest(token), email.toLowerCase(), new Date().toISOString()]
            );
            return Boolean(result.rowCount);
        }
        if (this.signup.allows(email)) return true;
        if (!token || !/^(?:[a-f0-9]{64}|ntinv_[A-Za-z0-9_-]{43})$/.test(token)) return false;
        if (token.startsWith("ntinv_")) {
            const invite = await this.pool.query(
                "SELECT email FROM notato.invitations WHERE token_hash=$1 AND email=$2 AND expires_at>$3 AND accepted_at IS NULL AND revoked_at IS NULL",
                [digest(token), email.toLowerCase(), new Date().toISOString()]
            );
            return Boolean(invite.rowCount);
        }
        const invite = await this.pool.query(
            "SELECT email FROM notato_instance_invitation WHERE token_hash=$1 AND email=$2 AND expires_at>now()",
            [digest(token), email.toLowerCase()]
        );
        return Boolean(invite.rowCount);
    }

    allowsSignup(email: string) {
        return this.signup.allows(email);
    }

    initialize(): Promise<void> {
        this.initialized ??= this.prepare();
        return this.initialized;
    }

    private async prepare() {
        const lock = await this.pool.connect();
        try {
            await lock.query("SELECT pg_advisory_lock(765092341)");
            await (await getMigrations(this.options)).runMigrations();
            await lock.query(
                `CREATE TABLE IF NOT EXISTS notato_instance (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id), root_user_id TEXT NOT NULL REFERENCES notato_auth_user(id) ON DELETE RESTRICT)`
            );
            await lock.query(
                `CREATE TABLE IF NOT EXISTS notato_instance_invitation (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`
            );
            const existing = await lock.query<{ root_user_id: string }>(
                "SELECT root_user_id FROM notato_instance WHERE id=TRUE"
            );
            if (existing.rows[0]) this.rootId = existing.rows[0].root_user_id;
            else {
                const email = this.env.NOTATO_ADMIN_EMAIL?.trim().toLowerCase();
                const password = this.env.NOTATO_ADMIN_PASSWORD;
                if (
                    !email ||
                    !z.email().safeParse(email).success ||
                    !password ||
                    password.length < 12 ||
                    password.length > 256
                )
                    throw new Error(
                        "First startup requires NOTATO_ADMIN_EMAIL and NOTATO_ADMIN_PASSWORD (12–256 characters)"
                    );
                const name = displayName.safeParse(
                    this.env.NOTATO_ADMIN_NAME ?? "Instance administrator"
                );
                if (!name.success)
                    throw new Error("NOTATO_ADMIN_NAME must contain 1–100 characters");
                // The lock serializes replicas. A transaction prevents a crash leaving an unprotected administrator.
                const id = crypto.randomUUID();
                const now = new Date();
                const passwordHash = await hashPassword(password);
                await lock.query("BEGIN");
                try {
                    await lock.query(
                        'INSERT INTO notato_auth_user (id,name,email,"emailVerified","createdAt","updatedAt",role,banned,"twoFactorEnabled") VALUES ($1,$2,$3,TRUE,$4,$4,\'admin\',FALSE,FALSE)',
                        [id, name.data, email, now]
                    );
                    await lock.query(
                        'INSERT INTO notato_auth_account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ($1,$2,\'credential\',$2,$3,$4,$4)',
                        [crypto.randomUUID(), id, passwordHash, now]
                    );
                    await lock.query(
                        "INSERT INTO notato_instance (id,root_user_id) VALUES (TRUE,$1)",
                        [id]
                    );
                    await lock.query("COMMIT");
                    this.rootId = id;
                } catch (error) {
                    await lock.query("ROLLBACK");
                    throw error;
                }
            }
            await lock.query(`CREATE OR REPLACE FUNCTION notato_protect_root() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                IF EXISTS (SELECT 1 FROM notato_instance WHERE root_user_id=OLD.id) AND (NEW.role IS DISTINCT FROM 'admin' OR NEW.banned=TRUE) THEN
                    RAISE EXCEPTION 'The instance administrator cannot be demoted or suspended';
                END IF; RETURN NEW; END $$`);
            await lock.query("DROP TRIGGER IF EXISTS notato_protect_root ON notato_auth_user");
            await lock.query(
                "CREATE TRIGGER notato_protect_root BEFORE UPDATE ON notato_auth_user FOR EACH ROW EXECUTE FUNCTION notato_protect_root()"
            );
        } finally {
            await lock.query("SELECT pg_advisory_unlock(765092341)").catch(() => {});
            lock.release();
        }
    }

    async handler(request: Request) {
        return this.auth.handler(request);
    }

    async verifyRequest(request: Request): Promise<VerifiedIdentity | null> {
        const result = await this.auth.api.getSession({
            headers: request.headers,
            query: { disableCookieCache: true },
        });
        if (!result?.user.emailVerified || result.user.banned) return null;
        return {
            provider: this.config.identityNamespace!,
            subject: result.user.id,
            email: result.user.email.toLowerCase(),
            displayName: result.user.name,
            expiresAt: new Date(result.session.expiresAt).toISOString(),
            issuedAt: new Date(result.session.createdAt).toISOString(),
            sessionId: result.session.id,
            assuranceLevel: result.user.twoFactorEnabled ? "aal2" : "aal1",
            instanceAdmin: result.user.role?.split(",").includes("admin") ?? false,
        };
    }
    verify(token: string) {
        return this.verifyRequest(
            new Request(`${this.config.url}/api/auth/get-session`, {
                headers: { Authorization: `Bearer ${token}` },
            })
        );
    }
    async activeUser(subject: string) {
        const result = await this.pool.query(
            "SELECT id FROM notato_auth_user WHERE id=$1 AND banned IS DISTINCT FROM TRUE",
            [subject]
        );
        return Boolean(result.rowCount);
    }
    async isProtectedUser(subject: string) {
        return subject === this.rootId;
    }
    private bootstrapPasswordChanged = false;
    async bootstrapPasswordInUse(email: string) {
        const password = this.env.NOTATO_ADMIN_PASSWORD;
        if (this.bootstrapPasswordChanged || !password || !this.rootId) return false;
        const root = await this.pool.query<{ email: string }>(
            "SELECT email FROM notato_auth_user WHERE id=$1",
            [this.rootId]
        );
        if (root.rows[0]?.email.toLowerCase() !== email.toLowerCase()) return false;
        if (await this.reauthenticate(this.rootId, password)) return true;
        // A password only ever moves away from the generated one, so this stays settled until a restart.
        this.bootstrapPasswordChanged = true;
        return false;
    }
    async reauthenticate(subject: string, password: string) {
        const result = await this.pool.query<{ password: string }>(
            'SELECT password FROM notato_auth_account WHERE "userId"=$1 AND "providerId"=\'credential\'',
            [subject]
        );
        const hash = result.rows[0]?.password;
        return Boolean(hash && (await verifyPassword({ hash, password }).catch(() => false)));
    }
    async revokeUserSessions(subject: string, keepId?: string) {
        await this.pool.query(
            'DELETE FROM notato_auth_session WHERE "userId"=$1 AND ($2::text IS NULL OR id!=$2)',
            [subject, keepId ?? null]
        );
    }
    async revokeIdentitySession(id: string) {
        await this.pool.query("DELETE FROM notato_auth_session WHERE id=$1", [id]);
    }
    async deleteUser(subject: string) {
        if (await this.isProtectedUser(subject))
            throw new Error("The instance administrator cannot be deleted");
        await this.pool.query("DELETE FROM notato_auth_user WHERE id=$1", [subject]);
    }
    async sendInvitation(email: string, url: string) {
        await this.mail.send({
            to: email,
            subject: "You’re invited to Notato",
            text: `Open your Notato invitation:\n\n${url}`,
        });
    }
    async invite(email: string) {
        const token = randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 7 * 86400_000);
        await this.pool.query(
            "INSERT INTO notato_instance_invitation (token_hash,email,expires_at) VALUES ($1,$2,$3)",
            [digest(token), email.toLowerCase(), expiresAt]
        );
        const url = new URL(this.config.url);
        url.searchParams.set("registration", token);
        url.searchParams.set("email", email);
        await this.mail.send({
            to: email,
            subject: "You’re invited to Notato",
            text: `Create your account on this Notato instance:\n\n${url}\n\nThis invitation expires in seven days.`,
        });
    }
    async close() {
        await this.pool.end();
    }
}

export function managedAuthFromEnv(): InstanceAuth {
    const url = process.env.NOTATO_DATABASE_URL;
    if (!url) throw new Error("Set NOTATO_DATABASE_URL for the self-hosted server");
    return new InstanceAuth(databasePool(url), mailerFromEnv());
}
