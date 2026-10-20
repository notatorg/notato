/**
 * What the monitor concludes from one check, as pure functions of what it saw and what it remembers: which alerts
 * start, continue, escalate or end. The Worker (`worker.ts`) does the fetching, storing and mailing.
 */

export type Severity = "warning" | "critical";

/** The parts of the service's `/metrics` the rules read. Counters are totals since the process started. */
export interface Sample {
    uptime: number;
    responses: number;
    errors: number;
    maintenanceFailing: string[];
    egress?: number;
    databaseBytes?: number;
    storedBytes?: number;
    volumeBytes?: number;
    volumeFreeBytes?: number;
}

/** The last verified recovery point the backup host reported. */
export interface BackupReport {
    verifiedAt: number;
    bytes: number;
    images: number;
    receivedAt: number;
}

export interface Observation {
    at: number;
    ready: boolean;
    /** Whether `/health` answered when `/ready` did not: the process is up but its database is not. */
    live?: boolean;
    metrics?: Sample;
    metricsError?: "unauthorized" | "unavailable";
    backup?: BackupReport;
}

export interface Limits {
    databaseBytes: number;
    storedBytes: number;
    monthlyEgressBytes: number;
    backupBytes: number;
    dailyGrowthBytes: number;
    requestsPerHour: number;
    errorsPer15Minutes: number;
    backupMaxAgeHours: number;
}

export interface Condition {
    key: string;
    /** When the condition began, when it is known to have begun before this check. */
    since?: number;
    severity: Severity;
    title: string;
    detail: string;
    action: string;
}

export interface Notification {
    /** The same for a retried delivery of the same message, so the mail provider can drop a duplicate. */
    id: string;
    key: string;
    kind: "alert" | "escalation" | "reminder" | "resolved" | "summary";
    severity: Severity;
    subject: string;
    text: string;
}

interface Delta {
    at: number;
    responses: number;
    errors: number;
    restarted: boolean;
}

export interface State {
    version: 1;
    startedAt: number;
    failures: number;
    downSince?: number;
    scrapeFailures: number;
    last?: Sample;
    deltas: Delta[];
    /** About one size sample an hour, for a day's growth. */
    sizes: { at: number; bytes: number }[];
    egressMonth?: { month: string; bytes: number };
    maintenanceRuns: Record<string, number>;
    alerts: Record<
        string,
        { since: number; notifiedAt: number; severity: Severity; title: string }
    >;
    period: { since: number; checks: number; failed: number };
    summaryAt: number;
    /** Alert mail sent on one UTC day, against the daily limit. */
    mail?: { day: string; sent: number };
    /** Complete messages awaiting provider acceptance, including recovery and weekly summary mail. */
    pendingMail?: Notification[];
    /** What the last check saw, for the admin console's health page. */
    seen?: {
        at: number;
        ready: boolean;
        live?: boolean;
        metricsError?: Observation["metricsError"];
    };
    /** The settings the last check used: the health page shows sizes against these limits. */
    limits?: Limits;
    target?: string;
    label?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Consecutive failed readiness checks before the service is called down: two, about ten minutes. */
const DOWN_AFTER = 2;
const REMIND_AFTER = DAY;
/** The alerts a check without metrics can still decide; every other one waits for the next readable metrics. */
const OBSERVED_WITHOUT_METRICS = new Set(["down", "backup", "backup-size"]);

export function initialState(now: number): State {
    return {
        version: 1,
        startedAt: now,
        failures: 0,
        scrapeFailures: 0,
        deltas: [],
        sizes: [],
        maintenanceRuns: {},
        alerts: {},
        period: { since: now, checks: 0, failed: 0 },
        summaryAt: now,
    };
}

/** Reads the series the rules need from Prometheus text; anything else is ignored. */
export function parseMetrics(text: string): Sample {
    const sample: Sample = { uptime: 0, responses: 0, errors: 0, maintenanceFailing: [] };
    for (const line of text.split("\n")) {
        const match = /^([a-z_]+)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line.trim());
        if (!match) continue;
        const [, name, labels = "", raw] = match;
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        const label = (key: string) => new RegExp(`${key}="([^"]*)"`).exec(labels)?.[1];
        switch (name) {
            case "notato_http_responses_total":
                sample.responses += value;
                if (Number(label("status")) >= 500) sample.errors += value;
                break;
            case "notato_uptime_seconds":
                sample.uptime = value;
                break;
            case "notato_maintenance_last_run_failed": {
                const task = label("task");
                if (value === 1 && task) sample.maintenanceFailing.push(task);
                break;
            }
            case "notato_object_egress_bytes_total":
                sample.egress = value;
                break;
            case "notato_database_bytes":
                sample.databaseBytes = value;
                break;
            case "notato_stored_bytes":
                sample.storedBytes = value;
                break;
            case "notato_data_volume_bytes":
                sample.volumeBytes = value;
                break;
            case "notato_data_volume_free_bytes":
                sample.volumeFreeBytes = value;
                break;
        }
    }
    return sample;
}

/** A counter's growth since the last sample; after a restart the counters began again from zero. */
function grown(current: number, previous: number | undefined, restarted: boolean) {
    if (previous === undefined || restarted || current < previous) return current;
    return current - previous;
}

export function formatBytes(bytes: number) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function utc(at: number) {
    return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function month(at: number) {
    return new Date(at).toISOString().slice(0, 7);
}

/** Folds one check into what the monitor remembers. */
function remember(previous: State, seen: Observation): State {
    const state: State = structuredClone(previous);
    const now = seen.at;
    state.seen = { at: now, ready: seen.ready, live: seen.live, metricsError: seen.metricsError };
    state.period.checks++;
    if (seen.ready) {
        state.failures = 0;
        state.downSince = undefined;
    } else {
        state.failures++;
        state.downSince ??= now;
        state.period.failed++;
    }
    const sample = seen.metrics;
    state.scrapeFailures = sample || !seen.ready ? 0 : state.scrapeFailures + 1;
    if (!sample) return state;

    const last = state.last;
    const restarted = Boolean(last && sample.uptime < last.uptime);
    if (last)
        state.deltas.push({
            at: now,
            responses: grown(sample.responses, last.responses, restarted),
            errors: grown(sample.errors, last.errors, restarted),
            restarted,
        });
    state.deltas = state.deltas.filter((d) => d.at > now - HOUR);

    if (sample.egress !== undefined) {
        const egress = last ? grown(sample.egress, last.egress, restarted) : 0;
        state.egressMonth =
            state.egressMonth?.month === month(now)
                ? { month: month(now), bytes: state.egressMonth.bytes + egress }
                : { month: month(now), bytes: egress };
    }

    const newest = state.sizes.at(-1);
    if (
        sample.databaseBytes !== undefined &&
        sample.storedBytes !== undefined &&
        (!newest || now - newest.at >= HOUR - MINUTE)
    )
        state.sizes.push({ at: now, bytes: sample.databaseBytes + sample.storedBytes });
    state.sizes = state.sizes.filter((s) => s.at > now - DAY - 2 * HOUR);

    const failing = new Set(sample.maintenanceFailing);
    state.maintenanceRuns = Object.fromEntries(
        [...failing].map((task) => [task, (state.maintenanceRuns[task] ?? 0) + 1])
    );
    state.last = sample;
    return state;
}

function capacity(
    key: string,
    what: string,
    used: number | undefined,
    limit: number,
    action: string
): Condition | undefined {
    if (used === undefined || limit <= 0) return undefined;
    const share = used / limit;
    if (share < 0.8) return undefined;
    return {
        key,
        severity: share >= 0.95 ? "critical" : "warning",
        title: `${what} is at ${Math.round(share * 100)}% of its allowance`,
        detail: `${what}: ${formatBytes(used)} of ${formatBytes(limit)}.`,
        action,
    };
}

/** Every condition that holds after this check. */
export function conditions(state: State, seen: Observation, limits: Limits): Condition[] {
    const now = seen.at;
    const found: (Condition | undefined)[] = [];
    if (state.failures >= DOWN_AFTER)
        found.push({
            key: "down",
            since: state.downSince,
            severity: "critical",
            title: seen.live
                ? "The service is up but cannot reach its database"
                : "The service is not answering",
            detail: `/ready has failed ${state.failures} checks in a row, since ${utc(state.downSince ?? now)}. ${
                seen.live
                    ? "/health answers, so the process is running."
                    : "/health does not answer either."
            }`,
            action: seen.live
                ? "Check Postgres, object storage and the database connection: `docker compose logs --tail=200` on the home server."
                : "Check the home server, its network and the container: `docker compose ps` and `docker compose logs --tail=200`.",
        });
    if (state.scrapeFailures >= 3)
        found.push({
            key: "metrics",
            severity: "warning",
            title:
                seen.metricsError === "unauthorized"
                    ? "The monitoring credential is refused"
                    : "Metrics cannot be read",
            detail: "The service answers /ready, but /metrics could not be read for 15 minutes. Error, storage and usage alerts are paused until it can.",
            action: "Check that NOTATO_MONITORING_TOKEN matches in the service's environment and the monitor's secrets.",
        });

    const recent = state.deltas.filter((d) => d.at > now - 15 * MINUTE);
    const errors = recent.reduce((sum, d) => sum + d.errors, 0);
    const responses = recent.reduce((sum, d) => sum + d.responses, 0);
    if (errors >= Math.max(1, limits.errorsPer15Minutes))
        found.push({
            key: "errors",
            severity: "warning",
            title: "The service is returning server errors",
            detail: `${errors} of ${responses} responses in the last 15 minutes were server errors (5xx).`,
            action: "Look for `[notato] unhandled error` in `docker compose logs --since=30m`.",
        });
    const restarts = state.deltas.filter((d) => d.restarted).length;
    if (restarts >= 3)
        found.push({
            key: "restarts",
            severity: "warning",
            title: "The service keeps restarting",
            detail: `The process restarted ${restarts} times in the last hour.`,
            action: "Check `docker compose ps` for restart counts and the logs before each start.",
        });
    const stuck = Object.entries(state.maintenanceRuns).filter(([, runs]) => runs >= 3);
    if (stuck.length)
        found.push({
            key: "maintenance",
            severity: "warning",
            title: "Background maintenance keeps failing",
            detail: `Failing for 15 minutes or more: ${stuck.map(([task]) => task).join(", ")}.`,
            action: "Check the `maintenance:` lines in the service's logs.",
        });
    const requests = state.deltas.reduce((sum, d) => sum + d.responses, 0);
    if (requests > limits.requestsPerHour)
        found.push({
            key: "requests",
            severity: "warning",
            title: "Unusually high request volume",
            detail: `${requests.toLocaleString("en-GB")} requests in the last hour, above the expected ${limits.requestsPerHour.toLocaleString("en-GB")}.`,
            action: "Check for abuse or a runaway client; consider an edge rate limit. Usage can raise provider bills.",
        });

    const backup = seen.backup;
    const maxAge = limits.backupMaxAgeHours * HOUR;
    if (!backup && now - state.startedAt >= HOUR)
        found.push({
            key: "backup",
            severity: "critical",
            title: "No verified backup has been reported",
            detail: "The monitor has never received a backup report from the backup host.",
            action: "Install the backup heartbeat on the backup host (services/monitor/README.md) and check its cron log.",
        });
    else if (backup && now - backup.verifiedAt > maxAge)
        found.push({
            key: "backup",
            severity: "critical",
            title: "Backups are overdue",
            detail: `The last verified backup was ${Math.floor((now - backup.verifiedAt) / HOUR)} hours ago (${utc(backup.verifiedAt)}); the limit is ${limits.backupMaxAgeHours}. Last report received ${utc(backup.receivedAt)}.`,
            action: "Run `backupctl.py health` on the backup host and check its private status and command-error log.",
        });
    if (backup)
        found.push(
            capacity(
                "backup-size",
                "The backup",
                backup.bytes,
                limits.backupBytes,
                "Check the backup storage bill and retention; raise the limit if the growth is expected."
            )
        );

    const sample = seen.metrics;
    if (sample) {
        found.push(
            capacity(
                "database-size",
                "The database",
                sample.databaseBytes,
                limits.databaseBytes,
                "Check the database disk, retention settings and capacity thresholds."
            ),
            capacity(
                "stored-size",
                "Stored notes and screenshots",
                sample.storedBytes,
                limits.storedBytes,
                "Check object storage capacity and the largest workspaces' usage."
            )
        );
        if (sample.volumeBytes && sample.volumeFreeBytes !== undefined) {
            const free = sample.volumeFreeBytes / sample.volumeBytes;
            if (free < 0.15)
                found.push({
                    key: "disk",
                    severity: free < 0.05 ? "critical" : "warning",
                    title: `The server's disk is ${Math.round((1 - free) * 100)}% full`,
                    detail: `${formatBytes(sample.volumeFreeBytes)} free of ${formatBytes(sample.volumeBytes)} on the service's data volume.`,
                    action: "On the home server: `df -h`, `docker system df`; prune old images and check the local backup repository.",
                });
        }
    }
    const newest = state.sizes.at(-1);
    const dayAgo = state.sizes.findLast((s) => s.at <= now - DAY + 5 * MINUTE);
    if (newest && dayAgo && newest.bytes - dayAgo.bytes > limits.dailyGrowthBytes)
        found.push({
            key: "growth",
            severity: "warning",
            title: "Storage grew unusually fast",
            detail: `Database and stored data grew ${formatBytes(newest.bytes - dayAgo.bytes)} in the last day, above the expected ${formatBytes(limits.dailyGrowthBytes)}.`,
            action: "Check which workspaces grew in the admin console or database; look for a runaway capture loop.",
        });
    if (state.egressMonth && state.egressMonth.month === month(now))
        found.push(
            capacity(
                "egress",
                "This month's screenshot egress",
                state.egressMonth.bytes,
                limits.monthlyEgressBytes,
                "Check object storage transfer and network usage."
            )
        );
    return found.filter((c): c is Condition => Boolean(c));
}

function message(label: string, condition: Condition, kind: Notification["kind"], since: number) {
    const heading = {
        alert: condition.severity === "critical" ? "Alert" : "Warning",
        escalation: "Worse",
        reminder: "Still failing",
        resolved: "Resolved",
        summary: "Summary",
    }[kind];
    return {
        subject: `[Notato ${label}] ${heading}: ${condition.title}`,
        text: [
            `${heading}: ${condition.title}`,
            "",
            condition.detail,
            "",
            `What to check: ${condition.action}`,
            "",
            `Started: ${utc(since)}`,
        ].join("\n"),
    };
}

/** The alerts that start, worsen, continue for a day or end with this check, and what to remember afterwards. */
export function evaluate(
    previous: State | undefined,
    seen: Observation,
    limits: Limits,
    label: string
): { state: State; notifications: Notification[] } {
    const now = seen.at;
    const state = remember(previous ?? initialState(now), seen);
    const notifications: Notification[] = [];
    const active = conditions(state, seen, limits);
    const rank = { warning: 0, critical: 1 };
    for (const condition of active) {
        const known = state.alerts[condition.key];
        const kind: Notification["kind"] | undefined = !known
            ? "alert"
            : rank[condition.severity] > rank[known.severity]
              ? "escalation"
              : now - known.notifiedAt >= REMIND_AFTER
                ? "reminder"
                : undefined;
        const since = known?.since ?? condition.since ?? now;
        state.alerts[condition.key] = {
            since,
            notifiedAt: kind ? now : (known?.notifiedAt ?? now),
            severity: condition.severity,
            title: condition.title,
        };
        if (kind)
            notifications.push({
                id: `${condition.key}/${kind}/${since}/${kind === "reminder" ? Math.floor(now / DAY) : condition.severity}`,
                key: condition.key,
                kind,
                severity: condition.severity,
                ...message(label, condition, kind, since),
            });
    }
    const still = new Set(active.map((c) => c.key));
    for (const [key, alert] of Object.entries(state.alerts)) {
        // Without metrics nothing can be measured: an alert that depends on them is held, not called resolved.
        if (still.has(key) || (!seen.metrics && !OBSERVED_WITHOUT_METRICS.has(key))) continue;
        delete state.alerts[key];
        const minutes = Math.max(1, Math.round((now - alert.since) / MINUTE));
        notifications.push({
            id: `${key}/resolved/${alert.since}`,
            key,
            kind: "resolved",
            severity: alert.severity,
            subject: `[Notato ${label}] Resolved: ${alert.title}`,
            text: `Resolved: ${alert.title}\n\nThe condition cleared at ${utc(now)} after about ${minutes} minutes (since ${utc(alert.since)}).`,
        });
    }
    notifications.sort((a, b) => rank[b.severity] - rank[a.severity]);
    return { state, notifications };
}

/**
 * A weekly status mail, Mondays from 08:00 UTC: proof that the monitor itself is running, with uptime for the
 * period, the latest sizes and the backup's age.
 */
export function weeklySummary(
    state: State,
    seen: Observation,
    limits: Limits,
    label: string
): Notification | undefined {
    const now = new Date(seen.at);
    if (now.getUTCDay() !== 1 || now.getUTCHours() < 8 || seen.at - state.summaryAt < 6 * DAY)
        return undefined;
    const { checks, failed, since } = state.period;
    const uptime = checks ? ((checks - failed) / checks) * 100 : 100;
    const last = state.last;
    const of = (used: number | undefined, limit: number) =>
        used === undefined ? "not measured" : `${formatBytes(used)} of ${formatBytes(limit)}`;
    const backup = seen.backup
        ? `${Math.floor((seen.at - seen.backup.verifiedAt) / HOUR)} hours ago (${formatBytes(seen.backup.bytes)}, ${seen.backup.images} screenshots)`
        : "never reported";
    const firing = Object.values(state.alerts).map((a) => `- ${a.title}`);
    state.period = { since: seen.at, checks: 0, failed: 0 };
    state.summaryAt = seen.at;
    return {
        id: `summary/${since}`,
        key: "summary",
        kind: "summary",
        severity: "warning",
        subject: `[Notato ${label}] Weekly status: ${uptime.toFixed(2)}% available${firing.length ? `, ${firing.length} open alerts` : ""}`,
        text: [
            `Weekly status since ${utc(since)}`,
            "",
            `Availability: ${uptime.toFixed(2)}% of ${checks} checks (${failed} failed).`,
            `Database: ${of(last?.databaseBytes, limits.databaseBytes)}.`,
            `Stored notes and screenshots: ${of(last?.storedBytes, limits.storedBytes)}.`,
            `Screenshot egress this month: ${of(state.egressMonth?.bytes, limits.monthlyEgressBytes)}.`,
            `Server disk free: ${last?.volumeFreeBytes === undefined ? "not measured" : formatBytes(last.volumeFreeBytes)}.`,
            `Last verified backup: ${backup}.`,
            "",
            firing.length ? `Open alerts:\n${firing.join("\n")}` : "No open alerts.",
            "",
            "This weekly mail also shows the monitor itself is running. If it stops arriving, check the Worker in Cloudflare.",
        ].join("\n"),
    };
}
