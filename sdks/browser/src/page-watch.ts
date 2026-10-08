import { onHistoryChange } from "./history.ts";
import { type FrameWatcher, watchFrames } from "./ui/frames.ts";
import { VARIANT_ATTR, VARIANT_NAME_ATTR } from "./ui/variants.ts";

export interface PageWatchOptions {
    /** The attributes that say which element is which (its id, its test ids): a change to one can change what a pin finds. */
    identityAttributes: string[];
    /** Something on the page may have moved: a scroll, a resize, an element changed. */
    onMove(): void;
    /**
     * Elements came or went, or one changed what it answers to: `touched` is the elements added and those changed, and
     * is left out when anything at all may have changed (an iframe came, with everything in it).
     */
    onElementsChanged(touched?: Element[]): void;
    /** The page went to another route: `pushState`, `replaceState`, back and forward, or the hash. */
    onRouteChange(): void;
}

export interface PageWatch {
    /** The page's window and each same-origin iframe's, as they come and go. */
    frames: FrameWatcher;
    destroy(): void;
}

/**
 * Follows the page for whatever the toolbar draws over it: scrolling and resizing, in the page and in every same-origin
 * iframe (which the page never hears of), elements coming and going, and the route changing.
 */
export function watchPage(options: PageWatchOptions): PageWatch {
    const { identityAttributes, onMove, onElementsChanged, onRouteChange } = options;
    /**
     * Elements coming and going, and the attributes that move things on the page or say what an element is: any other
     * attribute (an `aria-busy`, a `data-` value an app keeps state in) moves nothing, and on a busy app changes many
     * times a second.
     */
    const watched: MutationObserverInit = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
            "class",
            "style",
            "hidden",
            "open",
            VARIANT_ATTR,
            VARIANT_NAME_ATTR,
            ...identityAttributes,
        ],
    };
    const onMutations = (records: MutationRecord[]) => {
        let changed = false;
        const touched: Element[] = [];
        for (const r of records) {
            if (r.type === "childList") {
                changed = true;
                for (const node of Array.from(r.addedNodes))
                    if (node.nodeType === 1) touched.push(node as Element);
            } else if (r.attributeName !== null && identityAttributes.includes(r.attributeName)) {
                changed = true;
                touched.push(r.target as Element);
            }
        }
        if (changed) onElementsChanged(touched);
        onMove();
    };

    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    const frames = watchFrames(window, (win) => {
        if (win === window) return undefined;
        win.addEventListener("scroll", onMove, true);
        win.addEventListener("resize", onMove);
        const observer = new MutationObserver(onMutations);
        observer.observe(win.document, watched);
        onElementsChanged(); // what points into this frame can find its elements now
        return () => {
            win.removeEventListener("scroll", onMove, true);
            win.removeEventListener("resize", onMove);
            observer.disconnect();
        };
    });
    const mutations = new MutationObserver(onMutations);
    mutations.observe(document.body, watched);
    const resizes = new ResizeObserver(onMove);
    resizes.observe(document.documentElement);

    const stopHistory = onHistoryChange(onRouteChange);
    window.addEventListener("popstate", onRouteChange);
    window.addEventListener("hashchange", onRouteChange);

    return {
        frames,
        destroy() {
            stopHistory();
            window.removeEventListener("popstate", onRouteChange);
            window.removeEventListener("hashchange", onRouteChange);
            frames.destroy();
            window.removeEventListener("scroll", onMove, true);
            window.removeEventListener("resize", onMove);
            mutations.disconnect();
            resizes.disconnect();
        },
    };
}
