/** One message from the app's console, in the web SDK's shape (`context.console`). */
export interface LogEntry {
    level: "error" | "warn";
    message: string;
    at: string;
}

const MAX = 1000;

function format(args: unknown[]): string {
    const text = args
        .map((a) => {
            if (typeof a === "string") return a;
            if (a instanceof Error)
                return a.stack
                    ? `${a.message}\n${a.stack.split("\n").slice(0, 4).join("\n")}`
                    : a.message;
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        })
        .join(" ");
    return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

/**
 * Keeps the app's last warnings and errors (`console.warn`, `console.error`), which is what explains a bug, by
 * wrapping the two: they still print, and React Native's LogBox still shows them. Returns a function that unwraps them.
 */
export function captureConsole(limit: () => number, into: LogEntry[]): () => void {
    const original = { warn: console.warn, error: console.error };
    let inside = false;
    const wrap =
        (level: LogEntry["level"]) =>
        (...args: unknown[]) => {
            if (!inside) {
                inside = true;
                try {
                    into.push({ level, message: format(args), at: new Date().toISOString() });
                    const over = into.length - Math.max(limit(), 0);
                    if (over > 0) into.splice(0, over);
                } finally {
                    inside = false;
                }
            }
            original[level].apply(console, args as []);
        };
    console.warn = wrap("warn");
    console.error = wrap("error");
    return () => {
        console.warn = original.warn;
        console.error = original.error;
    };
}
