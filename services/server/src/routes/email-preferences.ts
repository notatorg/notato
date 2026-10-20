import { assertBoard, json as baseJson, RequestError, readJson } from "@notato/server";
import { z } from "zod";
import type { Principal } from "../auth.ts";
import type { CloudRoutes } from "../context.ts";
import {
    addressFingerprint,
    CURRENT_COPY_VERSION,
    EMAIL_COPY,
    readUnsubscribeToken,
    verifyProviderSignature,
} from "../email-preferences.ts";
import { boundedText } from "../http-body.ts";

const json = (value: unknown, status = 200) =>
    baseJson(value, status, { "Cache-Control": "no-store" });

const Choice = z
    .object({
        enabled: z.boolean(),
        expectedRevision: z.number().int().min(0).max(1_000_000),
        copyVersion: z.string().max(40),
        source: z.enum(["onboarding", "settings"]),
    })
    .strict();

const ProviderEvent = z.object({
    type: z.string().max(80),
    data: z
        .object({
            to: z.union([z.string().max(320), z.array(z.string().max(320)).max(50)]),
            bounce: z
                .object({ type: z.string().max(40).optional() })
                .partial()
                .optional(),
        })
        .passthrough(),
});

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

const htmlText = (text: string) =>
    text.replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c
    );

/** A plain page, with nothing to load: the unsubscribe link is opened from a mail client. */
function page(title: string, body: string, status = 200): Response {
    return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${htmlText(title)}</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px}button{font:inherit;padding:.6rem 1rem;border-radius:.4rem;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}</style></head><body><h1>${htmlText(title)}</h1>${body}</body></html>`,
        {
            status,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy":
                    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            },
        }
    );
}

const member = (principal: Principal | null) => (principal?.kind === "member" ? principal : null);

/**
 * A person's marketing-email choice, and the unsubscribe link in marketing mail. Both do nothing until an operator
 * sets `NOTATO_EMAIL_PREFERENCE_KEY`. The choice is recorded against the verified address of the signed-in account;
 * the unsubscribe link needs no sign-in and can only withdraw.
 */
export const emailPreferenceRoutes: CloudRoutes<Principal | null> = async (
    { req, url, path, method, principal },
    { backend, options }
) => {
    const settings = options.emailPreferences;
    if (path === "/account/email-preferences" && (method === "GET" || method === "PUT")) {
        const account = member(principal);
        if (!account) throw new RequestError("account sign-in required", 403);
        if (!settings || !account.email) return json({ available: false });
        const fingerprint = addressFingerprint(settings, account.email);
        if (method === "GET")
            return json({
                available: true,
                marketing: await backend.store.getMarketingPreference(
                    account.username,
                    fingerprint
                ),
                copy: { version: CURRENT_COPY_VERSION, ...EMAIL_COPY[CURRENT_COPY_VERSION] },
                privacyUrl: settings.privacyUrl,
                controller: settings.controller.name,
            });
        assertBoard(req, "email preferences");
        const choice = await readJson(req, Choice);
        if (choice.copyVersion !== CURRENT_COPY_VERSION)
            throw new RequestError("The wording changed. Reload to see it before choosing.", 409);
        return json({
            available: true,
            marketing: await backend.store.setMarketingPreference({
                username: account.username,
                fingerprint,
                enabled: choice.enabled,
                expectedRevision: choice.expectedRevision,
                source: choice.source,
                copyVersion: choice.copyVersion,
            }),
        });
    }

    if (path === "/account/email-preferences/export" && method === "GET") {
        const account = member(principal);
        if (!account) throw new RequestError("account sign-in required", 403);
        if (!settings || !account.email) return json({ available: false }, 404);
        const records = await backend.store.exportMarketingRecords(
            account.username,
            addressFingerprint(settings, account.email)
        );
        return new Response(
            JSON.stringify(
                {
                    exportedAt: new Date().toISOString(),
                    controller: settings.controller.name,
                    note: "Your marketing-email choice and the events that changed it. Your address is not stored in these records; it is matched by a keyed fingerprint.",
                    ...records,
                },
                null,
                2
            ),
            {
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Disposition": 'attachment; filename="notato-email-preferences.json"',
                    "Cache-Control": "no-store",
                },
            }
        );
    }

    if (path === "/email/provider-events" && method === "POST") {
        if (!settings?.providerWebhookSecret) return json({ error: "not found" }, 404);
        const raw = await boundedText(req, 65536);
        if (
            !verifyProviderSignature(settings.providerWebhookSecret, raw, {
                id: req.headers.get("svix-id"),
                timestamp: req.headers.get("svix-timestamp"),
                signature: req.headers.get("svix-signature"),
            })
        )
            return json({ error: "invalid signature" }, 401);
        const event = ProviderEvent.safeParse(safeJson(raw));
        if (!event.success) return json({ received: true });
        // Delivery events can only withdraw: a bounce (permanent only) or a spam complaint. They never grant consent.
        const reason =
            event.data.type === "email.complained"
                ? "complaint"
                : event.data.type === "email.bounced" &&
                    event.data.data.bounce?.type?.toLowerCase() === "permanent"
                  ? "hard_bounce"
                  : null;
        if (reason)
            for (const to of [event.data.data.to].flat().slice(0, 50))
                await backend.store.suppressEmail(
                    addressFingerprint(settings, to),
                    reason,
                    "provider"
                );
        return json({ received: true });
    }

    if (path === "/email/unsubscribe" && (method === "GET" || method === "POST")) {
        if (!settings) return page("Not found", "<p>This page is not available.</p>", 404);
        const fingerprint = readUnsubscribeToken(settings, url.searchParams.get("t") ?? "");
        if (!fingerprint)
            return page(
                "This link is not valid",
                "<p>Open the unsubscribe link from a recent Notato email, or sign in to change your email preferences.</p>",
                400
            );
        // Opening the link (or a mail scanner prefetching it) must not change anything: only a POST withdraws.
        if (method === "GET")
            return page(
                "Unsubscribe from Notato product emails?",
                `<p>You will stop receiving Notato product news, tips and offers. Account and security emails are not affected.</p><form method="post" action="/email/unsubscribe?t=${encodeURIComponent(url.searchParams.get("t") ?? "")}"><button type="submit">Unsubscribe</button></form>`
            );
        await backend.store.suppressEmail(fingerprint, "unsubscribe", "unsubscribe");
        return page(
            "You are unsubscribed",
            "<p>You will no longer receive Notato product news, tips and offers. You can turn them back on in your account settings.</p>"
        );
    }
    return null;
};
