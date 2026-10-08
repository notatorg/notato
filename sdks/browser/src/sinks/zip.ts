import { type AssetMap, type SinkPlugin, writeBundle } from "@notato/core";
import type { Annotation, Bundle } from "@notato/schema";

/** `notato-checkout-web-20261005-1042.zip`: sortable, and safe on every filesystem. */
export function bundleFilename(project: string, at: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
    return `notato-${project.replace(/[^\w.@-]/g, "_")}-${stamp}.zip`;
}

/** Builds the zip from a bundle and the screenshot blobs the page holds. */
export function bundleToZip(bundle: Bundle, assets: AssetMap): Promise<Uint8Array> {
    return writeBundle(bundle, async (ref) => {
        const blob = assets.get(ref.id);
        return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
    });
}

export function downloadZip(zip: Uint8Array, filename: string): void {
    const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    // The download has started by the time the task queue turns over; give slow browsers a while anyway.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export interface ZipSinkOptions {
    filename?: (bundle: Bundle) => string;
}

/** Downloads each packaged bundle as a zip. Single annotations are ignored: they travel inside bundles. */
export function zipSink(options: ZipSinkOptions = {}): SinkPlugin {
    return {
        id: "zip",
        async deliver(input: Annotation | Bundle, assets: AssetMap) {
            if (!("annotations" in input)) return;
            const zip = await bundleToZip(input, assets);
            downloadZip(zip, options.filename?.(input) ?? bundleFilename(input.projectId));
        },
    };
}
