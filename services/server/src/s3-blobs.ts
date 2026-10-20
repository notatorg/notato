import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { ASSET_ID, type BlobStore, sha256Hex, sniffImageMime } from "@notato/server";
import { BlobCache } from "./blob-cache.ts";

const missing = (error: unknown) =>
    (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
const MAX_IMAGE = 32 * 1024 * 1024;

/** Screenshots stay in a private S3-compatible bucket; only the authorized application serves their bytes. */
export class S3BlobStore implements BlobStore {
    downloadedBytes = 0;
    private epoch = 0;
    private pending = new Map<
        string,
        { epoch: number; value: ReturnType<S3BlobStore["download"]> }
    >();
    constructor(
        private client: S3Client,
        private bucket: string,
        private cache = new BlobCache()
    ) {}

    async check() {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    }
    async list(cursor?: string, limit = 100) {
        const page = await this.client.send(
            new ListObjectsV2Command({
                Bucket: this.bucket,
                ContinuationToken: cursor,
                MaxKeys: Math.min(1000, Math.max(1, limit)),
            })
        );
        return {
            items: (page.Contents ?? [])
                .filter((item) => ASSET_ID.test(item.Key ?? ""))
                .map((item) => ({
                    id: item.Key!,
                    createdAt: item.LastModified?.toISOString() ?? "",
                })),
            ...(page.IsTruncated ? { cursor: page.NextContinuationToken } : {}),
        };
    }
    async put(bytes: Uint8Array) {
        const mime = sniffImageMime(bytes);
        if (!mime || bytes.byteLength > MAX_IMAGE)
            throw new Error("Only PNG or WebP screenshots up to 32 MiB may be stored");
        const id = await sha256Hex(bytes);
        await this.client.send(
            new PutObjectCommand({ Bucket: this.bucket, Key: id, Body: bytes, ContentType: mime })
        );
        return { id, size: bytes.byteLength };
    }
    async get(id: string) {
        if (!ASSET_ID.test(id)) return null;
        const cached = this.cache.get(id);
        if (cached) return cached;
        const epoch = this.epoch;
        const prior = this.pending.get(id);
        if (prior?.epoch === epoch) {
            const image = await prior.value;
            return image ? { ...image, bytes: image.bytes.slice() } : null;
        }
        const value = this.download(id);
        if (this.pending.size < 128) this.pending.set(id, { epoch, value });
        try {
            const image = await value;
            if (image && epoch === this.epoch) this.cache.put(id, image);
            return image;
        } finally {
            if (this.pending.get(id)?.value === value) this.pending.delete(id);
        }
    }
    private async download(id: string) {
        try {
            const result = await this.client.send(
                new GetObjectCommand({ Bucket: this.bucket, Key: id })
            );
            if (!result.Body) return null;
            if ((result.ContentLength ?? 0) > MAX_IMAGE) {
                (result.Body as { destroy?(): void }).destroy?.();
                throw new Error("Stored screenshot is too large");
            }
            const chunks: Uint8Array[] = [];
            let size = 0;
            for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
                size += chunk.byteLength;
                if (size > MAX_IMAGE) throw new Error("Stored screenshot is too large");
                chunks.push(chunk);
            }
            const bytes = new Uint8Array(Buffer.concat(chunks));
            this.downloadedBytes += bytes.byteLength;
            const mime = sniffImageMime(bytes);
            if (!mime || (await sha256Hex(bytes)) !== id)
                throw new Error("Stored screenshot failed integrity check");
            return { bytes, mime };
        } catch (error) {
            if (missing(error)) return null;
            throw error;
        }
    }
    async delete(id: string) {
        if (!ASSET_ID.test(id)) return false;
        this.epoch++;
        this.cache.delete(id);
        try {
            await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: id }));
        } catch (error) {
            if (missing(error)) return false;
            throw error;
        }
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: id }));
        this.epoch++;
        this.cache.delete(id);
        return true;
    }
}

export async function s3BlobsFromEnv(
    env: Record<string, string | undefined> = process.env
): Promise<S3BlobStore> {
    const bucket = env.NOTATO_S3_BUCKET;
    if (!bucket) throw new Error("Set NOTATO_S3_BUCKET for private screenshot storage");
    if (Boolean(env.NOTATO_S3_ACCESS_KEY_ID) !== Boolean(env.NOTATO_S3_SECRET_ACCESS_KEY))
        throw new Error("Set both S3 access credentials, or use the standard AWS credential chain");
    if (
        env.NOTATO_S3_FORCE_PATH_STYLE &&
        !["true", "false"].includes(env.NOTATO_S3_FORCE_PATH_STYLE)
    )
        throw new Error("NOTATO_S3_FORCE_PATH_STYLE must be true or false");
    const cacheMb = Number(env.NOTATO_BLOB_CACHE_MB ?? 16);
    if (!Number.isInteger(cacheMb) || cacheMb < 0 || cacheMb > 128)
        throw new Error("NOTATO_BLOB_CACHE_MB must be an integer from 0 to 128");
    const store = new S3BlobStore(
        new S3Client({
            region: env.NOTATO_S3_REGION ?? "us-east-1",
            endpoint: env.NOTATO_S3_ENDPOINT,
            forcePathStyle: env.NOTATO_S3_FORCE_PATH_STYLE === "true",
            ...(env.NOTATO_S3_ACCESS_KEY_ID
                ? {
                      credentials: {
                          accessKeyId: env.NOTATO_S3_ACCESS_KEY_ID,
                          secretAccessKey: env.NOTATO_S3_SECRET_ACCESS_KEY!,
                      },
                  }
                : {}),
            requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
            maxAttempts: 3,
        }),
        bucket,
        new BlobCache(cacheMb * 1024 * 1024)
    );
    await store.check();
    return store;
}
