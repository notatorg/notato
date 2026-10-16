import { lstat, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ASSET_ID, type BlobStore, sniffImageMime } from "./storage.ts";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Plain files named by the hash of their contents, fanned out by the first two hex digits. */
export class FileBlobStore implements BlobStore {
    constructor(private dir: string) {}

    private path(id: string) {
        return join(this.dir, id.slice(0, 2), id);
    }

    async list(cursor?: string, limit = 100) {
        const items: Array<{ id: string; createdAt: string }> = [];
        const first = cursor ? parseInt(cursor.slice(0, 2), 16) : 0;
        for (let bucket = first; bucket < 256; bucket++) {
            const prefix = bucket.toString(16).padStart(2, "0");
            const names = await readdir(join(this.dir, prefix)).catch(
                (error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return [];
                    throw error;
                }
            );
            for (const id of names.sort()) {
                if (!ASSET_ID.test(id) || !id.startsWith(prefix) || (cursor && id <= cursor))
                    continue;
                if (items.length >= limit) return { items, cursor: items.at(-1)?.id };
                const info = await lstat(this.path(id)).catch((error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return null;
                    throw error;
                });
                if (info?.isFile()) items.push({ id, createdAt: info.mtime.toISOString() });
            }
        }
        return { items };
    }

    async put(bytes: Uint8Array) {
        const id = await sha256Hex(bytes);
        const path = this.path(id);
        const exists = await stat(path).then(
            () => true,
            () => false
        );
        if (!exists) {
            await mkdir(dirname(path), { recursive: true });
            // Write then rename so a crash never leaves a truncated file under its final name. The temporary name is this
            // write's own: two notes with the same screenshot arriving together each rename theirs into place (the bytes
            // are the same), where a shared name had the second rename find the file already gone.
            const temp = `${path}.${crypto.randomUUID()}.tmp`;
            try {
                await writeFile(temp, bytes);
                await rename(temp, path);
            } catch (error) {
                await unlink(temp).catch(() => undefined);
                throw error;
            }
        }
        return { id, size: bytes.byteLength };
    }

    async get(id: string) {
        if (!ASSET_ID.test(id)) return null;
        try {
            const bytes = new Uint8Array(await readFile(this.path(id)));
            return { bytes, mime: sniffImageMime(bytes) ?? "application/octet-stream" };
        } catch {
            return null;
        }
    }

    async delete(id: string) {
        if (!ASSET_ID.test(id)) return false;
        return unlink(this.path(id)).then(
            () => true,
            () => false
        );
    }
}
