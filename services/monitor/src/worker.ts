/**
 * Notato's monitor: a Cloudflare Worker, run every five minutes from outside the home server, so it still reports
 * when that server, its network or its power is gone. It reads the service's `/ready` and `/metrics`, keeps a little
 * history in KV, and mails alerts through Resend. The backup host reports its last verified backup to
 * `POST /backup-heartbeat`; the monitor alerts when that report is overdue. No customer data is read or mailed.
 */
import {
    type BackupReport,
    evaluate,
    type Limits,
    type Notification,
    type Observation,
    parseMetrics,
    type State,
    weeklySummary,
} from "./rules.ts";

/** The part of a Workers KV namespace the monitor uses. */
export interface KV {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
}

export interface Env {
    MONITOR: KV;
    sendMail?(notification: Notification, to: string[]): Promise<void>;
    /** The service's public origin, such as https://test.notato.dev. */
    NOTATO_MONITOR_TARGET: string;
    /** Names the deployment in mail subjects: "[Notato test]". */
    NOTATO_MONITOR_LABEL?: string;
    /** The backup configuration's instance name, which every backup report must carry. */
    NOTATO_MONITOR_INSTANCE: string;
    NOTATO_ALERT_FROM?: string;
    // Secrets: set with `wrangler secret put`, never in wrangler.json.
    NOTATO_ALERT_TO?: string;
    NOTATO_RESEND_API_KEY?: string;
    NOTATO_MONITORING_TOKEN?: string;
    NOTATO_BACKUP_HEARTBEAT_TOKEN?: string;
    // Optional operator-selected capacity thresholds.
    NOTATO_DATABASE_LIMIT_MB?: string;
    NOTATO_STORAGE_LIMIT_MB?: string;
    NOTATO_MONTHLY_EGRESS_LIMIT_MB?: string;
    NOTATO_BACKUP_LIMIT_MB?: string;
    NOTATO_DAILY_GROWTH_LIMIT_MB?: string;
    NOTATO_REQUESTS_PER_HOUR_LIMIT?: string;
    NOTATO_ERRORS_PER_15_MINUTES_LIMIT?: string;
    NOTATO_BACKUP_MAX_AGE_HOURS?: string;
    NOTATO_ALERT_DAILY_LIMIT?: string;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const MB = 1024 * 1024;
const MAX_METRICS_BYTES = 1024 * 1024;

function number(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function limits(env: Env): Limits {
    return {
        databaseBytes: number(env.NOTATO_DATABASE_LIMIT_MB, 500) * MB,
        storedBytes: number(env.NOTATO_STORAGE_LIMIT_MB, 1024) * MB,
        monthlyEgressBytes: number(env.NOTATO_MONTHLY_EGRESS_LIMIT_MB, 5120) * MB,
        backupBytes: number(env.NOTATO_BACKUP_LIMIT_MB, 10240) * MB,
        dailyGrowthBytes: number(env.NOTATO_DAILY_GROWTH_LIMIT_MB, 100) * MB,
        requestsPerHour: number(env.NOTATO_REQUESTS_PER_HOUR_LIMIT, 20_000),
        errorsPer15Minutes: number(env.NOTATO_ERRORS_PER_15_MINUTES_LIMIT, 5),
        backupMaxAgeHours: number(env.NOTATO_BACKUP_MAX_AGE_HOURS, 30),
    };
}

function target(env: Env) {
    const url = new URL(env.NOTATO_MONITOR_TARGET);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.username)
        throw new Error("NOTATO_MONITOR_TARGET must be an https origin");
    return url;
}

/** One look at the service: readiness, then liveness if it is not ready, or its metrics if it is. */
export async function observe(env: Env, at: number, fetcher: Fetcher): Promise<Observation> {
    const origin = target(env);
    const get = async (path: string, headers: Record<string, string> = {}) => {
        try {
            return await fetcher(new URL(path, origin), {
                headers,
                redirect: "manual",
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            return undefined;
        }
    };
    const ready = await get("/ready");
    await ready?.body?.cancel();
    if (ready?.status !== 200) {
        const health = await get("/health");
        await health?.body?.cancel();
        return { at, ready: false, live: health?.status === 200 };
    }
    if (!env.NOTATO_MONITORING_TOKEN) return { at, ready: true, metricsError: "unauthorized" };
    const metrics = await get("/metrics", {
        authorization: `Bearer ${env.NOTATO_MONITORING_TOKEN}`,
    });
    if (metrics?.status !== 200) {
        await metrics?.body?.cancel();
        return {
            at,
            ready: true,
            metricsError:
                metrics?.status === 401 || metrics?.status === 403 ? "unauthorized" : "unavailable",
        };
    }
    const text = await metrics.text();
    if (text.length > MAX_METRICS_BYTES) return { at, ready: true, metricsError: "unavailable" };
    return { at, ready: true, metrics: parseMetrics(text) };
}

async function read<T>(kv: KV, key: string): Promise<T | undefined> {
    const value = await kv.get(key);
    if (!value) return undefined;
    try {
        return JSON.parse(value) as T;
    } catch {
        return undefined;
    }
}

/** Mails one notification through Resend; true once the provider has accepted it. */
async function deliver(env: Env, fetcher: Fetcher, n: Notification) {
    const to = (env.NOTATO_ALERT_TO ?? "")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);
    if (!to.length) return false;
    if (env.sendMail) {
        try {
            await env.sendMail(n, to);
            return true;
        } catch {
            return false;
        }
    }
    if (!env.NOTATO_RESEND_API_KEY || !env.NOTATO_ALERT_FROM) return false;
    try {
        const response = await fetcher("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${env.NOTATO_RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": `notato-monitor/${n.id}`.slice(0, 256),
            },
            body: JSON.stringify({
                from: env.NOTATO_ALERT_FROM,
                to,
                subject: n.subject,
                text: n.text,
            }),
            signal: AbortSignal.timeout(12_000),
        });
        await response.body?.cancel();
        return response.ok;
    } catch {
        return false;
    }
}

/** One scheduled check: observe, decide, mail within the daily limit, remember. */
export async function check(env: Env, now: number, fetcher: Fetcher = fetch) {
    const rules = limits(env);
    const label = env.NOTATO_MONITOR_LABEL || "service";
    const previous = await read<State>(env.MONITOR, "state");
    const seen = await observe(env, now, fetcher);
    seen.backup = await read<BackupReport>(env.MONITOR, "backup");
    const { state, notifications } = evaluate(
        previous?.version === 1 ? previous : undefined,
        seen,
        rules,
        label
    );
    state.limits = rules;
    state.target = target(env).origin;
    state.label = label;
    const summary = weeklySummary(state, seen, rules, label);
    if (summary) notifications.push(summary);

    const day = new Date(now).toISOString().slice(0, 10);
    const mail = state.mail?.day === day ? state.mail : { day, sent: 0 };
    const allowance = number(env.NOTATO_ALERT_DAILY_LIMIT, 20);
    const footer = `Monitored: ${target(env).origin} (${env.NOTATO_MONITOR_INSTANCE}), every 5 minutes from Cloudflare.\nDaily alert mail limit: ${allowance}. Further messages wait until 00:00 UTC.\nThis message contains no customer data.`;
    const pending = new Map((state.pendingMail ?? []).map((n) => [n.id, n]));
    for (const n of notifications)
        if (!pending.has(n.id)) pending.set(n.id, { ...n, text: `${n.text}\n\n${footer}` });
    state.pendingMail = [...pending.values()];
    state.mail = mail;
    // Keep the same id and payload across failed deliveries, even after the condition clears or a new weekly
    // reporting period begins. Write state once per check, within KV's per-key write limit.
    while (state.pendingMail.length) {
        const n = state.pendingMail[0];
        if (!n) break;
        if (mail.sent >= allowance) {
            console.log(`notato-monitor: daily mail limit reached; ${n.key} ${n.kind} deferred`);
            break;
        }
        if (!(await deliver(env, fetcher, n))) {
            console.log(`notato-monitor: ${n.key} ${n.kind} not delivered; retrying next check`);
            break;
        }
        mail.sent++;
        state.pendingMail.shift();
    }
    await env.MONITOR.put("state", JSON.stringify(state));
    return { seen, state, notifications };
}

async function sameSecret(presented: string, expected: string) {
    const digest = async (value: string) =>
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    const [a, b] = await Promise.all([digest(presented), digest(expected)]);
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return difference === 0;
}

/** `POST /backup-heartbeat`: the backup host's report of its last verified recovery point. */
export async function heartbeat(req: Request, env: Env, now: number): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const expected = env.NOTATO_BACKUP_HEARTBEAT_TOKEN;
    const presented = /^Bearer (\S{1,512})$/.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!expected || expected.length < 32 || !presented || !(await sameSecret(presented, expected)))
        return new Response(null, { status: 401 });
    if (!req.headers.get("content-type")?.startsWith("application/json"))
        return new Response(null, { status: 415 });
    const body = await req.text();
    if (body.length > 2048) return new Response(null, { status: 413 });
    let report: { instance?: unknown; verified_at?: unknown; bytes?: unknown; images?: unknown };
    try {
        report = JSON.parse(body);
    } catch {
        return new Response(null, { status: 400 });
    }
    if (!report || typeof report !== "object" || Array.isArray(report))
        return new Response(null, { status: 400 });
    const verifiedAt =
        typeof report.verified_at === "string" ? Date.parse(report.verified_at) : NaN;
    const count = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (
        report.instance !== env.NOTATO_MONITOR_INSTANCE ||
        !Number.isFinite(verifiedAt) ||
        verifiedAt > now + 5 * 60_000 ||
        !count(report.bytes) ||
        !count(report.images)
    )
        return new Response(null, { status: 400 });
    const known = await read<BackupReport>(env.MONITOR, "backup");
    // A late or replayed report never moves the last verified backup backwards.
    const latest: BackupReport =
        known && known.verifiedAt > verifiedAt
            ? { ...known, receivedAt: now }
            : {
                  verifiedAt,
                  bytes: report.bytes as number,
                  images: report.images as number,
                  receivedAt: now,
              };
    await env.MONITOR.put("backup", JSON.stringify(latest));
    return new Response(null, { status: 204 });
}

export default {
    async fetch(req: Request, env: Env) {
        if (new URL(req.url).pathname === "/backup-heartbeat")
            return heartbeat(req, env, Date.now());
        return new Response(null, { status: 404 });
    },
    async scheduled(_controller: unknown, env: Env) {
        await check(env, Date.now());
    },
};
