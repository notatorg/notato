import { Database } from "bun:sqlite";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
    closeSync,
    constants,
    existsSync,
    fstatSync,
    fsyncSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { annotationAssets } from "@notato/schema";
import { Unzip, UnzipPassThrough } from "fflate";
import {
    BACKUP_CHUNK,
    BACKUP_MAX_BYTES,
    BACKUP_MAX_ENTRIES,
    BACKUP_V2_MAGIC,
    BackupReader,
    BackupWriter,
    backupEntryHeader,
} from "./backup-format.ts";
import { ASSET_ID } from "./storage.ts";

const MAGIC = Buffer.from("NOTATO-BACKUP-1\n");
function keyFrom(path: string): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0)
            throw new Error("backup key must be a private regular file (mode 600)");
        const key = readFileSync(fd);
        if (key.length !== 32) throw new Error("backup key must contain exactly 32 random bytes");
        return key;
    } finally {
        closeSync(fd);
    }
}
export function generateBackupKey(path: string) {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
        writeSync(fd, randomBytes(32));
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}
function writeAll(fd: number, bytes: Uint8Array) {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}
function regular(path: string) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) {
        closeSync(fd);
        throw new Error("backup sources must be regular files");
    }
    return fd;
}
function chunks(path: string, consume: (bytes: Uint8Array) => void) {
    const fd = regular(path);
    try {
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
            const n = readSync(fd, buffer, 0, buffer.length, null);
            if (!n) break;
            consume(buffer.subarray(0, n));
        }
    } finally {
        closeSync(fd);
    }
}

/** Consistent SQLite snapshot, referenced immutable assets, and settings. Encrypted with AES-256-GCM; key never enters the archive. */
export function backupLocal(options: {
    dir: string;
    file: string;
    key: string;
    config?: string;
}): void {
    const dir = resolve(options.dir),
        file = resolve(options.file),
        key = keyFrom(options.key);
    if (existsSync(file)) throw new Error("backup destination already exists");
    const staging = mkdtempSync(join(dirname(file), ".notato-backup-"));
    const output = join(staging, "encrypted");
    let target: number | undefined;
    let db: Database | undefined;
    let snapshot: Database | undefined;
    let writer: BackupWriter | undefined;
    try {
        db = new Database(join(dir, "notato.db"), { readonly: true });
        db.exec("PRAGMA busy_timeout=5000");
        const snapshotFile = join(staging, "notato.db");
        db.exec(`VACUUM INTO '${snapshotFile.replaceAll("'", "''")}'`);
        db.close();
        db = undefined;
        snapshot = new Database(snapshotFile, { readonly: true });
        if (
            (snapshot.query("PRAGMA integrity_check").get() as { integrity_check: string })
                .integrity_check !== "ok"
        )
            throw new Error("database snapshot failed integrity check");
        const ids = new Set<string>();
        for (const row of snapshot
            .query<{ json: string }, []>("SELECT json FROM annotations")
            .iterate()) {
            const a = JSON.parse(row.json);
            for (const ref of annotationAssets(a))
                if (ref) {
                    if (!ASSET_ID.test(ref.id)) throw new Error("invalid stored asset ID");
                    ids.add(ref.id);
                }
        }
        snapshot.close();
        snapshot = undefined;
        if (ids.size + 3 > BACKUP_MAX_ENTRIES) throw new Error("backup has too many screenshots");
        target = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        writer = new BackupWriter(target, key);
        const archive = writer;
        const add = (name: string, path: string, hash?: string) => {
            const fd = regular(path);
            try {
                const size = fstatSync(fd).size;
                archive.write(backupEntryHeader(name, size));
                const buffer = Buffer.alloc(BACKUP_CHUNK),
                    digest = hash ? createHash("sha256") : undefined;
                let remaining = size;
                while (remaining) {
                    const n = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
                    if (!n) throw new Error("backup source changed while reading");
                    remaining -= n;
                    digest?.update(buffer.subarray(0, n));
                    archive.write(buffer.subarray(0, n));
                }
                if (fstatSync(fd).size !== size)
                    throw new Error("backup source changed while reading");
                if (digest && digest.digest("hex") !== hash)
                    throw new Error("screenshot backup failed integrity check");
            } finally {
                closeSync(fd);
            }
        };
        const manifest = Buffer.from(
            JSON.stringify({
                format: 2,
                storage: "sqlite-files",
                createdAt: new Date().toISOString(),
                assets: ids.size,
            })
        );
        archive.write(backupEntryHeader("manifest.json", manifest.length));
        archive.write(manifest);
        add("notato.db", snapshotFile);
        const config = options.config ?? join(dir, "notato.config.json");
        if (existsSync(config)) add("notato.config.json", config);
        for (const id of ids)
            add(`assets/${id.slice(0, 2)}/${id}`, join(dir, "assets", id.slice(0, 2), id), id);
        archive.write(backupEntryHeader("", 0));
        archive.finish();
        fsyncSync(target);
        closeSync(target);
        target = undefined;
        linkSync(output, file);
        unlinkSync(output);
    } finally {
        if (target !== undefined) closeSync(target);
        db?.close();
        snapshot?.close();
        writer?.close();
        key.fill(0);
        rmSync(staging, { recursive: true, force: true });
    }
}

/** Restore only to a new directory. Authenticate the entire archive before any extraction is published. */
export function restoreLocal(options: { file: string; dir: string; key: string }): void {
    const dir = resolve(options.dir),
        key = keyFrom(options.key);
    if (existsSync(dir))
        throw new Error(
            "restore needs a new, empty destination path; stop the server before switching data directories"
        );
    const staging = mkdtempSync(join(dirname(dir), ".notato-restore-")),
        zipFile = join(staging, "archive.zip"),
        data = join(staging, "data");
    let input: number | undefined, output: number | undefined;
    const handles = new Set<number>();
    try {
        input = regular(options.file);
        const prefix = Buffer.alloc(BACKUP_V2_MAGIC.length);
        readSync(input, prefix, 0, prefix.length, 0);
        if (prefix.equals(BACKUP_V2_MAGIC)) {
            const seen = extractV2(input, key, data);
            publishRestored(data, dir, seen, 2);
            return;
        }
        const size = fstatSync(input).size,
            head = Buffer.alloc(MAGIC.length + 12),
            tag = Buffer.alloc(16);
        if (
            size < head.length + 16 ||
            readSync(input, head, 0, head.length, 0) !== head.length ||
            !head.subarray(0, MAGIC.length).equals(MAGIC)
        )
            throw new Error("unsupported backup format");
        readSync(input, tag, 0, 16, size - 16);
        const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
        decipher.setAAD(MAGIC);
        decipher.setAuthTag(tag);
        output = openSync(
            zipFile,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600
        );
        const buffer = Buffer.alloc(64 * 1024);
        let offset = head.length;
        while (offset < size - 16) {
            const n = readSync(
                input,
                buffer,
                0,
                Math.min(buffer.length, size - 16 - offset),
                offset
            );
            if (!n) throw new Error("truncated backup");
            offset += n;
            writeAll(output, decipher.update(buffer.subarray(0, n)));
        }
        try {
            writeAll(output, decipher.final());
        } catch {
            throw new Error("backup authentication failed: wrong key or damaged file");
        }
        closeSync(output);
        output = undefined;
        closeSync(input);
        input = undefined;
        mkdirSync(data, { mode: 0o700 });
        const seen = new Set<string>();
        let total = 0,
            complete = 0;
        const unzip = new Unzip((entry) => {
            const name = entry.name;
            if (
                seen.has(name) ||
                !(
                    name === "manifest.json" ||
                    name === "notato.db" ||
                    name === "notato.config.json" ||
                    /^assets\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(name)
                ) ||
                entry.compression !== 0
            )
                throw new Error("invalid backup archive entry");
            seen.add(name);
            const path = join(data, name);
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            const fd = openSync(
                path,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                0o600
            );
            handles.add(fd);
            const hash = name.startsWith("assets/") ? createHash("sha256") : undefined;
            entry.ondata = (error, bytes, final) => {
                if (error) throw error;
                total += bytes.length;
                if (total > 100 * 1024 ** 3)
                    throw new Error("restore exceeds 100 GiB safety limit");
                writeAll(fd, bytes);
                hash?.update(bytes);
                if (final) {
                    closeSync(fd);
                    handles.delete(fd);
                    if (hash && hash.digest("hex") !== name.split("/")[2])
                        throw new Error("restored asset failed integrity check");
                    complete++;
                }
            };
            entry.start();
        });
        unzip.register(UnzipPassThrough);
        chunks(zipFile, (bytes) => unzip.push(bytes));
        unzip.push(new Uint8Array(), true);
        if (complete !== seen.size || !seen.has("notato.db") || !seen.has("manifest.json"))
            throw new Error("incomplete backup archive");
        publishRestored(data, dir, seen, 1);
    } finally {
        for (const fd of handles) closeSync(fd);
        if (input !== undefined) closeSync(input);
        if (output !== undefined) closeSync(output);
        key.fill(0);
        rmSync(staging, { recursive: true, force: true });
    }
}

function publishRestored(data: string, dir: string, seen: Set<string>, format: number) {
    const manifest = JSON.parse(readFileSync(join(data, "manifest.json"), "utf8"));
    if (
        manifest.format !== format ||
        manifest.storage !== "sqlite-files" ||
        manifest.assets !== Array.from(seen).filter((n) => n.startsWith("assets/")).length
    )
        throw new Error("invalid backup manifest");
    const db = new Database(join(data, "notato.db"), { readonly: true });
    try {
        if (
            (db.query("PRAGMA integrity_check").get() as { integrity_check: string })
                .integrity_check !== "ok"
        )
            throw new Error("restored database failed integrity check");
        for (const row of db
            .query<{ json: string }, []>("SELECT json FROM annotations")
            .iterate()) {
            const a = JSON.parse(row.json);
            for (const ref of annotationAssets(a))
                if (ref && !seen.has(`assets/${ref.id.slice(0, 2)}/${ref.id}`))
                    throw new Error("backup lacks a referenced screenshot");
        }
    } finally {
        db.close();
    }
    unlinkSync(join(data, "manifest.json"));
    if (existsSync(dir)) throw new Error("restore destination already exists");
    renameSync(data, dir);
}

function extractV2(input: number, key: Buffer, data: string): Set<string> {
    const reader = new BackupReader(input, key),
        seen = new Set<string>();
    let total = 0;
    try {
        mkdirSync(data, { mode: 0o700 });
        for (;;) {
            const header = reader.read(10),
                length = header.readUInt16BE(0),
                size64 = header.readBigUInt64BE(2);
            if (length === 0) {
                if (size64 !== 0n) throw new Error("invalid backup terminator");
                break;
            }
            if (length > 128 || size64 > BigInt(BACKUP_MAX_BYTES))
                throw new Error("invalid backup archive entry");
            const name = reader.read(length).toString("utf8"),
                size = Number(size64);
            if (
                seen.has(name) ||
                seen.size >= BACKUP_MAX_ENTRIES ||
                !(
                    name === "manifest.json" ||
                    name === "notato.db" ||
                    name === "notato.config.json" ||
                    /^assets\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(name)
                )
            )
                throw new Error("invalid backup archive entry");
            if (name === "manifest.json" && size > 16384)
                throw new Error("invalid backup manifest");
            if (
                name.startsWith("assets/") &&
                name.split("/")[1] !== name.split("/")[2]?.slice(0, 2)
            )
                throw new Error("invalid backup asset path");
            total += size;
            if (total > BACKUP_MAX_BYTES) throw new Error("restore exceeds the 1 TiB safety limit");
            seen.add(name);
            const path = join(data, name);
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            const fd = openSync(
                    path,
                    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                    0o600
                ),
                hash = name.startsWith("assets/") ? createHash("sha256") : undefined;
            try {
                let remaining = size;
                while (remaining) {
                    const bytes = reader.read(Math.min(BACKUP_CHUNK, remaining));
                    writeAll(fd, bytes);
                    hash?.update(bytes);
                    remaining -= bytes.length;
                }
            } finally {
                closeSync(fd);
            }
            if (hash && hash.digest("hex") !== name.split("/")[2])
                throw new Error("restored asset failed integrity check");
        }
        reader.finish();
        if (!seen.has("manifest.json") || !seen.has("notato.db"))
            throw new Error("incomplete backup archive");
        return seen;
    } finally {
        reader.close();
    }
}
