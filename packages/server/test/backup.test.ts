import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { backupLocal, generateBackupKey, restoreLocal } from "../src/backup.ts";
import { BACKUP_MAX_BYTES, BackupWriter, backupEntryHeader } from "../src/backup-format.ts";
import { FileBlobStore } from "../src/blob-store.ts";
import { SqliteStore } from "../src/sqlite-store.ts";
import { annotationFixture, cleanupAfterEach, tempDir } from "./helpers.ts";

const defer = cleanupAfterEach();
it("restores existing version-one encrypted ZIP backups", async () => {
    const root = tempDir(defer, "notato-legacy-backup-"),
        key = join(root, "key"),
        file = join(root, "legacy.nbk");
    generateBackupKey(key);
    const store = new SqliteStore(join(root, "notato.db"));
    await store.createProject({ id: "test", name: "Test", createdAt: new Date().toISOString() });
    await store.insertAnnotation(annotationFixture({ projectId: "test", screenshots: undefined }));
    await store.close();
    const source = new Database(join(root, "notato.db"));
    const snapshot = join(root, "legacy.db");
    source.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    source.close();
    const magic = Buffer.from("NOTATO-BACKUP-1\n"),
        nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", readFileSync(key), nonce);
    cipher.setAAD(magic);
    const zip = zipSync(
        {
            "manifest.json": Buffer.from(
                JSON.stringify({ format: 1, storage: "sqlite-files", assets: 0 })
            ),
            "notato.db": readFileSync(snapshot),
        },
        { level: 0 }
    );
    writeFileSync(
        file,
        Buffer.concat([magic, nonce, cipher.update(zip), cipher.final(), cipher.getAuthTag()])
    );
    const dir = join(root, "restored");
    restoreLocal({ file, key, dir });
    const restored = new SqliteStore(join(dir, "notato.db"));
    expect(await restored.listProjects()).toHaveLength(1);
    await restored.close();
});

it("supports 64-bit file lengths and rejects unsafe authenticated archive entries without publishing data", () => {
    const header = backupEntryHeader("notato.db", 2 ** 32 + 17);
    expect(header.readBigUInt64BE(2)).toBe(4294967313n);
    const root = tempDir(defer, "notato-invalid-backup-"),
        key = join(root, "key");
    generateBackupKey(key);
    for (const [index, name, size] of [
        [0, "../escaped", 0],
        [1, "notato.db", BACKUP_MAX_BYTES],
        [2, "manifest.json", 16385],
    ] as const) {
        const file = join(root, `invalid-${index}.nbk`),
            fd = openSync(file, "wx", 0o600),
            writer = new BackupWriter(fd, readFileSync(key));
        try {
            writer.write(backupEntryHeader(name, size));
            writer.write(backupEntryHeader("", 0));
            writer.finish();
        } finally {
            writer.close();
            closeSync(fd);
        }
        const dir = join(root, `restored-${index}`);
        expect(() => restoreLocal({ file, key, dir })).toThrow();
        expect(existsSync(dir)).toBe(false);
    }
    expect(existsSync(join(root, "escaped"))).toBe(false);
});

it("rejects altered, truncated, reordered, spliced and appended version-two records", async () => {
    const root = tempDir(defer, "notato-record-backup-"),
        key = join(root, "key"),
        file = join(root, "good.nbk");
    generateBackupKey(key);
    const store = new SqliteStore(join(root, "notato.db"));
    await store.close();
    backupLocal({ dir: root, key, file });
    const original = readFileSync(file),
        start = Buffer.byteLength("NOTATO-BACKUP-2\n") + 40;
    const firstEnd = start + 5 + original.readUInt32BE(start) + 16;
    const secondEnd = firstEnd + 5 + original.readUInt32BE(firstEnd) + 16;
    const changed = Buffer.from(original);
    changed[firstEnd - 1] = (changed[firstEnd - 1] ?? 0) ^ 1;
    const length = Buffer.from(original);
    length.writeUInt32BE(0xffffffff, start);
    const versions = [
        changed,
        length,
        original.subarray(0, -21),
        Buffer.concat([original, Buffer.from([0])]),
        Buffer.concat([
            original.subarray(0, start),
            original.subarray(firstEnd, secondEnd),
            original.subarray(start, firstEnd),
            original.subarray(secondEnd),
        ]),
    ];
    const other = join(root, "other.nbk");
    backupLocal({ dir: root, key, file: other });
    const alternate = readFileSync(other);
    versions.push(Buffer.concat([original.subarray(0, start), alternate.subarray(start)]));
    for (const [i, bytes] of versions.entries()) {
        const bad = join(root, `bad-${i}.nbk`),
            dir = join(root, `restore-${i}`);
        writeFileSync(bad, bytes);
        expect(() => restoreLocal({ file: bad, key, dir })).toThrow();
        expect(existsSync(dir)).toBe(false);
    }
});
it("backs up a live WAL database and referenced screenshots, authenticates before restore, and preserves private modes", async () => {
    const root = tempDir(defer),
        dir = join(root, "data");
    mkdirSync(dir);
    const store = new SqliteStore(join(dir, "notato.db"));
    defer(() => store.close());
    await store.createProject({ id: "test", name: "Test", createdAt: new Date().toISOString() });
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const blobs = new FileBlobStore(join(dir, "assets"));
    const ref = await blobs.put(bytes);
    const previewBytes = new Uint8Array([...bytes, 7]);
    const preview = await blobs.put(previewBytes);
    const note = annotationFixture({
        projectId: "test",
        screenshots: {
            full: { ...ref, mime: "image/png", w: 1, h: 1 },
            thumbnail: { ...preview, mime: "image/png", w: 1, h: 1 },
        },
    });
    await store.insertAnnotation(note);
    writeFileSync(join(dir, "notato.config.json"), JSON.stringify({ screenshots: "on" }), {
        mode: 0o600,
    });
    const key = join(root, "key"),
        file = join(root, "backup.nbk");
    generateBackupKey(key);
    backupLocal({ dir, file, key });
    expect(readFileSync(file).includes(Buffer.from(note.comment))).toBe(false);
    const restored = join(root, "restored");
    restoreLocal({ file, dir: restored, key });
    const restoredStore = new SqliteStore(join(restored, "notato.db"));
    defer(() => restoredStore.close());
    expect((await restoredStore.getAnnotation(note.id))?.annotation.comment).toBe(note.comment);
    expect((await new FileBlobStore(join(restored, "assets")).get(ref.id))?.bytes).toEqual(bytes);
    expect((await new FileBlobStore(join(restored, "assets")).get(preview.id))?.bytes).toEqual(
        previewBytes
    );
    expect(readFileSync(join(restored, "notato.config.json"), "utf8")).toContain('"on"');
    expect(() => restoreLocal({ file, dir: restored, key })).toThrow("new, empty");
    const damaged = readFileSync(file);
    damaged[damaged.length - 20] = (damaged[damaged.length - 20] ?? 0) ^ 1;
    const bad = join(root, "bad.nbk");
    writeFileSync(bad, damaged);
    const badRestore = join(root, "bad-restore");
    expect(() => restoreLocal({ file: bad, dir: badRestore, key })).toThrow("authentication");
    expect(existsSync(badRestore)).toBe(false);
    const wrong = join(root, "wrong-key");
    generateBackupKey(wrong);
    expect(() => restoreLocal({ file, dir: join(root, "wrong-restore"), key: wrong })).toThrow(
        "authentication"
    );
    chmodSync(key, 0o644);
    expect(() => backupLocal({ dir, file: join(root, "another.nbk"), key })).toThrow(
        "private regular"
    );
});
it("refuses to declare a backup successful if a referenced screenshot is missing", async () => {
    const root = tempDir(defer),
        dir = join(root, "data");
    mkdirSync(dir);
    const store = new SqliteStore(join(dir, "notato.db"));
    defer(() => store.close());
    await store.createProject({ id: "test", name: "Test", createdAt: new Date().toISOString() });
    await store.insertAnnotation(annotationFixture({ projectId: "test" }));
    const key = join(root, "key"),
        file = join(root, "backup.nbk");
    generateBackupKey(key);
    expect(() => backupLocal({ dir, file, key })).toThrow();
    expect(existsSync(file)).toBe(false);
});

it("restores reference-only evidence with the encrypted backup", async () => {
    const root = tempDir(defer),
        dir = join(root, "data");
    mkdirSync(dir);
    const store = new SqliteStore(join(dir, "notato.db"));
    const blobs = new FileBlobStore(join(dir, "assets"));
    const { PNG } = await import("./helpers.ts");
    const { id } = await blobs.put(PNG);
    await store.createProject({ id: "test", name: "Test", createdAt: new Date().toISOString() });
    const note = annotationFixture({
        projectId: "test",
        screenshots: undefined,
        references: [{ id, mime: "image/png", w: 1, h: 1, name: "Design" }],
    });
    await store.insertAnnotation(note);
    const key = join(root, "key"),
        file = join(root, "backup.nbk");
    generateBackupKey(key);
    backupLocal({ dir, file, key });
    const restoredDir = join(root, "restored");
    restoreLocal({ file, key, dir: restoredDir });
    const restored = new SqliteStore(join(restoredDir, "notato.db"));
    defer(() => restored.close());
    defer(() => store.close());
    expect((await restored.getAnnotation(note.id))?.annotation.references).toEqual(note.references);
    expect((await new FileBlobStore(join(restoredDir, "assets")).get(id))?.bytes).toEqual(PNG);
});
