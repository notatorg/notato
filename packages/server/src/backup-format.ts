import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { fstatSync, readSync, writeSync } from "node:fs";

export const BACKUP_V2_MAGIC = Buffer.from("NOTATO-BACKUP-2\n");
export const BACKUP_CHUNK = 64 * 1024;
export const BACKUP_MAX_BYTES = 1024 ** 4;
export const BACKUP_MAX_ENTRIES = 1_000_003;
const HEADER_SIZE = BACKUP_V2_MAGIC.length + 40;

function writeAll(fd: number, bytes: Uint8Array) {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}
function subkey(key: Buffer, header: Buffer) {
    return Buffer.from(
        hkdfSync(
            "sha256",
            key,
            header.subarray(BACKUP_V2_MAGIC.length, BACKUP_V2_MAGIC.length + 32),
            "notato-backup-v2",
            32
        )
    );
}
function nonce(header: Buffer, sequence: number) {
    const value = Buffer.alloc(12);
    header.copy(value, 0, header.length - 8);
    value.writeUInt32BE(sequence, 8);
    return value;
}
function aad(header: Buffer, record: Buffer, sequence: number) {
    const number = Buffer.alloc(4);
    number.writeUInt32BE(sequence);
    return Buffer.concat([header, record, number]);
}

/** Independent per-backup key, unique record nonces and authenticated order/length/finality. */
export class BackupWriter {
    private readonly header = Buffer.concat([BACKUP_V2_MAGIC, randomBytes(32), randomBytes(8)]);
    private readonly key: Buffer;
    private sequence = 0;
    private total = 0;
    constructor(
        private readonly fd: number,
        key: Buffer
    ) {
        this.key = subkey(key, this.header);
        writeAll(fd, this.header);
    }
    private record(bytes: Uint8Array, final: boolean) {
        if (this.sequence >= 0xffff_ffff) throw new Error("backup has too many encrypted records");
        const record = Buffer.alloc(5);
        record.writeUInt32BE(bytes.length);
        record[4] = final ? 1 : 0;
        const cipher = createCipheriv("aes-256-gcm", this.key, nonce(this.header, this.sequence));
        cipher.setAAD(aad(this.header, record, this.sequence++));
        writeAll(this.fd, record);
        writeAll(this.fd, cipher.update(bytes));
        writeAll(this.fd, cipher.final());
        writeAll(this.fd, cipher.getAuthTag());
    }
    write(bytes: Uint8Array) {
        this.total += bytes.length;
        if (this.total > BACKUP_MAX_BYTES) throw new Error("backup exceeds the 1 TiB safety limit");
        for (let offset = 0; offset < bytes.length; offset += BACKUP_CHUNK)
            this.record(bytes.subarray(offset, offset + BACKUP_CHUNK), false);
    }
    finish() {
        this.record(new Uint8Array(), true);
    }
    close() {
        this.key.fill(0);
    }
}

/** Decrypt each bounded record before use; publication still requires the authenticated final record and exact EOF. */
export class BackupReader {
    private readonly header: Buffer;
    private readonly key: Buffer;
    private offset = HEADER_SIZE;
    private sequence = 0;
    private total = 0;
    private buffer = Buffer.alloc(0);
    private used = 0;
    private final = false;
    private readonly size: number;
    constructor(
        private readonly fd: number,
        key: Buffer
    ) {
        this.size = fstatSync(fd).size;
        this.header = this.raw(HEADER_SIZE, 0);
        if (!this.header.subarray(0, BACKUP_V2_MAGIC.length).equals(BACKUP_V2_MAGIC))
            throw new Error("unsupported backup format");
        this.key = subkey(key, this.header);
    }
    private raw(size: number, offset: number) {
        const result = Buffer.alloc(size);
        let n = 0;
        while (n < size) {
            const got = readSync(this.fd, result, n, size - n, offset + n);
            if (!got) throw new Error("truncated backup");
            n += got;
        }
        return result;
    }
    private next() {
        if (this.final || this.sequence >= 0xffff_ffff)
            throw new Error("invalid backup record sequence");
        const record = this.raw(5, this.offset),
            length = record.readUInt32BE(0),
            flag = record[4];
        if (
            length > BACKUP_CHUNK ||
            (flag !== 0 && flag !== 1) ||
            (flag === 1 ? length !== 0 : length === 0)
        )
            throw new Error("backup authentication failed: invalid record");
        this.offset += 5;
        const encrypted = this.raw(length + 16, this.offset);
        this.offset += encrypted.length;
        const decipher = createDecipheriv(
            "aes-256-gcm",
            this.key,
            nonce(this.header, this.sequence)
        );
        decipher.setAAD(aad(this.header, record, this.sequence++));
        decipher.setAuthTag(encrypted.subarray(length));
        try {
            this.buffer = Buffer.concat([
                decipher.update(encrypted.subarray(0, length)),
                decipher.final(),
            ]);
        } catch {
            throw new Error("backup authentication failed: wrong key or damaged file");
        }
        this.total += length;
        if (this.total > BACKUP_MAX_BYTES)
            throw new Error("restore exceeds the 1 TiB safety limit");
        this.used = 0;
        this.final = flag === 1;
        if (this.final && this.offset !== this.size) throw new Error("trailing backup data");
    }
    read(size: number) {
        if (!Number.isInteger(size) || size < 0 || size > BACKUP_CHUNK)
            throw new Error("invalid backup read size");
        const result = Buffer.alloc(size);
        let n = 0;
        while (n < size) {
            if (this.used === this.buffer.length) {
                if (this.final) throw new Error("truncated backup archive");
                this.next();
                if (this.final) throw new Error("truncated backup archive");
            }
            const take = Math.min(size - n, this.buffer.length - this.used);
            this.buffer.copy(result, n, this.used, this.used + take);
            this.used += take;
            n += take;
        }
        return result;
    }
    finish() {
        if (this.used !== this.buffer.length) throw new Error("trailing backup archive data");
        this.next();
        if (!this.final) throw new Error("missing final backup record");
    }
    close() {
        this.key.fill(0);
        this.buffer.fill(0);
    }
}

/** The stored file size is 64-bit, independent of ZIP's 32-bit entry and offset limits. */
export function backupEntryHeader(name: string, size: number) {
    const encoded = Buffer.from(name);
    if (encoded.length > 128 || !Number.isSafeInteger(size) || size < 0 || size > BACKUP_MAX_BYTES)
        throw new Error("invalid backup entry size");
    const header = Buffer.alloc(10);
    header.writeUInt16BE(encoded.length);
    header.writeBigUInt64BE(BigInt(size), 2);
    return Buffer.concat([header, encoded]);
}
