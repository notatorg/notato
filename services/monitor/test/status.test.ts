import { expect, it } from "bun:test";
import { evaluate, type Limits, type Observation, type Sample, type State } from "../src/rules.ts";
import { statusView } from "../src/status.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MINUTE = 60_000;
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
const backup = { verifiedAt: T0 - 3_600_000, bytes: 30 * MB, images: 4, receivedAt: T0 };

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

function run(steps: Partial<Observation>[]) {
    let state: State | undefined;
    for (const step of steps) {
        state = evaluate(
            state,
            { ready: true, backup, ...step, at: step.at ?? T0 } as Observation,
            LIMITS,
            "test"
        ).state;
        state.limits = LIMITS;
        state.target = "https://test.notato.dev";
    }
    return state as State;
}

it("shows nothing but a waiting state before the first check", () => {
    const view = statusView(undefined, undefined, T0);
    expect(view).toMatchObject({
        checkedAt: null,
        stale: true,
        status: "unknown",
        service: { ready: null, metrics: "unknown" },
        alerts: [],
        meters: [],
        backup: null,
        storage: [],
    });
});

it("reports traffic, sizes against their allowances and the last backup", () => {
    const state = run([
        { at: T0, metrics: sample() },
        { at: T0 + 5 * MINUTE, metrics: sample({ uptime: 1300, responses: 160, errors: 2 }) },
        {
            at: T0 + 10 * MINUTE,
            metrics: sample({
                uptime: 1600,
                responses: 200,
                errors: 3,
                egress: GB,
                databaseBytes: 410 * MB,
                volumeFreeBytes: 10 * GB,
            }),
        },
    ]);
    const view = statusView(state, backup, T0 + 11 * MINUTE);
    expect(view.checkedAt).toBe(T0 + 10 * MINUTE);
    expect(view.stale).toBe(false);
    expect(view.target).toBe("https://test.notato.dev");
    expect(view.service).toEqual({
        ready: true,
        live: undefined,
        metrics: "ok",
        downSince: undefined,
    });
    expect(view.traffic).toMatchObject({ requestsLastHour: 100, errorsLast15Minutes: 3 });
    expect(view.traffic.checks.map((c) => [c.responses, c.errors])).toEqual([
        [60, 2],
        [40, 1],
    ]);
    const meters = Object.fromEntries(view.meters.map((m) => [m.key, m]));
    expect(meters.database).toMatchObject({ used: 410 * MB, limit: 500 * MB, warnAt: 0.8 });
    expect(meters.egress).toMatchObject({ used: GB, limit: 5 * GB });
    expect(meters.backup).toMatchObject({ used: 30 * MB, limit: 10 * GB });
    expect(meters.disk).toMatchObject({ used: 90 * GB, limit: 100 * GB, warnAt: 0.85 });
    expect(view.backup).toEqual({ ...backup, maxAgeHours: 30 });
    // The database is past 80% and the disk past 85%: two warnings, so the page is a warning.
    expect(view.alerts.map((a) => [a.key, a.severity]).sort()).toEqual([
        ["database-size", "warning"],
        ["disk", "warning"],
    ]);
    expect(view.status).toBe("warning");
});

it("leads with an outage, and says when the monitor itself has stopped", () => {
    const state = run([
        { at: T0, metrics: sample() },
        { at: T0 + 5 * MINUTE, ready: false, live: true },
        { at: T0 + 10 * MINUTE, ready: false, live: true },
    ]);
    const view = statusView(state, backup, T0 + 11 * MINUTE);
    expect(view.status).toBe("critical");
    expect(view.service).toMatchObject({ ready: false, live: true, downSince: T0 + 5 * MINUTE });
    expect(view.alerts[0]).toMatchObject({ key: "down", severity: "critical" });
    expect(statusView(state, backup, T0 + 26 * MINUTE).stale).toBe(true);
});

it("reports a refused metrics credential", () => {
    const state = run([{ at: T0, metricsError: "unauthorized" }]);
    expect(statusView(state, undefined, T0).service.metrics).toBe("unauthorized");
});
