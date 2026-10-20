import {
    assertBoard,
    json as baseJson,
    generateSecret,
    isSecure,
    RequestError,
    sha256Hex,
} from "@notato/server";
import { ulid } from "ulid";
import { z } from "zod";
import { BETA_TOKEN, BetaLimiter, betaAdmin, betaCookie, invitationCookie } from "../beta.ts";
import type { CloudRoutes } from "../context.ts";
import { clientAddress } from "../hosted-guard.ts";

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    baseJson(value, status, { "Cache-Control": "no-store", ...headers });
const hash = (token: string) => sha256Hex(new TextEncoder().encode(token));
/** These public forms read at most 8 KiB, even for chunked requests; validation errors never echo submitted data. */
async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
    const reader = req.body?.getReader();
    if (!reader) throw new RequestError("A request body is required", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.length;
            if (size > 8192) {
                await reader.cancel();
                throw new RequestError("Request is too large", 413);
            }
            chunks.push(item.value);
        }
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.length;
        }
        const checked = schema.safeParse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
        if (!checked.success)
            throw new RequestError("Check the submitted fields and try again", 400);
        return checked.data;
    } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError("Invalid request body", 400);
    } finally {
        reader.releaseLock();
    }
}
const RequestBody = z
    .object({
        email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
        sdk: z.string().trim().max(80).default(""),
        useCase: z.string().trim().max(1200).default(""),
        website: z.string().max(300).default(""),
    })
    .strict();
const TokenBody = z.object({ token: z.string().regex(BETA_TOKEN) }).strict();

export function createBetaRoutes(): CloudRoutes<import("../auth.ts").Principal | null> {
    const limiter = new BetaLimiter();
    return async ({ req, path, method, info, principal, url }, { auth, options }) => {
        if (!path.startsWith("/beta/") || !options.beta || !auth) return null;
        const secure = isSecure(req, options.trustProxy);
        const store = auth.store;
        if (["/beta/waitlist", "/beta/invitation"].includes(path) && method === "POST") {
            assertBoard(req, "beta access");
            if (!limiter.allow(clientAddress(info.ip ?? "unknown")))
                return json({ error: "Too many requests. Please try again in a minute." }, 429, {
                    "Retry-After": "60",
                });
        }
        if (path === "/beta/status" && method === "GET") {
            const config = await store.betaSettings();
            const token = betaCookie(req, secure);
            const invitation =
                token && BETA_TOKEN.test(token)
                    ? await store.betaInvitation(await hash(token))
                    : null;
            return json({
                enabled: true,
                paused: config.paused,
                ...(invitation
                    ? { invitedEmail: invitation.email, expiresAt: invitation.expiresAt }
                    : {}),
            });
        }
        if (path === "/beta/waitlist" && method === "POST") {
            const input = await body(req, RequestBody);
            if (!input.website)
                await store.requestBeta({
                    id: ulid(),
                    email: input.email,
                    sdk: input.sdk,
                    useCase: input.useCase,
                    createdAt: new Date().toISOString(),
                });
            return json(
                {
                    message:
                        "Thanks for your interest. We'll contact you when a beta place is available.",
                },
                202
            );
        }
        if (path === "/beta/invitation" && method === "POST") {
            const { token } = await body(req, TokenBody);
            const invitation = await store.betaInvitation(await hash(token));
            if (!invitation)
                return json(
                    {
                        error: "This invitation has expired or is no longer available. Request another invitation from the service owner.",
                    },
                    403
                );
            return json({ email: invitation.email, expiresAt: invitation.expiresAt }, 200, {
                "Set-Cookie": invitationCookie(
                    token,
                    secure,
                    (Date.parse(invitation.expiresAt ?? "") - Date.now()) / 1000
                ),
            });
        }
        if (!path.startsWith("/beta/admin")) return null;
        if (
            principal?.kind !== "member" ||
            (!principal.instanceAdmin && !betaAdmin(options.beta, principal.email))
        )
            throw new RequestError("Beta administrator access required", 403);
        if (method !== "GET") assertBoard(req, "beta administration");
        if (path === "/beta/admin" && method === "GET")
            return json({
                ...(await store.betaOverview()),
                cloudWaitlist: Boolean(options.remoteWaitlist),
            });
        if (path === "/beta/admin/sync" && method === "POST") {
            if (!options.remoteWaitlist)
                throw new RequestError("Cloud waitlist is not configured", 404);
            return json({ checked: await options.remoteWaitlist.import(store) });
        }
        if (path === "/beta/admin" && method === "PATCH") {
            const config = await body(
                req,
                z
                    .object({ paused: z.boolean(), maxUsers: z.number().int().min(1).max(1000) })
                    .strict()
            );
            return json(await store.configureBeta(config));
        }
        if (path === "/beta/admin/requests" && method === "GET") {
            const query = z
                .object({
                    state: z.enum(["pending", "invited", "active", "revoked"]).optional(),
                    cursor: z
                        .string()
                        .regex(/^[A-Z0-9]{26}$/)
                        .optional(),
                })
                .safeParse(Object.fromEntries(url.searchParams));
            if (!query.success) throw new RequestError("Invalid filter", 400);
            return json(await store.listBetaRequests(query.data.state, query.data.cursor));
        }
        const action = /^\/beta\/admin\/requests\/([A-Z0-9]{26})\/(invite|revoke)$/.exec(path);
        if (action && method === "POST") {
            const id = action[1] as string;
            const target = await store.getBetaRequest(id);
            if (!target) throw new RequestError("Request not found", 404);
            if (betaAdmin(options.beta, target.email))
                throw new RequestError(
                    "Beta administrators already have access and cannot be suspended here.",
                    403
                );
            if (action[2] === "revoke") {
                await store.revokeBeta(id);
                return json({ ok: true });
            }
            const { days } = await body(
                req,
                z.object({ days: z.number().int().min(1).max(14).default(7) }).strict()
            );
            const token = generateSecret("nbeta_");
            const invitation = await store.inviteBeta(
                id,
                principal.username,
                await hash(token),
                new Date(Date.now() + days * 86400_000).toISOString()
            );
            const link = new URL(options.publicOrigin ?? req.url);
            link.pathname = "/";
            link.search = "";
            link.hash = `/x/beta/invite/${token}`;
            const managed = auth.managed;
            if (
                managed &&
                "sendInvitation" in managed &&
                typeof managed.sendInvitation === "function"
            )
                await managed.sendInvitation(target.email, link.toString());
            return json({ invitation, url: link.toString() }, 201);
        }
        return null;
    };
}
