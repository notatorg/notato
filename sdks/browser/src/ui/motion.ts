/**
 * How Notato's panels, cards, menus and toasts come and go: a quick fade with a small move, slowing as it arrives. The
 * Flutter SDK uses the same timings, so the platforms feel the same.
 *
 * Only `opacity`, `translate` and `scale` are animated: the compositor runs them without the page being laid out, and
 * `translate` and `scale` add on to any `transform` the element already has (the toast and the dialog are centred with
 * one). A browser without the separate properties still gets the fade.
 */

/** Where a thing is just before it comes in, and just after it has gone. */
export type Motion = Keyframe;

/** Comes up into place from just below: what opens above the toolbar, and the toast. */
export const RISE: Motion = { opacity: 0, translate: "0 6px" };
/** Comes down into place from just above: what opens below the toolbar. */
export const DROP: Motion = { opacity: 0, translate: "0 -6px" };
/** Grows into place: cards and dialogs. */
export const POP: Motion = { opacity: 0, scale: "0.96" };
/** Only fades: the shade behind a dialog. */
export const FADE: Motion = { opacity: 0 };

export const ENTER_MS = 200;
export const EXIT_MS = 160;
/** Quick off the mark and slowing to a stop. */
export const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** A little past and back: a pin landing. */
const OVERSHOOT = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const GROW_MS = 220;

/** Whether this person asked their system for less motion. Asked each time: it can change while the page is open. */
export function prefersReducedMotion(win: Window | null = window): boolean {
    try {
        return Boolean(win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    } catch {
        return false;
    }
}

/**
 * Whether to animate this element at all: not for less motion, not when the browser cannot, and not off screen (a tab
 * in the background), where an animation's end can wait until the tab is looked at again.
 */
export function canAnimate(el: Element): boolean {
    const doc = el.ownerDocument;
    return (
        typeof el.animate === "function" &&
        el.isConnected &&
        doc.visibilityState !== "hidden" &&
        !prefersReducedMotion(doc.defaultView)
    );
}

/**
 * What each element is doing: coming in, or going (`out`) with what to do once it has gone. One animation does both:
 * a change of mind reverses it from wherever it has got to, so nothing jumps.
 */
interface Moving {
    animation: Animation;
    out: boolean;
    done?: () => void;
}
const moving = new WeakMap<Element, Moving>();

function track(el: Element, animation: Animation, out: boolean, done?: () => void): void {
    const entry: Moving = { animation, out, done };
    moving.set(el, entry);
    animation.finished.then(
        () => {
            if (moving.get(el) !== entry) return;
            moving.delete(el);
            if (entry.out) entry.done?.();
            // Its fill would otherwise hold the element where the animation left it, the next time it is shown.
            animation.cancel();
        },
        () => {
            // cancelled: whoever cancelled it has taken over
        }
    );
}

/** Turns an animation under way around, if the browser can. False when it could not. */
function turnAround(entry: Moving, out: boolean, done?: () => void): boolean {
    if (entry.animation.playState !== "running" || typeof entry.animation.reverse !== "function")
        return false;
    entry.out = out;
    entry.done = done;
    entry.animation.reverse();
    return true;
}

/**
 * Brings an element in, from `from` to where its styles put it. Call it once the element is in the page and shown. One
 * still on its way out comes back from where it has got to, and its exit's `done` never runs.
 */
export function animateIn(el: HTMLElement, from: Motion = RISE): void {
    const entry = moving.get(el);
    if (entry) {
        if (!entry.out) return; // already coming in
        if (turnAround(entry, false)) return;
        moving.delete(el);
        entry.animation.cancel();
    }
    if (!canAnimate(el)) return;
    try {
        // Only where it starts: it ends wherever its styles say, which may not be fully opaque (a detached pin).
        const animation = el.animate([{ ...from, offset: 0 }], {
            duration: ENTER_MS,
            easing: EASE_OUT,
            fill: "backwards",
        });
        track(el, animation, false);
    } catch {
        // a browser that cannot animate from a single keyframe: it is simply there
    }
}

/**
 * Takes an element out: it goes to `to`, and `done` (removing it, hiding it) runs once it is there, or at once when
 * nothing is animated. One still coming in turns around from where it has got to. Asked again while it is going, the
 * newer `done` is the one that runs.
 */
export function animateOut(el: HTMLElement, done: () => void, to: Motion = RISE): void {
    const entry = moving.get(el);
    if (entry?.out) {
        entry.done = done;
        return;
    }
    if (entry) {
        if (turnAround(entry, true, done)) return;
        moving.delete(el);
        entry.animation.cancel();
    }
    if (!canAnimate(el)) {
        done();
        return;
    }
    try {
        const animation = el.animate([{ ...to, offset: 1 }], {
            duration: EXIT_MS,
            easing: EASE_OUT,
            fill: "forwards",
        });
        track(el, animation, true, done);
    } catch {
        done();
    }
}

/** Whether an element is on its way out. */
export function isLeaving(el: Element): boolean {
    return moving.get(el)?.out === true;
}

/** Ends whatever an element is doing now: one on its way out is gone at once (its `done` runs), one coming in is there. */
export function settle(el: Element): void {
    const entry = moving.get(el);
    if (!entry) return;
    moving.delete(el);
    entry.animation.cancel();
    if (entry.out) entry.done?.();
}

/** Whether animations can add on to what an element's styles already say (`composite: "add"`). */
const adds = () => typeof KeyframeEffect !== "undefined" && "composite" in KeyframeEffect.prototype;

/**
 * A pin landing: it grows from its middle with a little bounce. A pin is placed with its `transform`, so the growing is
 * added on to that rather than replacing it, and a pin that moves while it grows (a scroll) keeps up. A browser that
 * cannot add animations only fades it in.
 */
export function growIn(el: HTMLElement): void {
    if (!canAnimate(el)) return;
    try {
        el.animate([{ opacity: 0, offset: 0 }], {
            duration: GROW_MS * 0.6,
            easing: EASE_OUT,
            fill: "backwards",
        });
        if (adds())
            el.animate([{ transform: "scale(0.4)" }, { transform: "scale(1)" }], {
                duration: GROW_MS,
                easing: OVERSHOOT,
                composite: "add",
            });
    } catch {
        // it is simply there
    }
}
