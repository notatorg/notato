import type { Annotation } from "@notato/schema";
import { sha256Hex } from "./blob-store.ts";
import type { CaptureReceipt } from "./storage.ts";

/** Stable JSON: a retry may change JSON key order, but never the submitted content. */
function canonical(value: unknown, depth = 0): unknown {
    if (depth > 128) throw new Error("capture content is nested too deeply");
    if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, item]) => item !== undefined)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, item]) => [key, canonical(item, depth + 1)])
        );
    return value;
}

/** No credential secret is stored. Receipts are bound to its identity, deployment scope and project. */
export function captureScope(tokenId: string, projectId: string, scope?: string): Promise<string> {
    return sha256Hex(new TextEncoder().encode(JSON.stringify([scope ?? null, tokenId, projectId])));
}

/** A durable acknowledgement of these exact submitted bytes, never permission to read the stored note. */
export async function captureReceipt(
    annotation: Annotation,
    files: ReadonlyMap<string, Uint8Array>,
    scope: string
): Promise<CaptureReceipt> {
    // These fields are discarded on capture. A new zip may package the same notes under a different bundle id.
    const {
        bundleId: _bundle,
        status: _status,
        thread: _thread,
        links: _links,
        variants: _variants,
        ...note
    } = annotation;
    // Zip entry paths are packaging details, not part of the captured image.
    const screenshots = note.screenshots
        ? Object.fromEntries(
              Object.entries(note.screenshots)
                  .filter(([, ref]) => !!ref)
                  .map(([view, ref]) => [view, { ...ref, path: undefined }])
          )
        : undefined;
    const assets = await Promise.all(
        [...files]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(async ([id, bytes]) => [id, await sha256Hex(bytes)])
    );
    return {
        scope,
        fingerprint: await sha256Hex(
            new TextEncoder().encode(
                JSON.stringify(canonical({ note: { ...note, screenshots }, assets }))
            )
        ),
    };
}
