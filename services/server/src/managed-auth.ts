import { z } from "zod";

export type SignupMode = "closed" | "allowlist" | "open";

/** This policy stays on the server. Only its mode may be sent to the board. */
export function signupPolicyFromEnv(env: Record<string, string | undefined> = process.env) {
    const mode = env.NOTATO_SIGNUP_MODE ?? "closed";
    if (!["closed", "allowlist", "open"].includes(mode))
        throw new Error("NOTATO_SIGNUP_MODE must be closed, allowlist or open");
    const value = env.NOTATO_SIGNUP_ALLOWED_EMAILS ?? "";
    if (value.length > 65536) throw new Error("signup allowlist is too large");
    const emails = value.trim() ? value.split(",").map((email) => email.trim().toLowerCase()) : [];
    if (emails.length > 1000 || emails.some((email) => !z.email().safeParse(email).success))
        throw new Error(
            "NOTATO_SIGNUP_ALLOWED_EMAILS must contain comma-separated email addresses"
        );
    const allowed = new Set(emails);
    return {
        mode: mode as SignupMode,
        allows: (email: string) =>
            mode === "open" || (mode === "allowlist" && allowed.has(email.trim().toLowerCase())),
    };
}

/** Browser configuration contains no credentials. Authentication is served on this instance. */
export interface ManagedAuthConfig {
    provider: "better-auth";
    url: string;
    requireMfa?: boolean;
    operatorLogin?: boolean;
    identityNamespace?: string;
    signupMode?: SignupMode;
}
export interface VerifiedIdentity {
    provider: string;
    subject: string;
    email: string;
    displayName: string;
    expiresAt: string;
    assuranceLevel?: "aal1" | "aal2";
    sessionId?: string;
    issuedAt?: string;
    instanceAdmin?: boolean;
}
export interface ManagedAuth {
    readonly config: ManagedAuthConfig;
    verify(accessToken: string): Promise<VerifiedIdentity | null>;
    verifyRequest?(request: Request): Promise<VerifiedIdentity | null>;
    initialize?(): Promise<void>;
    close?(): Promise<void>;
    handler?(request: Request): Promise<Response>;
    revokeUserSessions?(subject: string, keepId?: string): Promise<void>;
    revokeIdentitySession?(id: string): Promise<void>;
    reauthenticate?(subject: string, password: string): Promise<boolean>;
    activeUser?(subject: string): Promise<boolean>;
    isProtectedUser?(subject: string): Promise<boolean>;
    deleteUser?(subject: string): Promise<void>;
    allowsSignup?(email: string): boolean;
}
