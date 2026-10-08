type Child = Node | string | null | false | undefined;

/**
 * Minimal element builder. `class` sets className, `on*` props add listeners, an object `style` is
 * assigned, everything else becomes an attribute. Text is always set through text nodes, never HTML.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, unknown> = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") el.className = String(value);
        else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
        else if (key.startsWith("on") && typeof value === "function") {
            el.addEventListener(key.slice(2), value as EventListener);
        } else el.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        el.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return el;
}

/** Static, trusted SVG markup only (icons). Never pass user content here. */
export function icon(svg: string): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = "icon";
    span.innerHTML = svg;
    return span;
}

export const ICONS = {
    crosshair:
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 1.5V6M12 18v4.5M1.5 12H6M18 12h4.5"/></svg>',
    package:
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.39-1.61M2 2l20 20"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/></svg>',
    grip: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/></svg>',
    // A tray with an arrow out of it: the export menu (Markdown, or a zip).
    export: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14V3M7.5 7.5 12 3l4.5 4.5M4 13v5a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5"/></svg>',
    clipboard:
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/></svg>',
    // A note with a folded corner: what the folded toolbar shows when the page will not show the potato.
    note: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10z"/><path d="M15 21v-4a2 2 0 012-2h4"/><path d="M7.5 8h9M7.5 12h5"/></svg>',
    chevronLeft:
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
    chevronRight:
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
} as const;

/** `Alt+Shift+KeyA` style combos, matched on `event.code` so Option-key layouts on macOS work. */
export function parseShortcut(combo: string) {
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

export function matchesShortcut(
    ev: KeyboardEvent,
    combo: ReturnType<typeof parseShortcut>
): boolean {
    return (
        ev.code === combo.code &&
        ev.altKey === combo.alt &&
        ev.shiftKey === combo.shift &&
        ev.ctrlKey === combo.ctrl &&
        ev.metaKey === combo.meta
    );
}

/** Events from our UI that must not reach the page: what is typed, clicked, touched or focused in it is not the page's. */
const KEY_EVENTS = ["keydown", "keyup", "keypress"];
const POINTER_EVENTS = [
    "mousedown",
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "pointerdown",
    "touchstart",
    "focusin",
    "focusout",
];
const PRESSES = ["mousedown", "pointerdown", "touchstart"];
const RELEASES = ["mouseup", "pointerup", "touchend"];

/**
 * Keeps events from the Notato UI from bubbling out to the page. Keys typed into it must not reach the app's
 * global shortcuts. And apps close a modal, menu or popover when a `mousedown` lands outside it (a listener on
 * `document`), and our toolbar and popover are outside it: without this, pressing Annotate would close the very
 * modal being annotated. The events are stopped at the host, after our own listeners inside the shadow root have run.
 * Listeners the page registered in the capture phase run before the event reaches us and are out of reach.
 */
export function isolateFromPage(host: HTMLElement): () => void {
    for (const type of [...KEY_EVENTS, ...POINTER_EVENTS])
        host.addEventListener(type, (ev) => ev.stopPropagation());
    // A release goes wherever the button is let go. One that ends a press begun on the page (a slider dragged over the
    // toolbar) is the page's: kept from it, the page would never hear its drag end. Only our own presses' are kept.
    let pressedHere = false;
    const onPress = (ev: Event) => {
        pressedHere = ev.composedPath().includes(host);
    };
    const onRelease = (ev: Event) => {
        if (pressedHere) ev.stopPropagation();
    };
    for (const type of PRESSES) window.addEventListener(type, onPress, true);
    for (const type of RELEASES) host.addEventListener(type, onRelease);
    return () => {
        for (const type of PRESSES) window.removeEventListener(type, onPress, true);
    };
}

// Nodes in an iframe are instances of that frame's own `Element`, `ShadowRoot` and so on, so `instanceof` with the page's
// classes is false for them. These look at what a node is instead, and work in every frame.
export const isElement = (n: unknown): n is Element => Boolean(n) && (n as Node).nodeType === 1;
export const isDocument = (n: unknown): n is Document => Boolean(n) && (n as Node).nodeType === 9;
export const isShadowRoot = (n: unknown): n is ShadowRoot =>
    Boolean(n) && (n as Node).nodeType === 11 && "host" in (n as object);
export const isIframe = (n: Element): n is HTMLIFrameElement => n.localName === "iframe";
