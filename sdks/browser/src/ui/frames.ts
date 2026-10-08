import { isIframe } from "./dom.ts";

/** A rectangle in CSS pixels. */
export interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** The iframe an element's document sits in, if it is in one the page can reach. */
const frameOf = (win: Window): HTMLIFrameElement | HTMLFrameElement | null => {
    try {
        return win.frameElement as HTMLIFrameElement | null;
    } catch {
        return null;
    }
};

/**
 * Where an iframe's content starts, in the viewport of the window that holds the iframe, and how much it is scaled:
 * past the border and padding, and by any CSS transform on the frame.
 */
function contentFrame(frame: Element): { left: number; top: number; sx: number; sy: number } {
    const r = frame.getBoundingClientRect();
    const view = frame.ownerDocument.defaultView;
    const style = view?.getComputedStyle(frame);
    const num = (v: string | undefined) => Number.parseFloat(v ?? "0") || 0;
    const el = frame as HTMLElement;
    const sx = el.offsetWidth ? r.width / el.offsetWidth : 1;
    const sy = el.offsetHeight ? r.height / el.offsetHeight : 1;
    return {
        left: r.left + (el.clientLeft + num(style?.paddingLeft)) * sx,
        top: r.top + (el.clientTop + num(style?.paddingTop)) * sy,
        sx,
        sy,
    };
}

/** A rectangle given in `win`'s viewport, in the top page's viewport: through every iframe between the two. */
export function boxToTop(win: Window, box: Box): Box {
    let { left, top, width, height } = box;
    for (let w: Window | null = win; w; ) {
        const frame = frameOf(w);
        if (!frame) break;
        const c = contentFrame(frame);
        left = c.left + left * c.sx;
        top = c.top + top * c.sy;
        width *= c.sx;
        height *= c.sy;
        w = frame.ownerDocument.defaultView;
    }
    return { left, top, width, height };
}

/** A point given in `win`'s viewport, in the top page's viewport. */
export function pointToTop(win: Window, x: number, y: number): { x: number; y: number } {
    const b = boxToTop(win, { left: x, top: y, width: 0, height: 0 });
    return { x: b.left, y: b.top };
}

/** An element's rectangle in the top page's viewport, wherever it lives. */
export function viewportRect(el: Element): Box {
    const r = el.getBoundingClientRect();
    const win = el.ownerDocument.defaultView;
    return win ? boxToTop(win, { left: r.left, top: r.top, width: r.width, height: r.height }) : r;
}

/** Where an iframe's content box is, in the viewport of the window that holds the iframe. */
export function contentBox(frame: Element): Box {
    const c = contentFrame(frame);
    const el = frame as HTMLElement;
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
    const num = (v: string | undefined) => Number.parseFloat(v ?? "0") || 0;
    return {
        left: c.left,
        top: c.top,
        width: Math.max(0, el.clientWidth - num(style?.paddingLeft) - num(style?.paddingRight)),
        height: Math.max(0, el.clientHeight - num(style?.paddingTop) - num(style?.paddingBottom)),
    };
}

/** Every same-origin iframe in a document (or shadow root), shadow roots included. A cross-origin one has no readable document. */
export function framesIn(doc: Document | ShadowRoot): HTMLIFrameElement[] {
    const found: HTMLIFrameElement[] = [];
    const visit = (root: ParentNode) => {
        for (const el of Array.from(root.querySelectorAll("*"))) {
            if (isIframe(el)) found.push(el);
            if (el.shadowRoot) visit(el.shadowRoot);
        }
    };
    visit(doc);
    return found;
}

const readable = (frame: HTMLIFrameElement): Window | null => {
    try {
        return frame.contentDocument?.defaultView ?? null;
    } catch {
        return null;
    }
};

export interface FrameWatcher {
    /** Every window being watched now: the page's own, then each iframe's. */
    windows(): Window[];
    /** Looks again, for a caller that has just started caring (it only hears of frames as they change). */
    rescan(): void;
    destroy(): void;
}

/** One caller of `watchFrames`, and what it has attached to which window. */
interface Watching {
    attach: (win: Window) => (() => void) | undefined;
    foreign?: (frame: HTMLIFrameElement) => void;
    /** What is attached to each window, and to which of its documents: a navigation replaces the document under the same window. */
    entries: Map<Window, { doc: Document; off: () => void }>;
}

/**
 * What looks for the frames of one page, shared by everyone watching it (the pins and the picker): one observer per
 * document, and one look when something changed, however many callers there are.
 */
interface Tracker {
    watching: Set<Watching>;
    observers: Map<Document, MutationObserver>;
    frameLoads: Map<HTMLIFrameElement, () => void>;
    /** Elements added since the last look. Only they can have brought a frame. */
    added: Element[];
    /** Too much was added to keep a list of: the next look is a whole one. */
    overflowed: boolean;
    /** Something was removed since the last look, perhaps a frame. */
    removed: boolean;
    frame: number;
}

const trackers = new Map<Window, Tracker>();
/** Past this many added elements in one frame (a whole page rendered at once), the next look covers the whole page. */
const MAX_ADDED = 2000;

/** An element that is, or holds, an iframe, shadow roots included. */
function holdsFrame(el: Element): boolean {
    if (isIframe(el) || el.querySelector("iframe")) return true;
    for (const inner of [el, ...Array.from(el.querySelectorAll("*"))])
        if (inner.shadowRoot && framesIn(inner.shadowRoot).length > 0) return true;
    return false;
}

/**
 * Calls `attach` for the page's window and for every same-origin iframe window inside it, now and as iframes appear,
 * navigate (a navigation gives the frame a new window) or go away, and runs what `attach` returned when a window
 * goes. The page's own window is attached first and last to go.
 *
 * Every caller on a page shares one set of observers. A change to the page is looked at once a frame, and only what it
 * added or removed: the page is searched for frames again only when that could have brought or taken one. An iframe
 * added later inside a shadow root that is already in the page is not seen until the next whole look (`rescan`, or a
 * frame loading).
 */
export function watchFrames(
    root: Window,
    attach: (win: Window) => (() => void) | undefined,
    /** Called for each iframe whose document cannot be read (another origin), on every look. */
    foreign?: (frame: HTMLIFrameElement) => void
): FrameWatcher {
    let tracker = trackers.get(root);
    if (!tracker) {
        tracker = {
            watching: new Set(),
            observers: new Map(),
            frameLoads: new Map(),
            added: [],
            overflowed: false,
            removed: false,
            frame: 0,
        };
        trackers.set(root, tracker);
    }
    const shared = tracker;
    const me: Watching = { attach, foreign, entries: new Map() };
    let stopped = false;

    const drop = (w: Watching, win: Window) => {
        w.entries.get(win)?.off();
        w.entries.delete(win);
    };
    const attachTo = (w: Watching, win: Window) => {
        w.entries.set(win, { doc: win.document, off: w.attach(win) ?? (() => {}) });
    };

    /** Looks at the whole page: every frame in it, for every caller. */
    const scan = () => {
        if (!trackers.has(root) || trackers.get(root) !== shared) return;
        const live: Window[] = [root];
        const foreignFrames: HTMLIFrameElement[] = [];
        const walk = (d: Document) => {
            for (const frame of framesIn(d)) {
                const win = readable(frame);
                if (!frame.isConnected) continue;
                // A load is a navigation: a new window, or a foreign frame that became readable (or the other way).
                if (!shared.frameLoads.has(frame)) {
                    const onLoad = () => scan();
                    frame.addEventListener("load", onLoad);
                    shared.frameLoads.set(frame, () => frame.removeEventListener("load", onLoad));
                }
                if (!win) {
                    foreignFrames.push(frame);
                    continue;
                }
                live.push(win);
                watchDocument(win.document);
                walk(win.document);
            }
        };
        walk(root.document);
        const docs = new Set(live.map((win) => win.document));
        for (const w of [...shared.watching]) {
            for (const win of live) {
                // Attached, and still to the document the window has now.
                const entry = w.entries.get(win);
                if (entry && entry.doc !== win.document) drop(w, win);
                if (!w.entries.has(win)) attachTo(w, win);
            }
            for (const win of [...w.entries.keys()]) if (!live.includes(win)) drop(w, win);
            for (const frame of foreignFrames) w.foreign?.(frame);
        }
        for (const [frame, off] of [...shared.frameLoads]) {
            if (!frame.isConnected) {
                off();
                shared.frameLoads.delete(frame);
            }
        }
        // A document that is gone (its frame removed, or navigated) needs no watching.
        for (const [doc, observer] of [...shared.observers]) {
            if (doc === root.document || docs.has(doc)) continue;
            observer.disconnect();
            shared.observers.delete(doc);
        }
    };

    /** At most once a frame: is there anything in what changed that could be, or could have been, a frame? */
    const look = () => {
        shared.frame = 0;
        const added = shared.added;
        const whole = shared.overflowed;
        const removed = shared.removed;
        shared.added = [];
        shared.overflowed = false;
        shared.removed = false;
        if (
            whole ||
            (removed && [...shared.frameLoads.keys()].some((f) => !f.isConnected)) ||
            added.some((el) => el.isConnected && holdsFrame(el))
        )
            scan();
    };

    const changed = (records: MutationRecord[]) => {
        for (const record of records) {
            if (record.removedNodes.length) shared.removed = true;
            for (const node of Array.from(record.addedNodes)) {
                if (node.nodeType !== 1) continue;
                if (shared.added.length < MAX_ADDED) shared.added.push(node as Element);
                else shared.overflowed = true;
            }
        }
        if (!shared.frame) shared.frame = requestAnimationFrame(look);
    };

    function watchDocument(doc: Document) {
        if (shared.observers.has(doc)) return;
        const observer = new MutationObserver(changed);
        observer.observe(doc, { childList: true, subtree: true });
        shared.observers.set(doc, observer);
    }

    shared.watching.add(me);
    watchDocument(root.document);
    scan();

    return {
        windows: () => [...me.entries.keys()],
        rescan: () => {
            if (!stopped) scan();
        },
        destroy() {
            if (stopped) return;
            stopped = true;
            shared.watching.delete(me);
            for (const win of [...me.entries.keys()].reverse()) drop(me, win);
            if (shared.watching.size > 0) return;
            // The last one watching this page: nothing needs to look any more.
            if (shared.frame) cancelAnimationFrame(shared.frame);
            for (const observer of shared.observers.values()) observer.disconnect();
            for (const off of shared.frameLoads.values()) off();
            trackers.delete(root);
        },
    };
}
