import { z } from "zod";
import {
    type AuthProvider,
    type IssuedToken,
    isAdmin,
    type Principal,
    UnknownProjectError,
} from "../auth.ts";
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
    showToken,
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

/**
 * Who am I, signing in and out, and the API tokens. `/auth/me` and the login are open to anyone; the rest exists only
 * on a server with logins.
 */
export const accountRoutes: Routes<Principal | null> = async (
    { req, path, method, principal, info, match },
    app
) => {
    const { auth, options } = app;
    if (path === "/auth/me" && method === "GET") {
        return json({
            mode: options.mode,
            authRequired: Boolean(auth),
            authenticated: Boolean(principal),
            ...(principal?.kind === "admin" || principal?.kind === "member"
                ? { username: principal.username }
                : {}),
            ...(principal?.kind === "token" ? { projectId: principal.projectId } : {}),
            ...(await options.aboutCaller?.(principal, req)),
        });
    }
    if (!auth) return null;

    if (path === "/auth/login" && method === "POST") {
        // A service on the public internet is signed in to from its own board: no other page signs a visitor in or out.
        if (options.strictOrigins) assertBoard(req, "sign-in");
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
        if (options.strictOrigins) assertBoard(req, "sign-out");
        return json({ ok: true }, 200, {
            "Set-Cookie": await auth.logout(req, isSecure(req, options.trustProxy)),
        });
    }

    // `/admin/tokens` is the older name, and always an admin's; the board asks for `/tokens`, which `tokenRules` may
    // open to others.
    const rules = options.tokenRules;
    const assertManager = () =>
        path.startsWith("/admin/") || !rules?.assertManager
            ? assertAdmin(principal)
            : rules.assertManager(principal);
    const visible = (who: Principal, token: TokenRecord) =>
        rules?.visible ? rules.visible(who, token) : isAdmin(who);
    if (path === "/admin/tokens" || path === "/tokens") {
        assertManager();
        if (!principal) return null;
        if (method === "GET")
            return json({
                items: (await auth.listTokens())
                    .filter((token) => visible(principal, token))
                    .map((token) => showToken(app, token)),
            });
        if (method === "POST") {
            assertBoard(req, "tokens");
            const issued = rules?.issue
                ? await rules.issue(principal, req)
                : await issueAsked(req, principal, auth);
            return json({ token: issued.token, record: showToken(app, issued.record) }, 201);
        }
    }
    const tokenOne = match(/^\/(?:admin\/)?tokens\/([^/]+)$/);
    if (tokenOne && method === "DELETE") {
        assertManager();
        assertBoard(req, "tokens");
        if (!principal) return null;
        const id = tokenOne[0] ?? "";
        // Anyone but an admin revokes only what they can see: any other id is one that does not exist.
        if (!isAdmin(principal)) {
            const token = (await auth.listTokens()).find((token) => token.id === id);
            if (!token || !visible(principal, token)) return notFound();
        }
        return (await auth.revokeToken(id)) ? noContent() : notFound();
    }
    return null;
};

/** The token `POST /tokens` asks for, by the server's own rules. */
async function issueAsked(
    req: Request,
    principal: Principal,
    auth: AuthProvider
): Promise<IssuedToken> {
    const { projectId, name, ...options } = await readJson(req, TokenBody);
    return auth
        .issueToken(projectId, name, {
            ...options,
            createdBy: principal.kind === "admin" ? principal.username : undefined,
        })
        .catch((error) => {
            if (error instanceof UnknownProjectError) throw error;
            throw new RequestError(error instanceof Error ? error.message : "bad token");
        });
}
