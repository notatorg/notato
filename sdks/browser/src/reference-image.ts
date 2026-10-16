/** Normalise an explicit attachment on the client: bound memory/transfer, strip metadata, prefer WebP. */
export async function referenceImage(
    file: File
): Promise<{ blob: Blob; name: string; w: number; h: number }> {
    if (
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 16 * 1024 * 1024
    )
        throw new Error("Choose a PNG, JPEG or WebP image of at most 16 MB.");
    const image = await createImageBitmap(file);
    try {
        if (image.width * image.height > 16_000_000)
            throw new Error("Reference images must be at most 16 megapixels.");
        const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
        const w = Math.max(1, Math.round(image.width * scale));
        const h = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("This browser cannot prepare image attachments.");
        ctx.drawImage(image, 0, 0, w, h);
        const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
                (b) => (b ? resolve(b) : reject(new Error("Could not prepare the image."))),
                "image/webp",
                0.82
            )
        );
        if (!["image/png", "image/webp"].includes(blob.type) || blob.size > 5 * 1024 * 1024)
            throw new Error("The reference is still larger than 5 MB. Choose a smaller image.");
        return {
            blob,
            name: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Design reference",
            w,
            h,
        };
    } finally {
        image.close();
    }
}
