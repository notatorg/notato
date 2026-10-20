import { expect, it } from "bun:test";
import { Readable } from "node:stream";
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    type S3Client,
} from "@aws-sdk/client-s3";
import { BlobCache } from "../src/blob-cache.ts";
import { S3BlobStore } from "../src/s3-blobs.ts";
import { PNG } from "./helpers.ts";

function fixture() {
    const objects = new Map<string, Uint8Array>();
    let downloads = 0;
    const client = {
        async send(command: unknown) {
            if (command instanceof PutObjectCommand) {
                objects.set(command.input.Key!, new Uint8Array(command.input.Body as Uint8Array));
                return {};
            }
            if (command instanceof ListObjectsV2Command)
                return {
                    Contents: [...objects.keys()].map((Key) => ({ Key, LastModified: new Date() })),
                };
            if (command instanceof DeleteObjectCommand) {
                objects.delete(command.input.Key!);
                return {};
            }
            if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) {
                const bytes = objects.get(command.input.Key!);
                if (!bytes)
                    throw Object.assign(new Error("missing"), {
                        $metadata: { httpStatusCode: 404 },
                    });
                if (command instanceof HeadObjectCommand) return {};
                downloads++;
                return { Body: Readable.from([bytes]), ContentLength: bytes.byteLength };
            }
            return {};
        },
    } as unknown as S3Client;
    return {
        store: new S3BlobStore(client, "screenshots", new BlobCache()),
        objects,
        downloads: () => downloads,
    };
}
it("round-trips verified content, coalesces concurrent reads and invalidates deleted objects", async () => {
    const f = fixture();
    const { id } = await f.store.put(PNG);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    const images = await Promise.all([f.store.get(id), f.store.get(id), f.store.get(id)]);
    expect(images.every((image) => Buffer.from(image!.bytes).equals(Buffer.from(PNG)))).toBe(true);
    expect(f.downloads()).toBe(1);
    images[0]!.bytes[0] = 0;
    expect((await f.store.get(id))!.bytes[0]).toBe(PNG[0]);
    expect((await f.store.list()).items[0]?.id).toBe(id);
    expect(await f.store.delete(id)).toBe(true);
    expect(await f.store.get(id)).toBeNull();
    expect(await f.store.delete(id)).toBe(false);
});
it("refuses corrupt objects, unsupported images and unsafe object identifiers", async () => {
    const f = fixture();
    const { id } = await f.store.put(PNG);
    f.objects.set(id, new Uint8Array([1, 2, 3]));
    await expect(f.store.get(id)).rejects.toThrow("integrity");
    await expect(f.store.put(new Uint8Array([1, 2, 3]))).rejects.toThrow("PNG or WebP");
    expect(await f.store.get("../secret")).toBeNull();
    expect(await f.store.delete("../secret")).toBe(false);
});
