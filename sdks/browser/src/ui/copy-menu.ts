import { DETAILS, type Detail } from "@notato/core";
import { capitalize, plural } from "../text.ts";
import { dismissOnOutside, h, ICONS, icon } from "./dom.ts";

const BLURB: Record<Detail, string> = {
    compact: "One line per note: what and where.",
    standard: "What it takes to find and fix it.",
    detailed: "Adds styles, position and animations.",
    forensic: "Everything that was captured.",
};

export interface ExportExtras {
    /** How many notes there are to export; none greys the menu out and says so. Left out, nothing is said. */
    count?: number;
    /** A zip of the notes, where there is one to make (test and agent mode). It has every page's notes in it. */
    zip?: { description: string; count: number; onPick(): void };
    /** The menu closed, however it was closed. */
    onClose?(): void;
    /** The button that opens and closes the menu: a press on it is left to its click, which closes the menu. */
    owner?: Element;
}

export interface CopyMenu {
    open(
        anchor: { left: number; top: number; width: number; height?: number },
        onPick: (detail: Detail) => void,
        extras?: ExportExtras
    ): void;
    close(): void;
    readonly isOpen: boolean;
    destroy(): void;
}

/**
 * The toolbar's Export menu: the four levels to copy Markdown at and, where there is one, a zip. It sits above the
 * button that opened it (below it when the toolbar is near the top). Esc or a click elsewhere closes it.
 */
export function createCopyMenu(layer: HTMLElement, remembered: () => Detail): CopyMenu {
    let el: HTMLElement | null = null;
    let off: (() => void) | undefined;
    let closed: (() => void) | undefined;

    const close = () => {
        off?.();
        off = undefined;
        el?.remove();
        el = null;
        const after = closed;
        closed = undefined;
        after?.();
    };

    return {
        get isOpen() {
            return el !== null;
        },
        open(anchor, onPick, extras = {}) {
            close();
            closed = extras.onClose;
            const last = remembered();
            const none = extras.count === 0;
            const levels = DETAILS.map((detail, i) =>
                h(
                    "button",
                    {
                        class: "menu-item",
                        type: "button",
                        role: "menuitem",
                        "aria-checked": String(detail === last),
                        disabled: none,
                        onclick: () => {
                            close();
                            onPick(detail);
                        },
                    },
                    h("span", { class: "glyph", "aria-hidden": "true" }, "·".repeat(i + 1)),
                    h("strong", {}, capitalize(detail)),
                    detail === last ? h("em", {}, "Last used") : h("em"),
                    h("span", { class: "desc" }, BLURB[detail])
                )
            );
            const zip = extras.zip
                ? h(
                      "button",
                      {
                          class: "menu-item",
                          type: "button",
                          role: "menuitem",
                          disabled: extras.zip.count === 0,
                          onclick: () => {
                              close();
                              extras.zip?.onPick();
                          },
                      },
                      h("span", { class: "glyph acc", "aria-hidden": "true" }, icon(ICONS.package)),
                      h("strong", {}, "Download zip…"),
                      h("em"),
                      h("span", { class: "desc" }, extras.zip.description)
                  )
                : null;
            el = h(
                "div",
                { class: "menu", role: "menu", "aria-label": "Export" },
                h(
                    "div",
                    { class: "menu-title" },
                    h("strong", {}, "Export"),
                    extras.count === undefined
                        ? null
                        : h("span", {}, `${plural(extras.count, "note")} on this page`)
                ),
                none
                    ? h(
                          "div",
                          { class: "menu-empty" },
                          "No notes on this page yet. Annotate something first, then export it here."
                      )
                    : null,
                h("div", { class: "menu-label" }, "Copy as Markdown"),
                ...levels,
                ...(zip ? [h("div", { class: "menu-sep" }), zip] : [])
            );
            layer.append(el);
            const w = el.offsetWidth || 220;
            el.style.left = `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
            if (anchor.top < window.innerHeight / 2)
                el.style.top = `${anchor.top + (anchor.height ?? 0) + 8}px`;
            else el.style.bottom = `${Math.max(8, window.innerHeight - anchor.top + 8)}px`;
            (el.querySelector(".menu-item:not(:disabled)") as HTMLElement | null)?.focus();
            off = dismissOnOutside(el, close, extras.owner);
        },
        close,
        destroy: close,
    };
}

/** Puts text on the clipboard: the async API where the page may use it, and the old way where it may not. */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const box = document.createElement("textarea");
        box.value = text;
        box.setAttribute("readonly", "");
        box.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        document.body.append(box);
        box.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch {
            ok = false;
        }
        box.remove();
        return ok;
    }
}
