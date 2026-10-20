import type { CloudBackend } from "./backend.ts";
import type { ManagedAuth } from "./managed-auth.ts";
import type { AuthStore, Store } from "./storage.ts";

export type MaintenanceTask = "orphans" | "retention" | "identity_deletion" | "email_records";
export interface MaintenanceTaskResult {
    task: MaintenanceTask;
    removed: number;
    failed: boolean;
    milliseconds: number;
    finishedAt: number;
}
export interface MaintenanceResult {
    notesRemoved: number;
    identitiesRemoved: number;
    assetsRemoved: number;
    failed: boolean;
    tasks: MaintenanceTaskResult[];
}

/** Bounded maintenance. Retention is disabled until an owner explicitly chooses it. Provider deletion retries durably. */
export function startMaintenance(
    backend: Pick<CloudBackend, "collectOrphanAssets" | "expireAnnotations">,
    store: Pick<AuthStore, "pendingIdentityDeletions" | "identityDeletionResult"> &
        Partial<Pick<Store, "purgeEmailRecords">>,
    managed?: ManagedAuth,
    report: (result: MaintenanceResult) => void = () => {},
    /** Cutoff for detached marketing-email evidence, when the marketing choice is configured. */
    emailEvidenceCutoff?: () => string
) {
    let running: Promise<void> | undefined;
    let stopped = false;
    const run = () => {
        if (running || stopped) return running ?? Promise.resolve();
        running = (async () => {
            const tasks: MaintenanceTaskResult[] = [];
            const perform = async (
                task: MaintenanceTask,
                action: (result: MaintenanceTaskResult) => Promise<void>
            ) => {
                const start = performance.now();
                const result: MaintenanceTaskResult = {
                    task,
                    removed: 0,
                    failed: false,
                    milliseconds: 0,
                    finishedAt: 0,
                };
                try {
                    await action(result);
                } catch {
                    result.failed = true;
                }
                result.milliseconds = performance.now() - start;
                result.finishedAt = Date.now();
                tasks.push(result);
            };
            await perform("orphans", async (result) => {
                result.removed = await backend.collectOrphanAssets(Date.now());
            });
            await perform("retention", async (result) => {
                result.removed = await backend.expireAnnotations(new Date().toISOString());
            });
            const purgeEmailRecords = store.purgeEmailRecords?.bind(store);
            if (purgeEmailRecords && emailEvidenceCutoff)
                await perform("email_records", async (result) => {
                    result.removed = await purgeEmailRecords(emailEvidenceCutoff());
                });
            if (managed?.deleteUser) {
                const deleteUser = managed.deleteUser.bind(managed);
                await perform("identity_deletion", async (result) => {
                    for (const job of await store.pendingIdentityDeletions(
                        new Date().toISOString()
                    )) {
                        if (
                            job.provider !==
                            (managed.config.identityNamespace ?? "better-auth:instance")
                        )
                            continue;
                        let success = false;
                        try {
                            await deleteUser(job.subject);
                            success = true;
                        } catch {
                            result.failed = true;
                        }
                        try {
                            await store.identityDeletionResult(
                                job.provider,
                                job.subject,
                                success,
                                new Date(Date.now() + 3600_000).toISOString()
                            );
                            if (success) result.removed++;
                        } catch {
                            // A provider or storage failure for one identity must not starve later jobs.
                            result.failed = true;
                        }
                    }
                });
            }
            try {
                report({
                    notesRemoved: tasks.find((t) => t.task === "retention")?.removed ?? 0,
                    identitiesRemoved:
                        tasks.find((t) => t.task === "identity_deletion")?.removed ?? 0,
                    assetsRemoved: tasks.find((t) => t.task === "orphans")?.removed ?? 0,
                    failed: tasks.some((t) => t.failed),
                    tasks,
                });
            } catch {
                // Observability must not reject a background timer or interrupt future maintenance.
            }
        })().finally(() => {
            running = undefined;
        });
        return running;
    };
    const timer = setInterval(() => void run(), 600_000);
    timer.unref?.();
    return {
        run,
        async stop() {
            stopped = true;
            clearInterval(timer);
            await running;
        },
    };
}
