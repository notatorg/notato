/** One frame of a React component stack: the component, and where in the served bundle its element was created. */
export interface StackFrame {
    name: string;
    url: string;
    line: number;
    col: number;
}

/** A frame mapped back to the file you edit, by the Metro server that served the bundle. */
export interface SourceFrame {
    name: string;
    file: string;
    line: number;
    col: number;
}

/**
 * Reads a React component stack (`componentStack` from React Native's inspector) into frames:
 * `    at ProductCard (http://localhost:8081/index.bundle?platform=ios:1234:56)`, innermost first. Frames without a
 * location (`    at View`) are kept out.
 */
export function parseComponentStack(stack: string | undefined): StackFrame[] {
    const frames: StackFrame[] = [];
    for (const line of (stack ?? "").split("\n")) {
        const match = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/.exec(line);
        if (!match) continue;
        const [, name, url, l, c] = match;
        frames.push({ name: name as string, url: url as string, line: Number(l), col: Number(c) });
    }
    return frames;
}

/**
 * Where the Metro server is, from a frame's bundle URL (`http://localhost:8081`), or undefined. A pattern, not `URL`:
 * React Native's own URL does not implement `origin`.
 */
export function metroOrigin(frames: StackFrame[]): string | undefined {
    for (const frame of frames) {
        const origin = /^(https?:\/\/[^/?#]+)/i.exec(frame.url)?.[1];
        if (origin) return origin;
    }
    return undefined;
}

/** Code from a dependency, not the app's: never what a person means by "where". */
export const isLibraryFile = (file: string) => /[\\/]node_modules[\\/]/.test(file);

/**
 * Maps frames to the app's source files with the Metro server's `/symbolicate` (what LogBox uses). Resolves to
 * nothing when Metro does not answer in time; never rejects.
 */
export async function symbolicate(
    frames: StackFrame[],
    fetcher: typeof fetch = fetch,
    timeoutMs = 1500
): Promise<SourceFrame[]> {
    const origin = metroOrigin(frames);
    if (!origin || frames.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetcher(`${origin}/symbolicate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                stack: frames.map((f) => ({
                    file: f.url,
                    lineNumber: f.line,
                    column: f.col,
                    methodName: f.name,
                })),
            }),
            signal: controller.signal,
        });
        if (!res.ok) return [];
        const body = (await res.json()) as {
            stack?: Array<{ file?: string; lineNumber?: number; column?: number }>;
        };
        return (body.stack ?? []).flatMap((s, i) =>
            s.file && s.lineNumber && frames[i]
                ? [
                      {
                          name: (frames[i] as StackFrame).name,
                          file: s.file,
                          line: s.lineNumber,
                          // Metro answers with 0-based columns; every Notato location is 1-based.
                          col: (s.column ?? 0) + 1,
                      },
                  ]
                : []
        );
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
    }
}
