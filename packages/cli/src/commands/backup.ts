import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { backupLocal, generateBackupKey, restoreLocal } from "@notato/server";
import { createBackupSchedule, verifiedBackupHealthy } from "../backup-schedule.ts";
import { dataDir } from "../options.ts";

export async function runBackupCommand(command: string, args: string[]): Promise<number> {
    const { values } = parseArgs({
        args,
        options: {
            help: { type: "boolean", short: "h" },
            dir: { type: "string" },
            file: { type: "string" },
            key: { type: "string" },
            out: { type: "string" },
            keep: { type: "string" },
            "interval-hours": { type: "string" },
            verify: { type: "boolean" },
            config: { type: "string" },
        },
    });
    if (values.help) {
        console.log(
            command === "backup-keygen"
                ? "notato backup-keygen --key /private/backup.key"
                : command === "restore"
                  ? "notato restore --file backup.nbk --key /private/backup.key --dir /new/data/path"
                  : "notato backup --dir .notato --file backup.nbk --key /private/backup.key [--config path]\nScheduled: notato backup --dir /data --out /backups --key /keys/backup.key --interval-hours 24 --keep 14 --verify"
        );
        return 0;
    }
    if (!values.key)
        throw new Error("--key is required; store the encryption key separately from backup files");
    const key = resolve(values.key);
    if (command === "backup-keygen") {
        generateBackupKey(key);
        console.log(`Generated private backup key: ${key}`);
        return 0;
    }
    if (command === "restore") {
        if (!values.file || !values.dir) throw new Error("restore needs --file and a new --dir");
        restoreLocal({ file: values.file, dir: values.dir, key });
        console.log("Restore verified and complete");
        return 0;
    }
    const dir = dataDir(values.dir);
    if (!values["interval-hours"]) {
        if (!values.file) throw new Error("backup needs --file, or --out with --interval-hours");
        backupLocal({ dir, file: values.file, key, config: values.config });
        console.log("Encrypted backup complete");
        return 0;
    }
    if (!values.out) throw new Error("scheduled backups need --out");
    const hours = Number(values["interval-hours"]),
        keep = Number(values.keep ?? 14);
    if (
        !Number.isFinite(hours) ||
        hours < 1 ||
        hours > 168 ||
        !Number.isInteger(keep) ||
        keep < 1 ||
        keep > 365
    )
        throw new Error("interval must be 1–168 hours; keep must be 1–365 backups");
    const { run } = createBackupSchedule({
        dir,
        out: values.out,
        key,
        hours,
        keep,
        verify: values.verify ?? false,
        config: values.config,
    });
    run();
    await new Promise<void>((done) => {
        const timer = setInterval(run, 60_000);
        const stop = () => {
            clearInterval(timer);
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            done();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
    return 0;
}

export function backupHealthcheck(args: string[]): number {
    const { values } = parseArgs({
        args,
        options: { out: { type: "string" }, "max-age-hours": { type: "string" } },
    });
    const hours = Number(values["max-age-hours"] ?? 30);
    if (!values.out || !Number.isFinite(hours) || hours < 1 || hours > 720) return 1;
    return verifiedBackupHealthy(values.out, hours * 3600_000) ? 0 : 1;
}
