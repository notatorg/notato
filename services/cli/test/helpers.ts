import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

/** A new folder in the system's temp folder. `removeTempDirs` deletes it again. */
export function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
}

export function removeTempDirs(): void {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
