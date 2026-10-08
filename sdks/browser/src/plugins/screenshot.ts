import type { CapturePlugin, DraftAnnotation } from "@notato/core";
import { domToCanvas } from "modern-screenshot";
import { EDITABLE, MASK_ATTR, ROOT_ATTR } from "../attributes.ts";
import { messageOf } from "../text.ts";
import { isIframe } from "../ui/dom.ts";
import { contentBox, framesIn, viewportRect } from "../ui/frames.ts";

export interface ScreenshotOptions {
    /** Cap on the long edge of the full screenshot, in pixels. */
    maxEdge?: number;
    /** Padding around the target in the crop, in CSS pixels. */
    cropPadding?: number;
    /**
     * Mask `input`, `textarea` and `select` values, and regions typed into (`contenteditable`, `role="textbox"`).
     * Defaults to true in test and agent mode, false in dev. Password fields and elements marked `data-notato-mask`
     * are masked regardless; `data-notato-mask="false"` opts a field out.
     */
    maskInputs?: boolean;
    /**
     * Asked before each capture. When it answers false nothing is rendered or kept, but the annotation is still made
     * (and still numbered), without a screenshot.
     */
    enabled?: () => boolean | Promise<boolean>;
    /** WebP quality, 0 to 1. */
    quality?: number;
    /** `auto` uses WebP where the browser can encode it and PNG otherwise. */
    format?: "auto" | "png";
    outlineColor?: string;
}

interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Device-pixel scale that honours the DPR but keeps the long edge at or under `maxEdge`. */
export function planCapture(vw: number, vh: number, dpr: number, maxEdge: number) {
    const scale = Math.min(dpr, maxEdge / Math.max(vw, vh));
    return { scale, width: Math.round(vw * scale), height: Math.round(vh * scale) };
}

/** The target padded by `padding`, clamped to the viewport. Coordinates are CSS pixels. */
export function cropBox(rect: Box, padding: number, vw: number, vh: number): Box {
    const x = Math.max(0, rect.x - padding);
    const y = Math.max(0, rect.y - padding);
    const right = Math.min(vw, rect.x + rect.w + padding);
    const bottom = Math.min(vh, rect.y + rect.h + padding);
    return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

const NON_VALUE_INPUTS = new Set(["button", "submit", "reset", "image", "hidden"]);

/** A form field with a value, or a region people type into, which holds what they wrote just the same. */
function isValueField(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input")
        return !NON_VALUE_INPUTS.has((el.getAttribute("type") ?? "text").toLowerCase());
    return el.matches(EDITABLE);
}

/**
 * Whether an element is covered in screenshots: anything marked `data-notato-mask` (and so all inside it), a password
 * field always, and with `maskFields` every value field that has not opted out with `data-notato-mask="false"`.
 */
export function shouldMask(el: Element, maskFields: boolean): boolean {
    const mark = el.getAttribute(MASK_ATTR);
    if (mark !== null && mark !== "false") return true;
    if (
        el.tagName.toLowerCase() === "input" &&
        (el.getAttribute("type") ?? "").toLowerCase() === "password"
    )
        return true;
    return maskFields && mark !== "false" && isValueField(el);
}

/** Turns a cloned node into a solid block with no user data left in it. Runs on the clone only. */
export function maskClone(cloned: Node, maskFields: boolean): void {
    if (cloned.nodeType !== 1) return;
    const el = cloned as HTMLElement;
    if (!shouldMask(el, maskFields)) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    for (const attr of ["value", "placeholder", "checked", "selected"]) el.removeAttribute(attr);
    const field = el as HTMLInputElement;
    if ("value" in field) field.value = "";
    if ("checked" in field) field.checked = false;
    const set = (prop: string, value: string) => el.style.setProperty(prop, value, "important");
    set("background", "#9ca3af");
    set("background-image", "none");
    set("color", "transparent");
    set("-webkit-text-fill-color", "transparent");
    set("text-shadow", "none");
    set("border-color", "#6b7280");
}

/**
 * The root is translated by the scroll offset to crop the viewport, which makes it the containing block
 * for `position: fixed` descendants. Shift those back so fixed headers and banners land where they were.
 */
export function shiftFixed(cloned: Node, scrollX: number, scrollY: number): void {
    if (cloned.nodeType !== 1 || (scrollX === 0 && scrollY === 0)) return;
    const style = (cloned as HTMLElement).style;
    if (style?.position !== "fixed") return;
    const existing = style.transform && style.transform !== "none" ? ` ${style.transform}` : "";
    style.transform = `translate(${scrollX}px, ${scrollY}px)${existing}`;
}

/** The colour a window's page is painted on: its body's, else its root's, else white. */
function backgroundOf(win: Window): string {
    for (const el of [win.document.body, win.document.documentElement]) {
        if (!el) continue;
        const bg = win.getComputedStyle(el).backgroundColor;
        if (bg && bg !== "transparent" && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg)) return bg;
    }
    return "#ffffff";
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export async function ensureVisible(el: Element | undefined): Promise<void> {
    if (!el?.scrollIntoView) return;
    const r = el.getBoundingClientRect();
    const inView =
        r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
    if (inView) return;
    el.scrollIntoView({ block: "center", inline: "center" });
    await nextFrame();
    await nextFrame();
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encode(
    canvas: HTMLCanvasElement,
    options: Required<Pick<ScreenshotOptions, "format" | "quality">>
) {
    if (options.format === "auto") {
        const webp = await toBlob(canvas, "image/webp", options.quality);
        if (webp?.type === "image/webp") return webp;
    }
    const png = await toBlob(canvas, "image/png");
    if (!png) throw new Error("canvas.toBlob returned null");
    return png;
}

/** Outline and number each target on the canvas. `f` converts CSS px to canvas px. */
function drawOutline(
    canvas: HTMLCanvasElement,
    boxes: Box[],
    pinNumber: number,
    f: number,
    color: string
) {
    const ctx = canvas.getContext("2d");
    if (!ctx || boxes.length === 0) return;
    ctx.lineWidth = Math.max(2, 3 * f);
    ctx.strokeStyle = color;
    boxes.forEach((b, i) => {
        ctx.setLineDash(boxes.length > 1 && i > 0 ? [8 * f, 5 * f] : []);
        ctx.strokeRect(b.x * f, b.y * f, b.w * f, b.h * f);
    });
    const first = boxes[0] as Box;
    const r = 11 * f;
    const cx = Math.min(Math.max(first.x * f, r + 2), canvas.width - r - 2);
    const cy = Math.min(Math.max(first.y * f, r + 2), canvas.height - r - 2);
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.round(12 * f)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(pinNumber), cx, cy + 0.5 * f);
}

function viewportBoxes(draft: DraftAnnotation): Box[] {
    if ((draft.kind === "element" || draft.kind === "multi") && draft.elements.length > 0) {
        return draft.elements.map((el) => {
            // In the top page's viewport, which is what the capture is of, however many iframes deep the element is.
            const r = viewportRect(el);
            return { x: r.left, y: r.top, w: r.width, h: r.height };
        });
    }
    return [
        {
            x: draft.rect.x - window.scrollX,
            y: draft.rect.y - window.scrollY,
            w: draft.rect.w,
            h: draft.rect.h,
        },
    ];
}

/**
 * DOM re-render with modern-screenshot. Known gaps: canvas, cross-origin images, video, some fonts.
 * If rendering fails the annotation still gets a placeholder image, so the note is never lost.
 */
export function screenshotPlugin(options: ScreenshotOptions = {}): CapturePlugin {
    const maxEdge = options.maxEdge ?? 2000;
    const cropPadding = options.cropPadding ?? 24;
    const outlineColor = options.outlineColor ?? "#ef4444";
    const encoding = { format: options.format ?? "auto", quality: options.quality ?? 0.9 } as const;

    return {
        id: "screenshot",
        async capture(draft) {
            if (options.enabled && !(await options.enabled())) {
                return { context: { screenshot: { method: "off", pin: draft.number } } };
            }
            const maskFields = options.maskInputs ?? draft.mode !== "dev";
            let shot: Rendered | undefined;
            let method: "supplied" | "dom" | "fallback" = "dom";
            let error: string | undefined;
            let suppliedError: string | undefined;

            // Real pixels from a driver beat an in-page re-render, which is imperfect by nature.
            if (draft.screenshot) {
                try {
                    shot = await fromSupplied(draft.screenshot, maxEdge, maskFields);
                    method = "supplied";
                } catch (e) {
                    suppliedError = messageOf(e);
                }
            }
            if (!shot) {
                await ensureVisible(draft.elements[0]);
                shot = await renderDom(maxEdge, maskFields);
                if (shot.error) {
                    method = "fallback";
                    error = shot.error;
                }
            }

            const { canvas, vw, vh } = shot;
            const boxes = viewportBoxes(draft);
            const f = canvas.width / vw;
            const primary = boxes[0] as Box;
            const crop = cropBox(boxes.length > 1 ? union(boxes) : primary, cropPadding, vw, vh);
            const cropCanvas = document.createElement("canvas");
            cropCanvas.width = Math.max(1, Math.round(crop.w * f));
            cropCanvas.height = Math.max(1, Math.round(crop.h * f));
            cropCanvas
                .getContext("2d")
                ?.drawImage(
                    canvas,
                    crop.x * f,
                    crop.y * f,
                    crop.w * f,
                    crop.h * f,
                    0,
                    0,
                    cropCanvas.width,
                    cropCanvas.height
                );

            drawOutline(canvas, boxes, draft.number, f, outlineColor);

            const [fullBlob, cropBlob] = await Promise.all([
                encode(canvas, encoding),
                encode(cropCanvas, encoding),
            ]);
            const full = await draft.putAsset(fullBlob, { w: canvas.width, h: canvas.height });
            const cropRef = await draft.putAsset(cropBlob, {
                w: cropCanvas.width,
                h: cropCanvas.height,
            });

            return {
                screenshots: { full, crop: cropRef },
                context: {
                    screenshot: {
                        method,
                        pin: draft.number,
                        ...(error ? { error } : {}),
                        ...(shot.frames ? { frames: shot.frames } : {}),
                        ...(shot.frameErrors ? { frameErrors: shot.frameErrors } : {}),
                        ...(shot.foreignFrames ? { foreignFrames: shot.foreignFrames } : {}),
                        ...(suppliedError ? { suppliedError } : {}),
                    },
                },
            };
        },
    };
}

interface Rendered {
    canvas: HTMLCanvasElement;
    /** How many iframes were drawn in, and how many could not be. */
    frames?: number;
    frameErrors?: number;
    /** Frames from another origin, which cannot be read and are drawn as a labelled box. */
    foreignFrames?: number;
    /** The viewport size in CSS pixels that the canvas covers. */
    vw: number;
    vh: number;
    error?: string;
}

/** Re-renders the visible part of the page. Falls back to a placeholder image if that fails. */
async function renderDom(maxEdge: number, maskFields: boolean): Promise<Rendered> {
    const root = document.documentElement;
    const vw = root.clientWidth;
    const vh = root.clientHeight;
    const plan = planCapture(vw, vh, window.devicePixelRatio || 1, maxEdge);
    const sx = window.scrollX;
    const sy = window.scrollY;
    try {
        const canvas = await domToCanvas(root, {
            width: vw,
            height: vh,
            scale: plan.scale,
            backgroundColor: backgroundOf(window),
            style: { transform: `translate(${-sx}px, ${-sy}px)`, transformOrigin: "0 0" },
            timeout: 8000,
            filter: (node) => !(node.nodeType === 1 && (node as Element).hasAttribute(ROOT_ATTR)),
            onCloneEachNode: (cloned) => {
                maskClone(cloned, maskFields);
                shiftFixed(cloned, sx, sy);
            },
        });
        // An iframe's content is a document of its own, which this render leaves blank: draw each one in.
        const frames = await compositeFrames(canvas, window, plan.scale, maskFields);
        return {
            canvas,
            vw,
            vh,
            ...(frames.drawn ? { frames: frames.drawn } : {}),
            ...(frames.failed ? { frameErrors: frames.failed } : {}),
            ...(frames.foreign ? { foreignFrames: frames.foreign } : {}),
        };
    } catch (e) {
        const error = messageOf(e);
        return { canvas: placeholder(plan.width, plan.height, error), vw, vh, error };
    }
}

/**
 * Renders each same-origin iframe in view on its own and draws it where it sits, down through nested frames. A frame
 * that cannot be rendered is left as it was (blank) and counted, so the screenshot is still made.
 */
async function compositeFrames(
    canvas: HTMLCanvasElement,
    win: Window,
    scale: number,
    maskFields: boolean,
    origin = { x: 0, y: 0 },
    depth = 0
): Promise<{ drawn: number; failed: number; foreign: number }> {
    const result = { drawn: 0, failed: 0, foreign: 0 };
    const ctx = canvas.getContext("2d");
    if (!ctx || depth > 3) return result;
    for (const frame of framesIn(win.document)) {
        let inner: Window | null = null;
        let foreign = false;
        try {
            inner = frame.contentWindow;
            void inner?.document.body;
        } catch {
            foreign = true; // another origin: nothing to read
        }
        const box = contentBox(frame);
        if (foreign) {
            // Say so on the image, rather than leave a blank that looks like a bug in the app.
            if (box.width > 0 && box.height > 0) {
                ctx.fillStyle = "#e5e7eb";
                ctx.fillRect(
                    (origin.x + box.left) * scale,
                    (origin.y + box.top) * scale,
                    box.width * scale,
                    box.height * scale
                );
                ctx.fillStyle = "#6b7280";
                ctx.font = `${Math.round(12 * scale)}px system-ui, sans-serif`;
                ctx.fillText(
                    "Content from another origin (not captured)",
                    (origin.x + box.left + 8) * scale,
                    (origin.y + box.top + 20) * scale
                );
                result.foreign += 1;
            }
            continue;
        }
        if (!inner) continue;
        const x = origin.x + box.left;
        const y = origin.y + box.top;
        const inView =
            box.width > 0 &&
            box.height > 0 &&
            x < canvas.width / scale &&
            y < canvas.height / scale &&
            x + box.width > 0 &&
            y + box.height > 0;
        if (!inView) continue;
        const sx = inner.scrollX;
        const sy = inner.scrollY;
        try {
            const sub = await domToCanvas(inner.document.documentElement, {
                width: box.width,
                height: box.height,
                scale,
                backgroundColor: backgroundOf(inner),
                style: { transform: `translate(${-sx}px, ${-sy}px)`, transformOrigin: "0 0" },
                timeout: 5000,
                onCloneEachNode: (cloned) => {
                    maskClone(cloned, maskFields);
                    shiftFixed(cloned, sx, sy);
                },
            });
            ctx.drawImage(sub, x * scale, y * scale, box.width * scale, box.height * scale);
            result.drawn += 1;
            const nested = await compositeFrames(
                canvas,
                inner,
                scale,
                maskFields,
                { x, y },
                depth + 1
            );
            result.drawn += nested.drawn;
            result.failed += nested.failed;
            result.foreign += nested.foreign;
        } catch {
            result.failed += 1;
        }
    }
    return result;
}

/** Decodes pixels a driver supplied, scales them to the size cap, and blocks out sensitive fields. */
async function fromSupplied(blob: Blob, maxEdge: number, maskFields: boolean): Promise<Rendered> {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // A driver's screenshot covers the whole viewport, scrollbars included.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    maskRects(canvas, canvas.width / vw, maskFields);
    return { canvas, vw, vh };
}

/**
 * Real pixels cannot be rewritten the way a cloned DOM can, so sensitive fields are covered with a solid
 * block at their current position instead. `f` converts CSS pixels to canvas pixels.
 */
export function maskRects(canvas: HTMLCanvasElement, f: number, maskFields: boolean): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#9ca3af";
    for (const el of maskCandidates(document)) {
        if (!shouldMask(el, maskFields)) continue;
        // In the top page's viewport, which is what the driver's pixels are of, wherever the element lives.
        const r = viewportRect(el);
        if (r.width === 0 || r.height === 0) continue;
        ctx.fillRect(r.left * f, r.top * f, r.width * f, r.height * f);
    }
}

const MASK_CANDIDATES = `[${MASK_ATTR}], input, textarea, select, ${EDITABLE}`;

/** What may need covering, in a document and in every open shadow root and same-origin iframe inside it. */
function maskCandidates(root: Document | ShadowRoot, depth = 0): Element[] {
    const found = [...root.querySelectorAll(MASK_CANDIDATES)];
    if (depth > 8) return found;
    for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) found.push(...maskCandidates(el.shadowRoot, depth + 1));
        if (!isIframe(el)) continue;
        let inner: Document | null = null;
        try {
            inner = el.contentDocument;
        } catch {
            // another origin: the driver's pixels show it, but nothing in it can be found
        }
        if (inner) found.push(...maskCandidates(inner, depth + 1));
    }
    return found;
}

/** Base64 (or a `data:` URL) to a Blob, typed by its magic bytes. Accepts PNG, WebP and JPEG. */
export function blobFromBase64(input: string): Blob {
    const base64 = input.replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const type =
        bytes[0] === 0x89 && bytes[1] === 0x50
            ? "image/png"
            : bytes[0] === 0xff && bytes[1] === 0xd8
              ? "image/jpeg"
              : bytes[0] === 0x52 && bytes[8] === 0x57
                ? "image/webp"
                : "";
    if (!type) throw new Error("screenshot must be a PNG, WebP or JPEG image, base64-encoded");
    return new Blob([bytes], { type });
}

function union(boxes: Box[]): Box {
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.w));
    const bottom = Math.max(...boxes.map((b) => b.y + b.h));
    return { x, y, w: right - x, h: bottom - y };
}

function placeholder(width: number, height: number, message: string): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
        ctx.fillStyle = "#f3f4f6";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#374151";
        ctx.font = "16px system-ui, sans-serif";
        ctx.fillText(`Screenshot unavailable: ${message}`.slice(0, 120), 16, 28);
    }
    return canvas;
}
