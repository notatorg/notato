import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Annotation, sampleAnnotation } from "@notato/schema";

// ---- housekeeping ----------------------------------------------------------------------------------------------

/** Something to undo once a test is over: close a client, stop a server, remove a folder. */
export type Cleanup = () => unknown;

/**
 * Undoes, after each test of the file that calls it (once, at the top), what the test handed to the function it
 * returns, last first.
 */
export function cleanupAfterEach(): (cleanup: Cleanup) => void {
    const pending: Cleanup[] = [];
    afterEach(async () => {
        for (const cleanup of pending.splice(0).reverse()) await cleanup();
    });
    return (cleanup) => {
        pending.push(cleanup);
    };
}

/** A new empty folder, removed once the test is over. */
export function tempDir(defer: (cleanup: Cleanup) => void, prefix = "notato-test-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    defer(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** Waits until `check` holds, looking every 20ms; resolves with whether it did within `ms`. */
export async function waitFor(
    check: () => boolean | Promise<boolean>,
    ms = 3000
): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end && !(await check())) await Bun.sleep(20);
    return check();
}

// ---- MCP -------------------------------------------------------------------------------------------------------

/** A tool call's result as the MCP client hands it back. */
export interface ToolResult {
    isError?: boolean;
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

/** The text parts of a tool result, one per line. */
export const toolText = (result: ToolResult) =>
    result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");

// ---- notes as an SDK sends them --------------------------------------------------------------------------------

/** A real 1×1 PNG, so magic-byte sniffing sees what the SDK would send. */
export const PNG = Uint8Array.from(
    atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ),
    (c) => c.charCodeAt(0)
);

/** A different valid PNG (one byte changed in the payload), to get a second distinct hash. */
export const PNG_B = Uint8Array.from([
    ...PNG.slice(0, PNG.length - 20),
    1,
    ...PNG.slice(PNG.length - 19),
]);

export const clientId = (n: number) => String(n).repeat(64).slice(0, 64);

let counter = 0;
/** A valid annotation whose asset ids are client-side placeholders, as the SDK sends them. */
export function annotationFixture(over: Partial<Annotation> = {}): Annotation {
    counter += 1;
    const id = `01TEST${String(counter).padStart(20, "0")}`;
    return {
        ...sampleAnnotation,
        id,
        bundleId: null,
        status: "open",
        thread: [],
        comment: `comment ${counter}`,
        screenshots: {
            full: { id: clientId(1), mime: "image/png", w: 1, h: 1 },
            crop: { id: clientId(2), mime: "image/png", w: 1, h: 1 },
        },
        context: { screenshot: { method: "dom", pin: counter } },
        ...over,
    };
}

export const filesFor = () =>
    new Map<string, Uint8Array>([
        [clientId(1), PNG],
        [clientId(2), PNG_B],
    ]);

export function multipart(
    annotation: unknown,
    files: Map<string, Uint8Array> = filesFor(),
    extra: Record<string, string> = {}
) {
    const form = new FormData();
    form.set(
        "annotation",
        typeof annotation === "string" ? annotation : JSON.stringify(annotation)
    );
    for (const [id, bytes] of files)
        form.set(`asset:${id}`, new File([bytes as BlobPart], id, { type: "image/png" }));
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    return form;
}
