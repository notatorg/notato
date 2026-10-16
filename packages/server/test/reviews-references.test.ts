import { describe, expect, it } from "bun:test";
import { assetsFor, readBundle } from "@notato/core";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    hex,
    makeBackend,
    multipart,
    PNG,
} from "./helpers.ts";
import { bearer, issue, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
const reference = {
    id: "reference",
    mime: "image/png" as const,
    w: 1,
    h: 1,
    name: "Desired design",
};

describe("references are private, quota-counted annotation assets", () => {
    it("counts bytes, canonicalises dimensions, survives a bundle roundtrip and deletes only after its last note", async () => {
        const sizes: number[] = [];
        const t = makeBackend();
        defer(t.cleanup);
        // The same hook used by cloud quotas; a reference-only note must not bypass it.
        const { LocalBackend } = await import("../src/backend.ts");
        const backend = new LocalBackend(t.backend.store, t.backend.blobs, {
            hooks: {
                beforeIngest: (_a, n) => {
                    sizes.push(n);
                },
            },
        });
        const a = annotationFixture({
            screenshots: undefined,
            references: [{ ...reference, w: 400, h: 300 }],
        });
        const files = new Map([[reference.id, PNG]]);
        const { stored } = await backend.ingest(a, files);
        expect(sizes).toEqual([PNG.length]);
        const id = await hex(PNG);
        expect(stored.annotation.references?.[0]).toMatchObject({
            id,
            w: 1,
            h: 1,
            name: reference.name,
        });
        expect(await backend.projectsWithAsset(id)).toEqual([a.projectId]);
        const result = await backend.exportBundle({ projectId: a.projectId });
        if (!result) throw new Error("Missing export");
        const zip = new Uint8Array(await new Response(result.zip).arrayBuffer());
        const bundled = readBundle(zip);
        const imported = bundled.bundle.annotations[0];
        expect(imported?.references?.[0]?.path).toBe("shots/01-reference-1.png");
        expect(imported && assetsFor(imported, bundled.files).get(id)).toEqual(PNG);
        const second = annotationFixture({
            screenshots: undefined,
            references: [{ ...reference, id }],
        });
        await backend.ingest(second, new Map());
        await backend.remove(a.id);
        expect(await backend.asset(id)).not.toBeNull();
        await backend.remove(second.id);
        expect(await backend.asset(id)).toBeNull();
    });
    it("rejects absent/oversized/invalid references before storing a note, and never reuses another project’s pixels", async () => {
        const t = makeBackend();
        defer(t.cleanup);
        const a = annotationFixture({ screenshots: undefined, references: [reference] });
        await expect(t.backend.ingest(a, new Map())).rejects.toThrow("missing screenshot");
        await expect(
            t.backend.ingest(a, new Map([[reference.id, new Uint8Array(6 * 1024 * 1024)]]))
        ).rejects.toThrow();
        await expect(
            t.backend.ingest(a, new Map([[reference.id, new TextEncoder().encode("<svg/>")]]))
        ).rejects.toThrow("PNG or WebP");
        await t.backend.ingest(a, new Map([[reference.id, PNG]]));
        await expect(
            t.backend.ingest(
                annotationFixture({
                    projectId: "other",
                    screenshots: undefined,
                    references: [{ ...reference, id: await hex(PNG) }],
                }),
                new Map()
            )
        ).rejects.toThrow("missing screenshot");
    });
    it("capture receipts cover references, do not leak feedback, and cannot grant reads to another project", async () => {
        const t = await startServe(defer);
        const token = await issue(t, "p", "capture", { permission: "capture" });
        const other = await issue(t, "other", "app", { purpose: "app" });
        const a = annotationFixture({
            projectId: "p",
            screenshots: undefined,
            references: [reference],
        });
        const send = (note = a) =>
            t.call("/projects/p/annotations", {
                method: "POST",
                headers: bearer(token),
                body: multipart(note, new Map([[reference.id, PNG]])),
            });
        expect((await send()).status).toBe(201);
        await t.rt.backend.reply(a.id, "Secret reply");
        const retry = await send();
        expect(retry.status).toBe(200);
        expect(JSON.stringify(await retry.json())).not.toContain("Secret reply");
        expect((await send({ ...a, references: [{ ...reference, name: "Changed" }] })).status).toBe(
            409
        );
        const id = await hex(PNG);
        expect((await t.call(`/assets/${id}`, { headers: bearer(other) })).status).toBe(404);
        expect((await t.call(`/assets/${id}`, { headers: bearer(token) })).status).toBe(403);
    });
});

describe("grouped reviews", () => {
    it("holds drafts off the server, filters by review, and gives the agent all public targets in that project", async () => {
        const t = makeBackend();
        defer(t.cleanup);
        const review = {
            id: "review1",
            instruction: "Use the same spacing for all of these",
            total: 3,
        };
        const a = annotationFixture({ screenshots: undefined, review });
        await expect(
            t.backend.ingest({ ...a, review: { ...review, draft: true } }, new Map())
        ).rejects.toThrow("Send the review");
        await t.backend.ingest(a, new Map());
        const { call, text } = await connectMcp(t.backend, defer);
        expect(text(await call("notato_get_review", { id: a.id }))).toContain("INCOMPLETE");
        await t.backend.ingest(
            annotationFixture({ screenshots: undefined, route: "/two", review }),
            new Map()
        );
        await t.backend.ingest(
            annotationFixture({ screenshots: undefined, route: "/three", review }),
            new Map()
        );
        await t.backend.ingest(
            annotationFixture({
                screenshots: undefined,
                review: { ...review, id: "unrelated" },
                comment: "unrelated",
            }),
            new Map()
        );
        await t.backend.ingest(
            annotationFixture({
                screenshots: undefined,
                projectId: "other",
                review,
                comment: "another project",
            }),
            new Map()
        );
        const result = await call("notato_get_review", { id: a.id });
        expect(text(result)).toContain("3/3 targets");
        expect(text(result)).toContain("/two");
        expect(text(result)).not.toContain("unrelated");
        expect(text(result)).not.toContain("another project");
        expect(result.content.filter((c) => c.type === "image")).toHaveLength(0);
    });
});

it("downloads reference bytes only on an explicit get, while the watch stays text-only for references", async () => {
    const t = makeBackend();
    defer(t.cleanup);
    const a = annotationFixture({ screenshots: undefined, references: [reference] });
    await t.backend.ingest(a, new Map([[reference.id, PNG]]));
    const { call } = await connectMcp(t.backend, defer);
    const images = (r: Awaited<ReturnType<typeof call>>) =>
        r.content.filter((c) => c.type === "image");
    expect(images(await call("notato_watch", { timeoutSeconds: 1, windowMs: 0 }))).toHaveLength(0);
    expect(
        images(await call("notato_get", { id: a.id, screenshots: "none", references: false }))
    ).toHaveLength(0);
    expect(images(await call("notato_get", { id: a.id, screenshots: "none" }))).toHaveLength(1);
});
