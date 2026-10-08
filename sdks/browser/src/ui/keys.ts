/** A key combination as `parseShortcut` reads it. */
export interface Shortcut {
    /** The key, as `KeyboardEvent.code` names it: `KeyA`, `ArrowRight`. */
    code: string;
    alt: boolean;
    shift: boolean;
    ctrl: boolean;
    meta: boolean;
}

/** Toggles annotate mode, unless the `shortcut` option says otherwise. */
export const ANNOTATE_SHORTCUT = "Alt+Shift+KeyA";
/** Pauses and resumes animations and media. */
export const PAUSE_SHORTCUT = "Alt+Shift+KeyP";
/** Show the next and the previous of the versions an agent put in the page. */
export const NEXT_VARIANT_SHORTCUT = "Alt+Shift+ArrowRight";
export const PREVIOUS_VARIANT_SHORTCUT = "Alt+Shift+ArrowLeft";

/** `Alt+Shift+KeyA` style combos, matched on `event.code` so Option-key layouts on macOS work. */
export function parseShortcut(combo: string): Shortcut {
    const parts = combo.split("+").map((p) => p.trim());
    const code = parts.pop() ?? "";
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    return {
        code,
        alt: mods.has("alt"),
        shift: mods.has("shift"),
        ctrl: mods.has("ctrl"),
        meta: mods.has("meta") || mods.has("cmd"),
    };
}

export function matchesShortcut(ev: KeyboardEvent, combo: Shortcut): boolean {
    return (
        ev.code === combo.code &&
        ev.altKey === combo.alt &&
        ev.shiftKey === combo.shift &&
        ev.ctrlKey === combo.ctrl &&
        ev.metaKey === combo.meta
    );
}

/** Whether this is a Mac (or an iPad with a keyboard), where Alt is the Option key. */
export const isMac = (nav: { platform: string; userAgent: string } = navigator): boolean =>
    /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent);

const MAC_KEYS: Record<string, string> = { alt: "⌥", shift: "⇧", ctrl: "⌃", meta: "⌘", cmd: "⌘" };
const ARROWS: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
};

/**
 * A shortcut as people read it on their keyboard: `⌥⇧A` on a Mac, where Alt is the Option key, and
 * `Alt + Shift + A` everywhere else.
 */
export function shortcutLabel(combo: string, mac = isMac()): string {
    const parts = combo.split("+").map((p) => p.trim());
    const key = (parts.pop() ?? "").replace(/^Key([A-Z])$/, "$1").replace(/^Digit(\d)$/, "$1");
    const shown = ARROWS[key] ?? key;
    if (mac) return `${parts.map((p) => MAC_KEYS[p.toLowerCase()] ?? p).join("")}${shown}`;
    return [...parts, shown].join(" + ");
}

/** The input types a person types text into, where Alt and Shift combinations type characters and move the caret. */
const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/** Whether a key pressed on this target is typing: a text field, a select, or a region people type into. */
export function isEditable(target: EventTarget | undefined): boolean {
    if (!target || (target as Node).nodeType !== 1) return false;
    const el = target as HTMLElement;
    const tag = el.localName;
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") return TEXT_INPUTS.has((el.getAttribute("type") ?? "").toLowerCase());
    return (
        el.isContentEditable ||
        el.closest('[contenteditable]:not([contenteditable="false"])') !== null
    );
}
