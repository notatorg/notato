import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBlobStore, SqliteStore, sniffImageMime } from "../src/index.ts";
import { annotationFixture, PNG } from "./helpers.ts";

describe("SqliteStore", () => {
    let store: SqliteStore;
    beforeEach(() => {
        store = new SqliteStore(":memory:");
    });
    afterEach(() => store.close());

    it("assigns increasing seq numbers and reads back identical annotations", async () => {
        const a = annotationFixture();
        const b = annotationFixture();
        const first = await store.insertAnnotation(a);
        const second = await store.insertAnnotation(b);
        expect(second.seq).toBeGreaterThan(first.seq);
        expect((await store.getAnnotation(a.id))?.annotation).toEqual(a);
        expect(await store.getAnnotation("nope")).toBeNull();
    });

    it("lists in insertion order and filters by every column", async () => {
        const mk = (over: Parameters<typeof annotationFixture>[0]) =>
            store.insertAnnotation(annotationFixture(over));
        const one = await mk({ projectId: "p1", route: "/a", severity: "major", status: "open" });
        await mk({ projectId: "p1", route: "/b", severity: "nit", status: "resolved" });
        const three = await mk({
            projectId: "p2",
            route: "/a",
            status: "acknowledged",
            author: { kind: "agent" },
        });
        await mk({ projectId: "p2", route: "/a", bundleId: "bundle-1" });

        const ids = async (f: Parameters<typeof store.listAnnotations>[0]) =>
            (await store.listAnnotations(f)).map((s) => s.annotation.id);
        expect((await ids({})).length).toBe(4);
        expect(await ids({ projectId: "p1", route: "/a" })).toEqual([one.annotation.id]);
        expect((await ids({ status: ["open", "acknowledged"] })).length).toBe(3);
        expect(await ids({ severity: "nit" })).toHaveLength(1);
        expect(await ids({ authorKind: "agent" })).toEqual([three.annotation.id]);
        expect(await ids({ bundleId: "bundle-1" })).toHaveLength(1);
        expect(await ids({ bundleId: null })).toHaveLength(3);
        expect(await ids({ afterSeq: one.seq, projectId: "p1" })).toHaveLength(1);
        expect(await ids({ limit: 2 })).toHaveLength(2);
    });

    it("updates atomically and keeps filter columns in sync", async () => {
        const { annotation } = await store.insertAnnotation(annotationFixture({ status: "open" }));
        const updated = await store.updateAnnotation(annotation.id, (a) => ({
            ...a,
            status: "resolved",
            comment: "new",
        }));
        expect(updated?.annotation.status).toBe("resolved");
        expect(await store.listAnnotations({ status: "open" })).toHaveLength(0);
        expect(await store.listAnnotations({ status: "resolved" })).toHaveLength(1);
        expect(await store.updateAnnotation("missing", (a) => a)).toBeNull();
    });

    it("rejects an update that breaks the schema, leaving the row untouched", async () => {
        const { annotation } = await store.insertAnnotation(annotationFixture());
        await expect(
            store.updateAnnotation(annotation.id, (a) => ({ ...a, status: "bogus" as never }))
        ).rejects.toThrow();
        expect((await store.getAnnotation(annotation.id))?.annotation.status).toBe("open");
    });

    it("deletes and summarises projects", async () => {
        const a = await store.insertAnnotation(
            annotationFixture({
                projectId: "alpha",
                status: "open",
                createdAt: "2026-10-01T09:00:00.000Z",
            })
        );
        await store.insertAnnotation(
            annotationFixture({
                projectId: "alpha",
                status: "resolved",
                createdAt: "2026-10-02T09:00:00.000Z",
                // The reply is the newest thing in the project, so it is the project's last activity.
                thread: [
                    {
                        id: "r1",
                        author: { kind: "agent", name: "Claude" },
                        body: "Fixed.",
                        createdAt: "2026-10-03T12:00:00.000Z",
                    },
                ],
            })
        );
        await store.insertAnnotation(
            annotationFixture({ projectId: "beta", createdAt: "2026-10-04T09:00:00.000Z" })
        );
        // A request to undo a change is still work waiting for someone.
        await store.insertAnnotation(
            annotationFixture({
                projectId: "beta",
                status: "revert_requested",
                createdAt: "2026-10-05T09:00:00.000Z",
            })
        );
        expect(await store.listProjects()).toEqual([
            {
                id: "alpha",
                name: "alpha",
                createdAt: "2026-10-01T09:00:00.000Z",
                annotations: 2,
                open: 1,
                statuses: { open: 1, resolved: 1 },
                lastActivityAt: "2026-10-03T12:00:00.000Z",
            },
            {
                id: "beta",
                name: "beta",
                createdAt: "2026-10-04T09:00:00.000Z",
                annotations: 2,
                open: 2,
                statuses: { open: 1, revert_requested: 1 },
                lastActivityAt: "2026-10-05T09:00:00.000Z",
            },
        ]);
        expect(await store.deleteAnnotation(a.annotation.id)).toBe(true);
        expect(await store.deleteAnnotation(a.annotation.id)).toBe(false);
    });

    it("refuses a database written by a newer schema", () => {
        const dir = mkdtempSync(join(tmpdir(), "notato-schema-"));
        try {
            const path = join(dir, "x.db");
            const s = new SqliteStore(path);
            s.close();
            const { Database } = require("bun:sqlite");
            const raw = new Database(path);
            raw.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
            raw.close();
            expect(() => new SqliteStore(path)).toThrow(/newer than this build/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("persists across reopen", async () => {
        const dir = mkdtempSync(join(tmpdir(), "notato-persist-"));
        try {
            const path = join(dir, "p.db");
            const a = annotationFixture();
            const first = new SqliteStore(path);
            await first.insertAnnotation(a);
            first.close();
            const second = new SqliteStore(path);
            expect((await second.getAnnotation(a.id))?.annotation).toEqual(a);
            second.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("schema 5", () => {
    it("fills the columns watch and the project list read from the notes a version 4 database already has", async () => {
        const dir = mkdtempSync(join(tmpdir(), "notato-v4-"));
        try {
            const path = join(dir, "notato.db");
            const first = new SqliteStore(path);
            const waiting = annotationFixture({
                projectId: "shop",
                thread: [
                    {
                        id: "r1",
                        author: { kind: "human", name: "Ada" },
                        body: "still wrong",
                        createdAt: "2030-01-01T00:00:00.000Z",
                    },
                ],
            });
            await first.insertAnnotation(waiting);
            await first.insertAnnotation(
                annotationFixture({ projectId: "shop", peopleOnly: true })
            );
            // Back to how version 4 left it: no derived columns.
            const db = new Database(path);
            for (const index of ["idx_annotations_awaits", "idx_annotations_project_activity"])
                db.run(`DROP INDEX ${index}`);
            for (const column of [
                "awaits_agent",
                "people_only",
                "diagnostic",
                "intent",
                "author_name",
                "last_activity_at",
            ])
                db.run(`ALTER TABLE annotations DROP COLUMN ${column}`);
            db.run("UPDATE meta SET value = '4' WHERE key = 'schema_version'");
            db.close();

            const store = new SqliteStore(path);
            expect(
                (await store.listAnnotations({ lastReplyBy: "human" })).map((s) => s.annotation.id)
            ).toEqual([waiting.id]);
            expect(await store.listAnnotations({ peopleOnly: false })).toHaveLength(1);
            const [project] = await store.listProjects();
            expect(project?.lastActivityAt).toBe("2030-01-01T00:00:00.000Z");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("FileBlobStore", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "notato-blobs-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("addresses content by sha-256, deduplicates, and sniffs the mime type", async () => {
        const blobs = new FileBlobStore(dir);
        const a = await blobs.put(PNG);
        const b = await blobs.put(PNG);
        expect(a.id).toMatch(/^[0-9a-f]{64}$/);
        expect(b.id).toBe(a.id);
        const got = await blobs.get(a.id);
        expect(got?.mime).toBe("image/png");
        expect(Array.from(got?.bytes ?? [])).toEqual(Array.from(PNG));
    });

    it("takes the same screenshot from many notes at once, leaving one file and no temporary ones", async () => {
        const blobs = new FileBlobStore(dir);
        const puts = await Promise.all(Array.from({ length: 32 }, () => blobs.put(PNG)));
        expect(new Set(puts.map((p) => p.id)).size).toBe(1);
        const id = puts[0]?.id as string;
        expect(readdirSync(join(dir, id.slice(0, 2)))).toEqual([id]);
    });

    it("returns null for unknown and malformed ids, including path traversal", async () => {
        const blobs = new FileBlobStore(dir);
        expect(await blobs.get("f".repeat(64))).toBeNull();
        expect(await blobs.get("../../etc/passwd")).toBeNull();
        expect(await blobs.get("")).toBeNull();
    });

    it("sniffs only PNG and WebP", () => {
        expect(sniffImageMime(PNG)).toBe("image/png");
        const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
        expect(sniffImageMime(webp)).toBe("image/webp");
        expect(
            sniffImageMime(new TextEncoder().encode("<html><script>alert(1)</script>"))
        ).toBeNull();
        expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    });
});
