// Images a person attaches on purpose (design references, images sent with a reply), prepared in the browser before
// they are sent: bounded in size, stripped of metadata, and encoded as WebP. Browser-only: it draws on a canvas.

/** What a person may choose or paste: checked before anything is decoded. */
export function validateImageFile(file: File): void {
    if (
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 16 * 1024 * 1024
    )
        throw new Error("Choose a PNG, JPEG or WebP image of at most 16 MB.");
}

/** An image ready to send: at most 2048 px a side, WebP, and named after its file (or `fallback`). */
export async function attachedImage(
    file: File,
    fallback = "Image"
): Promise<{ blob: Blob; name: string; w: number; h: number }> {
    return {
        ...(await prepareImage(file, 2048, 0.82)),
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || fallback,
    };
}

/** A small, local-only preview; the source file never needs an object URL or a data URL. */
export async function imageThumbnail(file: File): Promise<Blob> {
    return (await prepareImage(file, 112, 0.72)).blob;
}

async function prepareImage(file: File, maxSide: number, quality: number) {
    validateImageFile(file);
    const image = await createImageBitmap(file);
    let canvas: HTMLCanvasElement | undefined;
    try {
        if (image.width * image.height > 16_000_000)
            throw new Error("Images must be at most 16 megapixels.");
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
            throw new Error("The image is still larger than 5 MB. Choose a smaller image.");
        return { blob, w, h };
    } finally {
        image.close();
        if (canvas) canvas.width = canvas.height = 0;
    }
}
