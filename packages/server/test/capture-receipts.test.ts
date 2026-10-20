import { describe, expect, it } from "bun:test";
import { SqliteStore } from "../src/index.ts";
import {
    annotationFixture,
    cleanupAfterEach,
    filesFor,
    makeBundleZip,
    multipart,
    tempDir,
} from "./helpers.ts";
import { bearer, issue, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();

describe("capture submission receipts", () => {
    it("acknowledges only identical retries by the same token, without reading later feedback", async () => {
        const s = await startServe(defer);
        const token = await issue(s, "p", "capture", { permission: "capture" });
        const other = await issue(s, "p", "other", { permission: "capture" });
        const note = annotationFixture({ projectId: "p" });
        const send = (a = note, key = token, files = filesFor()) =>
            s.call("/projects/p/annotations", {
                method: "POST",
                headers: bearer(key),
                body: multipart(a, files),
            });
        expect((await send()).status).toBe(201);
        await s.rt.backend.reply(note.id, "Private reply added on the board", { kind: "human" });
        await s.rt.backend.setStatus(note.id, "resolved");
        const retry = await send();
        expect(retry.status).toBe(200);
        const ack = await retry.json();
        expect(ack).toMatchObject({
            accepted: true,
            seq: 0,
            annotation: { id: note.id, status: "open", thread: [] },
        });
        expect(JSON.stringify(ack)).not.toContain("Private reply");
        expect(JSON.stringify(ack)).not.toContain("fingerprint");
        expect((await send({ ...note, comment: "Different submission" })).status).toBe(409);
        expect((await send(note, other)).status).toBe(409);
        const files = filesFor();
        const entry = [...files][0];
        if (!entry) throw new Error("missing fixture image");
        const [id, bytes] = entry;
        files.set(id, new Uint8Array([...bytes, 0]));
        expect((await send(note, token, files)).status).toBe(409);
        expect((await s.rt.backend.get(note.id))?.annotation.status).toBe("resolved");
        expect((await s.call(`/annotations/${note.id}`, { headers: bearer(token) })).status).toBe(
            403
        );
    });

    it("handles simultaneous retries once and persists receipts across SQLite restarts", async () => {
        const s = await startServe(defer);
        const token = await issue(s, "p", "capture", { permission: "capture" });
        const note = annotationFixture({ projectId: "p" });
        const responses = await Promise.all(
            [0, 1].map(() =>
                s.call("/projects/p/annotations", {
                    method: "POST",
                    headers: bearer(token),
                    body: multipart(note, filesFor()),
                })
            )
        );
        expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
        expect(await s.rt.backend.list({ projectId: "p" })).toHaveLength(1);
        const path = `${tempDir(defer, "notato-receipt-")}/db.sqlite`;
        const receipt = { scope: "scope", fingerprint: "fingerprint" };
        const db = new SqliteStore(path);
        await db.insertAnnotation(note, 0, receipt);
        db.close();
        const reopened = new SqliteStore(path);
        defer(() => reopened.close());
        expect(await reopened.getCaptureReceipt(note.id)).toEqual(receipt);
        await reopened.updateAnnotation(note.id, (a) => ({ ...a, comment: "Edited" }));
        expect(await reopened.getCaptureReceipt(note.id)).toEqual(receipt);
        await reopened.deleteAnnotation(note.id);
        expect(await reopened.getCaptureReceipt(note.id)).toBeNull();
    });

    it("allows capture bundles as new human feedback and retries them without restoring history", async () => {
        const s = await startServe(defer);
        const token = await issue(s, "checkout-web", "capture", { permission: "capture" });
        const { zip, bundle, originals } = await makeBundleZip(2, () => ({
            status: "resolved",
            author: { kind: "agent" },
            thread: [
                {
                    id: "fake",
                    body: "Forged history",
                    author: { kind: "agent" },
                    createdAt: new Date().toISOString(),
                },
            ],
        }));
        const upload = () =>
            s.call("/projects/checkout-web/bundles", {
                method: "POST",
                headers: { ...bearer(token), "content-type": "application/zip" },
                body: zip as BodyInit,
            });
        const first = await upload();
        expect(first.status).toBe(201);
        expect(await first.json()).toMatchObject({ imported: 2, skipped: 0 });
        const notes = await s.rt.backend.list({ projectId: "checkout-web" });
        for (const { annotation } of notes) {
            expect(annotation.author.kind).toBe("human");
            expect(annotation.status).toBe("open");
            expect(annotation.thread).toEqual([]);
            expect(annotation.context).toMatchObject({
                notatoCaptureSource: "unverified app feedback",
            });
        }
        const again = await upload();
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ imported: 0, skipped: 2 });
        // Repackaging changes the bundle id and zip entry paths, not the captured notes.
        const repackaged = await makeBundleZip(2, (n) => originals[2 - n] ?? {});
        const repack = await s.call("/projects/checkout-web/bundles", {
            method: "POST",
            headers: bearer(token),
            body: repackaged.zip as BodyInit,
        });
        expect(repack.status).toBe(200);
        expect(await repack.json()).toMatchObject({ imported: 0, skipped: 2 });
        expect((await s.call(`/bundles/${bundle.id}`, { headers: bearer(token) })).status).toBe(
            403
        );
        expect(
            (await s.call(`/bundles/${bundle.id}/export`, { headers: bearer(token) })).status
        ).toBe(403);
        expect(
            (
                await s.call("/projects/other/bundles", {
                    method: "POST",
                    headers: bearer(token),
                    body: zip as BodyInit,
                })
            ).status
        ).toBe(403);
        const other = await issue(s, "checkout-web", "other", { permission: "capture" });
        expect(
            (
                await s.call("/projects/checkout-web/bundles", {
                    method: "POST",
                    headers: bearer(other),
                    body: zip as BodyInit,
                })
            ).status
        ).toBe(409);
    });

    it("refuses a bundle conflicting with someone else's note before storing its new notes", async () => {
        const s = await startServe(defer);
        const token = await issue(s, "checkout-web", "capture", { permission: "capture" });
        const existing = annotationFixture({ projectId: "checkout-web" });
        await s.rt.backend.ingest(existing, filesFor());
        const { zip } = await makeBundleZip(2, (n) => (n === 2 ? { id: existing.id } : {}));
        const res = await s.call("/projects/checkout-web/bundles", {
            method: "POST",
            headers: bearer(token),
            body: zip as BodyInit,
        });
        expect(res.status).toBe(409);
        expect(await s.rt.backend.list({ projectId: "checkout-web" })).toHaveLength(1);
    });
});
