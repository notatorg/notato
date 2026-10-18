import { type ChildProcess, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { type DevRuntime, runDev } from "@notato/server";
import {
    appEnvironment,
    connectionRoot,
    selectedConnection,
    verifyConnection,
    watchConnection,
} from "../connection.ts";

/** The wrapper owns its process tree. Switching never leaves an old app sending to the previous server. */
export async function runApp(
    command: string[],
    root: string,
    signal: AbortSignal,
    cwd = root
): Promise<number> {
    if (!command.length)
        throw new Error("Use notato run -- <your app command>, for example npm run dev.");
    let child: ChildProcess | undefined,
        local: DevRuntime | undefined,
        closing = false,
        expected = false;
    let resolveDone: (code: number) => void = () => {};
    const done = new Promise<number>((r) => {
        resolveDone = r;
    });
    const stopChild = async () => {
        const previous = child;
        child = undefined;
        if (previous?.pid && previous.exitCode === null) {
            const exit = new Promise<void>((r) => previous.once("exit", () => r()));
            const kill = (signal: NodeJS.Signals) => {
                try {
                    if (process.platform !== "win32") process.kill(-previous.pid!, signal);
                    else previous.kill(signal);
                } catch {}
            };
            kill("SIGTERM");
            const timer = setTimeout(() => kill("SIGKILL"), 2000);
            await exit;
            // npm and framework launchers can exit before their children. Finish the owned group too.
            if (process.platform !== "win32") kill("SIGKILL");
            clearTimeout(timer);
        }
        await local?.close();
        local = undefined;
    };
    const start = async () => {
        expected = true;
        await stopChild();
        expected = false;
        if (closing) return;
        const c = selectedConnection(root);
        if (!c)
            throw new Error("Select a connection first with notato connection local or import.");
        await verifyConnection(c);
        if (closing) return;
        if (JSON.stringify(selectedConnection(root)) !== JSON.stringify(c))
            throw new Error("Connection changed during verification. Select it again.");
        if (c.mode === "local")
            local = await runDev({
                port: Number(new URL(c.server).port || 80),
                dir: join(root, ".notato"),
                configFile: join(root, "notato.config.json"),
                stdio: false,
                tunnel: false,
                version: "connection",
                projects: c.project ? [c.project] : undefined,
            });
        console.error(
            `[notato] ${c.mode === "local" ? "Local" : c.name} · ${c.server}${c.context ? ` · ${c.context.name}` : ""}`
        );
        child = spawn(command[0]!, command.slice(1), {
            cwd,
            env: appEnvironment(c),
            stdio: "inherit",
            detached: process.platform !== "win32",
            shell: process.platform === "win32",
        });
        child.once("error", () => {
            console.error("[notato] Could not launch the app command.");
            resolveDone(1);
        });
        child.once("exit", (code) => {
            if (!expected && !closing) resolveDone(code ?? 1);
        });
    };
    let chain = Promise.resolve();
    // Re-arm after every switch: watchConnection deliberately compares against one session's starting file.
    let off = () => {};
    const arm = () => {
        off();
        off = watchConnection(root, () => {
            off();
            chain = chain.then(async () => {
                try {
                    await start();
                } catch (e) {
                    console.error(`[notato] ${(e as Error).message}`);
                } finally {
                    if (!closing) arm();
                }
            });
        });
    };
    const abort = () => {
        closing = true;
        resolveDone(0);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
        chain = start();
        arm();
        await chain;
        if (signal.aborted) abort();
        return await done;
    } finally {
        closing = true;
        off();
        signal.removeEventListener("abort", abort);
        await chain;
        await stopChild();
    }
}
export async function runAppCommand(argv: string[]): Promise<number> {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(
            "notato run [--cwd <checkout>] -- <app command>\n\nLaunch the app with the selected Local/Cloud profile. A profile change stops and restarts the app; agent credentials never enter its environment."
        );
        return 0;
    }
    const separator = argv.indexOf("--");
    const options = separator < 0 ? [] : argv.slice(0, separator),
        command = separator < 0 ? argv : argv.slice(separator + 1);
    if (options.length && !(options.length === 2 && options[0] === "--cwd"))
        throw new Error("Use notato run [--cwd <path>] -- <app command>.");
    const cwd = resolve(options[1] ?? process.cwd());
    const root = connectionRoot(cwd);
    const controller = new AbortController(),
        stop = () => controller.abort();
    for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, stop);
    try {
        return await runApp(command, root, controller.signal, cwd);
    } finally {
        for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(s, stop);
    }
}
