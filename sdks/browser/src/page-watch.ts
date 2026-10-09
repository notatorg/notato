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
    /**
     * The versions an agent put in the page may have changed: `found` when a version's marker was added or changed (an
     * element with one came, or the attribute itself changed), otherwise only because something was removed.
     */
    onVariantsChanged?(found: boolean): void;
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
    const { identityAttributes, onMove, onElementsChanged, onRouteChange, onVariantsChanged } =
        options;
    const marker = `[${VARIANT_ATTR}]`;
    /** Whether an added element is, or holds, a version: the selector is run only over what was added. */
    const holdsVersion = (el: Element) => {
        try {
            return el.matches(marker) || el.querySelector(marker) !== null;
        } catch {
            return false;
        }
    };
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
        let removed = false;
        let versions = false;
        const touched: Element[] = [];
        for (const r of records) {
            if (r.type === "childList") {
                changed = true;
                if (r.removedNodes.length > 0) removed = true;
                for (const node of Array.from(r.addedNodes)) {
                    if (node.nodeType !== 1) continue;
                    touched.push(node as Element);
                    if (!versions && onVariantsChanged) versions = holdsVersion(node as Element);
                }
            } else if (r.attributeName === VARIANT_ATTR || r.attributeName === VARIANT_NAME_ATTR) {
                versions = true;
            } else if (r.attributeName !== null && identityAttributes.includes(r.attributeName)) {
                changed = true;
                touched.push(r.target as Element);
            }
        }
        if (changed) onElementsChanged(touched);
        if (versions || removed) onVariantsChanged?.(versions);
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
        onVariantsChanged?.(true); // and it may have versions in it
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
