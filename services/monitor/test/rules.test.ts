import { describe, expect, it } from "bun:test";
import { Metrics } from "../../server/src/metrics.ts";
import {
    type BackupReport,
    evaluate,
    type Limits,
    type Notification,
    type Observation,
    parseMetrics,
    type Sample,
    type State,
    weeklySummary,
} from "../src/rules.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A Wednesday. */
const T0 = Date.UTC(2026, 9, 14, 12, 0);
const LIMITS: Limits = {
    databaseBytes: 500 * MB,
    storedBytes: 1024 * MB,
    monthlyEgressBytes: 5 * GB,
    backupBytes: 10 * GB,
    dailyGrowthBytes: 100 * MB,
    requestsPerHour: 20_000,
    errorsPer15Minutes: 5,
    backupMaxAgeHours: 30,
};
const fresh = (at: number): BackupReport => ({
    verifiedAt: at - HOUR,
    bytes: 20 * MB,
    images: 3,
    receivedAt: at,
});

function sample(over: Partial<Sample> = {}): Sample {
    return {
        uptime: 1000,
        responses: 100,
        errors: 0,
        maintenanceFailing: [],
        egress: 0,
        databaseBytes: 20 * MB,
        storedBytes: 5 * MB,
        volumeBytes: 100 * GB,
        volumeFreeBytes: 60 * GB,
        ...over,
    };
}

/** Runs checks in order, as the Worker would, and hands back each check's notifications. */
function checks(steps: Partial<Observation>[], start?: State) {
    let state = start;
    const sent: Notification[][] = [];
    for (const step of steps) {
        const at = step.at ?? T0;
        const result = evaluate(
            state,
            { ready: true, backup: fresh(at), ...step, at } as Observation,
            LIMITS,
            "test"
        );
        state = result.state;
        sent.push(result.notifications);
    }
    return { state: state as State, sent };
}

const every5 = (n: number, from = T0) => from + n * 5 * MINUTE;

describe("reading the service's metrics", () => {
    it("reads what the service's own /metrics renders", async () => {
        const metrics = new Metrics(() => 0);
        for (const status of [200, 200, 404, 500, 503]) metrics.record(status, 4);
        metrics.recordMaintenance({
            task: "retention",
            removed: 0,
            failed: true,
            milliseconds: 3,
            finishedAt: 1000,
        });
        metrics.recordMaintenance({
            task: "orphans",
            removed: 2,
            failed: false,
            milliseconds: 3,
            finishedAt: 1000,
        });
        metrics.measureCapacity(async () => ({
            databaseBytes: 1234,
            storedBytes: 56,
            volumeBytes: 9000,
            volumeFreeBytes: 400,
        }));
        metrics.measureEgress(() => 789);
        await metrics.refresh();
        const parsed = parseMetrics(metrics.render());
        expect(parsed).toMatchObject({
            responses: 5,
            errors: 2,
            maintenanceFailing: ["retention"],
            egress: 789,
            databaseBytes: 1234,
            storedBytes: 56,
            volumeBytes: 9000,
            volumeFreeBytes: 400,
        });
        expect(parsed.uptime).toBeGreaterThan(0);
    });
});

describe("alerts", () => {
    it("calls the service down after two failed checks, dated from the first, and says when it recovers", () => {
        const { sent } = checks([
            { at: every5(0), metrics: sample() },
            { at: every5(1), ready: false, live: false },
            { at: every5(2), ready: false, live: true },
            { at: every5(3), ready: false, live: true },
            { at: every5(4), metrics: sample({ uptime: 10 }) },
        ]);
        expect(sent[0]).toEqual([]);
        expect(sent[1]).toEqual([]);
        expect(sent[2]).toHaveLength(1);
        expect(sent[2]?.[0]).toMatchObject({ key: "down", kind: "alert", severity: "critical" });
        expect(sent[2]?.[0]?.subject).toBe(
            "[Notato test] Alert: The service is up but cannot reach its database"
        );
        expect(sent[2]?.[0]?.text).toContain("since 2026-10-14 12:05 UTC");
        expect(sent[3]).toEqual([]);
        expect(sent[4]).toHaveLength(1);
        expect(sent[4]?.[0]).toMatchObject({ key: "down", kind: "resolved" });
        expect(sent[4]?.[0]?.text).toContain("after about 15 minutes");
    });

    it("holds alerts that need metrics while the service is down instead of calling them resolved", () => {
        const full = sample({ volumeFreeBytes: 10 * GB });
        const { sent } = checks([
            { at: every5(0), metrics: full },
            { at: every5(1), ready: false },
            { at: every5(2), ready: false },
            { at: every5(3), metrics: sample({ uptime: 5 }) },
        ]);
        expect(sent[0]?.map((n) => [n.key, n.kind, n.severity])).toEqual([
            ["disk", "alert", "warning"],
        ]);
        expect(sent[0]?.[0]?.subject).toBe("[Notato test] Warning: The server's disk is 90% full");
        expect(sent[2]?.map((n) => [n.key, n.kind])).toEqual([["down", "alert"]]);
        expect(sent[3]?.map((n) => [n.key, n.kind]).sort()).toEqual([
            ["disk", "resolved"],
            ["down", "resolved"],
        ]);
    });

    it("counts server errors across a restart and clears once the window falls below the limit", () => {
        const { sent } = checks([
            { at: every5(0), metrics: sample({ uptime: 1000, responses: 100, errors: 0 }) },
            { at: every5(1), metrics: sample({ uptime: 1300, responses: 110, errors: 3 }) },
            // Restarted: the counters began again, so all of these are new.
            { at: every5(2), metrics: sample({ uptime: 10, responses: 4, errors: 2 }) },
            { at: every5(3), metrics: sample({ uptime: 310, responses: 30, errors: 2 }) },
            { at: every5(4), metrics: sample({ uptime: 610, responses: 60, errors: 2 }) },
        ]);
        expect(sent[1]).toEqual([]);
        expect(sent[2]?.map((n) => n.key)).toEqual(["errors"]);
        expect(sent[2]?.[0]?.text).toContain("5 of 14 responses in the last 15 minutes");
        expect(sent[3]).toEqual([]);
        expect(sent[4]?.map((n) => [n.key, n.kind])).toEqual([["errors", "resolved"]]);
    });

    it("reports a crash loop and maintenance that keeps failing", () => {
        const steps: Partial<Observation>[] = [{ at: every5(0), metrics: sample() }];
        for (let i = 1; i <= 3; i++)
            steps.push({
                at: every5(i),
                // Each check finds a younger process than the last: it restarted in between.
                metrics: sample({ uptime: 60 - i * 10, maintenanceFailing: ["identity_deletion"] }),
            });
        const { sent } = checks(steps);
        expect(sent[2]).toEqual([]);
        expect(sent[3]?.map((n) => n.key).sort()).toEqual(["maintenance", "restarts"]);
        expect(sent[3]?.find((n) => n.key === "maintenance")?.text).toContain("identity_deletion");
    });

    it("escalates a filling database, reminds daily and resolves", () => {
        let { state, sent } = checks([
            { at: every5(0), metrics: sample({ databaseBytes: 425 * MB }) },
            { at: every5(1), metrics: sample({ databaseBytes: 430 * MB }) },
            { at: every5(2), metrics: sample({ databaseBytes: 480 * MB }) },
        ]);
        expect(sent[0]?.[0]).toMatchObject({ key: "database-size", kind: "alert" });
        expect(sent[0]?.[0]?.subject).toBe(
            "[Notato test] Warning: The database is at 85% of its allowance"
        );
        expect(sent[1]).toEqual([]);
        expect(sent[2]?.[0]).toMatchObject({ kind: "escalation", severity: "critical" });
        expect(sent[2]?.[0]?.subject).toStartWith("[Notato test] Worse: The database is at 96%");

        ({ state, sent } = checks(
            [{ at: every5(2) + DAY, metrics: sample({ databaseBytes: 480 * MB }) }],
            state
        ));
        const reminder = sent[0]?.[0] as Notification;
        expect(reminder).toMatchObject({ kind: "reminder" });
        expect(reminder.subject).toStartWith("[Notato test] Still failing:");
        ({ state, sent } = checks(
            [
                { at: every5(3) + DAY, metrics: sample({ databaseBytes: 480 * MB }) },
                { at: every5(4) + DAY, metrics: sample({ databaseBytes: 480 * MB }) },
                { at: every5(5) + DAY, metrics: sample({ databaseBytes: 100 * MB }) },
            ],
            state
        ));
        expect(sent[0]).toEqual([]);
        expect(sent[1]).toEqual([]);
        expect(sent[2]?.map((n) => [n.key, n.kind])).toEqual([["database-size", "resolved"]]);
    });

    it("alerts when no verified backup has been reported, and when the last one is overdue", () => {
        const { sent } = checks([
            { at: T0, metrics: sample(), backup: undefined },
            { at: T0 + 30 * MINUTE, metrics: sample(), backup: undefined },
            { at: T0 + 65 * MINUTE, metrics: sample(), backup: undefined },
            { at: T0 + 70 * MINUTE, metrics: sample() },
            {
                at: T0 + 2 * DAY,
                metrics: sample(),
                backup: { verifiedAt: T0 + 17 * HOUR, bytes: MB, images: 0, receivedAt: T0 + DAY },
            },
        ]);
        expect(sent[1]).toEqual([]);
        expect(sent[2]?.[0]).toMatchObject({ key: "backup", severity: "critical" });
        expect(sent[2]?.[0]?.subject).toBe(
            "[Notato test] Alert: No verified backup has been reported"
        );
        expect(sent[3]?.map((n) => [n.key, n.kind])).toEqual([["backup", "resolved"]]);
        expect(sent[4]?.[0]?.subject).toBe("[Notato test] Alert: Backups are overdue");
        expect(sent[4]?.[0]?.text).toContain("31 hours ago");
        expect(sent[4]?.[0]?.text).toContain("the limit is 30");
    });

    it("notices a day's unusual growth, a request surge, and egress near the month's allowance", () => {
        const steps: Partial<Observation>[] = [];
        for (let hour = 0; hour <= 24; hour++)
            steps.push({
                at: T0 + hour * HOUR,
                metrics: sample({ uptime: 1000 + hour * 3600, storedBytes: (5 + hour * 6) * MB }),
            });
        const growth = checks(steps);
        expect(growth.sent.slice(0, 24).flat()).toEqual([]);
        expect(growth.sent[24]?.map((n) => n.key)).toEqual(["growth"]);
        expect(growth.sent[24]?.[0]?.text).toContain("grew 144 MB in the last day");

        const usage = checks([
            { at: every5(0), metrics: sample({ responses: 0, egress: 0 }) },
            { at: every5(1), metrics: sample({ uptime: 1300, responses: 25_000, egress: 3 * GB }) },
            // A restart in between: its counter began again at zero.
            { at: every5(2), metrics: sample({ uptime: 20, responses: 10, egress: 1.5 * GB }) },
        ]);
        expect(usage.sent[1]?.map((n) => n.key)).toEqual(["requests"]);
        expect(usage.sent[1]?.[0]?.text).toContain("25,000 requests in the last hour");
        expect(usage.sent[2]?.map((n) => [n.key, n.severity])).toEqual([["egress", "warning"]]);
        expect(usage.sent[2]?.[0]?.text).toContain("4.5 GB of 5.0 GB");
        expect(usage.state.egressMonth).toEqual({ month: "2026-10", bytes: 4.5 * GB });

        // A new month starts counting again from the next growth of the counter.
        const november = checks(
            [
                {
                    at: Date.UTC(2026, 10, 1, 0, 5),
                    metrics: sample({ uptime: 9e5, egress: 1.75 * GB }),
                },
            ],
            usage.state
        );
        expect(november.state.egressMonth).toEqual({ month: "2026-11", bytes: 0.25 * GB });
        expect(november.sent[0]?.map((n) => [n.key, n.kind])).toContainEqual([
            "egress",
            "resolved",
        ]);
    });

    it("sends one weekly summary on Monday morning, which also shows the monitor is alive", () => {
        const monday = Date.UTC(2026, 9, 19, 8, 0);
        const { state } = checks([
            { at: monday - 7 * DAY, metrics: sample() },
            { at: monday - 6 * DAY, ready: false },
        ]);
        const seen: Observation = { at: monday, ready: true, backup: fresh(monday) };
        expect(
            weeklySummary(state, { ...seen, at: monday - HOUR }, LIMITS, "test")
        ).toBeUndefined();
        const summary = weeklySummary(state, seen, LIMITS, "test");
        expect(summary?.subject).toBe("[Notato test] Weekly status: 50.00% available");
        expect(summary?.text).toContain("Availability: 50.00% of 2 checks (1 failed).");
        expect(summary?.text).toContain("Database: 20 MB of 500 MB.");
        expect(summary?.text).toContain(
            "Last verified backup: 1 hours ago (20 MB, 3 screenshots)."
        );
        expect(
            weeklySummary(state, { ...seen, at: monday + HOUR }, LIMITS, "test")
        ).toBeUndefined();
    });
});
