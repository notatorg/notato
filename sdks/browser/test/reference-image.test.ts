// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceImage } from "../src/reference-image.ts";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
describe("explicit design references", () => {
    it("resizes on the client, strips source metadata and encodes WebP before network transfer", async () => {
        const close = vi.fn();
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 4000, height: 2000, close }))
        );
        const draw = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
            drawImage: draw,
        } as unknown as CanvasRenderingContext2D);
        vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
            this: HTMLCanvasElement,
            cb
        ) {
            expect(this.width).toBe(2048);
            expect(this.height).toBe(1024);
            cb(new Blob(["normalised"], { type: "image/webp" }));
        });
        const result = await referenceImage(
            new File(["source with metadata"], "Design.jpg", { type: "image/jpeg" })
        );
        expect(result).toMatchObject({ name: "Design", w: 2048, h: 1024 });
        expect(result.blob.type).toBe("image/webp");
        expect(await result.blob.text()).toBe("normalised");
        expect(close).toHaveBeenCalledOnce();
    });
    it("refuses unsupported files and pixel bombs", async () => {
        await expect(
            referenceImage(new File(["svg"], "x.svg", { type: "image/svg+xml" }))
        ).rejects.toThrow("PNG, JPEG or WebP");
        const close = vi.fn();
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 10000, height: 10000, close }))
        );
        await expect(
            referenceImage(new File(["x"], "x.png", { type: "image/png" }))
        ).rejects.toThrow("16 megapixels");
        expect(close).toHaveBeenCalledOnce();
    });
});
