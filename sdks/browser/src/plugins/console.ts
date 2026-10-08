import type { CapturePlugin } from "@notato/core";

export interface ConsoleEntry {
    level: "log" | "info" | "warn" | "error" | "debug" | "uncaught" | "unhandledrejection";
    message: string;
    at: string;
}

export interface ConsoleOptions {
    /** Entries kept in the ring buffer and attached to each annotation. */
    limit?: number;
    levels?: ConsoleEntry["level"][];
}

const MAX_MESSAGE = 1000;

function format(arg: unknown): string {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
    try {
        return JSON.stringify(arg) ?? String(arg);
    } catch {
        return String(arg);
    }
}

const clip = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s);

/** Keeps the last few console messages and uncaught errors from the moment the SDK mounted. */
export function consolePlugin(options: ConsoleOptions = {}): CapturePlugin {
    const limit = options.limit ?? 50;
    const levels = new Set(
        options.levels ?? [
            "log",
            "info",
            "warn",
            "error",
            "debug",
            "uncaught",
            "unhandledrejection",
        ]
    );
    const buffer: ConsoleEntry[] = [];
    const push = (level: ConsoleEntry["level"], message: string) => {
        if (!levels.has(level)) return;
        buffer.push({ level, message: clip(message), at: new Date().toISOString() });
        if (buffer.length > limit) buffer.shift();
    };

    return {
        id: "console",
        setup() {
            const original: Partial<Record<string, (...args: unknown[]) => void>> = {};
            for (const level of ["log", "info", "warn", "error", "debug"] as const) {
                const fn = console[level].bind(console) as (...args: unknown[]) => void;
                original[level] = console[level];
                console[level] = (...args: unknown[]) => {
                    push(level, args.map(format).join(" "));
                    fn(...args);
                };
            }
            const onError = (e: ErrorEvent) =>
                push("uncaught", e.error ? format(e.error) : e.message);
            const onRejection = (e: PromiseRejectionEvent) =>
                push("unhandledrejection", format(e.reason));
            window.addEventListener("error", onError);
            window.addEventListener("unhandledrejection", onRejection);
            return () => {
                for (const [level, fn] of Object.entries(original)) {
                    (console as unknown as Record<string, unknown>)[level] = fn;
                }
                window.removeEventListener("error", onError);
                window.removeEventListener("unhandledrejection", onRejection);
            };
        },
        async capture() {
            return { context: { console: [...buffer] } };
        },
    };
}
