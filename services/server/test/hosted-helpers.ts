import { expect } from "bun:test";
import type { ManagedAuth, VerifiedIdentity } from "../src/managed-auth.ts";
import type { Server } from "./serve-helpers.ts";

const url = "https://notato.example.test";

export function fakeManagedAuth(): ManagedAuth {
    return {
        config: { provider: "better-auth", identityNamespace: "better-auth", url },
        async verify(token): Promise<VerifiedIdentity | null> {
            if (!["alice", "bob", "carol"].includes(token)) return null;
            return {
                provider: "better-auth",
                subject: token,
                email: `${token}@example.com`,
                displayName: token,
                expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            };
        },
    };
}

export async function customer(
    s: Server,
    accessToken: string,
    cookie?: string,
    revokeOtherSessions = false
) {
    const response = await s.call("/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ accessToken, revokeOtherSessions }),
    });
    expect(response.status).toBe(200);
    return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] as string, response };
}
