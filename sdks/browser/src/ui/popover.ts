import type { Intent, Severity } from "@notato/schema";
import { referenceThumbnail, validateReferenceFile } from "../reference-image.ts";
import { capitalize } from "../text.ts";
import { h, ICONS, icon } from "./dom.ts";
import { createFrames, type FrameJob, type Frames } from "./frame.ts";
import { isMac } from "./keys.ts";
import { animateIn, animateOut, RISE, settle } from "./motion.ts";

export interface PopoverInit {
    /** "1 element", "Text selection", "Area" ... */
    title: string;
    /** One short line per selected element. */
    targets: string[];
    /** Viewport coordinates of the thing being annotated; the popover sits beside it. */
    anchor: { left: number; top: number; width: number; height: number };
    hint?: string;
    screenshotsOff?: boolean;
    /**
     * Whether a Variants request can be made. It needs an agent on a server to put the versions in the code, so it is
     * left out where there is none (test mode, or no server).
     */
    variants?: boolean;
    references?: boolean;
    reviewInstruction?: string;
    onSave(value: {
        comment: string;
        references?: File[];
        severity?: Severity;
        intent?: Intent;
        /** Kept between people: the agent never gets it. */
        peopleOnly?: boolean;
    }): Promise<void>;
    onCancel(): void;
}

export interface Popover {
    readonly isOpen: boolean;
    open(init: PopoverInit): void;
    /** Refresh title, targets and anchor while keeping what the person has typed (multi-select). */
    update(
        patch: Partial<
            Pick<
                PopoverInit,
                "title" | "targets" | "anchor" | "hint" | "screenshotsOff" | "references"
            >
        >
    ): void;
    /** Closes it: it fades away, and is gone for `isOpen` at once. */
    close(): void;
    /** Places it again at the next frame, with the other things over the page (see frame.ts). */
    reposition(): void;
    destroy(): void;
}

const SEVERITIES: Severity[] = ["blocker", "major", "minor", "nit"];
const INTENTS: Intent[] = ["fix", "change", "question", "approve", "variants"];
const INTENT_HINT: Record<Intent, string> = {
    fix: "Something is broken",
    change: "It works, but should be different",
    question: "Answer me; do not change anything",
    approve: "This is right as it is",
    variants: "Show me a few versions to compare in the page, and I will pick one",
};
/** Said wherever People only can be turned on, in every SDK. */
export const PEOPLE_ONLY_HINT = "Keep this between people: the agent won't see it.";
const PLACEHOLDER = "What should change? Be specific.";
const VARIANTS_PLACEHOLDER = "What should the versions explore? e.g. three layouts for this header";
const WIDTH = 320;
const GAP = 12;

type Anchor = PopoverInit["anchor"];

/** Prefers the right of the target, then the left, then below, then above; always inside the viewport. */
export function placePopover(
    anchor: Anchor,
    size: { w: number; h: number },
    view: { w: number; h: number }
) {
    const clampX = (x: number) => Math.min(Math.max(8, x), Math.max(8, view.w - size.w - 8));
    const clampY = (y: number) => Math.min(Math.max(8, y), Math.max(8, view.h - size.h - 8));
    const right = anchor.left + anchor.width + GAP;
    if (right + size.w + 8 <= view.w) return { left: right, top: clampY(anchor.top) };
    const left = anchor.left - GAP - size.w;
    if (left >= 8) return { left, top: clampY(anchor.top) };
    const below = anchor.top + anchor.height + GAP;
    if (below + size.h + 8 <= view.h) return { left: clampX(anchor.left), top: below };
    return { left: clampX(anchor.left), top: clampY(anchor.top - GAP - size.h) };
}

export function createPopover(layer: HTMLElement, frames: Frames = createFrames()): Popover {
    let el: HTMLElement | null = null;
    /** Closed and fading away: gone at once if another opens meanwhile. */
    let leaving: HTMLElement | null = null;
    let current: PopoverInit | null = null;
    let severity: Severity | undefined;
    let intent: Intent | undefined;
    let peopleOnly = false;
    let textarea: HTMLTextAreaElement;
    let saveBtn: HTMLButtonElement;
    let status: HTMLElement;
    let titleEl: HTMLElement;
    let hintEl: HTMLElement;
    let screenshotState: HTMLElement;
    let clearPreviews = () => {};
    /** The line of small print under the targets; empty means no line at all. */
    const showHint = (text: string | undefined) => {
        hintEl.textContent = text ?? "";
        hintEl.style.display = text ? "" : "none";
        hintEl.classList.toggle("warn", Boolean(text?.includes("Animating")));
    };
    let targetsEl: HTMLElement;
    let saving = false;
    let files: File[] = [];
    const attachmentsBusy = (busy: boolean) => {
        for (const control of el?.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
            ".reference-picker input, .reference-picker button"
        ) ?? [])
            control.disabled = busy;
    };

    /** Where it goes, worked out from its height as last laid out. */
    let height = 0;
    const placeNow = () => {
        if (!el || !current) return;
        const size = { w: WIDTH, h: height || 260 };
        const pos = placePopover(current.anchor, size, {
            w: window.innerWidth,
            h: window.innerHeight,
        });
        el.style.left = `${pos.left}px`;
        el.style.top = `${pos.top}px`;
    };
    const place = () => {
        height = el?.offsetHeight ?? 0;
        placeNow();
    };
    // A scroll or a change in the page measures it with everything else, and places it once all of them are measured.
    const job: FrameJob = {
        read: () => {
            height = el?.offsetHeight ?? 0;
        },
        write: placeNow,
    };

    const renderTargets = () => {
        if (!current) return;
        titleEl.textContent = current.title;
        targetsEl.replaceChildren(...current.targets.map((t) => h("li", { title: t }, t)));
    };

    const save = async () => {
        if (!current || saving) return;
        const comment = textarea.value.trim() || current.reviewInstruction || "";
        if (!comment) {
            status.textContent = "Write a note first.";
            status.className = "status error";
            textarea.focus();
            return;
        }
        saving = true;
        saveBtn.disabled = true;
        attachmentsBusy(true);
        status.className = "status";
        status.textContent = "Saving…";
        const savingPopover = el;
        try {
            await current.onSave({
                comment,
                ...(files.length ? { references: [...files] } : {}),
                severity,
                intent,
                ...(peopleOnly ? { peopleOnly } : {}),
            });
        } catch (error) {
            if (el !== savingPopover) return;
            saving = false;
            saveBtn.disabled = false;
            attachmentsBusy(false);
            status.className = "status error";
            status.textContent = error instanceof Error ? error.message : "Could not save.";
        }
    };

    const close = () => {
        frames.cancel(job);
        clearPreviews();
        if (el) {
            const going = el;
            leaving = going;
            // Typing or clicking in it while it fades would go nowhere.
            going.inert = true;
            animateOut(
                going,
                () => {
                    going.remove();
                    if (leaving === going) leaving = null;
                },
                RISE
            );
        }
        el = null;
        current = null;
        severity = undefined;
        intent = undefined;
        peopleOnly = false;
        files = [];
        saving = false;
    };

    return {
        get isOpen() {
            return el !== null;
        },
        open(init) {
            close();
            if (leaving) settle(leaving);
            current = init;
            const intentChips = INTENTS.filter((i) => i !== "variants" || init.variants).map((i) =>
                h(
                    "button",
                    {
                        class: "chip",
                        type: "button",
                        "aria-pressed": "false",
                        "data-intent": i,
                        title: INTENT_HINT[i],
                        onclick: (ev: Event) => {
                            intent = intent === i ? undefined : i;
                            for (const chip of intentChips)
                                chip.setAttribute(
                                    "aria-pressed",
                                    String(chip.dataset.intent === intent)
                                );
                            textarea.placeholder =
                                intent === "variants" ? VARIANTS_PLACEHOLDER : PLACEHOLDER;
                            ev.stopPropagation();
                        },
                    },
                    capitalize(i)
                )
            );
            const chips = SEVERITIES.map((s) =>
                h(
                    "button",
                    {
                        class: "chip",
                        type: "button",
                        "aria-pressed": "false",
                        "data-severity": s,
                        onclick: (ev: Event) => {
                            severity = severity === s ? undefined : s;
                            for (const chip of chips)
                                chip.setAttribute(
                                    "aria-pressed",
                                    String(chip.dataset.severity === severity)
                                );
                            ev.stopPropagation();
                        },
                    },
                    h("span", { class: "dot", "aria-hidden": "true" }),
                    capitalize(s)
                )
            );
            const visibilityDetail = h("p", {}, "Agents can see this note.");
            const peopleChip = h(
                "button",
                {
                    class: "chip people",
                    type: "button",
                    "aria-pressed": "false",
                    title: PEOPLE_ONLY_HINT,
                    onclick: (ev: Event) => {
                        peopleOnly = !peopleOnly;
                        peopleChip.setAttribute("aria-pressed", String(peopleOnly));
                        visibilityDetail.textContent = peopleOnly
                            ? "Only people can see this note."
                            : "Agents can see this note.";
                        ev.stopPropagation();
                    },
                },
                icon(ICONS.lock),
                "Hide from agent"
            );
            hintEl = h("p", { class: "hint" });
            showHint(init.hint);
            titleEl = h("h2");
            targetsEl = h("ul", { class: "targets" });
            screenshotState = h(
                "p",
                {
                    class: "screenshot-state",
                    style: { display: init.screenshotsOff ? "" : "none" },
                    title: "No screenshot will be taken.",
                },
                icon(ICONS.image),
                "Screenshots off"
            );
            textarea = h("textarea", {
                placeholder: PLACEHOLDER,
                "aria-label": "Annotation comment",
                rows: 3,
                onkeydown: (ev: KeyboardEvent) => {
                    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
                        ev.preventDefault();
                        void save();
                    } else if (ev.key === "Escape") {
                        ev.preventDefault();
                        init.onCancel();
                    }
                },
            });
            if (init.reviewInstruction) textarea.placeholder = "Optional detail for this target";
            const fileList = h("div", { class: "reference-files", "aria-live": "polite" });
            const previews = new Map<File, { element: HTMLElement; url?: string }>();
            // Decode one preview at a time; retain only the tiny result, never a URL for the source image.
            let previewQueue = Promise.resolve();
            const removePreview = (file: File) => {
                const preview = previews.get(file);
                if (preview?.url) URL.revokeObjectURL(preview.url);
                previews.delete(file);
            };
            clearPreviews = () => {
                for (const file of previews.keys()) removePreview(file);
            };
            const previewFor = (file: File) => {
                const existing = previews.get(file);
                if (existing) return existing.element;
                const preview: { element: HTMLElement; url?: string } = {
                    element: h(
                        "span",
                        { class: "reference-preview", "aria-hidden": "true" },
                        icon(ICONS.image)
                    ),
                };
                previews.set(file, preview);
                previewQueue = previewQueue.then(async () => {
                    if (previews.get(file) !== preview) return;
                    try {
                        const blob = await referenceThumbnail(file);
                        // Closing the composer or removing this file while decoding must not leave a URL behind.
                        if (previews.get(file) !== preview) return;
                        preview.url = URL.createObjectURL(blob);
                        preview.element.replaceChildren(h("img", { src: preview.url, alt: "" }));
                    } catch {
                        preview.element.title = "Preview unavailable";
                    }
                });
                return preview.element;
            };
            const fileCount = h("span", { class: "reference-count" }, "0 / 3");
            const fileInput = h("input", {
                type: "file",
                accept: "image/png,image/jpeg,image/webp",
                multiple: true,
                hidden: true,
                "aria-label": "Attach reference images",
            });
            const chooseFiles = h(
                "button",
                {
                    class: "btn reference-choose",
                    type: "button",
                    onclick: () => {
                        if (!saving && current?.references) fileInput.click();
                    },
                },
                "Choose images"
            );
            const redraw = () => {
                fileCount.textContent = `${files.length} / 3`;
                fileCount.setAttribute("aria-label", `${files.length} of 3 images attached`);
                fileList.replaceChildren(
                    ...files.map((f) =>
                        h(
                            "div",
                            { class: "reference-file" },
                            previewFor(f),
                            h("span", { class: "reference-name", title: f.name }, f.name),
                            h(
                                "button",
                                {
                                    class: "btn reference-remove",
                                    type: "button",
                                    "aria-label": `Remove ${f.name}`,
                                    title: `Remove ${f.name}`,
                                    onclick: () => {
                                        if (saving) return;
                                        removePreview(f);
                                        files = files.filter((item) => item !== f);
                                        redraw();
                                    },
                                },
                                icon(ICONS.close)
                            )
                        )
                    )
                );
                place();
            };
            const attach = (selected: File[]) => {
                if (!current?.references || saving || !selected.length) return;
                try {
                    if (files.length + selected.length > 3)
                        throw new Error("Attach at most three reference images.");
                    for (const file of selected) validateReferenceFile(file);
                } catch (error) {
                    status.className = "status error";
                    status.textContent = (error as Error).message;
                    place();
                    return;
                }
                files.push(...selected);
                status.className = "status";
                status.textContent = "";
                redraw();
            };
            fileInput.addEventListener("change", () => {
                attach([...(fileInput.files ?? [])]);
                fileInput.value = "";
            });
            status = h("p", { class: "status", role: "status" });
            saveBtn = h(
                "button",
                { class: "btn primary", type: "button", onclick: () => void save() },
                init.reviewInstruction ? "Add to review" : "Save note"
            );
            el = h(
                "div",
                {
                    class: "popover",
                    role: "dialog",
                    "aria-label": "New annotation",
                    onpaste: (event: ClipboardEvent) => {
                        const data = event.clipboardData;
                        if (!current?.references || !data) return;
                        // Prefer files; some browsers expose images only as items. Do not attach both representations.
                        const pasted = [...data.files];
                        const selected = (
                            pasted.length
                                ? pasted
                                : [...data.items]
                                      .filter((item) => item.kind === "file")
                                      .map((item) => item.getAsFile())
                                      .filter((file): file is File => file !== null)
                        ).filter((file) => file.type.startsWith("image/"));
                        if (!selected.length) return;
                        event.stopPropagation();
                        // Mixed text/image clipboards keep the browser's normal text insertion in the comment.
                        if (saving || !data.getData("text/plain")) event.preventDefault();
                        attach(selected);
                    },
                },
                h(
                    "div",
                    { class: "composer-content" },
                    titleEl,
                    targetsEl,
                    hintEl,
                    screenshotState,
                    init.reviewInstruction
                        ? h(
                              "p",
                              { class: "review-instruction" },
                              "Review: ",
                              init.reviewInstruction
                          )
                        : null,
                    textarea,
                    h(
                        "div",
                        {
                            class: "reference-picker",
                            style: { display: init.references ? "" : "none" },
                        },
                        h(
                            "div",
                            { class: "reference-heading" },
                            h(
                                "span",
                                {},
                                "Reference images ",
                                h("span", { class: "reference-optional" }, "(optional)")
                            ),
                            fileCount
                        ),
                        fileInput,
                        h(
                            "div",
                            {
                                class: "reference-attach",
                                role: "group",
                                "aria-label": "Add reference images",
                                onclick: (event: MouseEvent) => {
                                    if (
                                        event.target instanceof Element &&
                                        event.target.closest("button")
                                    )
                                        return;
                                    textarea.focus({ preventScroll: true });
                                },
                            },
                            h(
                                "span",
                                { class: "reference-symbol", "aria-hidden": "true" },
                                icon(ICONS.image)
                            ),
                            h(
                                "div",
                                { class: "reference-options" },
                                h(
                                    "p",
                                    { class: "reference-paste" },
                                    "Paste an image ",
                                    h("kbd", {}, isMac() ? "⌘ V" : "Ctrl V")
                                ),
                                h(
                                    "div",
                                    { class: "reference-alternative" },
                                    h("span", {}, "or"),
                                    chooseFiles
                                )
                            )
                        ),
                        fileList,
                        h("p", { class: "reference-help" }, "PNG, JPG or WebP · Up to 16 MB each")
                    ),
                    h(
                        "div",
                        { class: "composer-options", role: "group", "aria-label": "Feedback type" },
                        h(
                            "span",
                            { class: "composer-label", "aria-hidden": "true" },
                            "Feedback type"
                        ),
                        h(
                            "div",
                            {
                                class: `chips composer-intents${init.variants ? " has-variants" : ""}`,
                            },
                            ...intentChips
                        )
                    ),
                    h(
                        "div",
                        { class: "composer-options", role: "group", "aria-label": "Severity" },
                        h("span", { class: "composer-label", "aria-hidden": "true" }, "Severity"),
                        h("div", { class: "chips composer-severities" }, ...chips)
                    ),
                    init.reviewInstruction
                        ? null
                        : h(
                              "div",
                              {
                                  class: "composer-visibility",
                                  role: "group",
                                  "aria-label": "Visibility",
                              },
                              h(
                                  "div",
                                  {},
                                  h("span", { class: "composer-label" }, "Visibility"),
                                  visibilityDetail
                              ),
                              peopleChip
                          )
                ),
                h(
                    "div",
                    { class: "composer-footer" },
                    status,
                    h(
                        "div",
                        { class: "composer-commands" },
                        h(
                            "span",
                            { class: "composer-shortcuts", title: "Escape to cancel" },
                            h("kbd", {}, isMac() ? "⌘↵" : "Ctrl+↵"),
                            " to save"
                        ),
                        h(
                            "div",
                            { class: "actions" },
                            h(
                                "button",
                                { class: "btn", type: "button", onclick: () => init.onCancel() },
                                "Cancel"
                            ),
                            saveBtn
                        )
                    )
                )
            );
            layer.append(el);
            renderTargets();
            place();
            animateIn(el, RISE);
            textarea.focus({ preventScroll: true });
        },
        update(patch) {
            if (!current) return;
            current = { ...current, ...patch };
            if ("hint" in patch) showHint(patch.hint);
            if ("screenshotsOff" in patch)
                screenshotState.style.display = patch.screenshotsOff ? "" : "none";
            if ("references" in patch) {
                const picker = el?.querySelector<HTMLElement>(".reference-picker");
                if (picker) picker.style.display = patch.references ? "" : "none";
            }
            renderTargets();
            place();
        },
        close,
        reposition() {
            if (el) frames.schedule(job);
        },
        destroy() {
            close();
            if (leaving) settle(leaving);
        },
    };
}
