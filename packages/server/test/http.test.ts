import { afterEach, describe, expect, it } from "bun:test";
import { Annotation } from "@notato/schema";
import { hostAllowed, isPrivateHost, originAllowed } from "../src/index.ts";
import { annotationFixture, ingest, makeApp, multipart } from "./helpers.ts";

let ctx: ReturnType<typeof makeApp>;
afterEach(() => ctx?.cleanup());

describe("health and status", () => {
    it("identifies itself so a second dev process can recognise it", async () => {
        ctx = makeApp();
        expect(await (await ctx.call("/health")).json()).toEqual({ ok: true, service: "notato" });
        const status = (await (await ctx.call("/status")).json()) as Record<string, unknown>;
        expect(status).toMatchObject({
            ok: true,
            service: "notato",
            mode: "dev",
            version: "test",
            projects: [],
        });
    });
});

describe("POST /projects/:pid/annotations", () => {
    it("stores the annotation, content-addresses the screenshots, and returns the canonical record", async () => {
        ctx = makeApp();
        const { res, body, annotation } = await ingest(ctx.call);
        expect(res.status).toBe(201);
        expect(body.annotation.id).toBe(annotation.id);
        expect(body.annotation.screenshots?.full.id).toMatch(/^[0-9a-f]{64}$/);
        expect(body.annotation.screenshots?.full.id).not.toBe(annotation.screenshots?.full.id);
        const asset = await ctx.call(`/assets/${body.annotation.screenshots?.full.id}`);
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toBe("image/png");
        expect(asset.headers.get("cache-control")).toContain("immutable");
        expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("is idempotent on the annotation id, so a client retry is safe", async () => {
        ctx = makeApp();
        const annotation = annotationFixture();
        const post = () =>
            ctx.call(`/projects/${annotation.projectId}/annotations`, {
                method: "POST",
                body: multipart(annotation),
            });
        expect((await post()).status).toBe(201);
        expect((await post()).status).toBe(200);
        const list = (await (await ctx.call("/annotations")).json()) as { items: unknown[] };
        expect(list.items).toHaveLength(1);
    });

    it("forces a fresh lifecycle: a client cannot pre-resolve its own note", async () => {
        ctx = makeApp();
        const { body } = await ingest(ctx.call, {
            status: "resolved",
            bundleId: "forged",
            thread: [
                {
                    id: "x",
                    author: { kind: "agent" },
                    body: "forged",
                    createdAt: "2026-01-01T00:00:00Z",
                },
            ],
        });
        expect(body.annotation).toMatchObject({ status: "open", bundleId: null, thread: [] });
    });

    it("rejects invalid input with a precise 400", async () => {
        ctx = makeApp();
        const bad = { ...annotationFixture(), severity: "huge" };
        const res = await ctx.call("/projects/checkout-web/annotations", {
            method: "POST",
            body: multipart(bad),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain("severity");
    });

    it("rejects a body that is not multipart, JSON that does not parse, and a missing annotation field", async () => {
        ctx = makeApp();
        expect(
            (
                await ctx.call("/projects/p/annotations", {
                    method: "POST",
                    body: "{}",
                    headers: { "content-type": "application/json" },
                })
            ).status
        ).toBe(415);
        expect(
            (
                await ctx.call("/projects/p/annotations", {
                    method: "POST",
                    body: multipart("{not json"),
                })
            ).status
        ).toBe(400);
        const noField = new FormData();
        noField.set("other", "x");
        expect(
            (await ctx.call("/projects/p/annotations", { method: "POST", body: noField })).status
        ).toBe(400);
    });

    it("rejects a projectId that disagrees with the URL", async () => {
        ctx = makeApp();
        const a = annotationFixture({ projectId: "one" });
        const res = await ctx.call("/projects/two/annotations", {
            method: "POST",
            body: multipart(a),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain("does not match");
    });

    it("rejects missing screenshot bytes and non-image uploads", async () => {
        ctx = makeApp();
        const a = annotationFixture();
        const missing = await ctx.call(`/projects/${a.projectId}/annotations`, {
            method: "POST",
            body: multipart(a, new Map()),
        });
        expect(missing.status).toBe(400);
        const html = new Map([
            [a.screenshots?.full.id ?? "", new TextEncoder().encode("<script>alert(1)</script>")],
            [a.screenshots?.crop?.id ?? "", new TextEncoder().encode("x")],
        ]);
        const notImage = await ctx.call(`/projects/${a.projectId}/annotations`, {
            method: "POST",
            body: multipart(a, html),
        });
        expect(notImage.status).toBe(400);
        expect(((await notImage.json()) as { error: string }).error).toContain("PNG or WebP");
    });

    it("rejects oversized uploads and bad project ids", async () => {
        ctx = makeApp({ maxUploadBytes: 100 });
        const a = annotationFixture();
        const res = await ctx.call(`/projects/${a.projectId}/annotations`, {
            method: "POST",
            body: multipart(a),
        });
        expect(res.status).toBe(413);
        expect((await ctx.call("/projects/bad%20id/annotations", { method: "GET" })).status).toBe(
            400
        );
        expect((await ctx.call("/projects/%E0%A4%A/annotations", { method: "GET" })).status).toBe(
            400
        );
    });
});

describe("reading, updating and deleting", () => {
    it("lists a summary of each note when asked, without its context or steps", async () => {
        ctx = makeApp();
        await ingest(ctx.call, {
            projectId: "a",
            context: { console: [{ level: "error", message: "boom".repeat(200) }] },
            steps: [{ action: "tap", target: "#pay", at: "2026-10-08T10:00:00Z" }],
        });
        const read = async (qs: string) =>
            (
                (await (await ctx.call(`/projects/a/annotations${qs}`)).json()) as {
                    items: Array<{ annotation: Annotation }>;
                }
            ).items[0]?.annotation as Annotation;
        const full = await read("");
        expect(full.context).toHaveProperty("console");
        expect(full.steps).toHaveLength(1);
        const slim = await read("?fields=summary");
        // The pin number the screenshot was drawn with stays; the console does not.
        expect(slim.context).toEqual({ screenshot: full.context.screenshot });
        expect(slim.steps).toBeUndefined();
        expect(slim.target).toEqual(full.target);
        expect(Annotation.safeParse(slim).success).toBe(true);
    });

    it("lists with filters, gets one, and 404s on unknown ids", async () => {
        ctx = makeApp();
        await ingest(ctx.call, { projectId: "a", route: "/x", severity: "major" });
        await ingest(ctx.call, { projectId: "b", route: "/y", severity: "nit" });
        const list = async (qs: string) =>
            (
                (await (await ctx.call(`/annotations${qs}`)).json()) as {
                    items: Array<{ annotation: Annotation }>;
                }
            ).items;
        expect(await list("")).toHaveLength(2);
        expect(await list("?project=a")).toHaveLength(1);
        expect(await list("?status=resolved")).toHaveLength(0);
        expect(await list("?status=open,acknowledged")).toHaveLength(2);
        expect(await list("?severity=major")).toHaveLength(1);
        expect(await list("?bundle=none")).toHaveLength(2);
        expect((await ctx.call("/annotations?status=nope")).status).toBe(400);
        expect((await ctx.call("/annotations?afterSeq=-1")).status).toBe(400);
        const projectList = (await (await ctx.call("/projects/a/annotations?route=/x")).json()) as {
            items: unknown[];
        };
        expect(projectList.items).toHaveLength(1);

        const { annotation } = (await list("?project=a"))[0] as { annotation: Annotation };
        expect((await ctx.call(`/annotations/${annotation.id}`)).status).toBe(200);
        expect((await ctx.call("/annotations/missing")).status).toBe(404);
    });

    it("PATCH changes status with an attributed note, and severity or comment", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        const patch = (body: unknown) =>
            ctx.call(`/annotations/${annotation.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
        const resolved = (await (
            await patch({
                status: "resolved",
                note: "Resolved: fixed",
                author: { kind: "agent", name: "Claude" },
            })
        ).json()) as {
            annotation: Annotation;
        };
        expect(resolved.annotation.status).toBe("resolved");
        expect(resolved.annotation.thread[0]).toMatchObject({
            body: "Resolved: fixed",
            author: { kind: "agent", name: "Claude" },
        });
        const edited = (await (await patch({ severity: null, comment: "reworded" })).json()) as {
            annotation: Annotation;
        };
        expect(edited.annotation).toMatchObject({ comment: "reworded", status: "resolved" });
        expect(edited.annotation.severity).toBeUndefined();
        expect((await patch({ status: "wrong" })).status).toBe(400);
        expect((await patch({ unknown: 1 })).status).toBe(400);
        expect(
            (
                await ctx.call("/annotations/missing", {
                    method: "PATCH",
                    body: JSON.stringify({ status: "open" }),
                })
            ).status
        ).toBe(404);
    });

    it("PATCH only lets a resolved annotation be sent for revert, and the cancel puts it back", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        const patch = (body: unknown) =>
            ctx.call(`/annotations/${annotation.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
        const early = await patch({ status: "revert_requested", note: "undo" });
        expect(early.status).toBe(409);
        expect(((await early.json()) as { error: string }).error).toContain(
            "only a resolved annotation"
        );

        await patch({
            status: "resolved",
            note: "Resolved: done",
            author: { kind: "agent", name: "Claude" },
        });
        const asked = (await (
            await patch({
                status: "revert_requested",
                note: "That broke it",
                author: { kind: "human", name: "Dom" },
            })
        ).json()) as { annotation: Annotation };
        expect(asked.annotation.status).toBe("revert_requested");
        expect(asked.annotation.thread.at(-1)).toMatchObject({
            body: "That broke it",
            author: { name: "Dom" },
        });

        const cancelled = (await (
            await patch({ status: "resolved", note: "Revert request cancelled." })
        ).json()) as {
            annotation: Annotation;
        };
        expect(cancelled.annotation.status).toBe("resolved");
    });

    it("/annotations/wait wakes on a revert request and honours exclude", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        const patch = (body: unknown) =>
            ctx.call(`/annotations/${annotation.id}`, {
                method: "PATCH",
                body: JSON.stringify(body),
            });
        await patch({ status: "resolved", note: "Resolved: done" });
        const wait = (query: string) =>
            ctx
                .call(`/annotations/wait?status=revert_requested&timeoutMs=${query}`)
                .then((r) => r.json()) as Promise<{
                ready: boolean;
            }>;
        const waiting = wait("5000");
        await new Promise((r) => setTimeout(r, 50));
        await patch({ status: "revert_requested", note: "undo" });
        expect((await waiting).ready).toBe(true);
        const ignored = await ctx
            .call(
                `/annotations/wait?status=revert_requested&exclude=${annotation.id}&timeoutMs=200`
            )
            .then((r) => r.json() as Promise<{ ready: boolean }>);
        expect(ignored.ready).toBe(false);
    });

    it("POST replies appends to the thread; DELETE removes", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        const reply = await ctx.call(`/annotations/${annotation.id}/replies`, {
            method: "POST",
            body: JSON.stringify({
                body: "Which breakpoint?",
                author: { kind: "agent", name: "Claude" },
            }),
        });
        expect(reply.status).toBe(201);
        expect(((await reply.json()) as { annotation: Annotation }).annotation.thread).toHaveLength(
            1
        );
        expect(
            (
                await ctx.call(`/annotations/${annotation.id}/replies`, {
                    method: "POST",
                    body: JSON.stringify({ body: "" }),
                })
            ).status
        ).toBe(400);
        expect((await ctx.call(`/annotations/${annotation.id}`, { method: "DELETE" })).status).toBe(
            204
        );
        expect((await ctx.call(`/annotations/${annotation.id}`, { method: "DELETE" })).status).toBe(
            404
        );
    });

    it("404s unknown routes and assets", async () => {
        ctx = makeApp();
        expect((await ctx.call("/nope")).status).toBe(404);
        expect((await ctx.call(`/assets/${"a".repeat(64)}`)).status).toBe(404);
        expect((await ctx.call("/assets/..%2F..%2Fsecret")).status).toBe(404);
    });
});

describe("origin, CORS and host protection", () => {
    it("allows loopback and private-network origins, and exposes private-network preflight", async () => {
        ctx = makeApp();
        const res = await ctx.call("/health", { headers: { origin: "http://192.168.1.20:5173" } });
        expect(res.headers.get("access-control-allow-origin")).toBe("http://192.168.1.20:5173");
        const preflight = await ctx.call("/projects/p/annotations", {
            method: "OPTIONS",
            headers: { origin: "http://localhost:5173" },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
    });

    it("sends no CORS headers to other origins", async () => {
        ctx = makeApp();
        const res = await ctx.call("/health", { headers: { origin: "https://evil.example" } });
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("rejects writes from a foreign origin outright: simple cross-origin POSTs skip preflight", async () => {
        ctx = makeApp();
        const a = annotationFixture();
        const res = await ctx.call(`/projects/${a.projectId}/annotations`, {
            method: "POST",
            body: multipart(a),
            headers: { origin: "https://evil.example" },
        });
        expect(res.status).toBe(403);
        expect((await (await ctx.call("/annotations")).json()) as { items: unknown[] }).toEqual({
            items: [],
        });
    });

    it("allows extra origins from configuration", async () => {
        ctx = makeApp({ corsOrigins: ["https://staging.example.com"] });
        const res = await ctx.call("/health", {
            headers: { origin: "https://staging.example.com" },
        });
        expect(res.headers.get("access-control-allow-origin")).toBe("https://staging.example.com");
    });

    it("answers only loopback Host headers in dev mode (DNS rebinding)", async () => {
        ctx = makeApp();
        expect((await ctx.call("/health", { headers: { host: "evil.example:4747" } })).status).toBe(
            403
        );
        expect((await ctx.call("/health", { headers: { host: "127.0.0.1:4747" } })).status).toBe(
            200
        );
        expect((await ctx.call("/health", { headers: { host: "[::1]:4747" } })).status).toBe(200);
    });

    it("classifies hosts and origins", () => {
        for (const h of [
            "localhost",
            "app.localhost",
            "127.0.0.1",
            "10.1.2.3",
            "172.20.0.1",
            "192.168.0.5",
            "100.100.1.1",
            "[::1]",
            "fd12::1",
        ]) {
            expect(isPrivateHost(h)).toBe(true);
        }
        for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1"])
            expect(isPrivateHost(h)).toBe(false);
        expect(originAllowed("not a url", [])).toBe(false);
        expect(originAllowed("https://x.dev", ["*"])).toBe(true);
        expect(
            hostAllowed(new Request("http://x", { headers: { host: "myhost" } }), ["myhost"])
        ).toBe(true);
        expect(hostAllowed(new Request("http://x"), "loopback")).toBe(false);
    });

    it("lets an authorize hook stop requests", async () => {
        ctx = makeApp({
            authorize: async (_req, access) =>
                access.write ? new Response("no", { status: 401 }) : null,
        });
        expect((await ctx.call("/health")).status).toBe(200);
        const a = annotationFixture();
        expect(
            (
                await ctx.call(`/projects/${a.projectId}/annotations`, {
                    method: "POST",
                    body: multipart(a),
                })
            ).status
        ).toBe(401);
    });
});

describe("long-poll and SSE", () => {
    it("/annotations/wait returns immediately when something matches, and false after the timeout", async () => {
        ctx = makeApp();
        expect(
            (
                (await (await ctx.call("/annotations/wait?timeoutMs=50")).json()) as {
                    ready: boolean;
                }
            ).ready
        ).toBe(false);
        await ingest(ctx.call);
        expect(
            (
                (await (await ctx.call("/annotations/wait?status=open&timeoutMs=2000")).json()) as {
                    ready: boolean;
                }
            ).ready
        ).toBe(true);
    });

    it("/annotations/wait wakes on an annotation that arrives while waiting", async () => {
        ctx = makeApp();
        const waiting = ctx
            .call("/annotations/wait?status=open&afterSeq=0&timeoutMs=5000")
            .then((r) => r.json());
        await new Promise((r) => setTimeout(r, 50));
        await ingest(ctx.call);
        expect(((await waiting) as { ready: boolean }).ready).toBe(true);
    });

    it("streams created, updated, replied and deleted events for the project", async () => {
        ctx = makeApp();
        const controller = new AbortController();
        const res = await ctx.call("/projects/checkout-web/events", { signal: controller.signal });
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const next = async (event: string) => {
            while (!buffer.includes(`event: ${event}`)) {
                const { value, done } = await reader.read();
                if (done) throw new Error(`stream ended before ${event}`);
                buffer += decoder.decode(value);
            }
            const at = buffer.indexOf(`event: ${event}`);
            const data = /data: (.*)\n/.exec(buffer.slice(at))?.[1] ?? "{}";
            buffer = buffer.slice(at + 1);
            return JSON.parse(data) as { id: string; annotation: Annotation };
        };

        await next("hello");
        const { annotation } = await ingest(ctx.call);
        await ingest(ctx.call, { projectId: "someone-else" });
        expect((await next("created")).id).toBe(annotation.id);
        await ctx.call(`/annotations/${annotation.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "acknowledged" }),
        });
        expect((await next("updated")).annotation.status).toBe("acknowledged");
        await ctx.call(`/annotations/${annotation.id}/replies`, {
            method: "POST",
            body: JSON.stringify({ body: "hi" }),
        });
        expect((await next("replied")).annotation.thread).toHaveLength(1);
        await ctx.call(`/annotations/${annotation.id}`, { method: "DELETE" });
        expect((await next("deleted")).id).toBe(annotation.id);
        // The other project's event never arrived on this stream.
        expect(buffer.includes("someone-else")).toBe(false);
        controller.abort();
        await reader.cancel().catch(() => {});
        await new Promise((r) => setTimeout(r, 20));
        expect(ctx.backend.bus.size).toBe(0);
    });
});
