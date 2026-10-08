import { type AnnotationRecord, buildBundle, type SinkPlugin } from "@notato/core";
import { bundleFilename, bundleToZip } from "./sinks/zip.ts";
import { messageOf } from "./text.ts";
import type { PackagedBundle } from "./types.ts";

/** A packaged bundle with its zip as bytes. `window.__notato.package()` hands the same over with the zip in base64. */
export type PackagedZip = Omit<PackagedBundle, "zipBase64"> & { zip: Uint8Array };

export interface PackageOptions {
    project: string;
    appName?: string;
    appVersion?: string;
    /** The name the bundle is from. */
    author?: string;
    /** Where the bundle goes when it is sent. */
    sinks: SinkPlugin[];
    /** Hand the bundle to every sink (download, upload), and say how each went. */
    send?: boolean;
}

/** Builds the bundle zip from every note, and with `send` hands the bundle to the sinks. */
export async function packageNotes(
    records: AnnotationRecord[],
    options: PackageOptions
): Promise<PackagedZip> {
    if (records.length === 0)
        throw new Error("nothing to package yet: make at least one annotation");
    const { bundle, assets } = buildBundle(records, {
        projectId: options.project,
        author: { name: options.author },
        appName: options.appName,
        appVersion: options.appVersion,
    });
    const delivery: PackagedBundle["delivery"] = [];
    if (options.send) {
        const results = await Promise.allSettled(
            options.sinks.map((s) => s.deliver(bundle, assets))
        );
        results.forEach((result, i) => {
            const sink = options.sinks[i]?.id ?? "unknown";
            delivery.push(
                result.status === "fulfilled"
                    ? { sink, ok: true }
                    : { sink, ok: false, error: messageOf(result.reason) }
            );
        });
    }
    return {
        bundleId: bundle.id,
        filename: bundleFilename(options.project),
        annotations: records.length,
        zip: await bundleToZip(bundle, assets),
        delivery,
    };
}

/** Standard base64 of raw bytes, in chunks so large zips do not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
        out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(out);
}
