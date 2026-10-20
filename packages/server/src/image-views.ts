import type { ScreenshotCrop } from "@notato/core";
import { PNG } from "pngjs";
import type { AssetBytes } from "./backend.ts";
import { sniffImageMime } from "./storage.ts";

const MAX_PIXELS = 16_000_000;
const MAX_BYTES = 25 * 1024 * 1024;
const CACHE_BYTES = 8 * 1024 * 1024;

/** Immutable derived pixels, in bounded memory only. Callers must authorize every request before reaching this. */
export class ImageViews {
    readonly supported = typeof Bun.Image === "function";
    private cache = new Map<string, { image: AssetBytes; until: number }>();
    private size = 0;
    private pending = new Map<string, Promise<AssetBytes | null>>();
    private turn: Promise<unknown> = Promise.resolve();

    constructor(private source: (id: string) => Promise<AssetBytes | null>) {}

    async get(
        id: string,
        crop: ScreenshotCrop | undefined,
        thumbnail: boolean,
        supplied?: AssetBytes
    ): Promise<AssetBytes | null> {
        if (!this.supported) return supplied ?? this.source(id);
        const key = `${id}:${crop ? [crop.x, crop.y, crop.w, crop.h].join(",") : "full"}:${thumbnail ? "thumb240" : "crop"}`;
        const cached = this.cache.get(key);
        if (cached && cached.until > Date.now()) {
            this.cache.delete(key);
            this.cache.set(key, cached);
            return { ...cached.image, bytes: cached.image.bytes.slice() };
        }
        if (cached) this.remove(key);
        let work = this.pending.get(key);
        if (!work) {
            if (this.pending.size >= 8) throw new Error("screenshot processor is busy");
            work = this.turn.then(async () => {
                const image = supplied ?? (await this.source(id));
                if (!image) return null;
                const result = await this.render(image, crop, thumbnail);
                for (const [old, value] of this.cache)
                    if (value.until <= Date.now()) this.remove(old);
                while (this.size + result.bytes.length > CACHE_BYTES || this.cache.size >= 128) {
                    const first = this.cache.keys().next().value;
                    if (!first) break;
                    this.remove(first);
                }
                if (!supplied && result.bytes.length <= CACHE_BYTES) {
                    this.cache.set(key, { image: result, until: Date.now() + 60_000 });
                    this.size += result.bytes.length;
                }
                return result;
            });
            this.pending.set(key, work);
            this.turn = work.catch(() => {});
            void work.finally(() => this.pending.delete(key)).catch(() => {});
        }
        const image = await work;
        return image ? { ...image, bytes: image.bytes.slice() } : null;
    }

    private remove(key: string) {
        const value = this.cache.get(key);
        if (value) this.size -= value.image.bytes.length;
        this.cache.delete(key);
    }

    private async render(
        image: AssetBytes,
        crop: ScreenshotCrop | undefined,
        thumbnail: boolean
    ): Promise<AssetBytes> {
        if (image.bytes.length > MAX_BYTES || !sniffImageMime(image.bytes))
            throw new Error("invalid screenshot input");
        const input = new Bun.Image(image.bytes, { maxPixels: MAX_PIXELS, autoOrient: false });
        const { width, height, format } = await input.metadata();
        if (
            width < 1 ||
            height < 1 ||
            width * height > MAX_PIXELS ||
            !["png", "webp"].includes(format)
        )
            throw new Error("screenshot dimensions exceed processing limits");
        if (
            crop &&
            (![crop.x, crop.y, crop.w, crop.h].every(Number.isSafeInteger) ||
                crop.x < 0 ||
                crop.y < 0 ||
                crop.w < 1 ||
                crop.h < 1 ||
                crop.x + crop.w > width ||
                crop.y + crop.h > height)
        )
            throw new Error("invalid screenshot crop");
        // PNG is a portable pixel bridge: Bun supplies native WebP decoding/encoding in the standalone CLI too.
        // An uncompressed intermediate avoids spending time compressing data that is never stored or transferred.
        const png =
            format === "png" ? image.bytes : await input.png({ compressionLevel: 0 }).bytes();
        const pixels = PNG.sync.read(Buffer.from(png));
        const box = crop ?? { x: 0, y: 0, w: width, h: height };
        const target = new PNG({ width: box.w, height: box.h });
        for (let row = 0; row < box.h; row++) {
            const start = ((box.y + row) * width + box.x) * 4;
            target.data.set(pixels.data.subarray(start, start + box.w * 4), row * box.w * 4);
        }
        const clean = PNG.sync.write(target, { deflateLevel: 0 });
        let output = new Bun.Image(clean, { maxPixels: MAX_PIXELS, autoOrient: false });
        if (thumbnail)
            output = output.resize(240, 160, { fit: "inside", withoutEnlargement: true });
        return {
            bytes: await output.webp({ quality: thumbnail ? 75 : 85 }).bytes(),
            mime: "image/webp",
        };
    }
}
