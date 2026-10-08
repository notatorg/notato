import { addSheet, type Sheet } from "./sheet.ts";

/** The browser's own animation object (CSS animations and transitions, and Web Animations), as far as it is paused. */
interface Anim {
    playState: string;
    pause(): void;
    play(): void;
}

type Frozen = Pick<Window, "document">;

export interface Freezer {
    readonly frozen: boolean;
    toggle(): void;
    freeze(): void;
    thaw(): void;
    destroy(): void;
}

const FREEZE_CSS = "*, *::before, *::after { animation-play-state: paused !important; }";
/** On the `<style>` element, where the browser needs one. */
export const FREEZE_MARKER = "data-notato-freeze";
const POLL_MS = 120;

/**
 * Freezes the page so it can be annotated mid-motion: every running animation and transition is paused where it
 * is (not jumped to its end), media is paused, and anything that starts while frozen is paused too. Thawing plays
 * only what this paused, so nothing that was already still starts moving.
 */
export function createFreezer(
    windows: () => Frozen[],
    onChange?: (frozen: boolean) => void
): Freezer {
    let frozen = false;
    const paused = new Set<Anim>();
    const media = new Set<HTMLMediaElement>();
    const styles = new Map<Document, Sheet>();
    let timer: ReturnType<typeof setInterval> | undefined;

    const sweep = () => {
        for (const win of windows()) {
            const doc = win.document;
            let list: Anim[] = [];
            try {
                list = (doc as unknown as { getAnimations?: () => Anim[] }).getAnimations?.() ?? [];
            } catch {
                // a document that is going away
            }
            for (const a of list) {
                if (a.playState === "running") {
                    try {
                        a.pause();
                        paused.add(a);
                    } catch {
                        // an animation that finished between the look and the pause
                    }
                }
            }
            for (const m of Array.from(doc.querySelectorAll<HTMLMediaElement>("video, audio"))) {
                if (!m.paused) {
                    m.pause();
                    media.add(m);
                }
            }
            // Set again on every sweep: an app that replaced the page's sheets meanwhile gets it back.
            const style = styles.get(doc);
            if (style) style.set(FREEZE_CSS);
            else styles.set(doc, addSheet(doc, FREEZE_CSS, FREEZE_MARKER));
        }
    };

    const freezer: Freezer = {
        get frozen() {
            return frozen;
        },
        freeze() {
            if (frozen) return;
            frozen = true;
            sweep();
            timer = setInterval(sweep, POLL_MS);
            onChange?.(true);
        },
        thaw() {
            if (!frozen) return;
            frozen = false;
            if (timer) clearInterval(timer);
            timer = undefined;
            for (const style of styles.values()) style.remove();
            styles.clear();
            for (const a of paused) {
                try {
                    a.play();
                } catch {
                    // cancelled while it was paused
                }
            }
            paused.clear();
            for (const m of media) m.play().catch(() => {});
            media.clear();
            onChange?.(false);
        },
        toggle() {
            if (frozen) freezer.thaw();
            else freezer.freeze();
        },
        destroy() {
            freezer.thaw();
        },
    };
    return freezer;
}
