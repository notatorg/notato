import { expect, it } from "bun:test";
import { type MaintenanceResult, startMaintenance } from "../src/maintenance.ts";
import { Metrics } from "../src/metrics.ts";
import { cleanupAfterEach } from "./helpers.ts";
import { fakeManagedAuth } from "./hosted-helpers.ts";

const defer = cleanupAfterEach();
it("continues retention and identity deletion after orphan collection fails, and retries failed jobs independently", async () => {
    const actions: string[] = [],
        reports: MaintenanceResult[] = [],
        retryTimes: string[] = [];
    const managed = fakeManagedAuth();
    managed.deleteUser = async (subject) => {
        actions.push(`delete:${subject}`);
        if (subject === "provider-failure")
            throw new Error("private provider error and credential");
    };
    const metrics = new Metrics();
    const maintenance = startMaintenance(
        {
            async collectOrphanAssets() {
                throw new Error("private object path");
            },
            async expireAnnotations() {
                actions.push("retention");
                return 7;
            },
        },
        {
            async pendingIdentityDeletions() {
                return ["provider-failure", "storage-failure", "ok"]
                    .map((subject) => ({ provider: "better-auth", subject }))
                    .concat({ provider: "another-provider", subject: "skip" });
            },
            async identityDeletionResult(_provider, subject, success, retryAt) {
                actions.push(`persist:${subject}:${success}`);
                retryTimes.push(retryAt);
                if (subject === "storage-failure") throw new Error("private database connection");
            },
        },
        managed,
        (result) => {
            reports.push(result);
            for (const task of result.tasks) metrics.recordMaintenance(task);
        }
    );
    defer(() => maintenance.stop());
    const now = Date.now();
    await maintenance.run();
    expect(actions).toEqual([
        "retention",
        "delete:provider-failure",
        "persist:provider-failure:false",
        "delete:storage-failure",
        "persist:storage-failure:true",
        "delete:ok",
        "persist:ok:true",
    ]);
    expect(retryTimes.every((at) => Date.parse(at) >= now + 3600_000)).toBe(true);
    expect(reports[0]).toMatchObject({
        notesRemoved: 7,
        assetsRemoved: 0,
        identitiesRemoved: 1,
        failed: true,
    });
    expect(reports[0]?.tasks.map((t) => [t.task, t.failed])).toEqual([
        ["orphans", true],
        ["retention", false],
        ["identity_deletion", true],
    ]);
    const text = metrics.render();
    expect(text).toContain('notato_maintenance_last_run_failed{task="orphans"} 1');
    expect(text).toContain('notato_maintenance_runs_total{task="retention",result="success"} 1');
    expect(text).not.toContain("private");
    expect(text).not.toContain("provider-failure");
    expect(text).not.toContain("another-provider");
});

it("continues after retention and reporting failures and records recovery separately from past failures", async () => {
    let failed = false,
        retentionFails = false,
        deleted = 0;
    const metrics = new Metrics(),
        managed = fakeManagedAuth();
    managed.deleteUser = async () => {
        deleted++;
    };
    const maintenance = startMaintenance(
        {
            async collectOrphanAssets() {
                return 2;
            },
            async expireAnnotations() {
                if (retentionFails) throw new Error("secret");
                return 3;
            },
        },
        {
            async pendingIdentityDeletions() {
                return [{ provider: "better-auth", subject: "queued" }];
            },
            async identityDeletionResult() {},
        },
        managed,
        (result) => {
            failed = result.failed;
            for (const task of result.tasks) metrics.recordMaintenance(task);
            throw new Error("reporting unavailable");
        }
    );
    defer(() => maintenance.stop());
    await maintenance.run();
    retentionFails = true;
    await maintenance.run();
    expect(failed).toBe(true);
    expect(metrics.render()).toContain(
        'notato_maintenance_runs_total{task="retention",result="failure"} 1'
    );
    expect(metrics.render()).toContain('notato_maintenance_last_run_failed{task="retention"} 1');
    retentionFails = false;
    await maintenance.run();
    expect(failed).toBe(false);
    expect(deleted).toBe(3);
    const text = metrics.render();
    expect(text).toContain('notato_maintenance_runs_total{task="retention",result="success"} 2');
    expect(text).toContain('notato_maintenance_runs_total{task="retention",result="failure"} 1');
    expect(text).toContain('notato_maintenance_last_run_failed{task="retention"} 0');
});

it("prevents overlapping runs and waits for in-flight work on shutdown", async () => {
    let release: () => void = () => {},
        runs = 0,
        stopped = false;
    const gate = new Promise<void>((done) => {
        release = done;
    });
    const maintenance = startMaintenance(
        {
            async collectOrphanAssets() {
                runs++;
                await gate;
                return 0;
            },
            async expireAnnotations() {
                return 0;
            },
        },
        {
            async pendingIdentityDeletions() {
                return [];
            },
            async identityDeletionResult() {},
        }
    );
    defer(() => maintenance.stop());
    const first = maintenance.run(),
        second = maintenance.run();
    expect(first).toBe(second);
    const stop = maintenance.stop().then(() => {
        stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    await maintenance.run();
    expect(runs).toBe(1);
});
