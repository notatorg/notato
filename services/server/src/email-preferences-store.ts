import type { Operation, Statement } from "./lifecycle-store.ts";
import { DataControlError } from "./storage.ts";

const q = (sql: string, ...params: Statement["params"]): Statement => ({ sql, params });

export type PreferenceSource =
    | "onboarding"
    | "settings"
    | "unsubscribe"
    | "provider"
    | "deletion"
    | "restore";
export type SuppressionReason = "unsubscribe" | "complaint" | "hard_bounce" | "deletion";

/** A suppression only a person's fresh request can clear: complaints and bounces are the mailbox's own answer. */
const HARD: readonly SuppressionReason[] = ["complaint", "hard_bounce"];

/**
 * Private tables, separate from users, plans and the waitlist. A missing preference means the person has not chosen,
 * which is off. Addresses appear only as purpose-specific fingerprints (see email-preferences.ts).
 */
export const EMAIL_PREFERENCE_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS notato.communication_preferences (
        username TEXT NOT NULL REFERENCES notato.users(username) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK(channel IN ('email')), purpose TEXT NOT NULL CHECK(purpose IN ('marketing')),
        enabled BOOLEAN NOT NULL, address_fingerprint TEXT NOT NULL, copy_version TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1), updated_at TEXT NOT NULL,
        PRIMARY KEY(username,channel,purpose))`,
    `CREATE INDEX IF NOT EXISTS idx_communication_preferences_address ON notato.communication_preferences(address_fingerprint,purpose)`,
    `CREATE TABLE IF NOT EXISTS notato.communication_preference_events (
        id TEXT PRIMARY KEY, username TEXT REFERENCES notato.users(username) ON DELETE SET NULL,
        address_fingerprint TEXT NOT NULL, channel TEXT NOT NULL, purpose TEXT NOT NULL, enabled BOOLEAN NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('onboarding','settings','unsubscribe','provider','deletion','restore')),
        copy_version TEXT, revision INTEGER, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_communication_events_user ON notato.communication_preference_events(username,created_at)`,
    `CREATE TABLE IF NOT EXISTS notato.email_suppressions (
        address_fingerprint TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('marketing')),
        reason TEXT NOT NULL CHECK(reason IN ('unsubscribe','complaint','hard_bounce','deletion')),
        recorded_at TEXT NOT NULL, source_event_id TEXT, PRIMARY KEY(address_fingerprint,purpose))`,
];

export const EMAIL_PREFERENCE_TABLES = [
    "communication_preferences",
    "communication_preference_events",
    "email_suppressions",
];

export interface MarketingPreference {
    /** Whether marketing mail may be sent: an explicit, current opt-in for the verified address, not suppressed. */
    enabled: boolean;
    /** Whether the person has chosen for their current address, either way. */
    decided: boolean;
    /** Expected by the next update; 0 before any choice. */
    revision: number;
    copyVersion?: string;
    updatedAt?: string;
    /** Set while a complaint or bounce prevents a settings change from re-enabling mail to this address. */
    blocked?: "complaint" | "hard_bounce";
}

export function* preference(username: string, fingerprint: string): Operation<MarketingPreference> {
    const row = (yield q(
        "SELECT enabled,address_fingerprint,copy_version,revision,updated_at FROM notato.communication_preferences WHERE username=$1 AND channel='email' AND purpose='marketing'",
        username
    ))[0];
    const suppression = (yield q(
        "SELECT reason FROM notato.email_suppressions WHERE address_fingerprint=$1 AND purpose='marketing'",
        fingerprint
    ))[0];
    const reason = suppression ? (String(suppression.reason) as SuppressionReason) : undefined;
    const current = Boolean(row) && row?.address_fingerprint === fingerprint;
    return {
        enabled: current && Boolean(row?.enabled) && reason === undefined,
        decided: current,
        revision: row ? Number(row.revision) : 0,
        ...(row
            ? { copyVersion: String(row.copy_version), updatedAt: String(row.updated_at) }
            : {}),
        ...(reason && HARD.includes(reason)
            ? { blocked: reason as "complaint" | "hard_bounce" }
            : {}),
    };
}

/**
 * Saves a person's choice and its evidence together. Repeating the choice already in force is a no-op (and a stale
 * revision only fails when the choice would actually change something), so a retried request is safe.
 */
export function* setPreference(input: {
    username: string;
    fingerprint: string;
    enabled: boolean;
    expectedRevision: number;
    source: "onboarding" | "settings";
    copyVersion: string;
    eventId: string;
    at: string;
}): Operation<MarketingPreference> {
    // One writer per account; every preference change for it takes this turn.
    yield q("SELECT username FROM notato.users WHERE username=$1 FOR UPDATE", input.username);
    const now = yield* preference(input.username, input.fingerprint);
    if (now.decided && now.enabled === input.enabled) return now;
    const stored = now.revision;
    if (stored !== input.expectedRevision)
        throw new DataControlError(
            "Your email preference changed elsewhere. Reload and try again.",
            409
        );
    if (input.enabled) {
        if (now.blocked)
            throw new DataControlError(
                "This address cannot receive marketing email. Contact support if this is a mistake.",
                409
            );
        // A fresh, affirmative request replaces an earlier unsubscribe or deletion for this address.
        yield q(
            "DELETE FROM notato.email_suppressions WHERE address_fingerprint=$1 AND purpose='marketing' AND reason IN ('unsubscribe','deletion')",
            input.fingerprint
        );
    }
    const revision = stored + 1;
    yield q(
        `INSERT INTO notato.communication_preferences (username,channel,purpose,enabled,address_fingerprint,copy_version,revision,updated_at)
         VALUES ($1,'email','marketing',$2,$3,$4,$5,$6)
         ON CONFLICT(username,channel,purpose) DO UPDATE SET enabled=excluded.enabled,
            address_fingerprint=excluded.address_fingerprint, copy_version=excluded.copy_version,
            revision=excluded.revision, updated_at=excluded.updated_at`,
        input.username,
        input.enabled,
        input.fingerprint,
        input.copyVersion,
        revision,
        input.at
    );
    yield q(
        "INSERT INTO notato.communication_preference_events (id,username,address_fingerprint,channel,purpose,enabled,source,copy_version,revision,created_at) VALUES ($1,$2,$3,'email','marketing',$4,$5,$6,$7,$8)",
        input.eventId,
        input.username,
        input.fingerprint,
        input.enabled,
        input.source,
        input.copyVersion,
        revision,
        input.at
    );
    return yield* preference(input.username, input.fingerprint);
}

/**
 * Withdraws consent for an address and remembers that it did, without a sign-in. Provider events and unsubscribe
 * links use it; neither can grant consent. A complaint or bounce is never downgraded to a plain unsubscribe.
 */
export function* suppress(input: {
    fingerprint: string;
    reason: SuppressionReason;
    source: PreferenceSource;
    eventId: string;
    at: string;
}): Operation<{ changed: boolean }> {
    const accounts = yield q(
        "SELECT username,revision FROM notato.communication_preferences WHERE address_fingerprint=$1 AND channel='email' AND purpose='marketing' AND enabled ORDER BY username FOR UPDATE",
        input.fingerprint
    );
    let changed = false;
    let first = true;
    for (const account of accounts) {
        const revision = Number(account.revision) + 1;
        yield q(
            "UPDATE notato.communication_preferences SET enabled=FALSE,revision=$1,updated_at=$2 WHERE username=$3 AND channel='email' AND purpose='marketing'",
            revision,
            input.at,
            String(account.username)
        );
        yield q(
            "INSERT INTO notato.communication_preference_events (id,username,address_fingerprint,channel,purpose,enabled,source,revision,created_at) VALUES ($1,$2,$3,'email','marketing',FALSE,$4,$5,$6)",
            first ? input.eventId : `${input.eventId}:${String(account.username)}`,
            String(account.username),
            input.fingerprint,
            input.source,
            revision,
            input.at
        );
        first = false;
        changed = true;
    }
    const existing = (yield q(
        "SELECT reason FROM notato.email_suppressions WHERE address_fingerprint=$1 AND purpose='marketing'",
        input.fingerprint
    ))[0];
    const held = existing ? (String(existing.reason) as SuppressionReason) : undefined;
    // Never replace a complaint or bounce with a plain unsubscribe; a complaint may replace a bounce.
    const record =
        held === undefined ||
        (!HARD.includes(held) && held !== input.reason) ||
        (HARD.includes(held) && input.reason === "complaint" && held !== "complaint");
    if (record) {
        yield q(
            `INSERT INTO notato.email_suppressions (address_fingerprint,purpose,reason,recorded_at,source_event_id)
             VALUES ($1,'marketing',$2,$3,$4)
             ON CONFLICT(address_fingerprint,purpose) DO UPDATE SET reason=excluded.reason,
                recorded_at=excluded.recorded_at, source_event_id=excluded.source_event_id`,
            input.fingerprint,
            input.reason,
            input.at,
            input.eventId
        );
        changed = true;
    }
    if (changed && !accounts.length)
        // Nobody to attribute it to (an unsubscribe after the account is gone): keep the evidence anyway.
        yield q(
            "INSERT INTO notato.communication_preference_events (id,username,address_fingerprint,channel,purpose,enabled,source,created_at) VALUES ($1,NULL,$2,'email','marketing',FALSE,$3,$4)",
            input.eventId,
            input.fingerprint,
            input.source,
            input.at
        );
    return { changed };
}

/** Before an account is removed: stop marketing to its address and keep only the suppression. */
export function* onAccountDeleted(username: string, at: string): Operation<void> {
    const row = (yield q(
        "SELECT address_fingerprint,enabled,revision FROM notato.communication_preferences WHERE username=$1 AND channel='email' AND purpose='marketing' FOR UPDATE",
        username
    ))[0];
    if (!row || !row.enabled) return;
    const fingerprint = String(row.address_fingerprint);
    const eventId = `deletion:${username}:${at}`;
    yield q(
        "INSERT INTO notato.communication_preference_events (id,username,address_fingerprint,channel,purpose,enabled,source,revision,created_at) VALUES ($1,$2,$3,'email','marketing',FALSE,'deletion',$4,$5) ON CONFLICT(id) DO NOTHING",
        eventId,
        username,
        fingerprint,
        Number(row.revision) + 1,
        at
    );
    yield q(
        `INSERT INTO notato.email_suppressions (address_fingerprint,purpose,reason,recorded_at,source_event_id)
         VALUES ($1,'marketing','deletion',$2,$3) ON CONFLICT(address_fingerprint,purpose) DO NOTHING`,
        fingerprint,
        at,
        eventId
    );
}

const HOLD_KEY = "marketing_send_hold";

/** While held (for example after a restore, until later withdrawals are replayed) no marketing message may be sent. */
export function* sendHeld(): Operation<boolean> {
    return Boolean((yield q("SELECT 1 FROM notato.meta WHERE key=$1", HOLD_KEY))[0]);
}

export function* setSendHold(held: boolean): Operation<void> {
    if (held)
        yield q(
            "INSERT INTO notato.meta (key,value) VALUES ($1,'1') ON CONFLICT(key) DO NOTHING",
            HOLD_KEY
        );
    else yield q("DELETE FROM notato.meta WHERE key=$1", HOLD_KEY);
}

/** The last check before a marketing message is handed to a provider. */
export function* eligible(username: string, fingerprint: string): Operation<boolean> {
    if (yield* sendHeld()) return false;
    return (yield* preference(username, fingerprint)).enabled;
}

export interface MarketingRecords {
    preference: {
        enabled: boolean;
        decided: boolean;
        revision: number;
        copyVersion?: string;
        updatedAt?: string;
    };
    suppression?: { reason: SuppressionReason; recordedAt: string };
    events: Array<{
        at: string;
        enabled: boolean;
        source: PreferenceSource;
        copyVersion?: string;
        revision?: number;
    }>;
}

/** Everything held about one account's marketing choice, for the person it concerns (a subject access request). */
export function* records(username: string, fingerprint: string): Operation<MarketingRecords> {
    const current = yield* preference(username, fingerprint);
    const suppression = (yield q(
        "SELECT reason,recorded_at FROM notato.email_suppressions WHERE address_fingerprint=$1 AND purpose='marketing'",
        fingerprint
    ))[0];
    const events = yield q(
        "SELECT created_at,enabled,source,copy_version,revision FROM notato.communication_preference_events WHERE username=$1 AND channel='email' AND purpose='marketing' ORDER BY created_at,id",
        username
    );
    return {
        preference: {
            enabled: current.enabled,
            decided: current.decided,
            revision: current.revision,
            ...(current.copyVersion ? { copyVersion: current.copyVersion } : {}),
            ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
        },
        ...(suppression
            ? {
                  suppression: {
                      reason: String(suppression.reason) as SuppressionReason,
                      recordedAt: String(suppression.recorded_at),
                  },
              }
            : {}),
        events: events.map((e) => ({
            at: String(e.created_at),
            enabled: Boolean(e.enabled),
            source: String(e.source) as PreferenceSource,
            ...(e.copy_version ? { copyVersion: String(e.copy_version) } : {}),
            ...(e.revision != null ? { revision: Number(e.revision) } : {}),
        })),
    };
}

/**
 * Retention: evidence about a live account's choice is kept while the account exists. Once an account is gone, its
 * detached events and the suppressions that protect its address are kept only until the cutoff. Sending needs a
 * fresh explicit opt-in, so forgetting a suppression never subscribes anyone.
 */
export function* purge(cutoff: string): Operation<number> {
    const events = yield q(
        "DELETE FROM notato.communication_preference_events WHERE username IS NULL AND created_at < $1 RETURNING id",
        cutoff
    );
    const suppressions = yield q(
        "DELETE FROM notato.email_suppressions WHERE recorded_at < $1 RETURNING address_fingerprint",
        cutoff
    );
    return events.length + suppressions.length;
}
