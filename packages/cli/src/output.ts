/**
 * What a command prints and the code it exits with, returned rather than written, for the commands that never need
 * the process (config, webhook, inject): their tests read the result.
 */
export interface CommandOutput {
    code: number;
    stdout: string;
    stderr: string;
}

/** A mistake in how the command was called, rather than a failure of what it did: it exits with 2. */
export class UsageError extends Error {}

/** Lines for stdout and stderr, collected as a command runs, then handed back with its exit code. */
export function collectOutput() {
    const out: string[] = [];
    const err: string[] = [];
    const done = (code: number): CommandOutput => ({
        code,
        stdout: out.join("\n"),
        stderr: err.join("\n"),
    });
    return { out, err, done };
}

/** Writes a command's output to the terminal and gives back its exit code. */
export function print({ code, stdout, stderr }: CommandOutput): number {
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    return code;
}
