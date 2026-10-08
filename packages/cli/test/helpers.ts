import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProgramResult, RunProgram } from "../src/process.ts";

const made: string[] = [];

/** A new folder in the system's temp folder, with `files` written into it. `removeTempDirs` deletes it again. */
export function tempDir(prefix: string, files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    writeFiles(dir, files);
    return dir;
}

/** Deletes every folder `tempDir` made. Each test file runs it after each test. */
export function removeTempDirs(): void {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Writes files (path → content, paths relative to `root`), making their folders. */
export function writeFiles(root: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

export const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

/**
 * Stands in for the agents' own commands (`claude`, `codex`): every one is installed, and each run is recorded and
 * answered with `answer`. `commands` has what was run; `calls` has where, too.
 */
export function fakeCommands(answer: ProgramResult = { code: 0, output: "Added" }) {
    const calls: Array<{ command: string[]; cwd?: string }> = [];
    const commands: string[][] = [];
    const run: RunProgram = async (command, cwd) => {
        calls.push({ command, cwd });
        commands.push(command);
        return answer;
    };
    return { calls, commands, opts: { which: (name: string) => `/usr/local/bin/${name}`, run } };
}
