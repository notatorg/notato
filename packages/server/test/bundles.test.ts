import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBundle } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createMcpServer, SqliteStore } from "../src/index.ts";
import {
    cleanupAfterEach,
    connectMcp,
    makeApp,
    makeBackend,
    makeBundleZip,
    PNG,
    tempDir,
} from "./helpers.ts";

/** A template annotation, for tests that tweak just its target. */
const originals0 = (await makeBundleZip(1)).originals[0] as Annotation;

let ctx: ReturnType<typeof makeApp>;
afterEach(() => ctx?.cleanup());
const defer = cleanupAfterEach();

const postZip = (
    zip: Uint8Array,
    path = "/projects/checkout-web/bundles",
    headers: Record<string, string> = { "content-type": "application/zip" }
) => ctx.call(path, { method: "POST", body: zip as BodyInit, headers });

const listAll = async () =>
    (
        (await (await ctx.call("/annotations?limit=500")).json()) as {
            items: Array<{ annotation: Annotation }>;
        }
    ).items.map((i) => i.annotation);

/** Drops what importing legitimately adds: the zip-internal screenshot paths. */
const withoutPaths = (a: Annotation) => ({
    ...a,
    screenshots: {
        full: { ...a.screenshots?.full, path: undefined },
        ...(a.screenshots?.crop ? { crop: { ...a.screenshots?.crop, path: undefined } } : {}),
    },
});

describe("a zip exported in the browser imports into a fresh store", () => {
    it("and every annotation reads back identically", async () => {
        ctx = makeApp();
        const { zip, bundle, originals } = await makeBundleZip(3, (n) => ({
            severity: n === 2 ? "nit" : "major",
            route: `/page-${n}`,
            steps:
                n === 3
                    ? [{ action: "click", target: "#pay", at: "2026-10-05T10:00:00Z" }]
                    : undefined,
            target: { ...originals0.target, selectedText: n === 1 ? "selected words" : undefined },
        }));
        const res = await postZip(zip);
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({
            bundleId: bundle.id,
            projectId: "checkout-web",
            imported: 3,
            skipped: 0,
        });

        const stored = await listAll();
        expect(stored).toHaveLength(3);
        stored.forEach((a, i) => {
            // What the browser held, plus only the bundle bookkeeping (its id on each annotation).
            const original = originals[i] as Annotation;
            expect(withoutPaths(a)).toEqual(withoutPaths({ ...original, bundleId: bundle.id }));
            expect(a.screenshots?.full.id).toBe(original.screenshots?.full.id);
        });
    });

    it("serves the screenshots from the content-addressed store", async () => {
        ctx = makeApp();
        const { zip } = await makeBundleZip(1);
        await postZip(zip);
        const [a] = await listAll();
        const asset = await ctx.call(`/assets/${a?.screenshots?.full.id}`);
        expect(asset.status).toBe(200);
        expect(Array.from(new Uint8Array(await asset.arrayBuffer()))).toEqual(Array.from(PNG));
    });

    it("keeps statuses and threads that the tester's bundle carried", async () => {
        ctx = makeApp();
        const { zip } = await makeBundleZip(1, () => ({
            status: "acknowledged",
            thread: [
                {
                    id: "r1",
                    author: { kind: "human", name: "Tester" },
                    body: "see also the footer",
                    createdAt: "2026-10-05T10:00:00Z",
                },
            ],
        }));
        await postZip(zip);
        expect((await listAll())[0]).toMatchObject({
            status: "acknowledged",
            thread: [{ body: "see also the footer" }],
        });
    });
});

describe("importing again", () => {
    it("is idempotent: nothing duplicated, existing work untouched", async () => {
        ctx = makeApp();
        const { zip } = await makeBundleZip(2);
        expect((await postZip(zip)).status).toBe(201);
        const first = (await listAll())[0] as Annotation;
        await ctx.call(`/annotations/${first.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "resolved", note: "done" }),
        });

        const again = await postZip(zip);
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ imported: 0, skipped: 2 });
        expect(await listAll()).toHaveLength(2);
        expect((await listAll())[0]).toMatchObject({ status: "resolved" });
    });

    it("imports only what is new when a bundle grows", async () => {
        ctx = makeApp();
        const small = await makeBundleZip(2, () => ({}), { id: "BUNDLE-A" });
        await postZip(small.zip);
        // A second bundle sharing the first two annotations by id and adding one.
        const a = small.originals;
        const grown = await makeBundleZip(
            3,
            (n) => (n <= 2 ? { id: (a[n - 1] as Annotation).id } : {}),
            {
                id: "BUNDLE-B",
            }
        );
        expect(await (await postZip(grown.zip)).json()).toMatchObject({ imported: 1, skipped: 2 });
    });
});

describe("bundle records and export", () => {
    it("lists bundles, returns one with its annotations, and 404s unknown ids", async () => {
        ctx = makeApp();
        const { zip, bundle } = await makeBundleZip(2);
        await postZip(zip);
        const list = (await (await ctx.call("/projects/checkout-web/bundles")).json()) as {
            items: Array<{ id: string; annotationCount: number; author: { name: string } }>;
        };
        expect(list.items).toMatchObject([
            { id: bundle.id, annotationCount: 2, author: { name: "Tester" } },
        ]);
        const one = (await (await ctx.call(`/bundles/${bundle.id}`)).json()) as {
            bundle: { id: string };
            annotations: unknown[];
        };
        expect(one.bundle.id).toBe(bundle.id);
        expect(one.annotations).toHaveLength(2);
        expect((await ctx.call("/bundles/nope")).status).toBe(404);
        expect((await ctx.call("/bundles/nope/export")).status).toBe(404);
    });

    it("filters imported annotations by bundle", async () => {
        ctx = makeApp();
        const a = await makeBundleZip(2, () => ({}), { id: "BUNDLE-A" });
        const b = await makeBundleZip(1, () => ({}), { id: "BUNDLE-B" });
        await postZip(a.zip);
        await postZip(b.zip);
        expect(
            (
                (await (await ctx.call("/annotations?bundle=BUNDLE-A")).json()) as {
                    items: unknown[];
                }
            ).items
        ).toHaveLength(2);
        expect(
            (
                (await (await ctx.call("/annotations?bundle=BUNDLE-B")).json()) as {
                    items: unknown[];
                }
            ).items
        ).toHaveLength(1);
    });

    it("exports a bundle as it stands now, and the export imports back", async () => {
        ctx = makeApp();
        const { zip, bundle } = await makeBundleZip(2);
        await postZip(zip);
        const first = (await listAll())[0] as Annotation;
        await ctx.call(`/annotations/${first.id}`, {
            method: "PATCH",
            body: JSON.stringify({
                status: "resolved",
                note: "Resolved: fixed",
                author: { kind: "agent", name: "Claude" },
            }),
        });

        const res = await ctx.call(`/bundles/${bundle.id}/export`);
        expect(res.headers.get("content-type")).toBe("application/zip");
        expect(res.headers.get("content-disposition")).toContain(
            `notato-checkout-web-${bundle.id}.zip`
        );
        const exported = new Uint8Array(await res.arrayBuffer());
        expect(Object.keys(unzipSync(exported)).sort()).toContain("feedback.md");
        const read = readBundle(exported);
        expect(read.bundle.id).toBe(bundle.id);
        expect(read.bundle.annotations).toHaveLength(2);
        expect(read.bundle.annotations.find((a) => a.id === first.id)).toMatchObject({
            status: "resolved",
            thread: [{ body: "Resolved: fixed" }],
        });

        // Into a different, empty server: the same annotations arrive, with their work history.
        const other = makeApp();
        const into = await other.call("/bundles", {
            method: "POST",
            body: exported as BodyInit,
            headers: { "content-type": "application/zip" },
        });
        expect(await into.json()).toMatchObject({ imported: 2 });
        other.cleanup();
    });

    it("exports a filtered set of a project as a new bundle", async () => {
        ctx = makeApp();
        await postZip(
            (await makeBundleZip(3, (n) => ({ severity: n === 1 ? "blocker" : "nit" }))).zip
        );
        const res = await ctx.call("/projects/checkout-web/export?severity=blocker");
        expect(res.status).toBe(200);
        const read = readBundle(new Uint8Array(await res.arrayBuffer()));
        expect(read.bundle.annotations).toHaveLength(1);
        expect(read.bundle.annotations[0]?.severity).toBe("blocker");
    });

    it("accepts a multipart upload with a bundle file", async () => {
        ctx = makeApp();
        const { zip } = await makeBundleZip(1);
        const form = new FormData();
        form.set(
            "bundle",
            new File([zip as BlobPart], "feedback.zip", { type: "application/zip" })
        );
        const res = await ctx.call("/projects/checkout-web/bundles", {
            method: "POST",
            body: form,
        });
        expect(res.status).toBe(201);
        const missing = await ctx.call("/projects/checkout-web/bundles", {
            method: "POST",
            body: new FormData(),
        });
        expect(missing.status).toBe(400);
    });
});

describe("rejecting bad bundles", () => {
    const error = async (res: Response) => ((await res.json()) as { error: string }).error;

    it("rejects non-zip, empty, and wrong-project bundles with a precise message", async () => {
        ctx = makeApp();
        expect(await error(await postZip(strToU8("not a zip")))).toContain("not a readable zip");
        expect((await postZip(new Uint8Array())).status).toBe(400);
        const { zip } = await makeBundleZip(1);
        const res = await postZip(zip, "/projects/other-project/bundles");
        expect(res.status).toBe(400);
        expect(await error(res)).toContain('bundle is for project "checkout-web"');
    });

    it("rejects a bundle for a project id no project can have, instead of making that project", async () => {
        ctx = makeApp();
        const { zip } = await makeBundleZip(1, () => ({ projectId: ".." }), { projectId: ".." });
        const res = await postZip(zip, "/bundles");
        expect(res.status).toBe(400);
        expect(await error(res)).toContain("is not a project id");
        expect((await (await ctx.call("/projects")).json()).items).toEqual([]);
    });

    it("rejects an unsupported schemaVersion and a missing screenshot", async () => {
        ctx = makeApp();
        const { zip } = await makeBundleZip(1);
        const files = unzipSync(zip);
        const json = JSON.parse(new TextDecoder().decode(files["annotations.json"]));
        json.schemaVersion = 2;
        expect(
            await error(
                await postZip(
                    zipSync({ ...files, "annotations.json": strToU8(JSON.stringify(json)) })
                )
            )
        ).toContain("schemaVersion 2");
        const noShot = { ...files };
        delete noShot["shots/01-full.png"];
        expect(await error(await postZip(zipSync(noShot)))).toContain("not in the bundle");
        expect(await listAll()).toHaveLength(0);
    });

    it("imports nothing when one screenshot is not an image", async () => {
        ctx = makeApp();
        const { zip } = await makeBundleZip(2);
        const files = unzipSync(zip);
        files["shots/02-crop.png"] = strToU8("<script>alert(1)</script>");
        const res = await postZip(zipSync(files));
        expect(res.status).toBe(400);
        expect(await error(res)).toContain("PNG or WebP");
        expect(await listAll()).toHaveLength(0);
    });

    it("rejects oversized bundles", async () => {
        ctx = makeApp({ maxBundleBytes: 50 });
        const { zip } = await makeBundleZip(1);
        expect((await postZip(zip)).status).toBe(413);
    });

    it("rejects a bundle that is a zip bomb", async () => {
        ctx = makeApp();
        const { zip } = await makeBundleZip(1);
        const files = unzipSync(zip);
        const res = await postZip(
            zipSync({ ...files, "shots/bomb.png": new Uint8Array(26 * 1024 * 1024) })
        );
        expect(res.status).toBe(400);
        expect(await error(res)).toContain("larger than");
    });
});

describe("database migration", () => {
    it("upgrades a version 1 database in place, keeping its annotations", async () => {
        const path = join(tempDir(defer, "notato-migrate-"), "old.db");
        const old = new Database(path, { create: true });
        old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        old.run(
            `CREATE TABLE annotations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, bundle_id TEXT, status TEXT NOT NULL, severity TEXT, route TEXT NOT NULL, author_kind TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL)`
        );
        old.run("INSERT INTO meta VALUES ('schema_version', '1')");
        const { annotationFixture } = await import("./helpers.ts");
        const a = annotationFixture();
        old.query(
            "INSERT INTO annotations (id, project_id, bundle_id, status, severity, route, author_kind, created_at, json) VALUES (?,?,?,?,?,?,?,?,?)"
        ).run(
            a.id,
            a.projectId,
            null,
            a.status,
            a.severity ?? null,
            a.route,
            a.author.kind,
            a.createdAt,
            JSON.stringify(a)
        );
        old.close();

        const store = new SqliteStore(path);
        expect((await store.getAnnotation(a.id))?.annotation).toEqual(a);
        expect(
            await store.insertBundle({
                id: "b",
                projectId: "p",
                createdAt: "t",
                author: {},
                annotationCount: 0,
                importedAt: "t",
            })
        ).toBe(true);
        expect(
            await store.insertBundle({
                id: "b",
                projectId: "p",
                createdAt: "t",
                author: {},
                annotationCount: 0,
                importedAt: "t",
            })
        ).toBe(false);
        expect((await store.listBundles("p")).map((b) => b.id)).toEqual(["b"]);
        // The project its notes were in became a project record.
        expect((await store.getProject(a.projectId))?.name).toBe(a.projectId);
        store.close();
        const raw = new Database(path);
        expect(
            (
                raw.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
                    value: string;
                }
            ).value
        ).toBe("5");
        raw.close();
    });
});

describe("notato_import_bundle", () => {
    async function connect(allowImportPaths?: boolean) {
        const b = makeBackend();
        defer(b.cleanup);
        const server = createMcpServer({ backend: b.backend, version: "t", allowImportPaths });
        return { ...b, ...(await connectMcp(server, defer, { client: "t" })) };
    }

    it("loads a zip from a path, then the annotations are workable", async () => {
        const t = await connect();
        const dir = tempDir(defer, "notato-import-");
        const { zip, bundle } = await makeBundleZip(2, (n) => ({ comment: `tester note ${n}` }));
        const file = join(dir, "feedback.zip");
        writeFileSync(file, zip);

        const result = await t.call("notato_import_bundle", { path: file });
        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("2 new annotations");
        expect(result.content[0]?.text).toContain(bundle.id);

        const listed = await t.call("notato_list_open", { bundleId: bundle.id });
        expect(listed.content[0]?.text).toContain("tester note 1");
        expect(listed.content[0]?.text).toContain("tester note 2");
        const again = await t.call("notato_import_bundle", { path: file });
        expect(again.content[0]?.text).toContain("2 already present");
    });

    it("reports a missing file, a bad file, and a server that does not read paths", async () => {
        const t = await connect();
        expect(
            (await t.call("notato_import_bundle", { path: "/definitely/not/here.zip" })).content[0]
                ?.text
        ).toContain("No file at");
        const dir = tempDir(defer, "notato-import-");
        const bad = join(dir, "bad.zip");
        writeFileSync(bad, "not a zip");
        const result = await t.call("notato_import_bundle", { path: bad });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("not a readable zip");

        const locked = await connect(false);
        const refused = await locked.call("notato_import_bundle", { path: bad });
        expect(refused.isError).toBe(true);
        expect(refused.content[0]?.text).toContain("does not read files from disk");
    });
});
