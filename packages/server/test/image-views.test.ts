import { expect, it } from "bun:test";
import { screenshotCrop } from "@notato/core";
import { PNG } from "pngjs";
import { ImageViews } from "../src/image-views.ts";
import { ScopedBackend } from "../src/scoped-backend.ts";
import { annotationFixture, cleanupAfterEach, connectMcp, makeApp, multipart } from "./helpers.ts";
import { bearer, createProject, issue, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
function picture() {
    const png = new PNG({ width: 640, height: 480 });
    for (let y = 0; y < 480; y++)
        for (let x = 0; x < 640; x++) {
            const at = (y * 640 + x) * 4;
            png.data.set(
                x >= 100 && x < 300 && y >= 80 && y < 280
                    ? [156, 163, 175, 255]
                    : [x % 256, y % 256, (x + y) % 256, 255],
                at
            );
        }
    return PNG.sync.write(png);
}
const crop = { x: 100, y: 80, w: 200, h: 200 };

it("makes correctly located crops and bounded thumbnails from WebP, coalesces work and keeps cached bytes private", async () => {
    const original = await new Bun.Image(picture()).webp({ quality: 85 }).bytes();
    let downloads = 0;
    const views = new ImageViews(async () => {
        downloads++;
        return { bytes: original, mime: "image/webp" };
    });
    const [first, second] = await Promise.all([
        views.get("image", crop, false),
        views.get("image", crop, false),
    ]);
    if (!first || !second) throw new Error("missing crop");
    expect(downloads).toBe(1);
    expect(first?.bytes).toEqual(second?.bytes);
    expect(await new Bun.Image(first.bytes).metadata()).toMatchObject({ width: 200, height: 200 });
    const decoded = PNG.sync.read(Buffer.from(await new Bun.Image(first.bytes).png().bytes()));
    const middle = (100 * 200 + 100) * 4;
    expect(decoded.data[middle]).toBeGreaterThan(150);
    expect(decoded.data[middle]).toBeLessThan(162);
    first.bytes.fill(0);
    expect((await views.get("image", crop, false))?.bytes).toEqual(second?.bytes);
    const thumb = await views.get("image", undefined, true);
    if (!thumb) throw new Error("missing thumbnail");
    expect(await new Bun.Image(thumb.bytes).metadata()).toMatchObject({ width: 213, height: 160 });
    expect(thumb.bytes.length).toBeLessThan(original.length);
    await expect(views.get("image", { ...crop, x: 630 }, false)).rejects.toThrow("crop");
});

it("refuses invalid crop metadata and corrupt input instead of accepting unchecked dimensions", async () => {
    const a = annotationFixture({ context: { screenshot: { cropRect: { ...crop, x: -1 } } } });
    expect(screenshotCrop(a)).toBeUndefined();
    const views = new ImageViews(async () => ({
        bytes: new Uint8Array([1, 2]),
        mime: "image/png",
    }));
    await expect(views.get("bad", undefined, true)).rejects.toThrow("input");
});

it("accepts one uploaded image, stores a tiny preview, serves derived views through note permissions, and supplies a real crop to MCP", async () => {
    const app = makeApp();
    defer(app.cleanup);
    const bytes = picture();
    const note = annotationFixture({
        screenshots: { full: { id: "full", mime: "image/png", w: 640, h: 480 } },
        context: { screenshot: { pin: 1, cropRect: crop } },
    });
    const sent = await app.call(`/projects/${note.projectId}/annotations`, {
        method: "POST",
        body: multipart(note, new Map([["full", bytes]])),
    });
    expect(sent.status).toBe(201);
    const stored = await app.store.getAnnotation(note.id);
    expect(stored?.annotation.screenshots?.crop).toMatchObject({
        w: 200,
        h: 200,
        mime: "image/webp",
    });
    expect(stored?.annotation.screenshots?.thumbnail).toMatchObject({
        w: 160,
        h: 160,
        mime: "image/webp",
    });
    const response = await app.call(`/annotations/${note.id}/screenshot?view=thumbnail`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const agent = await connectMcp(app.backend, defer);
    const result = await agent.call("notato_get", { id: note.id, screenshots: "crop" });
    const image = result.content.find((c) => c.type === "image");
    if (!image?.data) throw new Error("missing MCP image");
    expect(image.mimeType).toBe("image/webp");
    expect(await new Bun.Image(Buffer.from(image.data, "base64")).metadata()).toMatchObject({
        width: 200,
        height: 200,
    });
    const foreign = new ScopedBackend(app.backend, "another-project");
    expect(await foreign.screenshot(note.id, "crop")).toBeNull();
    await app.call(`/annotations/${note.id}`, { method: "DELETE" });
    expect((await app.call(`/annotations/${note.id}/screenshot?view=thumbnail`)).status).toBe(404);
});

it("never exposes even a warmed view to another project or a send-only credential", async () => {
    const app = await startServe(defer);
    await createProject(app, "mine");
    await createProject(app, "other");
    const owner = bearer(await issue(app, "mine"));
    const other = bearer(await issue(app, "other"));
    const sendOnly = bearer(
        await issue(app, "mine", "send-only", { permission: "capture", purpose: "app" })
    );
    const note = annotationFixture({
        projectId: "mine",
        screenshots: { full: { id: "full", mime: "image/png", w: 640, h: 480 } },
        context: { screenshot: { cropRect: crop } },
    });
    expect(
        (
            await app.call("/projects/mine/annotations", {
                method: "POST",
                headers: owner,
                body: multipart(note, new Map([["full", picture()]])),
            })
        ).status
    ).toBe(201);
    const path = `/annotations/${note.id}/screenshot?view=thumbnail`;
    expect((await app.call(path, { headers: owner })).status).toBe(200);
    expect((await app.call(path, { headers: other })).status).toBe(403);
    expect((await app.call(path, { headers: sendOnly })).status).toBe(403);
    expect((await app.call(path)).status).toBe(401);
});

it("serves cold stored derivatives without reading the original, accounts every byte and keeps shared thumbnails until the last reference is removed", async () => {
    const app = makeApp();
    defer(app.cleanup);
    const bytes = picture();
    const note = annotationFixture({
        screenshots: { full: { id: "upload", mime: "image/png", w: 640, h: 480 } },
        context: { screenshot: { cropRect: crop } },
    });
    let accounted = 0;
    app.backend.hooks.beforeIngest = (_a, size) => {
        accounted = size;
    };
    await app.backend.ingest(note, new Map([["upload", bytes]]));
    const saved = (await app.backend.get(note.id))?.annotation;
    if (!saved?.screenshots?.crop || !saved.screenshots.thumbnail)
        throw new Error("missing derivatives");
    const refs = Object.values(saved.screenshots).filter((r) => r !== undefined);
    const read = app.backend.blobs.get.bind(app.backend.blobs);
    const expected = (
        await Promise.all(refs.map(async (r) => (await read(r.id))?.bytes.length ?? 0))
    ).reduce((a, b) => a + b, 0);
    expect(accounted).toBe(expected);
    const reads: string[] = [];
    app.backend.blobs.get = async (id) => {
        reads.push(id);
        return read(id);
    };
    await app.backend.screenshot(note.id, "crop");
    await app.backend.screenshot(note.id, "thumbnail");
    expect(reads).toEqual([saved.screenshots.crop.id, saved.screenshots.thumbnail.id]);
    expect(await app.store.projectsWithAsset(saved.screenshots.thumbnail.id)).toEqual([
        note.projectId,
    ]);
    const exported = await app.backend.exportBundle({ projectId: note.projectId });
    if (!exported) throw new Error("missing export");
    const other = makeApp();
    defer(other.cleanup);
    await other.backend.importBundle(
        new Uint8Array(await new Response(exported.zip).arrayBuffer())
    );
    expect((await other.backend.get(note.id))?.annotation.screenshots?.thumbnail?.id).toBe(
        saved.screenshots.thumbnail.id
    );
    expect(await other.backend.blobs.get(saved.screenshots.thumbnail.id)).not.toBeNull();
    const duplicate = { ...saved, id: `${note.id}_copy` };
    await app.store.insertAnnotation(duplicate);
    await app.backend.remove(note.id);
    expect(await read(saved.screenshots.thumbnail.id)).not.toBeNull();
    await app.backend.remove(duplicate.id);
    for (const ref of refs) expect(await read(ref.id)).toBeNull();
});
