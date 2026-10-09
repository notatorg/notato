import { h } from "./dom.ts";
import { animateIn, animateOut, isLeaving, RISE, settle } from "./motion.ts";

export interface Toast {
    show(message: string, ms?: number): void;
    destroy(): void;
}

/**
 * A short message that goes away on its own, for "Copied 3 annotations". It fades in and out; a newer message takes the
 * place of the one showing, and one on its way out comes back with the newer message on it.
 */
export function createToast(layer: HTMLElement): Toast {
    let el: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        show(message, ms = 2600) {
            if (timer) clearTimeout(timer);
            if (el) {
                el.textContent = message;
                if (isLeaving(el)) animateIn(el, RISE);
            } else {
                el = h("div", { class: "toast", role: "status" }, message);
                layer.append(el);
                animateIn(el, RISE);
            }
            const shown = el;
            timer = setTimeout(() => {
                timer = undefined;
                animateOut(
                    shown,
                    () => {
                        shown.remove();
                        if (el === shown) el = null;
                    },
                    RISE
                );
            }, ms);
        },
        destroy() {
            if (timer) clearTimeout(timer);
            if (el) settle(el);
            el?.remove();
            el = null;
        },
    };
}
