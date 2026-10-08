import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildBundle, writeBundle } from "@notato/core";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import {
    type Backend,
    type ConfigSource,
    createApp,
    createMcpServer,
    FileBlobStore,
    LocalBackend,
    SqliteStore,
} from "../src/index.ts";

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

/**
 * An MCP client talking in memory to `target`: a server made with `createMcpServer`, or a backend to make a default one
 * for. The client calls itself `client`, which is the agent the server signs its replies with ("claude-code": Claude).
 */
export async function connectMcp(
    target: Backend | McpServer,
    defer: (cleanup: Cleanup) => void,
    { client: name = "claude-code" }: { client?: string } = {}
) {
    const server =
        target instanceof McpServer
            ? target
            : createMcpServer({ backend: target, version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name, version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    defer(() => client.close());
    /** Calls a tool and hands back its result. */
    const call = async (tool: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name: tool, arguments: args })) as unknown as ToolResult;
    return { client, server, call, text: toolText };
}

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

export function makeBackend(config?: ConfigSource) {
    const dir = mkdtempSync(join(tmpdir(), "notato-test-"));
    const store = new SqliteStore(":memory:");
    const backend = new LocalBackend(store, new FileBlobStore(join(dir, "assets")), { config });
    return {
        backend,
        store,
        dir,
        cleanup() {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

export function makeApp(
    options: Partial<Parameters<typeof createApp>[0]> = {},
    config?: ConfigSource
) {
    const ctx = makeBackend(config);
    const app = createApp({ backend: ctx.backend, mode: "dev", version: "test", ...options });
    /** Requests as Bun.serve would deliver them: with a Host header. */
    const call = (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (!headers.has("host")) headers.set("host", "localhost:4747");
        return app(new Request(`http://localhost:4747${path}`, { ...init, headers }));
    };
    return { ...ctx, app, call };
}

export async function ingest(
    call: ReturnType<typeof makeApp>["call"],
    over: Partial<Annotation> = {}
) {
    const annotation = annotationFixture(over);
    const res = await call(`/projects/${annotation.projectId}/annotations`, {
        method: "POST",
        body: multipart(annotation),
    });
    return { annotation, res, body: (await res.json()) as { seq: number; annotation: Annotation } };
}

// ---- bundles -------------------------------------------------------------------------------------

export const hex = async (bytes: Uint8Array) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) =>
        b.toString(16).padStart(2, "0")
    ).join("");

/**
 * What a browser produces in test mode: annotations whose screenshot ids are the real sha-256 of their
 * bytes, packaged through the same `buildBundle` + `writeBundle` the SDK uses.
 */
export async function makeBundleZip(
    count = 2,
    over: (n: number) => Partial<Annotation> = () => ({}),
    meta: Partial<Parameters<typeof buildBundle>[1]> = {}
) {
    const fullId = await hex(PNG);
    const cropId = await hex(PNG_B);
    const records = Array.from({ length: count }, (_, i) => {
        const annotation = annotationFixture({
            mode: "test",
            bundleId: null,
            screenshots: {
                full: { id: fullId, mime: "image/png", w: 1, h: 1 },
                crop: { id: cropId, mime: "image/png", w: 1, h: 1 },
            },
            ...over(i + 1),
        });
        return {
            annotation,
            assets: new Map<string, Blob>([
                [fullId, new Blob([PNG as BlobPart], { type: "image/png" })],
                [cropId, new Blob([PNG_B as BlobPart], { type: "image/png" })],
            ]),
        };
    });
    const { bundle } = buildBundle(records, {
        projectId: "checkout-web",
        author: { name: "Tester" },
        appName: "checkout-web",
        appVersion: "1.4.2",
        ...meta,
    });
    const zip = await writeBundle(bundle, async (ref) => (ref.id === fullId ? PNG : PNG_B));
    return { zip, bundle, originals: records.map((r) => r.annotation) };
}
