/**
 * The style rules Notato adds: to its own shadow root, and to the page while annotating, paused or showing variants.
 * Where the browser can, each is a constructed stylesheet (`adoptedStyleSheets`), which a Content-Security-Policy
 * without `'unsafe-inline'` allows. Elsewhere it is a `<style>` element carrying the nonce the page gave (the `nonce`
 * option), which such a policy lets through.
 */

/** One sheet of rules, wherever it ended up. */
export interface Sheet {
    /** Replaces the rules. Also puts the sheet back if the page took it away, as an app setting `adoptedStyleSheets` does. */
    set(css: string): void;
    /** Off, the rules apply to nothing; the sheet stays where it is. */
    disabled: boolean;
    remove(): void;
}

type Root = Document | ShadowRoot;
type WindowWithSheets = Window & { CSSStyleSheet: typeof CSSStyleSheet };

let nonce: string | undefined;

/** The nonce for `<style>` elements, from the page's options. Constructed stylesheets need none. */
export function setStyleNonce(value: string | undefined): void {
    nonce = value || undefined;
}

/** What each constructed sheet says, and what it is for: a constructed sheet has no element to read that from. */
const made = new WeakMap<CSSStyleSheet, { marker: string; css: string }>();

const documentOf = (root: Root): Document =>
    root.nodeType === 9 ? (root as Document) : (root as ShadowRoot).ownerDocument;

/**
 * The constructor a sheet for this root must come from: a sheet can only be adopted in the document whose window made
 * it, so a frame's sheets come from the frame. None where the browser cannot adopt sheets.
 */
function constructorFor(root: Root): WindowWithSheets["CSSStyleSheet"] | undefined {
    const win = documentOf(root).defaultView as WindowWithSheets | null;
    const Sheet = win?.CSSStyleSheet;
    if (!Sheet || !("adoptedStyleSheets" in root)) return undefined;
    return typeof Sheet.prototype.replaceSync === "function" ? Sheet : undefined;
}

/**
 * Adds `css` to a document or shadow root. `marker` says what it is for, and is the attribute on the `<style>` element
 * where one is used (`data-notato-freeze`).
 */
export function addSheet(root: Root, css: string, marker: string): Sheet {
    const Constructed = constructorFor(root);
    if (Constructed) {
        try {
            return adopted(root, Constructed, css, marker);
        } catch {
            // a browser that has the API but will not take this sheet here: the element below
        }
    }
    return element(root, css, marker);
}

function adopted(
    root: Root,
    Constructed: WindowWithSheets["CSSStyleSheet"],
    css: string,
    marker: string
): Sheet {
    const make = (text: string) => {
        const one = new Constructed();
        one.replaceSync(text);
        made.set(one, { marker, css: text });
        return one;
    };
    let sheet = make(css);
    let current = css;
    const adopt = () => {
        if (!root.adoptedStyleSheets.includes(sheet))
            root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    };
    adopt();
    return {
        set(next) {
            if (next !== current) {
                // A new sheet in the old one's place, rather than the old one rewritten: a change to the list is what
                // every implementation restyles for (happy-dom, which the tests run in, keeps styles it worked out
                // from a sheet that was later rewritten). Rules change rarely: when a different variant is shown.
                const fresh = make(next);
                fresh.disabled = sheet.disabled;
                const was = sheet;
                sheet = fresh;
                current = next;
                root.adoptedStyleSheets = root.adoptedStyleSheets.map((s) =>
                    s === was ? fresh : s
                );
            }
            adopt();
        },
        get disabled() {
            return sheet.disabled;
        },
        set disabled(off) {
            sheet.disabled = off;
        },
        remove() {
            try {
                root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
            } catch {
                // a document that is going away (its frame was removed)
            }
        },
    };
}

function element(root: Root, css: string, marker: string): Sheet {
    const doc = documentOf(root);
    const style = doc.createElement("style");
    style.setAttribute(marker, "");
    if (nonce) style.setAttribute("nonce", nonce);
    style.textContent = css;
    let off = false;
    const place = () => {
        if (style.isConnected) return;
        if (root.nodeType === 9) (doc.head ?? doc.documentElement).append(style);
        else root.prepend(style);
        // A style element put back is a new sheet: it starts enabled.
        if (style.sheet) style.sheet.disabled = off;
    };
    place();
    return {
        set(next) {
            if (style.textContent !== next) style.textContent = next;
            place();
        },
        get disabled() {
            return off;
        },
        set disabled(next) {
            off = next;
            if (style.sheet) style.sheet.disabled = next;
        },
        remove() {
            style.remove();
        },
    };
}

/** The rules of every sheet with this marker in a document or shadow root, constructed or not: for tests and debugging. */
export function sheetsIn(root: Root, marker: string): string[] {
    const out: string[] = [];
    for (const sheet of "adoptedStyleSheets" in root ? root.adoptedStyleSheets : []) {
        const info = made.get(sheet);
        if (info?.marker === marker) out.push(info.css);
    }
    for (const style of Array.from(root.querySelectorAll(`style[${marker}]`)))
        out.push(style.textContent ?? "");
    return out;
}
