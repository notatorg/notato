import { h } from "./dom.ts";

export interface Toast {
    show(message: string, ms?: number): void;
    destroy(): void;
}

/** A short message that goes away on its own, for "Copied 3 annotations". */
export function createToast(layer: HTMLElement): Toast {
    let el: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        show(message, ms = 2600) {
            el?.remove();
            if (timer) clearTimeout(timer);
            el = h("div", { class: "toast", role: "status" }, message);
            layer.append(el);
            timer = setTimeout(() => {
                el?.remove();
                el = null;
            }, ms);
        },
        destroy() {
            if (timer) clearTimeout(timer);
            el?.remove();
        },
    };
}
