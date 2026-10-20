import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { databaseIn, ensureDataDir, runDev, runServe } from "../src/index.ts";
import { cleanupAfterEach, tempDir } from "./helpers.ts";

const defer = cleanupAfterEach();

const modeOf = (path: string) => statSync(path).mode & 0o777;

// File modes mean nothing on Windows.
describe.skipIf(process.platform === "win32")("the data directory", () => {
    it("is made readable by this user only, and so is its database, journal files included", async () => {
        const dir = join(tempDir(defer), "nested", ".notato");
        const dev = await runDev({ port: 0, dir, version: "t", stdio: false, log: () => {} });
        defer(() => dev.close());
        expect(modeOf(dir)).toBe(0o700);
        expect(modeOf(join(dir, "notato.db"))).toBe(0o600);
        for (const journal of ["notato.db-wal", "notato.db-shm"]) {
            const file = join(dir, journal);
            if (existsSync(file)) expect(modeOf(file), journal).toBe(0o600);
        }
    });

    it("is made private when it is already there, open to others, from before", () => {
        const dir = join(tempDir(defer), ".notato");
        mkdirSync(dir);
        chmodSync(dir, 0o755);
        writeFileSync(join(dir, "notato.db"), "");
        chmodSync(join(dir, "notato.db"), 0o644);
        ensureDataDir(dir);
        expect(modeOf(dir)).toBe(0o700);
        expect(modeOf(databaseIn(dir))).toBe(0o600);
    });

    it("is private on a shared server too", async () => {
        const dir = join(tempDir(defer), "data");
        const rt = await runServe({
            port: 0,
            dir,
            version: "t",
            adminPassword: "correct horse",
            log: () => {},
        });
        defer(() => rt.stop());
        expect(modeOf(dir)).toBe(0o700);
        expect(modeOf(join(dir, "notato.db"))).toBe(0o600);
    });
});
