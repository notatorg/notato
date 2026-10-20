/** The same input bounds apply to selected files and images explicitly pasted into the composer. */
export function validateReferenceFile(file: File): void {
    if (
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 16 * 1024 * 1024
    )
        throw new Error("Choose a PNG, JPEG or WebP image of at most 16 MB.");
}

/** Normalise an explicit attachment on the client: bound memory/transfer, strip metadata, prefer WebP. */
export async function referenceImage(
    file: File
): Promise<{ blob: Blob; name: string; w: number; h: number }> {
    return {
        ...(await prepareReference(file, 2048, 0.82)),
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Design reference",
    };
}

/** A small, local-only preview; the source file never needs an object URL or a data URL. */
export async function referenceThumbnail(file: File): Promise<Blob> {
    return (await prepareReference(file, 112, 0.72)).blob;
}

async function prepareReference(file: File, maxSide: number, quality: number) {
    validateReferenceFile(file);
    const image = await createImageBitmap(file);
    let canvas: HTMLCanvasElement | undefined;
    try {
        if (image.width * image.height > 16_000_000)
            throw new Error("Reference images must be at most 16 megapixels.");
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const w = Math.max(1, Math.round(image.width * scale));
        const h = Math.max(1, Math.round(image.height * scale));
        const surface = document.createElement("canvas");
        canvas = surface;
        surface.width = w;
        surface.height = h;
        const ctx = surface.getContext("2d");
        if (!ctx) throw new Error("This browser cannot prepare image attachments.");
        ctx.drawImage(image, 0, 0, w, h);
        const blob = await new Promise<Blob>((resolve, reject) =>
            surface.toBlob(
                (b) => (b ? resolve(b) : reject(new Error("Could not prepare the image."))),
                "image/webp",
                quality
            )
        );
        if (!["image/png", "image/webp"].includes(blob.type) || blob.size > 5 * 1024 * 1024)
            throw new Error("The reference is still larger than 5 MB. Choose a smaller image.");
        return { blob, w, h };
    } finally {
        image.close();
        if (canvas) canvas.width = canvas.height = 0;
    }
}
