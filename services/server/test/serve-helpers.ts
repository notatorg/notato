import { expect } from "bun:test";
import { join } from "node:path";
import type { Annotation } from "@notato/schema";
import { FileBlobStore } from "@notato/server";
import { runCloud } from "../src/index.ts";
import { HOSTED_LIMITS } from "../src/storage.ts";
import { annotationFixture, type Cleanup, filesFor, multipart, tempDir } from "./helpers.ts";
import { embeddedPostgres } from "./postgres.ts";

// A shared server (`notato serve`) on a free port, with logins, and what the tests do with it: sign in as the admin,
// issue tokens, post notes and read event streams.

/** The admin's password on every test server. */
export const ADMIN_PASSWORD = "correct horse";

/** A shared server with its own data folder, stopped (and the folder removed) once the test is over. */
export async function startServe(
    defer: (cleanup: Cleanup) => void,
    options: Partial<Parameters<typeof runCloud>[0]> = {},
    /** Headers every `call` carries, as a trusted proxy in front of the service would add them. */
    headers: Record<string, string> = {}
) {
    const dir = tempDir(defer, "notato-serve-");
    const rt = await runCloud({
        port: 0,
        dir,
        version: "t",
        adminPassword: ADMIN_PASSWORD,
        log: () => {},
        // Tests never inherit a developer's real hosted credentials or mutate a cloud database.
        managedAuth: null,
        billing: null,
        testPlans: false,
        resourceLimits: HOSTED_LIMITS,
        // Older authentication/storage suites intentionally exercise generic hosted limits.
        workspacePlans: Boolean(options.billing?.workspacePlans),
        hosted: false,
        store: options.store ?? (await embeddedPostgres()).store,
        blobs: options.blobs ?? new FileBlobStore(join(dir, "assets")),
        ...options,
    });
    defer(() => rt.stop());
    const base = `http://127.0.0.1:${rt.port}`;
    const call = (path: string, init: RequestInit = {}) =>
        fetch(`${base}${path}`, {
            ...init,
            headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        });
    return { rt, base, call };
}

export type Server = Awaited<ReturnType<typeof startServe>>;

export const login = async (s: Server, password = ADMIN_PASSWORD) =>
    s.call("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password }),
    });

/** Signs in as the admin and hands back the session cookie, ready for a `cookie` header. */
export async function adminCookie(s: Server): Promise<string> {
    const res = await login(s);
    expect(res.status).toBe(200);
    return (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

/** Projects are created before tokens are issued for them; creating one twice is harmless here. */
export async function createProject(s: Server, id: string) {
    if (id !== "*") await s.rt.backend.createProject(id);
}

/** A token for `projectId` (`*` for every project), issued by the admin as the board would. */
export async function issue(s: Server, projectId: string, name = "test"): Promise<string> {
    await createProject(s, projectId);
    const cookie = await adminCookie(s);
    const res = await s.call("/admin/tokens", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ projectId, name }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A note posted to `projectId` with `token`, as an SDK sends it. */
export async function post(
    s: Server,
    token: string,
    projectId: string,
    over: Partial<Annotation> = {}
) {
    const a = annotationFixture({ projectId, ...over });
    const res = await s.call(`/projects/${projectId}/annotations`, {
        method: "POST",
        headers: bearer(token),
        body: multipart(a, filesFor()),
    });
    return { a, res };
}

/** Reads an event stream frame by frame. Resolves with the data of the next frame named `event`. */
export function sse(res: Response) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return async (event: string, timeoutMs = 3000): Promise<unknown> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (frame.includes(`event: ${event}`))
                    return JSON.parse(/data: (.*)/.exec(frame)?.[1] ?? "null");
                continue;
            }
            const chunk = await Promise.race([
                reader.read(),
                new Promise<{ done: true; value?: undefined }>((resolve) =>
                    setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now()))
                ),
            ]);
            if (chunk.done) throw new Error(`no "${event}" event arrived`);
            buffer += decoder.decode(chunk.value);
        }
    };
}
