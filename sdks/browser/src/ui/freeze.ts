import { addSheet, type Sheet } from "./sheet.ts";

/** The browser's own animation object: CSS animations and transitions and Web Animations all come through it. */
interface Anim {
    playState: string;
    pause(): void;
    play(): void;
    effect?: {
        getComputedTiming?(): {
            progress?: number | null;
            duration?: unknown;
            delay?: number;
            iterations?: number;
            currentIteration?: number | null;
        };
        getTiming?(): { easing?: string; direction?: string; fill?: string };
        getKeyframes?(): Array<Record<string, unknown>>;
    } | null;
    animationName?: string;
    transitionProperty?: string;
    id?: string;
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

export interface AnimationInfo {
    kind: "css-animation" | "css-transition" | "web-animation";
    name?: string;
    property?: string;
    duration?: number;
    delay?: number;
    easing?: string;
    iterations?: number | string;
    progress?: number;
    state: string;
    keyframes?: Array<Record<string, string | number>>;
}

const SKIP_KEYFRAME = new Set(["computedOffset", "easing", "composite"]);

/** What is animating on an element (and inside it): each animation's name, timing, how far along it is, and its keyframes. */
export function animationsOn(el: Element, limit = 8): AnimationInfo[] {
    let list: Anim[] = [];
    try {
        list =
            (
                el as unknown as { getAnimations?: (o: { subtree: boolean }) => Anim[] }
            ).getAnimations?.({
                subtree: true,
            }) ?? [];
    } catch {
        return [];
    }
    const out: AnimationInfo[] = [];
    for (const a of list.slice(0, limit)) {
        const timing = a.effect?.getComputedTiming?.();
        const options = a.effect?.getTiming?.();
        const kind =
            a.animationName !== undefined
                ? "css-animation"
                : a.transitionProperty !== undefined
                  ? "css-transition"
                  : "web-animation";
        const duration = typeof timing?.duration === "number" ? timing.duration : undefined;
        const info: AnimationInfo = {
            kind,
            state: a.playState,
            ...(kind === "css-animation" ? { name: a.animationName } : {}),
            ...(kind === "css-transition" ? { property: a.transitionProperty } : {}),
            ...(kind === "web-animation" && a.id ? { name: a.id } : {}),
            ...(duration !== undefined ? { duration } : {}),
            ...(timing?.delay ? { delay: timing.delay } : {}),
            // A CSS animation keeps its timing function on its keyframes, and says `linear` for the animation itself.
            ...(() => {
                const easing =
                    options?.easing && options.easing !== "linear"
                        ? options.easing
                        : (a.effect?.getKeyframes?.()?.[0]?.easing as string | undefined);
                return easing ? { easing } : {};
            })(),
            ...(timing?.iterations !== undefined
                ? {
                      iterations: Number.isFinite(timing.iterations)
                          ? timing.iterations
                          : "infinite",
                  }
                : {}),
            ...(typeof timing?.progress === "number"
                ? { progress: Math.round(timing.progress * 1000) / 1000 }
                : {}),
        };
        const frames = a.effect?.getKeyframes?.();
        if (frames?.length) {
            info.keyframes = frames.slice(0, 6).map((f) =>
                Object.fromEntries(
                    Object.entries(f)
                        .filter(([k, v]) => !SKIP_KEYFRAME.has(k) && v !== null && v !== undefined)
                        .slice(0, 6)
                        .map(([k, v]) => [k, typeof v === "number" ? v : String(v)])
                )
            );
        }
        out.push(info);
    }
    return out;
}
