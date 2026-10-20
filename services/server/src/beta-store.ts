import type { Operation, Statement } from "./lifecycle-store.ts";
import { DataControlError } from "./storage.ts";

const q = (sql: string, ...params: Statement["params"]): Statement => ({ sql, params });
export type BetaState = "pending" | "invited" | "active" | "revoked";
export interface BetaRequest {
    id: string;
    email: string;
    sdk: string;
    useCase: string;
    state: BetaState;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
    redeemedBy?: string;
}
export interface BetaSettings {
    paused: boolean;
    maxUsers: number;
}
export interface BetaOverview extends BetaSettings {
    pending: number;
    invited: number;
    active: number;
    revoked: number;
    users: number;
    workspaces: number;
    notes: number;
    bytes: number;
}
export const BETA_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS notato.beta_settings (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id), paused BOOLEAN NOT NULL DEFAULT TRUE, max_users INTEGER NOT NULL DEFAULT 10 CHECK(max_users BETWEEN 1 AND 1000))`,
    `INSERT INTO notato.beta_settings(id) VALUES(TRUE) ON CONFLICT(id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS notato.beta_requests (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,sdk TEXT NOT NULL,use_case TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','invited','active','revoked')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,token_hash TEXT UNIQUE,expires_at TEXT,approved_by TEXT REFERENCES notato.users(username) ON DELETE SET NULL,redeemed_by TEXT UNIQUE REFERENCES notato.users(username) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS idx_beta_requests_state ON notato.beta_requests(state,id)`,
];
const shown = (r: Record<string, unknown>): BetaRequest => ({
    id: String(r.id),
    email: String(r.email),
    sdk: String(r.sdk),
    useCase: String(r.use_case),
    state: r.state as BetaState,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    ...(r.expires_at ? { expiresAt: String(r.expires_at) } : {}),
    ...(r.redeemed_by ? { redeemedBy: String(r.redeemed_by) } : {}),
});
export function* settings(lock = false): Operation<BetaSettings> {
    const row = (yield q(
        `SELECT paused,max_users FROM notato.beta_settings WHERE id=TRUE${lock ? " FOR UPDATE" : ""}`
    ))[0];
    if (!row) throw new Error("beta settings unavailable");
    return { paused: Boolean(row.paused), maxUsers: Number(row.max_users) };
}
export function* request(r: Omit<BetaRequest, "state" | "updatedAt">): Operation<void> {
    yield* settings(true);
    const count = (yield q("SELECT count(*) AS n FROM notato.beta_requests"))[0];
    if (Number(count?.n) >= 5000)
        throw new DataControlError(
            "The waitlist is temporarily full. Please try again later.",
            503
        );
    // Repeated requests neither reveal an existing entry nor overwrite its details or admission state.
    yield q(
        "INSERT INTO notato.beta_requests(id,email,sdk,use_case,state,created_at,updated_at) VALUES($1,$2,$3,$4,'pending',$5,$5) ON CONFLICT(email) DO NOTHING",
        r.id,
        r.email,
        r.sdk,
        r.useCase,
        r.createdAt
    );
}
export function* get(id: string): Operation<BetaRequest | null> {
    const row = (yield q("SELECT * FROM notato.beta_requests WHERE id=$1", id))[0];
    return row ? shown(row) : null;
}
export function* list(
    state?: BetaState,
    cursor?: string
): Operation<{ items: BetaRequest[]; nextCursor?: string }> {
    const rows = yield q(
        "SELECT * FROM notato.beta_requests WHERE ($1::text IS NULL OR state=$1) AND ($2::text IS NULL OR id<$2) ORDER BY id DESC LIMIT 51",
        state ?? null,
        cursor ?? null
    );
    const items = rows.slice(0, 50).map(shown);
    return { items, ...(rows.length > 50 ? { nextCursor: items.at(-1)?.id } : {}) };
}
export function* overview(): Operation<BetaOverview> {
    const config = yield* settings();
    const rows = yield q("SELECT state,count(*) AS n FROM notato.beta_requests GROUP BY state");
    const count = (state: string) => Number(rows.find((r) => r.state === state)?.n ?? 0);
    const usage = (yield q(
        "SELECT (SELECT count(*) FROM notato.users WHERE NOT is_admin) AS users,(SELECT count(*) FROM notato.workspaces) AS workspaces,(SELECT count(*) FROM notato.annotations) AS notes,(SELECT coalesce(sum(octet_length(json)+asset_bytes),0) FROM notato.annotations) AS bytes"
    ))[0];
    return {
        ...config,
        pending: count("pending"),
        invited: count("invited"),
        active: count("active"),
        revoked: count("revoked"),
        users: Number(usage?.users),
        workspaces: Number(usage?.workspaces),
        notes: Number(usage?.notes),
        bytes: Number(usage?.bytes),
    };
}
function* occupied(now: string): Operation<number> {
    return Number(
        (yield q(
            "SELECT count(*) AS n FROM notato.beta_requests WHERE state='active' OR (state='invited' AND expires_at>$1)",
            now
        ))[0]?.n ?? 0
    );
}
export function* configure(config: BetaSettings, now: string): Operation<BetaSettings> {
    yield* settings(true);
    if (config.maxUsers < (yield* occupied(now)))
        throw new DataControlError(
            "Revoke unused invitations or access before reducing the beta places below current reservations."
        );
    yield q(
        "UPDATE notato.beta_settings SET paused=$1,max_users=$2 WHERE id=TRUE",
        config.paused,
        config.maxUsers
    );
    return config;
}
export function* invite(
    id: string,
    actor: string,
    hash: string,
    now: string,
    expires: string
): Operation<BetaRequest> {
    const config = yield* settings(true);
    const row = (yield q("SELECT * FROM notato.beta_requests WHERE id=$1 FOR UPDATE", id))[0];
    if (!row) throw new DataControlError("Request not found", 404);
    if (row.state === "active") throw new DataControlError("This account already has beta access.");
    const reserved = row.state === "invited" && String(row.expires_at) > now;
    if (!reserved && (yield* occupied(now)) >= config.maxUsers)
        throw new DataControlError(
            "All beta places are active or reserved. Increase the limit or revoke an unused invitation."
        );
    const updated = (yield q(
        "UPDATE notato.beta_requests SET state='invited',token_hash=$1,expires_at=$2,approved_by=$3,updated_at=$4 WHERE id=$5 RETURNING *",
        hash,
        expires,
        actor,
        now,
        id
    ))[0];
    return shown(updated as Record<string, unknown>);
}
export function* revoke(id: string, now: string): Operation<void> {
    yield* settings(true);
    const row = (yield q(
        "UPDATE notato.beta_requests SET state='revoked',token_hash=NULL,expires_at=NULL,updated_at=$1 WHERE id=$2 RETURNING redeemed_by",
        now,
        id
    ))[0];
    if (!row) throw new DataControlError("Request not found", 404);
    if (row.redeemed_by) {
        yield q("DELETE FROM notato.sessions WHERE username=$1", String(row.redeemed_by));
        yield q(
            "UPDATE notato.tokens SET revoked_at=$1 WHERE ownership='user' AND owner_username=$2 AND revoked_at IS NULL",
            now,
            String(row.redeemed_by)
        );
    }
}
export function* invitation(hash: string, now: string): Operation<BetaRequest | null> {
    const row = (yield q(
        "SELECT * FROM notato.beta_requests WHERE token_hash=$1 AND state='invited' AND expires_at>$2",
        hash,
        now
    ))[0];
    return row ? shown(row) : null;
}
export function* blocked(username: string): Operation<boolean> {
    return (
        (yield q(
            "SELECT 1 FROM notato.beta_requests WHERE redeemed_by=$1 AND state<>'active'",
            username
        )).length > 0
    );
}
export function* workspaceBlocked(workspace: string): Operation<boolean> {
    const row = (yield q(
        "SELECT count(*) AS owners,count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM notato.beta_requests b WHERE b.redeemed_by=m.username AND b.state<>'active')) AS active FROM notato.memberships m WHERE m.workspace_id=$1 AND m.role='owner'",
        workspace
    ))[0];
    return Number(row?.owners) > 0 && Number(row?.active) === 0;
}
/** Runs inside identity provisioning's transaction; locks serialize admission with revocation and capacity changes. */
export function* admit(
    email: string,
    username: string | undefined,
    hash: string | undefined,
    bypass: boolean,
    now: string
): Operation<string | null> {
    if (bypass) return null;
    const config = yield* settings(true);
    const previous = username
        ? (yield q("SELECT state FROM notato.beta_requests WHERE redeemed_by=$1", username))[0]
        : null;
    if (previous?.state === "active") return null;
    if (username && !previous && !hash) return null; // Existing accounts keep access while admissions are paused.
    if (username && !previous && config.paused) return null;
    const row = hash
        ? (yield q(
              "SELECT * FROM notato.beta_requests WHERE token_hash=$1 AND email=$2 AND state='invited' AND expires_at>$3 FOR UPDATE",
              hash,
              email,
              now
          ))[0]
        : null;
    if (username && !previous && !row) return null;
    if (!row || (row.redeemed_by && row.redeemed_by !== username))
        throw new DataControlError(
            "A valid beta invitation for your verified email is required.",
            403
        );
    if (config.paused)
        throw new DataControlError(
            "New beta admissions are paused. Your invitation can be used once admissions reopen.",
            403
        );
    const active = Number(
        (yield q("SELECT count(*) AS n FROM notato.beta_requests WHERE state='active'"))[0]?.n ?? 0
    );
    if (active >= config.maxUsers)
        throw new DataControlError(
            "The beta is currently at capacity. Please contact the service owner.",
            403
        );
    return String(row.id);
}
export function* claim(id: string, username: string, now: string): Operation<void> {
    yield q(
        "UPDATE notato.beta_requests SET state='active',redeemed_by=$1,token_hash=NULL,expires_at=NULL,updated_at=$2 WHERE id=$3",
        username,
        now,
        id
    );
}
