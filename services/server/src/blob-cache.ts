import type { BlobStore } from "@notato/server";

type Image = NonNullable<Awaited<ReturnType<BlobStore["get"]>>>;

/** Verified images in bounded process memory only. Permission checks still happen before every asset read. */
export class BlobCache {
    private entries = new Map<string, { image: Image; until: number }>();
    private bytes = 0;
    constructor(
        private maxBytes = 16 * 1024 * 1024,
        private ttlMs = 60_000,
        private now = Date.now
    ) {}

    get(id: string): Image | undefined {
        const entry = this.entries.get(id);
        if (!entry) return undefined;
        if (entry.until <= this.now()) {
            this.delete(id);
            return undefined;
        }
        this.entries.delete(id);
        this.entries.set(id, entry);
        return { ...entry.image, bytes: entry.image.bytes.slice() };
    }

    put(id: string, image: Image) {
        this.delete(id);
        const size = image.bytes.byteLength;
        if (size > this.maxBytes || size === 0 || this.maxBytes === 0) return;
        for (const [key, entry] of this.entries) if (entry.until <= this.now()) this.delete(key);
        while (this.bytes + size > this.maxBytes || this.entries.size >= 128) {
            const first = this.entries.keys().next().value;
            if (!first) break;
            this.delete(first);
        }
        this.entries.set(id, {
            image: { ...image, bytes: image.bytes.slice() },
            until: this.now() + this.ttlMs,
        });
        this.bytes += size;
    }

    delete(id: string) {
        const entry = this.entries.get(id);
        if (entry) this.bytes -= entry.image.bytes.byteLength;
        this.entries.delete(id);
    }
}
