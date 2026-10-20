import { statfs } from "node:fs/promises";
import type { MaintenanceTask, MaintenanceTaskResult } from "./maintenance.ts";
import type { Store } from "./storage.ts";

/** The service's size, measured when metrics are read; a part that could not be measured is absent. */
export interface Capacity {
    databaseBytes?: number;
    storedBytes?: number;
    volumeBytes?: number;
    volumeFreeBytes?: number;
}

/** How long a capacity sample answers repeated reads, so a collector cannot make every read query the database. */
const CAPACITY_TTL_MS = 60_000;

/** The database and stored bytes from the store, and the data folder's filesystem; each part is measured alone. */
export async function sampleCapacity(store: Store, dir: string): Promise<Capacity> {
    const [records, volume] = await Promise.allSettled([store.serviceCapacity?.(), statfs(dir)]);
    return {
        ...(records.status === "fulfilled" ? records.value : {}),
        ...(volume.status === "fulfilled"
            ? {
                  volumeBytes: volume.value.blocks * volume.value.bsize,
                  volumeFreeBytes: volume.value.bavail * volume.value.bsize,
              }
            : {}),
    };
}

/** Aggregate counters deliberately contain no URLs, customer IDs, IPs or credentials. */
export class Metrics {
    private responses = new Map<number, number>();
    private count = 0;
    private duration = 0;
    private maintenance = new Map<
        MaintenanceTask,
        {
            successes: number;
            failures: number;
            seconds: number;
            lastAttempt: number;
            lastSuccess: number;
            lastFailed: boolean;
            removed: number;
        }
    >();
    private capacitySource?: () => Promise<Capacity>;
    private capacity: Capacity = {};
    private capacitySampledAt?: number;
    private capacitySampling?: Promise<void>;
    private egressSource?: () => number;
    constructor(private now: () => number = Date.now) {}
    record(status: number, milliseconds: number) {
        this.count++;
        this.duration += milliseconds / 1000;
        this.responses.set(status, (this.responses.get(status) ?? 0) + 1);
    }
    recordMaintenance(result: MaintenanceTaskResult) {
        const counters = this.maintenance.get(result.task) ?? {
            successes: 0,
            failures: 0,
            seconds: 0,
            lastAttempt: 0,
            lastSuccess: 0,
            lastFailed: false,
            removed: 0,
        };
        if (result.failed) counters.failures++;
        else counters.successes++;
        counters.seconds += result.milliseconds / 1000;
        counters.lastAttempt = result.finishedAt / 1000;
        if (!result.failed) counters.lastSuccess = counters.lastAttempt;
        counters.lastFailed = result.failed;
        counters.removed += result.removed;
        this.maintenance.set(result.task, counters);
    }
    /** Where capacity comes from; it is sampled when metrics are read, at most once a minute. */
    measureCapacity(source: () => Promise<Capacity>) {
        this.capacitySource = source;
    }
    /** Where the object store's billed egress comes from, when it is a provider's. */
    measureEgress(source: () => number) {
        this.egressSource = source;
    }
    /**
     * Takes a fresh capacity sample when the last is over a minute old; concurrent reads share one. A sample that
     * fails or takes over five seconds leaves the last one in place, and its timestamp shows how old that is.
     */
    async refresh() {
        const source = this.capacitySource;
        const age = this.now() - (this.capacitySampledAt ?? Number.NEGATIVE_INFINITY);
        if (!source || age < CAPACITY_TTL_MS) return;
        this.capacitySampling ??= Promise.race([
            source(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("capacity sample timed out")), 5000).unref()
            ),
        ])
            .then(
                (capacity) => {
                    this.capacity = capacity;
                    this.capacitySampledAt = this.now();
                },
                () => {}
            )
            .finally(() => {
                this.capacitySampling = undefined;
            });
        await this.capacitySampling;
    }
    render() {
        const gauge = (name: string, value: number | undefined) =>
            value === undefined ? [] : [`# TYPE ${name} gauge`, `${name} ${value}`];
        const egress = this.egressSource?.();
        return [
            "# TYPE notato_http_responses_total counter",
            ...Array.from(
                this.responses,
                ([status, count]) => `notato_http_responses_total{status="${status}"} ${count}`
            ),
            "# TYPE notato_http_duration_seconds summary",
            `notato_http_duration_seconds_count ${this.count}`,
            `notato_http_duration_seconds_sum ${this.duration}`,
            "# TYPE notato_maintenance_runs_total counter",
            "# TYPE notato_maintenance_duration_seconds summary",
            "# TYPE notato_maintenance_last_attempt_timestamp_seconds gauge",
            "# TYPE notato_maintenance_last_success_timestamp_seconds gauge",
            "# TYPE notato_maintenance_last_run_failed gauge",
            "# TYPE notato_maintenance_removed_total counter",
            ...Array.from(this.maintenance, ([task, c]) =>
                [
                    `notato_maintenance_runs_total{task="${task}",result="success"} ${c.successes}`,
                    `notato_maintenance_runs_total{task="${task}",result="failure"} ${c.failures}`,
                    `notato_maintenance_duration_seconds_count{task="${task}"} ${c.successes + c.failures}`,
                    `notato_maintenance_duration_seconds_sum{task="${task}"} ${c.seconds}`,
                    `notato_maintenance_last_attempt_timestamp_seconds{task="${task}"} ${c.lastAttempt}`,
                    `notato_maintenance_last_success_timestamp_seconds{task="${task}"} ${c.lastSuccess}`,
                    `notato_maintenance_last_run_failed{task="${task}"} ${Number(c.lastFailed)}`,
                    `notato_maintenance_removed_total{task="${task}"} ${c.removed}`,
                ].join("\n")
            ),
            ...gauge("notato_database_bytes", this.capacity.databaseBytes),
            ...gauge("notato_stored_bytes", this.capacity.storedBytes),
            ...gauge("notato_data_volume_bytes", this.capacity.volumeBytes),
            ...gauge("notato_data_volume_free_bytes", this.capacity.volumeFreeBytes),
            ...(this.capacitySampledAt !== undefined
                ? gauge("notato_capacity_sampled_timestamp_seconds", this.capacitySampledAt / 1000)
                : []),
            ...(egress === undefined
                ? []
                : [
                      "# TYPE notato_object_egress_bytes_total counter",
                      `notato_object_egress_bytes_total ${egress}`,
                  ]),
            "# TYPE notato_uptime_seconds gauge",
            `notato_uptime_seconds ${process.uptime()}`,
            "# TYPE notato_process_resident_bytes gauge",
            `notato_process_resident_bytes ${process.memoryUsage().rss}`,
            "",
        ].join("\n");
    }
}
