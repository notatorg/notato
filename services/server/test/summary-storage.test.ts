import { expect, it } from "bun:test";
import { annotationFixture, cleanupAfterEach } from "./helpers.ts";
import { embeddedPostgres } from "./postgres.ts";

const defer = cleanupAfterEach();
it("returns summaries from Postgres without transferring diagnostics or changing stored notes", async () => {
    const { store } = await embeddedPostgres();
    defer(() => store.close());
    const note = annotationFixture({
        context: { screenshot: { pin: 7 }, console: "large diagnostic ".repeat(1000) },
    });
    await store.insertAnnotation(note);
    const full = await store.getAnnotation(note.id);
    const rows = await store.listAnnotations({ projectId: note.projectId, summary: true });
    expect(rows[0]?.annotation.context).toEqual({ screenshot: { pin: 7 } });
    expect(rows[0]?.annotation.steps).toBeUndefined();
    expect(JSON.stringify(rows).length).toBeLessThan(JSON.stringify(full).length / 2);
    expect((await store.getAnnotation(note.id))?.annotation.context).toEqual(note.context);
});

it("keeps generated derivatives in Postgres usage and reference checks, including an existing database index upgrade", async () => {
    const { CloudBackend } = await import("../src/backend.ts");
    const { FileBlobStore } = await import("@notato/server");
    const { DEFAULT_WORKSPACE_ID } = await import("../src/storage.ts");
    const { tempDir, PNG } = await import("./helpers.ts");
    const { join } = await import("node:path");
    const { store, pg, database } = await embeddedPostgres();
    defer(() => store.close());
    await pg.exec("DROP INDEX notato.idx_annotations_thumbnail_shot");
    const { PostgresStore } = await import("../src/postgres-store.ts");
    await PostgresStore.open(database);
    const indexes = await pg.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname='notato' AND indexname='idx_annotations_thumbnail_shot'"
    );
    expect(indexes.rows).toHaveLength(1);
    const blobs = new FileBlobStore(join(tempDir(defer), "assets"));
    const backend = new CloudBackend(store, blobs);
    const note = annotationFixture({
        screenshots: { full: { id: "upload", mime: "image/png", w: 1, h: 1 } },
        context: { screenshot: { cropRect: { x: 0, y: 0, w: 1, h: 1 } } },
    });
    const { stored } = await backend.ingest(note, new Map([["upload", PNG]]));
    const shots = stored.annotation.screenshots;
    if (!shots?.crop || !shots.thumbnail) throw new Error("missing stored derivatives");
    expect(await store.projectsWithAsset(shots.thumbnail.id)).toEqual([note.projectId]);
    const sizes = await Promise.all(
        Object.values(shots).map(async (ref) =>
            ref ? ((await blobs.get(ref.id))?.bytes.length ?? 0) : 0
        )
    );
    expect((await store.workspaceUsage(DEFAULT_WORKSPACE_ID)).bytes).toBeGreaterThanOrEqual(
        sizes.reduce((a, b) => a + b, 0)
    );
    await backend.remove(note.id);
    expect(await store.projectsWithAsset(shots.thumbnail.id)).toEqual([]);
    expect(await blobs.get(shots.thumbnail.id)).toBeNull();
});

it("includes reference-only images in private ownership, usage and deletion, and scopes grouped review reads", async () => {
    const { CloudBackend } = await import("../src/backend.ts");
    const { FileBlobStore } = await import("@notato/server");
    const { DEFAULT_WORKSPACE_ID } = await import("../src/storage.ts");
    const { tempDir, PNG } = await import("./helpers.ts");
    const { join } = await import("node:path");
    const { store, pg, database } = await embeddedPostgres();
    defer(() => store.close());
    // Existing deployments receive both query indexes during the additive upgrade.
    await pg.exec(
        "DROP INDEX notato.idx_annotations_references; DROP INDEX notato.idx_annotations_review; UPDATE notato.meta SET value='15' WHERE key='schema_version'"
    );
    const { PostgresStore } = await import("../src/postgres-store.ts");
    await PostgresStore.open(database);
    expect(
        (
            await pg.query(
                "SELECT indexname FROM pg_indexes WHERE schemaname='notato' AND indexname IN ('idx_annotations_references','idx_annotations_review')"
            )
        ).rows
    ).toHaveLength(2);
    const backend = new CloudBackend(store, new FileBlobStore(join(tempDir(defer), "assets")));
    const note = annotationFixture({
        screenshots: undefined,
        references: [{ id: "upload", mime: "image/png", w: 1, h: 1, name: "Design" }],
        review: { id: "review", instruction: "Same fix", total: 1 },
    });
    const { stored } = await backend.ingest(note, new Map([["upload", PNG]]));
    const id = stored.annotation.references?.[0]?.id;
    if (!id) throw new Error("Missing reference");
    expect(await store.projectsWithAsset(id)).toEqual([note.projectId]);
    expect((await store.workspaceUsage(DEFAULT_WORKSPACE_ID)).bytes).toBeGreaterThanOrEqual(
        PNG.length
    );
    expect(
        await store.listAnnotations({
            projectId: note.projectId,
            reviewId: "review",
            summary: true,
        })
    ).toHaveLength(1);
    expect(
        await store.listAnnotations({ projectId: note.projectId, reviewId: "other" })
    ).toHaveLength(0);
    await backend.remove(note.id);
    expect(await store.projectsWithAsset(id)).toEqual([]);
    expect(await backend.asset(id)).toBeNull();
});
