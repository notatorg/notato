import type { Rect, Target } from "@notato/schema";
import { h, isElement } from "./dom.ts";
import { type Box, boxToTop, viewportRect, watchFrames } from "./frames.ts";
import { addSheet, type Sheet } from "./sheet.ts";

export interface Selection {
    kind: Target["kind"];
    elements: Element[];
    /** Page coordinates, CSS px. */
    rect: Rect;
    selectedText?: string;
}

export interface PickEvent extends Selection {
    /** Cmd/Ctrl was held: add to or remove from the current draft instead of replacing it. */
    additive: boolean;
}

export interface Picker {
    readonly active: boolean;
    setActive(active: boolean): void;
    /** Outlines the elements of the draft in progress. */
    showDraft(elements: Element[], area?: Rect): void;
    clearDraft(): void;
    destroy(): void;
}

interface PickerOptions {
    /** The shadow host: events from inside it belong to Notato's own UI. */
    host: HTMLElement;
    layer: HTMLElement;
    /**
     * Short label for the hover highlight, e.g. `button "Pay now"`. Asked for every element the pointer crosses, so it
     * must be cheap: the full identity is for what is picked.
     */
    describe(el: Element): string;
    onPick(event: PickEvent): void;
}

const DRAG_THRESHOLD = 8;
const SELECT_THRESHOLD = 3;
const SWALLOWED = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "auxclick",
] as const;

export const toPageRect = (r: {
    left: number;
    top: number;
    width: number;
    height: number;
}): Rect => ({
    x: r.left + window.scrollX,
    y: r.top + window.scrollY,
    w: r.width,
    h: r.height,
});

/** True when the point sits over rendered text, so a drag from there means "select this text". */
export function pointIsOnText(x: number, y: number, doc: Document = document): boolean {
    const d = doc as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (
            x: number,
            y: number
        ) => { offsetNode: Node; offset: number } | null;
    };
    const node =
        d.caretRangeFromPoint?.(x, y)?.startContainer ??
        d.caretPositionFromPoint?.(x, y)?.offsetNode;
    if (node?.nodeType !== 3) return false;
    const probe = doc.createRange();
    probe.selectNodeContents(node);
    return Array.from(probe.getClientRects()).some(
        (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    );
}

/** The window an event happened in: the page's, or an iframe's. */
const windowOf = (ev: Event): Window => ((ev as UIEvent).view as Window | null) ?? window;

const CURSOR_CSS = "html, html * { cursor: crosshair !important; }";
/**
 * Kept apart from the cursor, because a hit test that has to see these turns this sheet off for a moment, and turning
 * off a rule for every element (the cursor's) makes the browser restyle the whole page.
 */
const CLICK_THROUGH_CSS = [
    // Browsers never dispatch mousedown, mouseup or click to a disabled form control, so a click on one would not
    // reach us at all: while annotating they are click-through, and `elementAt` finds the one really under the pointer.
    ":disabled { pointer-events: none !important; }",
    // A frame from another origin cannot be entered, so it is picked as the one element it is, and does not take the click.
    "iframe[data-notato-foreign] { pointer-events: none !important; }",
].join(" ");
/** What the click-through rules make the browser look past. */
const CLICK_THROUGH = ":disabled, iframe[data-notato-foreign]";
const PICKING_MARKER = "data-notato-picking";

export function createPicker(options: PickerOptions): Picker {
    const { host, layer } = options;
    const label = h("div", { class: "hover-label" });
    const hover = h("div", { class: "hover" }, label);
    const drag = h("div", { class: "drag" });
    const selBoxes: HTMLElement[] = [];
    layer.append(hover, drag);

    let active = false;
    let hovered: Element | null = null;
    /** Where a press started, in the coordinates of the window it started in. */
    let down: {
        x: number;
        y: number;
        el: Element;
        win: Window;
        additive: boolean;
        onText: boolean;
    } | null = null;
    let dragging = false;
    let draftEls: Element[] = [];
    let draftArea: Rect | undefined;

    const fromUi = (ev: Event) => ev.composedPath().includes(host);

    /** The sheets of each window being picked in, the page's and each same-origin iframe's, while annotating. */
    const styles = new Map<Window, { cursor: Sheet; clickThrough: Sheet }>();
    const addStyles = (win: Window) => {
        if (styles.has(win)) return;
        styles.set(win, {
            cursor: addSheet(win.document, CURSOR_CSS, PICKING_MARKER),
            clickThrough: addSheet(win.document, CLICK_THROUGH_CSS, PICKING_MARKER),
        });
    };
    const removeStyles = (win: Window) => {
        const sheets = styles.get(win);
        sheets?.cursor.remove();
        sheets?.clickThrough.remove();
        styles.delete(win);
    };

    /** Runs `fn` with disabled controls and foreign frames hit-testable again, for a hit test that has to see them. */
    const lifted = <T>(win: Window, fn: () => T): T => {
        const sheet = styles.get(win)?.clickThrough;
        if (!sheet) return fn();
        const was = sheet.disabled;
        sheet.disabled = true;
        try {
            return fn();
        } finally {
            sheet.disabled = was;
        }
    };

    /** While Shift is held the page is used as normal: no crosshair, and disabled controls act as disabled again. */
    const showPageCursor = (shift: boolean) => {
        for (const sheets of styles.values()) {
            sheets.cursor.disabled = shift;
            sheets.clickThrough.disabled = shift;
        }
    };
    const onShiftKey = (ev: KeyboardEvent) => {
        if (active && ev.key === "Shift") showPageCursor(ev.type === "keydown");
    };
    const onWindowBlur = () => showPageCursor(false);

    const hitTest = (win: Window, x: number, y: number): Element | null => {
        let el = win.document.elementFromPoint(x, y);
        while (el && el !== host && el.shadowRoot) {
            const inner = el.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === el) break;
            el = inner;
        }
        return el === host ? null : el;
    };
    /** Whether something the click-through rules make the browser look past is at this point. There are seldom many. */
    const clickThroughAt = (win: Window, x: number, y: number) => {
        for (const el of Array.from(win.document.querySelectorAll(CLICK_THROUGH))) {
            const r = el.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
        }
        return false;
    };
    /**
     * The topmost element at a point of a window, looking inside open shadow roots, disabled controls included. The
     * click-through rules are only lifted when one of the elements they apply to is at the point: lifting them makes the
     * browser restyle the page.
     */
    const elementAt = (win: Window, x: number, y: number): Element | null => {
        const sheet = styles.get(win)?.clickThrough;
        if (!sheet || sheet.disabled || !clickThroughAt(win, x, y)) return hitTest(win, x, y);
        return lifted(win, () => hitTest(win, x, y));
    };

    /** What the pointer is over: what was hit there, or failing that what the event was dispatched to. */
    const pointedAt = (win: Window, x: number, y: number, first: unknown): Element | null =>
        elementAt(win, x, y) ?? (isElement(first) ? first : null);
    const targetOf = (ev: MouseEvent): Element | null =>
        pointedAt(windowOf(ev), ev.clientX, ev.clientY, ev.composedPath()[0]);
    const place = (box: HTMLElement, r: Box) => {
        Object.assign(box.style, {
            display: "block",
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
        });
    };

    /** The element the label was written for: the label is only worked out again for a different one. */
    let labelled: Element | null = null;
    const paintHover = () => {
        if (!active || !hovered?.isConnected) {
            hover.style.display = "none";
            labelled = null;
            return;
        }
        const r = viewportRect(hovered);
        place(hover, r);
        if (labelled !== hovered) {
            label.textContent = options.describe(hovered);
            labelled = hovered;
        }
        hover.classList.toggle("below", r.top < 30);
        // Kept inside the window: next to the right edge the label is pulled back to the left.
        label.style.transform = "";
        const over = r.left - 2 + label.offsetWidth - (window.innerWidth - 8);
        if (over > 0)
            label.style.transform = `translateX(${-Math.min(over, Math.max(0, r.left - 6))}px)`;
    };

    const paintDraft = () => {
        for (const box of selBoxes) box.style.display = "none";
        const rects: Box[] = draftArea
            ? [
                  {
                      left: draftArea.x - window.scrollX,
                      top: draftArea.y - window.scrollY,
                      width: draftArea.w,
                      height: draftArea.h,
                  },
              ]
            : draftEls.filter((e) => e.isConnected).map((e) => viewportRect(e));
        rects.forEach((r, i) => {
            let box = selBoxes[i];
            if (!box) {
                box = h("div", { class: "sel" });
                layer.append(box);
                selBoxes[i] = box;
            }
            box.classList.toggle("extra", i > 0);
            place(box, r);
        });
    };

    /**
     * Holding Shift hands the click to the page, so the app can still be used (open a menu, close a modal, go to the
     * next page) without leaving annotate mode. The decision is made when the press starts and holds until its click
     * is over, so letting go of Shift halfway never delivers half a click.
     */
    let gesture: "page" | "pick" | null = null;
    const wantsPassThrough = (ev: Event) => {
        const shift = (ev as MouseEvent).shiftKey === true;
        if (ev.type === "pointerdown" || (ev.type === "mousedown" && gesture === null))
            gesture = shift ? "page" : "pick";
        // Inside a press, the decision made at its start stands; with no press (a click from the keyboard), Shift decides.
        return gesture !== null ? gesture === "page" : shift;
    };
    const endGesture = (ev: Event) => {
        if (ev.type === "click" || ev.type === "auxclick" || ev.type === "dblclick") gesture = null;
    };

    const swallow = (ev: Event) => {
        if (!active || fromUi(ev)) return;
        const pass = wantsPassThrough(ev);
        endGesture(ev);
        if (pass) return;
        ev.stopImmediatePropagation();
        if (ev.type === "click" || ev.type === "auxclick" || ev.type === "dblclick")
            ev.preventDefault();
    };

    const onMouseDown = (ev: MouseEvent) => {
        if (!active || fromUi(ev) || ev.button !== 0) return;
        if (wantsPassThrough(ev)) {
            down = null;
            return;
        }
        ev.stopImmediatePropagation();
        const win = windowOf(ev);
        const el = targetOf(ev);
        down = el
            ? {
                  x: ev.clientX,
                  y: ev.clientY,
                  el,
                  win,
                  additive: ev.metaKey || ev.ctrlKey,
                  onText: lifted(win, () => pointIsOnText(ev.clientX, ev.clientY, win.document)),
              }
            : null;
        dragging = false;
    };

    /**
     * The last move not looked at yet. A mouse reports a move many times a frame, and finding the element under the
     * pointer makes the browser lay the page out: that is done at most once a frame, for wherever the pointer is then.
     */
    let move: { win: Window; x: number; y: number; first: unknown } | null = null;
    let moveFrame = 0;
    const followPointer = () => {
        moveFrame = 0;
        const at = move;
        move = null;
        if (!active || !at) return;
        // Over the same element as before, only its outline is placed again: its label is already written.
        hovered = pointedAt(at.win, at.x, at.y, at.first);
        paintHover();
    };

    const onMouseMove = (ev: MouseEvent) => {
        if (!active) return;
        if (fromUi(ev) || ev.shiftKey) {
            // Over our own UI, or Shift is down: nothing is being picked, so no highlight.
            move = null;
            hovered = null;
            paintHover();
            return;
        }
        const win = windowOf(ev);
        // The event's path is only there while it is being dispatched: kept now, for the frame.
        move = { win, x: ev.clientX, y: ev.clientY, first: ev.composedPath()[0] };
        if (!moveFrame) moveFrame = requestAnimationFrame(followPointer);
        if (
            down &&
            down.win === win &&
            ev.buttons & 1 &&
            Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > DRAG_THRESHOLD
        ) {
            dragging = true;
            // Drawn on the page, so in the page's coordinates, however deep in iframes the drag is.
            place(
                drag,
                boxToTop(win, {
                    left: Math.min(down.x, ev.clientX),
                    top: Math.min(down.y, ev.clientY),
                    width: Math.abs(ev.clientX - down.x),
                    height: Math.abs(ev.clientY - down.y),
                })
            );
        }
    };

    const onMouseUp = (ev: MouseEvent) => {
        if (!active) return;
        if (fromUi(ev)) {
            // Let go over Notato's own UI: the press is over, with nothing picked, and its box must not stay drawn.
            down = null;
            dragging = false;
            drag.style.display = "none";
            return;
        }
        if (wantsPassThrough(ev)) return;
        ev.stopImmediatePropagation();
        const start = down;
        down = null;
        const wasDragging = dragging;
        dragging = false;
        drag.style.display = "none";
        const win = windowOf(ev);
        if (!start || ev.button !== 0 || start.win !== win) return;

        const moved = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
        const selection = win.getSelection();
        const text = selection && !selection.isCollapsed ? selection.toString().trim() : "";

        if (text && moved > SELECT_THRESHOLD && start.onText && selection) {
            const range = selection.getRangeAt(0);
            const node = range.commonAncestorContainer;
            const el = isElement(node) ? node : node.parentElement;
            const rect = range.getBoundingClientRect();
            selection.removeAllRanges();
            if (el) {
                options.onPick({
                    kind: "text",
                    elements: [el],
                    rect: toPageRect(boxToTop(win, rect)),
                    selectedText: text.slice(0, 500),
                    additive: false,
                });
            }
            return;
        }

        if (wasDragging && moved > DRAG_THRESHOLD) {
            selection?.removeAllRanges();
            const left = Math.min(start.x, ev.clientX);
            const top = Math.min(start.y, ev.clientY);
            const box = {
                left,
                top,
                width: Math.abs(ev.clientX - start.x),
                height: Math.abs(ev.clientY - start.y),
            };
            const cx = left + box.width / 2;
            const cy = top + box.height / 2;
            const stack = lifted(win, () => win.document.elementsFromPoint(cx, cy)).filter(
                (e) => e !== host && !host.contains(e)
            );
            const container =
                stack.find((e) => {
                    const r = e.getBoundingClientRect();
                    return (
                        r.left <= box.left &&
                        r.top <= box.top &&
                        r.right >= box.left + box.width &&
                        r.bottom >= box.top + box.height
                    );
                }) ?? stack[0];
            if (container) {
                options.onPick({
                    kind: "area",
                    elements: [container],
                    rect: toPageRect(boxToTop(win, box)),
                    additive: false,
                });
            }
            return;
        }

        selection?.removeAllRanges();
        options.onPick({
            kind: "element",
            elements: [start.el],
            rect: toPageRect(viewportRect(start.el)),
            additive: start.additive,
        });
    };

    const repaint = () => {
        paintHover();
        paintDraft();
    };

    /** Listeners for one window: the page's, or an iframe's. Events there are not ours until we ask. */
    const attach = (win: Window): (() => void) => {
        if (active) addStyles(win);
        for (const type of SWALLOWED) {
            if (type !== "mousedown" && type !== "mouseup")
                win.addEventListener(type, swallow, true);
        }
        win.addEventListener("keydown", onShiftKey, true);
        win.addEventListener("keyup", onShiftKey, true);
        win.addEventListener("blur", onWindowBlur);
        win.addEventListener("mousedown", onMouseDown, true);
        win.addEventListener("mouseup", onMouseUp, true);
        win.addEventListener("mousemove", onMouseMove, true);
        win.addEventListener("scroll", repaint, true);
        win.addEventListener("resize", repaint);
        return () => {
            for (const type of SWALLOWED) {
                if (type !== "mousedown" && type !== "mouseup")
                    win.removeEventListener(type, swallow, true);
            }
            win.removeEventListener("keydown", onShiftKey, true);
            win.removeEventListener("keyup", onShiftKey, true);
            win.removeEventListener("blur", onWindowBlur);
            win.removeEventListener("mousedown", onMouseDown, true);
            win.removeEventListener("mouseup", onMouseUp, true);
            win.removeEventListener("mousemove", onMouseMove, true);
            win.removeEventListener("scroll", repaint, true);
            win.removeEventListener("resize", repaint);
            removeStyles(win);
        };
    };

    const frames = watchFrames(window, attach, (frame) => {
        if (active) frame.setAttribute("data-notato-foreign", "");
    });

    const setActive = (next: boolean) => {
        if (active === next) return;
        active = next;
        if (!active) {
            hovered = null;
            down = null;
            move = null;
            if (moveFrame) cancelAnimationFrame(moveFrame);
            moveFrame = 0;
            dragging = false;
            hover.style.display = "none";
            drag.style.display = "none";
            for (const win of frames.windows()) {
                win.document.documentElement.style.removeProperty("cursor");
                for (const f of Array.from(
                    win.document.querySelectorAll("iframe[data-notato-foreign]")
                ))
                    f.removeAttribute("data-notato-foreign");
            }
            for (const win of [...styles.keys()]) removeStyles(win);
        } else {
            for (const win of frames.windows()) addStyles(win);
            gesture = null;
            frames.rescan(); // marks the frames that cannot be entered
        }
        paintHover();
    };

    return {
        get active() {
            return active;
        },
        setActive,
        showDraft(elements, area) {
            draftEls = elements;
            draftArea = area;
            paintDraft();
        },
        clearDraft() {
            draftEls = [];
            draftArea = undefined;
            paintDraft();
        },
        destroy() {
            setActive(false);
            frames.destroy();
            hover.remove();
            drag.remove();
            for (const box of selBoxes) box.remove();
        },
    };
}
