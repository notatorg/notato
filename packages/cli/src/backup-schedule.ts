import { createHash } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    existsSync,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backupLocal, generateBackupKey, restoreLocal } from "@notato/server";

const STATUS_FILE = "backup-status.json";
const BACKUP_NAME = /^notato-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.nbk$/;
const HOUR = 3600_000;

interface CompletedBackup {
    file: string;
    completedAt: number;
    verified: boolean;
    bytes: number;
    mtimeMs: number;
}
export interface BackupStatus {
    version: 1;
    keyId: string;
    lastAttemptAt: number;
    lastAttempt: "running" | "complete" | "failed";
    nextRunAt: number;
    consecutiveFailures: number;
    lastSuccess?: CompletedBackup;
}

function positive(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function validateStatus(value: unknown): BackupStatus {
    const s = value as Partial<BackupStatus> | null;
    if (
        s?.version !== 1 ||
        typeof s.keyId !== "string" ||
        !/^[a-f0-9]{64}$/.test(s.keyId) ||
        !positive(s.lastAttemptAt) ||
        !positive(s.nextRunAt) ||
        !["running", "complete", "failed"].includes(s.lastAttempt ?? "") ||
        !Number.isSafeInteger(s.consecutiveFailures) ||
        (s.consecutiveFailures ?? -1) < 0
    )
        throw new Error("invalid backup status");
    const b = s.lastSuccess;
    if (
        b !== undefined &&
        (!b ||
            typeof b.file !== "string" ||
            !BACKUP_NAME.test(b.file) ||
            !positive(b.completedAt) ||
            typeof b.verified !== "boolean" ||
            !Number.isSafeInteger(b.bytes) ||
            b.bytes <= 0 ||
            !positive(b.mtimeMs))
    )
        throw new Error("invalid backup status");
    if (s.lastAttempt === "complete" && (!b || s.consecutiveFailures !== 0))
        throw new Error("invalid backup status");
    return {
        version: 1,
        keyId: s.keyId,
        lastAttemptAt: s.lastAttemptAt,
        lastAttempt: s.lastAttempt as BackupStatus["lastAttempt"],
        nextRunAt: s.nextRunAt,
        consecutiveFailures: s.consecutiveFailures as number,
        ...(b
            ? {
                  lastSuccess: {
                      file: b.file,
                      completedAt: b.completedAt,
                      verified: b.verified,
                      bytes: b.bytes,
                      mtimeMs: b.mtimeMs,
                  },
              }
            : {}),
    };
}

function keyId(path: string): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer | undefined;
    try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size !== 32)
            throw new Error("backup key must be a private regular file with 32 random bytes");
        bytes = readFileSync(fd);
        if (bytes.length !== 32) throw new Error("backup key changed while being read");
        return createHash("sha256").update(bytes).digest("hex");
    } finally {
        bytes?.fill(0);
        closeSync(fd);
    }
}

/** Private metadata only: no database contents, credentials, keys or source paths. */
export function readBackupStatus(out: string): BackupStatus | undefined {
    let fd: number;
    try {
        fd = openSync(
            join(out, STATUS_FILE),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("backup status cannot be read safely");
    }
    try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 8192)
            throw new Error("invalid backup status");
        return validateStatus(JSON.parse(readFileSync(fd, "utf8")));
    } catch {
        throw new Error("backup status cannot be read safely");
    } finally {
        closeSync(fd);
    }
}

function writeStatus(out: string, status: BackupStatus) {
    const temporary = join(out, `.backup-status-${crypto.randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        writeFileSync(fd, JSON.stringify(status));
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, join(out, STATUS_FILE));
        const directory = openSync(out, constants.O_RDONLY);
        try {
            fsyncSync(directory);
        } finally {
            closeSync(directory);
        }
    } finally {
        if (fd !== undefined) closeSync(fd);
        rmSync(temporary, { force: true });
    }
}

function archiveInfo(path: string) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0)
            throw new Error("backup must be a private regular file");
        return info;
    } finally {
        closeSync(fd);
    }
}

/** Health is based on a completed restore verification, never on a recent-looking filename. */
export function verifiedBackupHealthy(
    out: string,
    maxAgeMilliseconds: number,
    now = Date.now()
): boolean {
    if (!positive(maxAgeMilliseconds) || !positive(now)) return false;
    try {
        const status = readBackupStatus(out),
            b = status?.lastSuccess;
        if (
            status?.lastAttempt !== "complete" ||
            status.consecutiveFailures !== 0 ||
            !b?.verified ||
            b.completedAt > now ||
            b.completedAt < status.lastAttemptAt ||
            now - b.completedAt >= maxAgeMilliseconds
        )
            return false;
        const info = archiveInfo(join(out, b.file));
        return info.size === b.bytes && info.mtimeMs === b.mtimeMs;
    } catch {
        return false;
    }
}

export function createBackupSchedule(options: {
    dir: string;
    out: string;
    key: string;
    hours: number;
    keep: number;
    verify: boolean;
    config?: string;
    log?: (message: string, failed: boolean) => void;
}) {
    if (
        !positive(options.hours) ||
        options.hours < 1 ||
        options.hours > 168 ||
        !Number.isSafeInteger(options.keep) ||
        options.keep < 1 ||
        options.keep > 365
    )
        throw new Error("interval must be 1–168 hours; keep must be 1–365 backups");
    const out = resolve(options.out),
        key = resolve(options.key);
    mkdirSync(out, { recursive: true, mode: 0o700 });
    if (!lstatSync(out).isDirectory())
        throw new Error("backup output must be a directory, not a symlink");
    chmodSync(out, 0o700);
    let status = readBackupStatus(out);
    if (!existsSync(key)) {
        if (status || readdirSync(out).some((n) => n.endsWith(".nbk")))
            throw new Error("backup key is missing for existing backups; restore the original key");
        mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
        generateBackupKey(key);
    }
    const fingerprint = keyId(key);
    if (status && status.keyId !== fingerprint)
        throw new Error("backup key does not match previous backups; restore the original key");
    const log = (message: string, failed: boolean) => {
        try {
            if (options.log) options.log(message, failed);
            else if (failed) console.error(message);
            else console.log(message);
        } catch {
            // The persisted result remains authoritative even when a log sink fails.
        }
    };
    return {
        run(now = Date.now()): boolean {
            if (status && now < status.nextRunAt) return false;
            const started = Date.now(),
                previous = status?.lastSuccess;
            const name = `notato-${new Date(now).toISOString().replaceAll(":", "-")}.nbk`;
            const file = join(out, name);
            let created = false,
                completed: CompletedBackup | undefined;
            const elapsedNow = () => now + Math.max(0, Date.now() - started);
            status = {
                version: 1,
                keyId: fingerprint,
                lastAttemptAt: now,
                lastAttempt: "running",
                nextRunAt: now + HOUR,
                consecutiveFailures: status?.consecutiveFailures ?? 0,
                ...(previous ? { lastSuccess: previous } : {}),
            };
            try {
                if (keyId(key) !== fingerprint)
                    throw new Error("backup key changed; restore the original key");
                // A force-killed worker leaves an incomplete attempt, which fails health until retried.
                writeStatus(out, status);
                backupLocal({ dir: options.dir, file, key, config: options.config });
                created = true;
                if (options.verify) {
                    const restored = join(out, `.verify-${crypto.randomUUID()}`);
                    try {
                        restoreLocal({ file, dir: restored, key });
                    } finally {
                        rmSync(restored, { recursive: true, force: true });
                    }
                }
                const info = archiveInfo(file);
                completed = {
                    file: name,
                    completedAt: elapsedNow(),
                    verified: options.verify,
                    bytes: info.size,
                    mtimeMs: info.mtimeMs,
                };
                const files = readdirSync(out)
                    .filter(
                        (n) => BACKUP_NAME.test(n) && n <= name && lstatSync(join(out, n)).isFile()
                    )
                    .sort()
                    .reverse();
                for (const old of files.slice(options.keep)) rmSync(join(out, old));
                status = {
                    ...status,
                    lastAttempt: "complete",
                    consecutiveFailures: 0,
                    lastSuccess: completed,
                    nextRunAt: elapsedNow() + options.hours * HOUR,
                };
                writeStatus(out, status);
                log(
                    `[notato] encrypted backup and ${options.verify ? "restore verification" : "snapshot"} complete; retained ${Math.min(files.length, options.keep)} backups`,
                    false
                );
                return true;
            } catch {
                if (created && !completed) {
                    try {
                        rmSync(file, { force: true });
                    } catch {
                        /* Leave it unverified; health still fails. */
                    }
                }
                status = {
                    ...status,
                    lastAttempt: "failed",
                    consecutiveFailures: status.consecutiveFailures + 1,
                    nextRunAt: elapsedNow() + HOUR,
                    ...(completed ? { lastSuccess: completed } : {}),
                };
                try {
                    writeStatus(out, status);
                } catch {
                    /* The running or previous status cannot claim this attempt succeeded. */
                }
                log(
                    "[notato] backup worker failed; retry in one hour; check worker health and available storage",
                    true
                );
                return false;
            }
        },
    };
}
