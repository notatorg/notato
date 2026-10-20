import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What the person was shown when they chose, by version, so a stored choice can be reconstructed later. Add a new
 * entry (never edit one) when the wording changes, and point CURRENT_COPY_VERSION at it.
 */
export const EMAIL_COPY = {
    "2026-10-19": {
        label: "Email me Notato product news, tips and offers.",
        note: "Optional — unsubscribe at any time.",
    },
} as const;
export type CopyVersion = keyof typeof EMAIL_COPY;
export const CURRENT_COPY_VERSION: CopyVersion = "2026-10-19";

export interface EmailPreferenceOptions {
    /** The protected key fingerprints and unsubscribe links derive from. At least 32 characters; never logged. */
    key: string;
    /** The privacy notice shown beside the choice and linked from the board. */
    privacyUrl: string;
    /** The organisation that decides how this mail is used and sends it: named beside the choice and in every footer. */
    controller: { name: string; address?: string };
    /** Signing secret (`whsec_…`) for the email provider's bounce and complaint events. Without it they are refused. */
    providerWebhookSecret?: string;
    /** Days to keep detached evidence and suppressions after an account is gone. Default 1095 (three years). */
    evidenceRetentionDays?: number;
}

const derive = (key: string, purpose: string) => createHmac("sha256", key).update(purpose).digest();
const normalize = (email: string) => email.trim().toLowerCase();

/** A purpose-specific fingerprint of an address. It is still personal data, but not an unsalted email hash. */
export function addressFingerprint(options: EmailPreferenceOptions, email: string): string {
    return createHmac("sha256", derive(options.key, "fingerprint:email:marketing"))
        .update(normalize(email))
        .digest("base64url");
}

const mac = (options: EmailPreferenceOptions, fingerprint: string) =>
    createHmac("sha256", derive(options.key, "unsubscribe:email:marketing"))
        .update(fingerprint)
        .digest("base64url");

/** An unguessable, address- and purpose-bound link token for a marketing message's unsubscribe link. */
export function unsubscribeToken(options: EmailPreferenceOptions, email: string): string {
    const fingerprint = addressFingerprint(options, email);
    return `v1.${fingerprint}.${mac(options, fingerprint)}`;
}

/** The address fingerprint a token names, or null when it was not issued by this service's key. */
export function readUnsubscribeToken(
    options: EmailPreferenceOptions,
    token: string
): string | null {
    const [version, fingerprint, signature, ...rest] = token.split(".");
    if (version !== "v1" || !fingerprint || !signature || rest.length) return null;
    const expected = Buffer.from(mac(options, fingerprint));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given)
        ? fingerprint
        : null;
}

export function emailPreferenceOptions(
    env: Record<string, string | undefined>
): EmailPreferenceOptions | undefined {
    const key = env.NOTATO_EMAIL_PREFERENCE_KEY;
    if (!key) return undefined;
    if (key.length < 32)
        throw new Error("NOTATO_EMAIL_PREFERENCE_KEY must be at least 32 characters");
    const privacyUrl = env.NOTATO_PRIVACY_URL;
    if (!privacyUrl || new URL(privacyUrl).protocol !== "https:")
        throw new Error("NOTATO_PRIVACY_URL must be an HTTPS URL when marketing email is enabled");
    const name = env.NOTATO_MARKETING_CONTROLLER_NAME?.trim();
    if (!name)
        throw new Error(
            "NOTATO_MARKETING_CONTROLLER_NAME must name the sender when marketing email is enabled"
        );
    const address = env.NOTATO_MARKETING_CONTROLLER_ADDRESS?.trim();
    const secret = env.NOTATO_EMAIL_WEBHOOK_SECRET;
    if (secret && !/^whsec_[A-Za-z0-9+/=]{16,}$/.test(secret))
        throw new Error("NOTATO_EMAIL_WEBHOOK_SECRET must be the provider's whsec_ signing secret");
    const days = env.NOTATO_EMAIL_EVIDENCE_RETENTION_DAYS;
    if (days && !/^[1-9]\d{0,3}$/.test(days))
        throw new Error("NOTATO_EMAIL_EVIDENCE_RETENTION_DAYS must be a whole number of days");
    return {
        key,
        privacyUrl,
        controller: { name, ...(address ? { address } : {}) },
        ...(secret ? { providerWebhookSecret: secret } : {}),
        ...(days ? { evidenceRetentionDays: Number(days) } : {}),
    };
}

export const evidenceCutoff = (options: EmailPreferenceOptions, now = Date.now()) =>
    new Date(now - (options.evidenceRetentionDays ?? 1095) * 86_400_000).toISOString();

/**
 * What every marketing message must carry: a one-click unsubscribe header (RFC 8058), and a footer that names the
 * sender, gives a contact address and links the same unsubscribe page. A sender calls this per recipient, after
 * `marketingEligible` returns true; essential service mail never uses it.
 */
export function marketingMessage(
    options: EmailPreferenceOptions,
    email: string,
    publicOrigin: string
): { headers: Record<string, string>; footer: string } {
    if (!options.controller.address)
        throw new Error("set NOTATO_MARKETING_CONTROLLER_ADDRESS before sending marketing email");
    const link = `${new URL(publicOrigin).origin}/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(options, email))}`;
    return {
        headers: {
            "List-Unsubscribe": `<${link}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        footer: [
            "You are receiving this because you chose to hear from us about Notato product news, tips and offers.",
            `Unsubscribe: ${link}`,
            `${options.controller.name}, ${options.controller.address}`,
            `Privacy notice: ${options.privacyUrl}`,
        ].join("\n"),
    };
}

/**
 * Verifies a Svix-signed webhook (the scheme Resend uses): HMAC-SHA256 over `id.timestamp.body` with the secret's
 * decoded bytes, any listed `v1` signature may match, and deliveries more than five minutes off are refused.
 */
export function verifyProviderSignature(
    secret: string,
    body: string,
    headers: { id: string | null; timestamp: string | null; signature: string | null },
    now = Date.now()
): boolean {
    const { id, timestamp, signature } = headers;
    if (!id || !timestamp || !signature) return false;
    const sent = Number(timestamp);
    if (!Number.isFinite(sent) || Math.abs(now / 1000 - sent) > 300) return false;
    const expected = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
        .update(`${id}.${timestamp}.${body}`)
        .digest();
    return signature.split(" ").some((part) => {
        const [version, value] = part.split(",");
        if (version !== "v1" || !value) return false;
        const given = Buffer.from(value, "base64");
        return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
