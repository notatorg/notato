/** How a program exited, and what it printed (stdout, then stderr). */
export interface ProgramResult {
    code: number;
    output: string;
}

/** Runs a program to completion, such as an agent's own `claude mcp add`. Injectable, so tests never run a real one. */
export type RunProgram = (command: string[], cwd?: string) => Promise<ProgramResult>;

export const runProgram: RunProgram = async (command, cwd) => {
    const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, output: `${out}${err}`.trim() };
};

/**
 * Exits once `close` has run, on Ctrl+C, `kill` or a closed terminal. For the commands that keep a server running:
 * nothing reads their stdin, so a signal is the only way they stop.
 */
export function stopOnSignals(close: () => Promise<void>): void {
    const stop = () => void close().finally(() => process.exit(0));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
}
