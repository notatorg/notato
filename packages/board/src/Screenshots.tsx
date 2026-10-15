import { pinNumber, screenshotCrop } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { useCallback, useRef, useState } from "react";
import { assetHref } from "./api.ts";
import { Icon, useEscape } from "./ui.tsx";

const FULL_ALT = "The page, with the target outlined";

/**
 * A note's screenshots: the page with its pin's number on paper, and the close-up beside it when there is one. Either
 * opens the page full size over everything, until Escape or a click closes it.
 */
export function Screenshots({ annotation: a }: { annotation: Annotation }) {
    const [zoom, setZoom] = useState(false);
    useEscape(() => setZoom(false), zoom);
    const fullImage = useRef<HTMLImageElement>(null);
    const cropCanvas = useRef<HTMLCanvasElement>(null);
    const lightboxCanvas = useRef<HTMLCanvasElement | null>(null);
    const drawLightbox = useCallback((canvas: HTMLCanvasElement | null) => {
        lightboxCanvas.current = canvas;
        const image = fullImage.current;
        if (!canvas || !image?.complete || !image.naturalWidth) return;
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d")?.drawImage(image, 0, 0);
    }, []);
    const crop = screenshotCrop(a);
    const drawCrop = () => {
        const image = fullImage.current;
        const canvas = cropCanvas.current;
        if (!image?.complete || !image.naturalWidth || !canvas || !crop) return;
        const scale = Math.min(1, 800 / Math.max(crop.w, crop.h));
        canvas.width = Math.max(1, Math.round(crop.w * scale));
        canvas.height = Math.max(1, Math.round(crop.h * scale));
        canvas
            .getContext("2d")
            ?.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
    };
    const shots = a.screenshots;
    if (!shots) return null;
    const pin = pinNumber(a);

    return (
        <>
            <div className={shots.crop || crop ? "shots two" : "shots"}>
                <button
                    type="button"
                    className="shot"
                    onClick={() => setZoom(true)}
                    aria-label="Enlarge the screenshot"
                >
                    <img
                        ref={fullImage}
                        onLoad={() => {
                            drawCrop();
                            drawLightbox(lightboxCanvas.current);
                        }}
                        src={assetHref(shots.full.id)}
                        alt={FULL_ALT}
                        loading="lazy"
                    />
                    {pin ? (
                        <span className="paper-tag" aria-hidden="true">
                            #{pin}
                        </span>
                    ) : null}
                    <span className="shot-route">{a.route}</span>
                </button>
                {crop ? (
                    <button
                        type="button"
                        className="shot crop"
                        onClick={() => setZoom(true)}
                        aria-label="Enlarge"
                    >
                        <canvas
                            ref={cropCanvas}
                            role="img"
                            aria-label="Close-up of the target"
                            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                        />
                    </button>
                ) : shots.crop ? (
                    <button
                        type="button"
                        className="shot crop"
                        onClick={() => setZoom(true)}
                        aria-label="Enlarge"
                    >
                        <img
                            src={assetHref(shots.crop.id)}
                            alt="Close-up of the target"
                            loading="lazy"
                        />
                    </button>
                ) : null}
            </div>

            {zoom ? (
                <dialog className="lightbox" open aria-label="Screenshot">
                    <button
                        type="button"
                        className="shade"
                        aria-label="Close"
                        onClick={() => setZoom(false)}
                    />
                    <canvas
                        ref={drawLightbox}
                        className="lightbox-img"
                        role="img"
                        aria-label={FULL_ALT}
                    />
                    <button
                        type="button"
                        className="icon-button lightbox-close"
                        aria-label="Close"
                        onClick={() => setZoom(false)}
                    >
                        <Icon name="close" />
                    </button>
                </dialog>
            ) : null}
        </>
    );
}
