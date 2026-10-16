/** One message from the app's console, in the web SDK's shape (`context.console`). */
export interface LogEntry {
    level: "error" | "warn";
    message: string;
    at: string;
}

const MAX = 1000;

/** Keys whose values are credentials, in whatever object is logged: a request's headers, its config, a form. */
const SECRET_KEY =
    /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|(access[-_]?|refresh[-_]?|id[-_]?)?token|password|passwd|secret|client[-_]?secret)$/i;

/** Credentials written into the text itself: `Bearer …` and `Basic …`, and a cookie or key header's value. */
const SECRET_TEXT: Array<[RegExp, string]> = [
    [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]"],
    [/\b(cookie|set-cookie|x-api-key)(["']?\s*[:=]\s*)[^\n"'}]+/gi, "$1$2[redacted]"],
];

/** A message with the credentials in it blanked out: they would go to the server and the agent with the note. */
function redact(text: string): string {
    return SECRET_TEXT.reduce((out, [pattern, to]) => out.replace(pattern, to), text);
}

function format(args: unknown[]): string {
    const text = redact(
        args
            .map((a) => {
                if (typeof a === "string") return a;
                if (a instanceof Error)
                    return a.stack
                        ? `${a.message}\n${a.stack.split("\n").slice(0, 4).join("\n")}`
                        : a.message;
                try {
                    return JSON.stringify(a, (key, value) =>
                        SECRET_KEY.test(key) && value != null ? "[redacted]" : value
                    );
                } catch {
                    return String(a);
                }
            })
            .join(" ")
    );
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
