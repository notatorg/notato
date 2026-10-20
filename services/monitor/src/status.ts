/**
 * The admin console's health page, from what the monitor remembers: the last check, open alerts, traffic, sizes
 * against their allowances and the last verified backup. Aggregate figures only, like the mails.
 */
import type { BackupReport, Severity, State } from "./rules.ts";

export interface Meter {
    key: string;
    label: string;
    /** Absent when the service has not reported it. */
    used?: number;
    limit: number;
    /** Shares of the limit at which the monitor warns and calls it critical. */
    warnAt: number;
    criticalAt: number;
}

export interface StatusView {
    generatedAt: number;
    /** The last check, or null before the monitor has run. */
    checkedAt: number | null;
    /** True when the monitor has not checked for 15 minutes: it, not the service, needs attention. */
    stale: boolean;
    target?: string;
    status: "ok" | Severity | "unknown";
    service: {
        ready: boolean | null;
        live?: boolean;
        metrics: "ok" | "unauthorized" | "unavailable" | "unknown";
        downSince?: number;
    };
    alerts: { key: string; title: string; severity: Severity; since: number }[];
    availability: { since: number; checks: number; failed: number } | null;
    traffic: {
        requestsLastHour: number;
        errorsLast15Minutes: number;
        restartsLastHour: number;
        checks: { at: number; responses: number; errors: number; restarted: boolean }[];
    };
    meters: Meter[];
    backup: (BackupReport & { maxAgeHours: number }) | null;
    /** Database plus stored bytes, about hourly, for the last day. */
    storage: { at: number; bytes: number }[];
}

const MINUTE = 60_000;

export function statusView(
    state: State | undefined,
    backup: BackupReport | undefined,
    now: number
): StatusView {
    const seen = state?.seen;
    const last = state?.last;
    const limits = state?.limits;
    const alerts = Object.entries(state?.alerts ?? {})
        .map(([key, a]) => ({ key, title: a.title, severity: a.severity, since: a.since }))
        .sort((a, b) =>
            a.severity === b.severity ? a.since - b.since : a.severity === "critical" ? -1 : 1
        );
    const deltas = (state?.deltas ?? []).filter((d) => d.at > now - 60 * MINUTE);
    const meters: Meter[] = [];
    if (limits) {
        meters.push(
            {
                key: "database",
                label: "Database",
                used: last?.databaseBytes,
                limit: limits.databaseBytes,
                warnAt: 0.8,
                criticalAt: 0.95,
            },
            {
                key: "stored",
                label: "Notes and screenshots",
                used: last?.storedBytes,
                limit: limits.storedBytes,
                warnAt: 0.8,
                criticalAt: 0.95,
            },
            {
                key: "egress",
                label: "Screenshot egress this month",
                used:
                    state?.egressMonth?.month === new Date(now).toISOString().slice(0, 7)
                        ? state.egressMonth.bytes
                        : last?.egress === undefined
                          ? undefined
                          : 0,
                limit: limits.monthlyEgressBytes,
                warnAt: 0.8,
                criticalAt: 0.95,
            },
            {
                key: "backup",
                label: "Latest backup",
                used: backup?.bytes,
                limit: limits.backupBytes,
                warnAt: 0.8,
                criticalAt: 0.95,
            }
        );
        if (last?.volumeBytes && last.volumeFreeBytes !== undefined)
            meters.push({
                key: "disk",
                label: "Server disk",
                used: last.volumeBytes - last.volumeFreeBytes,
                limit: last.volumeBytes,
                warnAt: 0.85,
                criticalAt: 0.95,
            });
    }
    const status: StatusView["status"] = !seen
        ? "unknown"
        : !seen.ready || alerts.some((a) => a.severity === "critical")
          ? "critical"
          : alerts.length
            ? "warning"
            : "ok";
    return {
        generatedAt: now,
        checkedAt: seen?.at ?? null,
        stale: !seen || now - seen.at > 15 * MINUTE,
        target: state?.target,
        status,
        service: {
            ready: seen ? seen.ready : null,
            live: seen?.live,
            metrics: !seen ? "unknown" : (seen.metricsError ?? (last ? "ok" : "unknown")),
            downSince: state?.downSince,
        },
        alerts,
        availability: state ? { ...state.period } : null,
        traffic: {
            requestsLastHour: deltas.reduce((sum, d) => sum + d.responses, 0),
            errorsLast15Minutes: deltas
                .filter((d) => d.at > now - 15 * MINUTE)
                .reduce((sum, d) => sum + d.errors, 0),
            restartsLastHour: deltas.filter((d) => d.restarted).length,
            checks: deltas.map(({ at, responses, errors, restarted }) => ({
                at,
                responses,
                errors,
                restarted,
            })),
        },
        meters,
        backup: backup ? { ...backup, maxAgeHours: limits?.backupMaxAgeHours ?? 30 } : null,
        storage: (state?.sizes ?? []).filter((s) => s.at > now - 24 * 60 * MINUTE - 5 * MINUTE),
    };
}
