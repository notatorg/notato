import type { Intent, Severity } from "@notato/schema";
import { capitalize } from "../text.ts";
import { h } from "./dom.ts";
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
    /**
     * Whether a Variants request can be made. It needs an agent on a server to put the versions in the code, so it is
     * left out where there is none (test mode, or no server).
     */
    variants?: boolean;
    onSave(value: {
        comment: string;
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
    update(patch: Partial<Pick<PopoverInit, "title" | "targets" | "anchor" | "hint">>): void;
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
    /** The line of small print under the targets; empty means no line at all. */
    const showHint = (text: string | undefined) => {
        hintEl.textContent = text ?? "";
        hintEl.style.display = text ? "" : "none";
        // A warning (something on it is moving, or no screenshot will be taken) is tinted; a tip is not.
        hintEl.classList.toggle("warn", Boolean(text && /Animating|No screenshot/.test(text)));
    };
    /** What the status line says while nothing is happening: how to save and how to back out. */
    const idle = () => `${isMac() ? "⌘↵" : "Ctrl+↵"} save · Esc cancel`;
    let targetsEl: HTMLElement;
    let saving = false;

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
        const comment = textarea.value.trim();
        if (!comment) {
            status.textContent = "Write a note first.";
            status.className = "status error";
            textarea.focus();
            return;
        }
        saving = true;
        saveBtn.disabled = true;
        status.className = "status";
        status.textContent = "Saving…";
        try {
            await current.onSave({
                comment,
                severity,
                intent,
                ...(peopleOnly ? { peopleOnly } : {}),
            });
        } catch (error) {
            saving = false;
            saveBtn.disabled = false;
            status.className = "status error";
            status.textContent = error instanceof Error ? error.message : "Could not save.";
        }
    };

    const close = () => {
        frames.cancel(job);
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
                        ev.stopPropagation();
                    },
                },
                "People only"
            );
            hintEl = h("p", { class: "hint" });
            showHint(init.hint);
            titleEl = h("h2");
            targetsEl = h("ul", { class: "targets" });
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
            status = h("span", { class: "status" }, idle());
            saveBtn = h(
                "button",
                { class: "btn primary", type: "button", onclick: () => void save() },
                "Save"
            );
            el = h(
                "div",
                { class: "popover", role: "dialog", "aria-label": "New annotation" },
                titleEl,
                targetsEl,
                hintEl,
                textarea,
                h(
                    "div",
                    { class: "chips", role: "group", "aria-label": "What should happen" },
                    ...intentChips
                ),
                h("div", { class: "chips", role: "group", "aria-label": "Severity" }, ...chips),
                h(
                    "div",
                    { class: "chips", role: "group", "aria-label": "Who it is for" },
                    peopleChip
                ),
                h(
                    "div",
                    { class: "actions" },
                    status,
                    h(
                        "button",
                        { class: "btn", type: "button", onclick: () => init.onCancel() },
                        "Cancel"
                    ),
                    saveBtn
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
