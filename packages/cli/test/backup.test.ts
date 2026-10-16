import { afterEach, expect, it } from "bun:test";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { generateBackupKey, SqliteStore } from "@notato/server";
import {
    createBackupSchedule,
    readBackupStatus,
    verifiedBackupHealthy,
} from "../src/backup-schedule.ts";
import { backupHealthcheck } from "../src/commands/backup.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const stores: SqliteStore[] = [];
afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    removeTempDirs();
});
function fixture(verify = true) {
    const root = tempDir("notato-backup-worker-"),
        dir = join(root, "data"),
        out = join(root, "backups");
    mkdirSync(dir);
    const store = new SqliteStore(join(dir, "notato.db"));
    stores.push(store);
    const options = {
        dir,
        out,
        key: join(root, "keys", "key"),
        hours: 24,
        keep: 2,
        verify,
        log: () => {},
    };
    return { root, dir, out, store, options };
}
const archives = (out: string) => readdirSync(out).filter((n) => n.endsWith(".nbk"));

it("requires a completed restore verification and persists its private status and schedule across restarts", () => {
    const { out, options } = fixture();
    const worker = createBackupSchedule(options);
    writeFileSync(join(out, "notato-2099-01-01T00-00-00.000Z.nbk"), "not an encrypted backup", {
        mode: 0o600,
    });
    expect(backupHealthcheck(["--out", out])).toBe(1);
    expect(worker.run()).toBe(true);
    const status = readBackupStatus(out);
    expect(status?.lastAttempt).toBe("complete");
    expect(status?.lastSuccess?.verified).toBe(true);
    expect(backupHealthcheck(["--out", out])).toBe(0);
    expect(statSync(join(out, "backup-status.json")).mode & 0o777).toBe(0o600);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    const metadata = readFileSync(join(out, "backup-status.json"), "utf8");
    expect(metadata).not.toContain(options.key);
    expect(metadata).not.toContain(options.dir);
    expect(readdirSync(out).some((n) => n.startsWith(".verify-") || n.startsWith(".notato-"))).toBe(
        false
    );
    const before = archives(out);
    expect(createBackupSchedule(options).run()).toBe(false);
    expect(archives(out)).toEqual(before);
    expect(
        verifiedBackupHealthy(
            out,
            30 * 3600_000,
            (status?.lastSuccess?.completedAt ?? 0) + 30 * 3600_000
        )
    ).toBe(false);
});

it("records failures without removing verified backups, keeps retries across restart and recovers once storage works", async () => {
    const { dir, out, options, store } = fixture();
    const now = Date.now();
    const worker = createBackupSchedule(options);
    expect(worker.run(now)).toBe(true);
    const good = readBackupStatus(out)?.lastSuccess;
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    rmSync(dir, { recursive: true });
    const retry = now + 25 * 3600_000;
    expect(worker.run(retry)).toBe(false);
    const failed = readBackupStatus(out);
    expect(failed?.lastAttempt).toBe("failed");
    expect(failed?.consecutiveFailures).toBe(1);
    expect(failed?.lastSuccess).toEqual(good);
    expect(good && existsSync(join(out, good.file))).toBe(true);
    // The previous verified archive is recent enough, but the latest attempt failed.
    expect(verifiedBackupHealthy(out, 30 * 3600_000, retry)).toBe(false);
    expect(archives(out)).toHaveLength(1);
    const restarted = createBackupSchedule(options);
    expect(restarted.run(retry + 30 * 60_000)).toBe(false);
    expect(readBackupStatus(out)?.consecutiveFailures).toBe(1);
    mkdirSync(dir);
    stores.push(new SqliteStore(join(dir, "notato.db")));
    expect(restarted.run(retry + 2 * 3600_000)).toBe(true);
    expect(readBackupStatus(out)?.consecutiveFailures).toBe(0);
    expect(verifiedBackupHealthy(out, 30 * 3600_000, retry + 2 * 3600_000 + 1000)).toBe(true);
});

it("rejects changed, missing or symlinked archives and interrupted or unsafe status files", () => {
    const { out, options } = fixture();
    expect(createBackupSchedule(options).run()).toBe(true);
    const status = readBackupStatus(out);
    const file = join(out, status?.lastSuccess?.file ?? "missing");
    const bytes = readFileSync(file);
    appendFileSync(file, "damage");
    expect(backupHealthcheck(["--out", out])).toBe(1);
    rmSync(file);
    expect(backupHealthcheck(["--out", out])).toBe(1);
    const elsewhere = join(options.dir, "unrelated-file");
    writeFileSync(elsewhere, bytes, { mode: 0o600 });
    symlinkSync(elsewhere, file);
    expect(backupHealthcheck(["--out", out])).toBe(1);
    const metadata = join(out, "backup-status.json");
    writeFileSync(metadata, JSON.stringify({ ...status, lastAttempt: "running" }));
    expect(backupHealthcheck(["--out", out])).toBe(1);
    writeFileSync(
        metadata,
        JSON.stringify({
            ...status,
            lastSuccess: { ...status?.lastSuccess, file: "../unrelated-file" },
        })
    );
    expect(backupHealthcheck(["--out", out])).toBe(1);
    expect(() => createBackupSchedule(options)).toThrow("cannot be read safely");
    writeFileSync(metadata, JSON.stringify(status));
    chmodSync(metadata, 0o644);
    expect(backupHealthcheck(["--out", out])).toBe(1);
    rmSync(metadata);
    symlinkSync(elsewhere, metadata);
    expect(backupHealthcheck(["--out", out])).toBe(1);
    expect(() => createBackupSchedule(options)).toThrow("cannot be read safely");
});

it("keeps the newest completed snapshots and never prunes unrelated files or symlinks", () => {
    const { root, out, options } = fixture();
    const worker = createBackupSchedule(options),
        now = Date.now();
    const unrelated = join(root, "important");
    writeFileSync(unrelated, "keep me");
    const link = join(out, "notato-2000-01-01T00-00-00.000Z.nbk");
    symlinkSync(unrelated, link);
    writeFileSync(join(out, "manual-backup.nbk"), "keep this too");
    for (let i = 0; i < 3; i++) expect(worker.run(now + i * 25 * 3600_000)).toBe(true);
    expect(archives(out)).toHaveLength(4); // Two completed snapshots, the manual file and the symlink.
    expect(readFileSync(unrelated, "utf8")).toBe("keep me");
    expect(readFileSync(join(out, "manual-backup.nbk"), "utf8")).toBe("keep this too");
    expect(verifiedBackupHealthy(out, 30 * 3600_000, now + 50 * 3600_000 + 1000)).toBe(true);
});

it("does not report unverified snapshots as restore-verified and refuses symlinked output directories", () => {
    const { root, out, options } = fixture(false);
    expect(createBackupSchedule(options).run()).toBe(true);
    expect(readBackupStatus(out)?.lastSuccess?.verified).toBe(false);
    expect(backupHealthcheck(["--out", out])).toBe(1);
    const link = join(root, "output-link");
    symlinkSync(out, link);
    expect(() => createBackupSchedule({ ...options, out: link })).toThrow("not a symlink");
});

it("refuses missing or replaced encryption keys so existing backups cannot be silently made unrecoverable", () => {
    const { out, options } = fixture();
    const worker = createBackupSchedule(options),
        now = Date.now();
    expect(worker.run(now)).toBe(true);
    const original = readFileSync(options.key),
        status = readBackupStatus(out);
    rmSync(options.key);
    expect(() => createBackupSchedule(options)).toThrow("restore the original key");
    expect(existsSync(options.key)).toBe(false);
    expect(readBackupStatus(out)).toEqual(status);
    generateBackupKey(options.key);
    expect(() => createBackupSchedule(options)).toThrow("does not match");
    expect(worker.run(now + 25 * 3600_000)).toBe(false);
    expect(archives(out)).toHaveLength(1);
    expect(readBackupStatus(out)?.lastAttempt).toBe("failed");
    expect(readBackupStatus(out)?.keyId).toBe(status?.keyId);
    writeFileSync(options.key, original, { mode: 0o600 });
    const restored = createBackupSchedule(options);
    expect(restored.run(now + 27 * 3600_000)).toBe(true);
    expect(readBackupStatus(out)?.lastAttempt).toBe("complete");
});

it("does not delete an existing archive when a scheduled filename collides", () => {
    const { out, options } = fixture();
    const worker = createBackupSchedule(options),
        now = Date.now();
    expect(worker.run(now)).toBe(true);
    const next = now + 25 * 3600_000;
    const collision = join(out, `notato-${new Date(next).toISOString().replaceAll(":", "-")}.nbk`);
    writeFileSync(collision, "existing backup must survive", { mode: 0o600 });
    expect(worker.run(next)).toBe(false);
    expect(readFileSync(collision, "utf8")).toBe("existing backup must survive");
    expect(readBackupStatus(out)?.lastAttempt).toBe("failed");
});
