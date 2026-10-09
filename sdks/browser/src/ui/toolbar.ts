import { h, ICONS, icon } from "./dom.ts";
import { LOGO } from "./logo.ts";

export type ToolbarPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";
export type ConnectionState = "connected" | "connecting" | "offline";

/**
 * Where the toolbar was dragged to, as fractions of the room it can move in: `{ x: 0, y: 0 }` is the top left corner,
 * `{ x: 1, y: 1 }` the bottom right. Fractions rather than pixels, so it stays in the same place relative to the edges
 * when the window is resized. The native SDKs keep the toolbar's place the same way.
 */
export interface ToolbarFraction {
    x: number;
    y: number;
}

interface Size {
    w: number;
    h: number;
}

/** The gap kept between the toolbar and the window's edges, as the corner classes have it. */
export const TOOLBAR_MARGIN = 16;
const POSITION_KEY = "notato:toolbar-position";
/** How far a press must move before it is a drag rather than a click. */
const DRAG_THRESHOLD = 5;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The toolbar's top left for a fraction, held inside the window. */
export function placeAt(
    fraction: ToolbarFraction,
    size: Size,
    viewport: Size
): { left: number; top: number } {
    const roomX = Math.max(0, viewport.w - size.w - 2 * TOOLBAR_MARGIN);
    const roomY = Math.max(0, viewport.h - size.h - 2 * TOOLBAR_MARGIN);
    return {
        left: Math.round(TOOLBAR_MARGIN + roomX * clamp01(fraction.x)),
        top: Math.round(TOOLBAR_MARGIN + roomY * clamp01(fraction.y)),
    };
}

/** The fraction for a top left position: the inverse of `placeAt`. */
export function fractionAt(
    position: { left: number; top: number },
    size: Size,
    viewport: Size
): ToolbarFraction {
    const roomX = Math.max(0, viewport.w - size.w - 2 * TOOLBAR_MARGIN);
    const roomY = Math.max(0, viewport.h - size.h - 2 * TOOLBAR_MARGIN);
    const round = (n: number) => Math.round(n * 10_000) / 10_000;
    return {
        x: roomX > 0 ? round(clamp01((position.left - TOOLBAR_MARGIN) / roomX)) : 1,
        y: roomY > 0 ? round(clamp01((position.top - TOOLBAR_MARGIN) / roomY)) : 1,
    };
}

/** Where the toolbar was last dragged to in this browser (for this site), or null. */
export function loadToolbarFraction(): ToolbarFraction | null {
    try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(POSITION_KEY) ?? "null");
        if (!parsed || typeof parsed !== "object") return null;
        const { x, y } = parsed as Record<string, unknown>;
        if (
            typeof x !== "number" ||
            typeof y !== "number" ||
            !Number.isFinite(x) ||
            !Number.isFinite(y)
        )
            return null;
        return { x: clamp01(x), y: clamp01(y) };
    } catch {
        return null;
    }
}

function saveToolbarFraction(fraction: ToolbarFraction | null) {
    try {
        if (fraction) window.localStorage.setItem(POSITION_KEY, JSON.stringify(fraction));
        else window.localStorage.removeItem(POSITION_KEY);
    } catch {
        // private mode or blocked storage: the toolbar stays where it is for this visit only
    }
}

const COLLAPSED_KEY = "notato:toolbar-collapsed";

/** Whether the toolbar was last left folded into its one button in this browser (for this site). */
export function loadToolbarCollapsed(): boolean {
    try {
        return window.localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
        return false;
    }
}

function saveToolbarCollapsed(collapsed: boolean) {
    try {
        if (collapsed) window.localStorage.setItem(COLLAPSED_KEY, "1");
        else window.localStorage.removeItem(COLLAPSED_KEY);
    } catch {
        // blocked storage: it stays folded (or not) for this visit only
    }
}

/**
 * A spring as a CSS `linear()` easing: quick off the mark, one small overshoot (about 5%), settled by the end. Browsers
 * without `linear()` get the nearest cubic-bézier.
 */
function springEasing(): string {
    try {
        if (!CSS.supports("transition-timing-function", "linear(0, 1)"))
            throw new Error("no linear()");
    } catch {
        return "cubic-bezier(0.34, 1.4, 0.64, 1)";
    }
    const zeta = 0.68; // damping ratio
    const omega = 6 / zeta; // within 0.25% of the end by t = 1
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    const points: number[] = [];
    for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const decay = Math.exp(-zeta * omega * t);
        const x =
            1 -
            decay *
                (Math.cos(damped * t) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(damped * t));
        points.push(i === 40 ? 1 : Math.round(x * 1000) / 1000);
    }
    return `linear(${points.join(", ")})`;
}

export interface ToolbarButton {
    el: HTMLButtonElement;
    setPressed(pressed: boolean): void;
    setIcon(svg: string): void;
    setTitle(title: string): void;
    /** Whether the menu or panel this button opens is open. */
    setExpanded(expanded: boolean): void;
}

export interface Toolbar {
    el: HTMLElement;
    setActive(active: boolean): void;
    setCount(count: number): void;
    /** `null` hides the dot (no server configured). */
    setConnection(state: ConnectionState | null, title?: string): void;
    /** An icon button, before the pins toggle. Its title is its accessible name. */
    addButton(options: {
        title: string;
        icon: string;
        onClick(): void;
        /** Extra classes for the styles, such as `tb-pause`. */
        className?: string;
    }): ToolbarButton;
    /** Folds the bar into one round button, or opens it again (animated). Remembered in this browser. */
    setCollapsed(collapsed: boolean): void;
    readonly collapsed: boolean;
    destroy(): void;
}

interface ToolbarOptions {
    /** Where the toolbar starts. People can drag it anywhere; that is remembered in this browser. */
    position: ToolbarPosition;
    shortcutLabel?: string;
    onToggleAnnotate(): void;
    onTogglePins(visible: boolean): void;
    /** The bar is folding away: anything opened from its buttons should close. */
    onCollapse?(): void;
}

export function createToolbar(options: ToolbarOptions): Toolbar {
    function annotateTitle(active: boolean) {
        const key = options.shortcutLabel ? ` (${options.shortcutLabel})` : "";
        return active
            ? `Annotating: Esc stops, hold Shift to click through to the page${key}`
            : `Annotate${key}`;
    }
    const count = h("span", { class: "tb-count", "aria-label": "Annotations on this page" }, "0");
    const annotate = h(
        "button",
        {
            class: "tb-btn tb-annotate",
            type: "button",
            "aria-pressed": "false",
            title: annotateTitle(false),
            onclick: options.onToggleAnnotate,
        },
        icon(ICONS.crosshair),
        h("span", { class: "tb-label" }, "Annotate"),
        count
    );

    let pinsVisible = true;
    const eye = h(
        "button",
        { class: "tb-btn tb-eye", type: "button", title: "Hide pins", "aria-pressed": "false" },
        icon(ICONS.eye)
    );
    eye.addEventListener("click", () => {
        pinsVisible = !pinsVisible;
        eye.replaceChildren(icon(pinsVisible ? ICONS.eye : ICONS.eyeOff));
        eye.title = pinsVisible ? "Hide pins" : "Show pins";
        eye.setAttribute("aria-pressed", String(!pinsVisible));
        options.onTogglePins(pinsVisible);
    });
    // Between Annotate and the rest.
    const sep = h("span", { class: "tb-sep", "aria-hidden": "true" });

    // The whole bar can be dragged; the grip says so, and is where the keyboard moves it from.
    const grip = h(
        "span",
        {
            class: "tb-grip",
            role: "button",
            tabindex: "0",
            "aria-label": "Move the toolbar. Arrow keys move it, Home puts it back in its corner.",
            title: "Drag to move the toolbar. Double-click to put it back.",
        },
        icon(ICONS.grip)
    );
    const dot = h("span", { class: "tb-dot", role: "status", style: { display: "none" } });
    const collapseButton = h("button", {
        class: "tb-btn tb-collapse",
        type: "button",
        title: "Fold the toolbar",
        "aria-label": "Fold the toolbar",
        "aria-expanded": "true",
    });
    // What the bar folds into: one round button with the potato, the count and (when it is not connected) the server's
    // state. A page whose CSP refuses data: images gets a note icon instead.
    const fabCount = h("span", { class: "tb-fab-count", "aria-hidden": "true", hidden: true });
    const fabDot = h("span", { class: "tb-fab-dot", "aria-hidden": "true", hidden: true });
    const logo = h("img", { src: LOGO, alt: "", width: 28, height: 28, draggable: "false" });
    logo.addEventListener("error", () => logo.replaceWith(icon(ICONS.note)), { once: true });
    const fab = h(
        "button",
        {
            class: "tb-fab",
            type: "button",
            title: "Open Notato",
            "aria-label": "Open the Notato toolbar",
            "aria-expanded": "false",
        },
        logo,
        fabCount,
        fabDot
    );
    const el = h(
        "div",
        { class: `toolbar ${options.position}`, role: "toolbar", "aria-label": "Notato" },
        dot,
        grip,
        annotate,
        sep,
        eye,
        collapseButton,
        fab
    );

    // ---- position ---------------------------------------------------------------------------------------------------
    // Until it is dragged, the corner class places it. Once dragged, it is placed from the stored fraction, and placed
    // again whenever the window or the toolbar changes size, so a bar dragged to an edge stays on that edge.
    let fraction = loadToolbarFraction();
    // The side the bar folds to and opens away from: settled at the first fold or open after the toolbar is put somewhere,
    // and kept until it is moved again. Worked out afresh each time, a wide bar opened from just right of the middle would
    // count as left of it and fold away from where its button had been.
    let heldSide: "left" | "right" | null = null;
    // Where the other state was, so a fold undoes an open exactly (and the other way round) even when the open bar had
    // to be pushed back inside the window. Also kept until the toolbar is moved.
    let returnTo: ToolbarFraction | null = null;
    const forgetFold = () => {
        heldSide = null;
        returnTo = null;
    };
    const viewport = (): Size => ({ w: window.innerWidth, h: window.innerHeight });
    const size = (): Size => ({ w: el.offsetWidth, h: el.offsetHeight });

    function setLeftTop(left: number, top: number) {
        Object.assign(el.style, {
            left: `${left}px`,
            top: `${top}px`,
            right: "auto",
            bottom: "auto",
        });
    }

    function place() {
        syncChevron();
        if (!fraction) {
            Object.assign(el.style, { left: "", top: "", right: "", bottom: "" });
            return;
        }
        const at = placeAt(fraction, size(), viewport());
        setLeftTop(at.left, at.top);
    }

    /** A top left for the toolbar, held inside the window, and the fraction it is at. Only works it out. */
    function within(left: number, top: number, s: Size, v: Size) {
        const x = Math.min(
            Math.max(TOOLBAR_MARGIN, left),
            Math.max(TOOLBAR_MARGIN, v.w - s.w - TOOLBAR_MARGIN)
        );
        const y = Math.min(
            Math.max(TOOLBAR_MARGIN, top),
            Math.max(TOOLBAR_MARGIN, v.h - s.h - TOOLBAR_MARGIN)
        );
        return { x, y, fraction: fractionAt({ left: x, top: y }, s, v) };
    }

    /** Puts the toolbar at a new place, as far as the window allows: where a drag ends, or an arrow key takes it. */
    function moveTo(left: number, top: number, s: Size = size(), v: Size = viewport()) {
        const to = within(left, top, s, v);
        setLeftTop(to.x, to.y);
        fraction = to.fraction;
        forgetFold();
        syncChevron(); // dragged past the middle, it now folds towards the other side
    }

    /** The slide back to its corner, kept so a second one can take over from it. */
    let glide: Animation | null = null;
    function resetPosition() {
        const before = el.getBoundingClientRect();
        fraction = null;
        forgetFold();
        saveToolbarFraction(null);
        place();
        // It slides there, rather than jumping: from where it was, drawn as an offset from its new place.
        glide?.cancel();
        glide = null;
        if (!canAnimate()) return;
        const after = el.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        glide = el.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
            { duration: 520, easing: spring }
        );
        glide.finished.catch(() => {});
    }

    /**
     * A press on the bar, which becomes a drag once it has moved far enough. The bar's size and the window's are measured
     * once, when the drag starts: from then on each move is only arithmetic, and the bar follows by a transform from
     * where it started, at most once a frame. Its place is written when the drag ends.
     */
    let drag: {
        id: number;
        x: number;
        y: number;
        left: number;
        top: number;
        moved: boolean;
        size?: Size;
        viewport?: Size;
        /** Where the pointer last was, for the next frame to put the bar under it. */
        to?: { x: number; y: number };
        frame?: number;
    } | null = null;
    // A drag that started on a button must not also press it.
    let swallowClick = false;

    // Moves are followed on the window, not the bar: a quick flick leaves the bar before it is a drag, and moves over the
    // page never reach the bar. Capture phase, because Notato's host stops pointer events from leaving it.
    /** Where a drag has the bar now: its top left, held inside the window. */
    const dragged = (d: NonNullable<typeof drag>) =>
        within(
            d.left + (d.to?.x ?? d.x) - d.x,
            d.top + (d.to?.y ?? d.y) - d.y,
            d.size ?? size(),
            d.viewport ?? viewport()
        );
    /** Draws the bar where the drag has it: an offset from where it started, which lays nothing out. */
    const follow = () => {
        if (!drag) return;
        drag.frame = 0;
        const at = dragged(drag);
        el.style.transform = `translate3d(${at.x - drag.left}px, ${at.y - drag.top}px, 0)`;
        fraction = at.fraction;
        forgetFold();
        syncChevron(); // dragged past the middle, it now folds towards the other side
    };
    const onMove = (ev: PointerEvent) => {
        if (!drag || ev.pointerId !== drag.id) return;
        const dx = ev.clientX - drag.x;
        const dy = ev.clientY - drag.y;
        if (!drag.moved) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            drag.moved = true;
            drag.size = size();
            drag.viewport = viewport();
            glide?.cancel();
            glide = null;
            el.classList.add("dragging");
            try {
                // Keeps the moves coming while the pointer is over an iframe.
                el.setPointerCapture(ev.pointerId);
            } catch {
                // the pointer is already gone: the next pointerup ends the drag anyway
            }
        }
        ev.preventDefault();
        drag.to = { x: ev.clientX, y: ev.clientY };
        drag.frame ||= requestAnimationFrame(follow);
    };
    const endDrag = (ev: PointerEvent) => {
        if (!drag || ev.pointerId !== drag.id) return;
        const ended = drag;
        drag = null;
        stopFollowing();
        if (ended.frame) cancelAnimationFrame(ended.frame);
        if (!ended.moved) return;
        // Where it was let go is where it stays: its place written, and the offset it was drawn with dropped.
        const at = dragged(ended);
        el.style.transform = "";
        moveTo(at.x, at.y, ended.size, ended.viewport);
        el.classList.remove("dragging");
        if (fraction) saveToolbarFraction(fraction);
        swallowClick = true;
        // A drag that ends off the bar fires no click; do not swallow the next real one.
        setTimeout(() => {
            swallowClick = false;
        }, 0);
    };
    const stopFollowing = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", endDrag, true);
        window.removeEventListener("pointercancel", endDrag, true);
    };
    el.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0 || !ev.isPrimary) return;
        const r = el.getBoundingClientRect();
        drag = {
            id: ev.pointerId,
            x: ev.clientX,
            y: ev.clientY,
            left: r.left,
            top: r.top,
            moved: false,
        };
        stopFollowing();
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", endDrag, true);
        window.addEventListener("pointercancel", endDrag, true);
    });
    el.addEventListener(
        "click",
        (ev) => {
            if (!swallowClick) return;
            swallowClick = false;
            ev.stopPropagation();
            ev.preventDefault();
        },
        true
    );

    grip.addEventListener("dblclick", resetPosition);
    grip.addEventListener("keydown", (ev) => {
        const step = ev.shiftKey ? 64 : 16;
        const moves: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
        };
        if (ev.key === "Home") {
            ev.preventDefault();
            resetPosition();
            return;
        }
        const move = moves[ev.key];
        if (!move) return;
        ev.preventDefault();
        const from = fraction ? placeAt(fraction, size(), viewport()) : el.getBoundingClientRect();
        moveTo(from.left + move[0], from.top + move[1]);
        if (fraction) saveToolbarFraction(fraction);
    });

    // ---- collapsing ------------------------------------------------------------------------------------------------
    // The bar folds into one round button and opens out of it again. It grows away from the side it is held to (the
    // nearer edge once dragged, else its corner), so the buttons stay where they will be and the edge sweeps over them.
    let collapsed = loadToolbarCollapsed();
    // Opened by annotate mode starting while folded: folds again when it stops.
    let openedForAnnotate = false;
    let morph: Animation[] = [];
    let morphRun = 0;
    const spring = springEasing();
    const settle = "cubic-bezier(0.32, 0.72, 0, 1)";

    const heldRight = () =>
        heldSide
            ? heldSide === "right"
            : fraction
              ? fraction.x >= 0.5
              : options.position.endsWith("right");
    let chevronRight: boolean | null = null;
    function syncChevron() {
        const right = heldRight();
        if (right === chevronRight) return;
        chevronRight = right;
        collapseButton.replaceChildren(icon(right ? ICONS.chevronRight : ICONS.chevronLeft));
    }
    syncChevron();

    const canAnimate = () =>
        typeof el.animate === "function" &&
        el.isConnected &&
        !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    /** `remember: false` for an open that only lasts while annotating: the place it goes back to is the one kept. */
    function setCollapsed(next: boolean, remember = true) {
        if (next === collapsed) return;
        const root = el.getRootNode() as Document | ShadowRoot;
        const focused = root.activeElement instanceof Node && el.contains(root.activeElement);
        // Mid-flight this is where the bar is on screen, so a change of mind turns around from there.
        const before = el.getBoundingClientRect();
        for (const a of morph) a.cancel();
        morph = [];
        el.classList.remove("morphing", "held-right");

        collapsed = next;
        if (remember) saveToolbarCollapsed(next);
        if (next) options.onCollapse?.();
        el.classList.toggle("collapsed", next);
        if (focused) (next ? fab : collapseButton).focus({ preventScroll: true });
        const right = heldRight();
        heldSide = right ? "right" : "left";

        // A dragged bar goes back to where the other state last was or, the first time, keeps its held edge where it is
        // (as far as the window allows). One in its corner is held there by the corner class already.
        const from = before.width;
        const to = el.getBoundingClientRect().width;
        let lefts: [number, number] | null = null;
        if (fraction) {
            const v = viewport();
            const h = el.offsetHeight;
            const back = returnTo;
            returnTo = fraction;
            if (back) fraction = back;
            else {
                const edge = right ? before.right : before.left;
                const left = Math.min(
                    Math.max(TOOLBAR_MARGIN, right ? edge - to : edge),
                    Math.max(TOOLBAR_MARGIN, v.w - to - TOOLBAR_MARGIN)
                );
                fraction = fractionAt({ left, top: before.top }, { w: to, h }, v);
            }
            // Open only while annotating: the place kept is still the round button's, which a reload comes back to.
            if (remember) saveToolbarFraction(fraction);
            place();
            lefts = [before.left, placeAt(fraction, { w: to, h }, v).left];
        }
        if (!canAnimate()) return;

        el.classList.add("morphing");
        el.classList.toggle("held-right", right);
        // Nearest the held side first: that is where the sweep starts.
        const items = [...el.children].filter(
            (c): c is HTMLElement =>
                c instanceof HTMLElement && c !== fab && getComputedStyle(c).display !== "none"
        );
        if (right) items.reverse();
        const toward = right ? 1 : -1;
        const run = ++morphRun;

        // A dragged bar's left moves on the same curve as its width, so the held edge stays put on every frame (placing it
        // again after each change of size would be a frame late, and wobble).
        const frame = (w: number, left?: number): Keyframe =>
            left === undefined ? { width: `${w}px` } : { width: `${w}px`, left: `${left}px` };
        // Every animation is kept so a change of mind can cancel it; cancelling rejects `finished`, which is expected.
        const play = (
            target: HTMLElement,
            keyframes: Keyframe[],
            timing: KeyframeAnimationOptions
        ) => {
            const a = target.animate(keyframes, timing);
            a.finished.catch(() => {});
            morph.push(a);
            return a;
        };

        const width = play(el, [frame(from, lefts?.[0]), frame(to, lefts?.[1])], {
            duration: next ? 420 : 560,
            easing: next ? settle : spring,
        });
        if (next) {
            // The far buttons go first, as the edge comes in over them, then the button they fold into turns in.
            items.reverse().forEach((item, i) => {
                play(
                    item,
                    [
                        { opacity: 1, transform: "none" },
                        { opacity: 0, transform: `translateX(${8 * toward}px) scale(0.92)` },
                    ],
                    { duration: 160, delay: i * 16, easing: "ease-in", fill: "forwards" }
                );
            });
            play(
                fab,
                [
                    { opacity: 0, transform: `scale(0.5) rotate(${-90 * toward}deg)` },
                    { opacity: 1, transform: "none" },
                ],
                { duration: 460, delay: 170, easing: spring, fill: "backwards" }
            );
            play(
                fabCount,
                [
                    { opacity: 0, transform: "scale(0.4)" },
                    { opacity: 1, transform: "none" },
                ],
                { duration: 380, delay: 400, easing: spring, fill: "backwards" }
            );
        } else {
            play(
                fab,
                [
                    { opacity: 1, transform: "none" },
                    { opacity: 0, transform: `scale(0.5) rotate(${-90 * toward}deg)` },
                ],
                { duration: 180, easing: "ease-in", fill: "forwards" }
            );
            items.forEach((item, i) => {
                play(
                    item,
                    [
                        { opacity: 0, transform: `translateX(${10 * toward}px) scale(0.94)` },
                        { opacity: 1, transform: "none" },
                    ],
                    // Close behind the edge, which covers most of the way in the first 150ms.
                    { duration: 280, delay: 25 + i * 18, easing: settle, fill: "backwards" }
                );
            });
        }
        width.finished.then(
            () => {
                if (run !== morphRun) return;
                el.classList.remove("morphing", "held-right");
                // What is now hidden has nothing left to show; the rest finish on their own.
                for (const a of morph) {
                    const target = (a.effect as KeyframeEffect | null)?.target;
                    if (target && (next ? target !== fab && target !== fabCount : target === fab))
                        a.cancel();
                }
            },
            () => {
                // cancelled by a newer change, which has taken over
            }
        );
    }

    collapseButton.addEventListener("click", () => {
        openedForAnnotate = false;
        setCollapsed(true);
    });
    fab.addEventListener("click", () => {
        openedForAnnotate = false;
        setCollapsed(false);
    });
    el.classList.toggle("collapsed", collapsed);

    // Another tab of the same site moved it or folded it: follow, as the settings do.
    const onStorage = (ev: StorageEvent) => {
        if (ev.key === COLLAPSED_KEY) {
            openedForAnnotate = false;
            setCollapsed(loadToolbarCollapsed());
            return;
        }
        if (ev.key !== POSITION_KEY) return;
        fraction = loadToolbarFraction();
        forgetFold();
        place();
    };
    // Not while it is being dragged: the drag has its place, and writes it when it ends.
    const placeUnlessDragging = () => {
        if (!drag?.moved) place();
    };
    window.addEventListener("resize", placeUnlessDragging);
    window.addEventListener("storage", onStorage);
    const resizes =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(placeUnlessDragging);
    resizes?.observe(el);
    // The first placement needs the bar's size, which it has once it is in the page.
    const firstPlace = requestAnimationFrame(place);

    return {
        el,
        setActive(active) {
            annotate.setAttribute("aria-pressed", String(active));
            annotate.title = annotateTitle(active);
            // Annotating (from the shortcut) while folded opens the bar so it shows, and folds it again after.
            if (active && collapsed) {
                openedForAnnotate = true;
                setCollapsed(false, false);
            } else if (!active && openedForAnnotate) {
                openedForAnnotate = false;
                setCollapsed(true, false);
            }
        },
        setCount(n) {
            count.textContent = String(n);
            fabCount.textContent = n > 99 ? "99+" : String(n);
            fabCount.hidden = n === 0;
        },
        setConnection(state, title) {
            dot.style.display = state ? "" : "none";
            if (state) dot.dataset.state = state;
            dot.title = title ?? (state ? `Server: ${state}` : "");
            // Folded, it only speaks up when something is wrong.
            fabDot.hidden = !state || state === "connected";
            if (state) fabDot.dataset.state = state;
        },
        addButton({ title, icon: svg, onClick, className }) {
            const btn = h(
                "button",
                {
                    class: className ? `tb-btn ${className}` : "tb-btn",
                    type: "button",
                    title,
                    "aria-label": title,
                    onclick: onClick,
                },
                icon(svg)
            );
            el.insertBefore(btn, eye);
            return {
                el: btn,
                setPressed: (pressed) => {
                    btn.setAttribute("aria-pressed", String(pressed));
                },
                setIcon: (next) => {
                    btn.replaceChildren(icon(next));
                },
                setTitle: (next) => {
                    btn.title = next;
                    btn.setAttribute("aria-label", next);
                },
                setExpanded: (expanded) => {
                    btn.setAttribute("aria-expanded", String(expanded));
                },
            };
        },
        setCollapsed(next) {
            openedForAnnotate = false;
            setCollapsed(next);
        },
        get collapsed() {
            return collapsed;
        },
        destroy() {
            cancelAnimationFrame(firstPlace);
            for (const a of morph) a.cancel();
            morph = [];
            glide?.cancel();
            if (drag?.frame) cancelAnimationFrame(drag.frame);
            drag = null;
            stopFollowing();
            window.removeEventListener("resize", placeUnlessDragging);
            window.removeEventListener("storage", onStorage);
            resizes?.disconnect();
        },
    };
}
