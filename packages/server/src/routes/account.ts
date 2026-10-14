import { z } from "zod";
import { type Principal, UnknownProjectError } from "../auth.ts";
import { RequestError } from "../backend.ts";
import { PROJECT_ID, type TokenRecord } from "../storage.ts";
import {
    assertAdmin,
    assertBoard,
    isSecure,
    json,
    noContent,
    notFound,
    type Routes,
    readJson,
} from "./common.ts";

const LoginBody = z.object({
    username: z.string().min(1).max(200),
    password: z.string().min(1).max(1000),
});

const TokenBody = z.object({
    projectId: z.union([z.literal("*"), z.string().regex(PROJECT_ID)]),
    name: z.string().trim().min(1).max(100),
    purpose: z.enum(["app", "agent"]).optional(),
    permission: z.enum(["capture", "full"]).optional(),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
});

/** A token record as it is shown: everything but the hash of the token. */
export const shownToken = ({ tokenHash: _hash, ...record }: TokenRecord) => record;

/**
 * Who am I, signing in and out, and the admin's API tokens. `/auth/me` and the login are open to anyone; the rest
 * exists only on a server with logins.
 */
export const accountRoutes: Routes<Principal | null> = async (
    { req, path, method, principal, info, match },
    { auth, options }
) => {
    if (path === "/auth/me" && method === "GET") {
        return json({
            mode: options.mode,
            authRequired: Boolean(auth),
            authenticated: Boolean(principal),
            ...(principal?.kind === "admin" || principal?.kind === "member"
                ? { username: principal.username }
                : {}),
            ...(principal?.kind === "token" ? { projectId: principal.projectId } : {}),
        });
    }
    if (!auth) return null;

    if (path === "/auth/login" && method === "POST") {
        const { username, password } = await readJson(req, LoginBody);
        const result = await auth.login(
            username,
            password,
            info.ip ?? "unknown",
            isSecure(req, options.trustProxy)
        );
        if (!result.ok) {
            return json(
                { error: result.error },
                result.status,
                result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {}
            );
        }
        return json({ username }, 200, { "Set-Cookie": result.cookie });
    }
    if (path === "/auth/logout" && method === "POST") {
        return json({ ok: true }, 200, {
            "Set-Cookie": await auth.logout(req, isSecure(req, options.trustProxy)),
        });
    }

    // `/admin/tokens` is the older name: the board asks for `/tokens`, which a deployment with workspaces answers its own way.
    if (path === "/admin/tokens" || path === "/tokens") {
        assertAdmin(principal);
        if (method === "GET") return json({ items: (await auth.listTokens()).map(shownToken) });
        if (method === "POST") {
            assertBoard(req, "tokens");
            const { projectId, name, ...options } = await readJson(req, TokenBody);
            const issued = await auth
                .issueToken(projectId, name, {
                    ...options,
                    createdBy: principal?.kind === "admin" ? principal.username : undefined,
                })
                .catch((error) => {
                    if (error instanceof UnknownProjectError) throw error;
                    throw new RequestError(error instanceof Error ? error.message : "bad token");
                });
            return json({ token: issued.token, record: shownToken(issued.record) }, 201);
        }
    }
    const tokenOne = match(/^\/(?:admin\/)?tokens\/([^/]+)$/);
    if (tokenOne && method === "DELETE") {
        assertAdmin(principal);
        assertBoard(req, "tokens");
        return (await auth.revokeToken(tokenOne[0] ?? "")) ? noContent() : notFound();
    }
    return null;
};
