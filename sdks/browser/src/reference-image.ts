import { attachedImage, imageThumbnail, validateImageFile } from "@notato/core";

// Design references and images sent with replies are prepared the same way (see @notato/core's attached-image).

/** The same input bounds apply to selected files and images explicitly pasted into the composer. */
export function validateReferenceFile(file: File): void {
    validateImageFile(file);
}

/** Normalise an explicit attachment on the client: bound memory/transfer, strip metadata, prefer WebP. */
export function referenceImage(
    file: File
): Promise<{ blob: Blob; name: string; w: number; h: number }> {
    return attachedImage(file, "Design reference");
}

/** A small, local-only preview; the source file never needs an object URL or a data URL. */
export function referenceThumbnail(file: File): Promise<Blob> {
    return imageThumbnail(file);
}
