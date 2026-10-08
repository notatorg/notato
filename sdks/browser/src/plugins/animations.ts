import type { CapturePlugin } from "@notato/core";

/** The browser's own animation object (CSS animations and transitions, and Web Animations), as much of it as is read. */
interface Anim {
    playState: string;
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

/**
 * Records what is animating on the annotated elements, and how far along each animation is, which is what "too slow"
 * or "it jumps" is about. Freezing the page first (Pause) makes the progress the moment the person was looking at.
 */
export function animationsPlugin(): CapturePlugin {
    return {
        id: "animations",
        async capture(draft) {
            const seen = draft.elements.flatMap((el) => animationsOn(el));
            return seen.length ? { context: { animations: seen } } : undefined;
        },
    };
}
