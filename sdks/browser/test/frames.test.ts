// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type Box,
    boxToTop,
    contentBox,
    type FrameWatcher,
    framesIn,
    viewportRect,
    watchFrames,
} from "../src/ui/frames.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

/** A real same-origin iframe (about:blank) in `into`; happy-dom gives it its own document and window. */
const addFrame = (into: ParentNode = document.body, doc: Document = document) => {
    const frame = doc.createElement("iframe");
    into.append(frame);
    return frame;
};
const windowOf = (frame: HTMLIFrameElement) => frame.contentWindow as Window;
/** A point in `win`'s viewport, in the top page's: `boxToTop` for a box with no size. */
const pointToTop = (win: Window, x: number, y: number) => {
    const box = boxToTop(win, { left: x, top: y, width: 0, height: 0 });
    return { x: box.left, y: box.top };
};
const docOf = (frame: HTMLIFrameElement) => frame.contentDocument as Document;

/** What a browser does for a frame from another origin: its document cannot be read. */
const makeForeign = (frame: HTMLIFrameElement, how: "throws" | "null") =>
    Object.defineProperty(frame, "contentDocument", {
        configurable: true,
        get() {
            if (how === "null") return null;
            throw new DOMException(
                "Blocked a frame from accessing a cross-origin frame.",
                "SecurityError"
            );
        },
    });

let watchers: FrameWatcher[];
/** Every window `attach` was called with, in order, and what the teardown it returned has been told. */
let log: string[];
let attached: Window[];
/** A window is named by the `id` on its body when it was attached, so its teardown can say who it was after it is gone. */
const attach = (win: Window) => {
    const name = win === window ? "page" : `frame:${win.document.body?.id ?? ""}`;
    attached.push(win);
    log.push(`attach ${name}`);
    return () => log.push(`detach ${name}`);
};
const watch = (foreign?: (frame: HTMLIFrameElement) => void) => {
    const watcher = watchFrames(window, attach, foreign);
    watchers.push(watcher);
    return watcher;
};

beforeEach(() => {
    watchers = [];
    log = [];
    attached = [];
    document.body.innerHTML = "";
});
afterEach(() => {
    for (const w of watchers) w.destroy();
    document.body.innerHTML = "";
});

describe("watchFrames", () => {
    it("attaches the page's own window first, once", () => {
        watch();
        expect(attached).toEqual([window]);
    });

    it("attaches each same-origin iframe in the page, once", async () => {
        const a = addFrame();
        const b = addFrame();
        docOf(a).body.id = "a";
        docOf(b).body.id = "b";
        const watcher = watch();
        await settle(); // the frames' own load events must not attach them again
        expect(attached).toEqual([window, windowOf(a), windowOf(b)]);
        expect(watcher.windows()).toEqual([window, windowOf(a), windowOf(b)]);
    });

    it("attaches an iframe nested inside another", async () => {
        const outer = addFrame();
        const inner = addFrame(docOf(outer).body, docOf(outer));
        watch();
        await settle();
        expect(attached).toEqual([window, windowOf(outer), windowOf(inner)]);
    });

    it("attaches an iframe inside a shadow root", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const frame = addFrame(host.attachShadow({ mode: "open" }));
        watch();
        expect(attached).toEqual([window, windowOf(frame)]);
    });

    it("attaches an iframe added after watching began", async () => {
        watch();
        const frame = addFrame();
        await settle();
        expect(attached).toEqual([window, windowOf(frame)]);
    });

    it("attaches an iframe added later inside an iframe that is already watched", async () => {
        const outer = addFrame();
        watch();
        const inner = addFrame(docOf(outer).body, docOf(outer));
        await settle();
        expect(attached).toEqual([window, windowOf(outer), windowOf(inner)]);
    });

    it("does not attach a window again when it looks again", async () => {
        const frame = addFrame();
        const watcher = watch();
        watcher.rescan();
        watcher.rescan();
        await settle();
        expect(attached).toEqual([window, windowOf(frame)]);
    });

    it("runs the teardown of an iframe that is removed, and only that one", async () => {
        const keep = addFrame();
        const gone = addFrame();
        docOf(keep).body.id = "keep";
        docOf(gone).body.id = "gone";
        const watcher = watch();
        log.length = 0;
        gone.remove();
        await settle();
        expect(log).toEqual(["detach frame:gone"]);
        expect(watcher.windows()).toEqual([window, windowOf(keep)]);
    });

    it("replaces what is attached when an iframe navigates to a new window", async () => {
        const frame = addFrame();
        docOf(frame).body.id = "old";
        const before = windowOf(frame);
        const watcher = watch();
        log.length = 0;
        frame.srcdoc = "<body id=new></body>";
        await settle();
        expect(windowOf(frame)).not.toBe(before);
        expect([...log].sort()).toEqual(["attach frame:new", "detach frame:old"]);
        expect(watcher.windows()).toEqual([window, windowOf(frame)]);
    });

    // A browser keeps the frame's window across a same-origin navigation and swaps its document, so what was attached
    // to the old document would be listening to a page that is gone. happy-dom makes a new window instead, so the swap
    // is done by hand: the window's `document` now answers with a fresh one that points back at it, and the frame says
    // it loaded.
    it("re-attaches a window whose document was replaced under it", async () => {
        const frame = addFrame();
        docOf(frame).body.id = "prev";
        const win = windowOf(frame);
        const watcher = watch();
        expect(attached).toEqual([window, win]);
        log.length = 0;

        const replacement = document.implementation.createHTMLDocument("next");
        replacement.body.id = "next";
        Object.defineProperty(replacement, "defaultView", { value: win });
        Object.defineProperty(win, "document", { configurable: true, value: replacement });
        frame.dispatchEvent(new Event("load"));
        await settle();
        expect([...log].sort()).toEqual(["attach frame:next", "detach frame:prev"]);
        expect(attached.at(-1)).toBe(win);
        expect(watcher.windows()).toEqual([window, win]);

        // And the new document is the one being watched now: a frame added to it is found.
        const late = replacement.createElement("iframe");
        replacement.body.append(late);
        // The frame is not in the page's document, so only the replacement's own observer can see it.
        await settle();
        expect(attached.at(-1)).toBe(windowOf(late));
    });

    it("reports an iframe whose document cannot be read instead of attaching it", async () => {
        const readable = addFrame();
        const blocked = addFrame();
        const hidden = addFrame();
        makeForeign(blocked, "throws");
        makeForeign(hidden, "null");
        const foreign = vi.fn();
        const watcher = watch(foreign);
        expect(foreign.mock.calls.map(([frame]) => frame)).toEqual([blocked, hidden]);
        expect(watcher.windows()).toEqual([window, windowOf(readable)]);
    });

    it("keeps reporting a foreign iframe on every look", () => {
        makeForeign(addFrame(), "throws");
        const foreign = vi.fn();
        const watcher = watch(foreign);
        watcher.rescan();
        expect(foreign).toHaveBeenCalledTimes(2);
    });

    it("detaches everything on destroy, the page's window last", async () => {
        const a = addFrame();
        const b = addFrame();
        docOf(a).body.id = "a";
        docOf(b).body.id = "b";
        const watcher = watch();
        log.length = 0;
        watcher.destroy();
        expect(log).toEqual(["detach frame:b", "detach frame:a", "detach page"]);
        expect(watcher.windows()).toEqual([]);
    });

    it("ignores frames that appear after destroy", async () => {
        const watcher = watch();
        watcher.destroy();
        log.length = 0;
        addFrame();
        watcher.rescan();
        await settle();
        expect(log).toEqual([]);
    });
});

describe("framesIn", () => {
    it("lists iframes in document order, including those inside shadow roots, and no other element", () => {
        const first = addFrame();
        const host = document.createElement("div");
        document.body.append(host);
        const inShadow = addFrame(host.attachShadow({ mode: "open" }));
        const last = addFrame();
        document.body.append(document.createElement("section"), document.createElement("object"));
        expect(framesIn(document)).toEqual([first, inShadow, last]);
    });

    it("does not look inside an iframe's own document", () => {
        const outer = addFrame();
        addFrame(docOf(outer).body, docOf(outer));
        expect(framesIn(document)).toEqual([outer]);
    });
});

describe("coordinates through iframes", () => {
    // happy-dom does no layout and has no `Window.frameElement`. These give a frame the numbers a layout engine would and
    // the link from its window back to it, so the code under test reads them through the same DOM calls as in a browser.
    interface Layout {
        /** Where the frame's border box sits in the viewport that holds it, as painted (after any transform). */
        rect: Box;
        /** Border width on every side: `clientLeft` and `clientTop`. */
        border?: number;
        /** Padding, as CSS. */
        padding?: string;
        /** The frame's own layout size, before any transform. Defaults to the painted size. */
        layoutSize?: { width: number; height: number };
    }
    const lay = (frame: HTMLIFrameElement, layout: Layout) => {
        const { left, top, width, height } = layout.rect;
        const size = layout.layoutSize ?? { width, height };
        const define = (props: Record<string, number>) => {
            for (const [key, value] of Object.entries(props))
                Object.defineProperty(frame, key, { configurable: true, get: () => value });
        };
        frame.getBoundingClientRect = () =>
            ({
                left,
                top,
                width,
                height,
                x: left,
                y: top,
                right: left + width,
                bottom: top + height,
            }) as DOMRect;
        define({
            offsetWidth: size.width,
            offsetHeight: size.height,
            clientLeft: layout.border ?? 0,
            clientTop: layout.border ?? 0,
            clientWidth: size.width - 2 * (layout.border ?? 0),
            clientHeight: size.height - 2 * (layout.border ?? 0),
        });
        if (layout.padding) frame.style.padding = layout.padding;
        Object.defineProperty(windowOf(frame), "frameElement", {
            configurable: true,
            get: () => frame,
        });
        return frame;
    };
    const at = (left: number, top: number, width = 400, height = 300): Box => ({
        left,
        top,
        width,
        height,
    });

    it("leaves a box in the page's own window alone", () => {
        expect(boxToTop(window, { left: 5, top: 7, width: 20, height: 10 })).toEqual(
            at(5, 7, 20, 10)
        );
        expect(pointToTop(window, 5, 7)).toEqual({ x: 5, y: 7 });
    });

    it("moves a point by the frame's offset, its border and its padding", () => {
        const frame = lay(addFrame(), { rect: at(100, 50), border: 2, padding: "10px" });
        // The content starts 12px in from the frame's corner on both axes.
        expect(pointToTop(windowOf(frame), 0, 0)).toEqual({ x: 112, y: 62 });
        expect(pointToTop(windowOf(frame), 5, 7)).toEqual({ x: 117, y: 69 });
    });

    it("uses each side's own padding", () => {
        const frame = lay(addFrame(), { rect: at(100, 50), padding: "4px 6px 8px 12px" });
        expect(pointToTop(windowOf(frame), 0, 0)).toEqual({ x: 112, y: 54 });
    });

    it("keeps a box's size when the frame is not scaled", () => {
        const frame = lay(addFrame(), { rect: at(100, 50), border: 2, padding: "10px" });
        expect(boxToTop(windowOf(frame), { left: 5, top: 7, width: 20, height: 10 })).toEqual(
            at(117, 69, 20, 10)
        );
    });

    it("scales through a frame that is drawn smaller than its layout, border and padding included", () => {
        // `transform: scale(.5)` on a 400x300 frame: painted at 200x150.
        const frame = lay(addFrame(), {
            rect: at(100, 50, 200, 150),
            layoutSize: { width: 400, height: 300 },
            border: 2,
            padding: "10px",
        });
        // Content starts (2 + 10) * 0.5 = 6px in; 20 and 40 inside are 10 and 20 on screen.
        expect(pointToTop(windowOf(frame), 20, 40)).toEqual({ x: 116, y: 76 });
        expect(boxToTop(windowOf(frame), { left: 20, top: 40, width: 40, height: 60 })).toEqual(
            at(116, 76, 20, 30)
        );
    });

    it("goes through two levels of frames", () => {
        const outer = lay(addFrame(), { rect: at(100, 50), border: 2, padding: "10px" });
        const inner = lay(addFrame(docOf(outer).body, docOf(outer)), {
            rect: at(30, 40),
            border: 1,
        });
        // inner's content is at (31, 41) in outer's viewport, which is at (112, 62) on the page.
        expect(pointToTop(windowOf(inner), 5, 7)).toEqual({ x: 148, y: 110 });
        expect(boxToTop(windowOf(inner), { left: 0, top: 0, width: 10, height: 10 })).toEqual(
            at(143, 103, 10, 10)
        );
        // A point already in the outer frame's viewport only goes through the one level.
        expect(pointToTop(windowOf(outer), 36, 48)).toEqual({ x: 148, y: 110 });
    });

    it("compounds the scale of nested frames", () => {
        const outer = lay(addFrame(), {
            rect: at(100, 50, 200, 150),
            layoutSize: { width: 400, height: 300 },
        }); // 0.5
        const inner = lay(addFrame(docOf(outer).body, docOf(outer)), {
            rect: at(10, 10, 200, 200),
            layoutSize: { width: 100, height: 100 },
        }); // 2, inside the half-size outer frame
        // (3, 4) is (6, 8) further in outer's viewport, at (16, 18), which is (8, 9) on screen from outer's corner.
        expect(pointToTop(windowOf(inner), 3, 4)).toEqual({ x: 108, y: 59 });
        expect(boxToTop(windowOf(inner), { left: 0, top: 0, width: 10, height: 10 }).width).toBe(
            10
        ); // 10 * 2 * 0.5
    });

    it("treats a window whose frame cannot be read as the top", () => {
        const sealed = {
            get frameElement(): never {
                throw new DOMException("blocked", "SecurityError");
            },
        } as unknown as Window;
        expect(boxToTop(sealed, at(5, 7, 20, 10))).toEqual(at(5, 7, 20, 10));
    });

    it("gives an element's rectangle on the page, wherever it lives", () => {
        const frame = lay(addFrame(), { rect: at(100, 50), border: 2, padding: "10px" });
        const button = docOf(frame).createElement("button");
        docOf(frame).body.append(button);
        button.getBoundingClientRect = () =>
            ({ left: 5, top: 7, width: 80, height: 24 }) as DOMRect;
        expect(viewportRect(button)).toEqual(at(117, 69, 80, 24));

        const own = document.createElement("button");
        document.body.append(own);
        own.getBoundingClientRect = () => ({ left: 5, top: 7, width: 80, height: 24 }) as DOMRect;
        expect(viewportRect(own)).toEqual(at(5, 7, 80, 24));
    });

    it("gives an iframe's content box: past border and padding, and without the padding in its size", () => {
        const frame = lay(addFrame(), {
            rect: at(100, 50, 306, 206),
            border: 3,
            padding: "10px 20px",
            layoutSize: { width: 306, height: 206 },
        });
        // clientWidth is 300 and clientHeight is 200 (the border is outside them).
        expect(contentBox(frame)).toEqual(at(123, 63, 260, 180));
    });

    it("never gives a content box with a negative size", () => {
        const frame = lay(addFrame(), { rect: at(0, 0, 30, 30), padding: "20px" });
        const { width, height } = contentBox(frame);
        expect(width).toBe(0);
        expect(height).toBe(0);
    });
});

describe("watching a page from more than one place", () => {
    it("has one observer per document, however many are watching", () => {
        const Real = globalThis.MutationObserver;
        let made = 0;
        globalThis.MutationObserver = class extends Real {
            constructor(callback: MutationCallback) {
                super(callback);
                made += 1;
            }
        };
        try {
            addFrame();
            watch();
            watch();
            expect(made).toBe(2); // the page's document, and the frame's
        } finally {
            globalThis.MutationObserver = Real;
        }
    });

    it("tells each of them about a frame added later, and each goes on its own when destroyed", async () => {
        const first = watch();
        const second = watch();
        const frame = addFrame();
        await settle();
        expect(first.windows()).toEqual([window, windowOf(frame)]);
        expect(second.windows()).toEqual([window, windowOf(frame)]);
        first.destroy();
        const later = addFrame();
        await settle();
        expect(second.windows()).toEqual([window, windowOf(frame), windowOf(later)]);
        expect(first.windows()).toEqual([]);
    });

    it("does not search the page for frames when nothing that changed holds one", async () => {
        watch();
        const search = vi.spyOn(document, "querySelectorAll");
        const block = document.createElement("section");
        block.append(document.createElement("p"), document.createElement("p"));
        document.body.append(block);
        block.remove();
        document.body.append(document.createElement("div"));
        await settle();
        expect(search).not.toHaveBeenCalled();
        addFrame();
        await settle();
        expect(search).toHaveBeenCalled();
        search.mockRestore();
    });

    it("looks at a burst of changes once, at the next frame", async () => {
        const watcher = watch();
        const search = vi.spyOn(document, "querySelectorAll");
        const frames = [addFrame(), addFrame(), addFrame()];
        expect(watcher.windows()).toEqual([window]); // not yet
        await settle();
        expect(search).toHaveBeenCalledTimes(1);
        expect(watcher.windows()).toEqual([window, ...frames.map(windowOf)]);
        search.mockRestore();
    });
});
