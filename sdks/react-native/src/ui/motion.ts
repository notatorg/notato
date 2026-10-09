// How Notato's pieces come and go: the same timings as the other SDKs, run by the native driver so the app's own work
// on the JavaScript thread cannot make them stutter.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";

/** How long Notato's pieces take to come in and go: quick, so they never hold the person up. */
export const ENTER_MS = 240;
export const LEAVE_MS = 180;
/** A sheet's content giving way to the next, and the next coming in. */
export const SWAP_OUT_MS = 90;
export const SWAP_IN_MS = 160;
/** Under Reduce Motion: pieces fade in place, and nearly at once. */
const REDUCED_MS = 80;

/** Coming in slows to a stop; going speeds away. */
export const ENTER_EASING = Easing.out(Easing.cubic);
export const LEAVE_EASING = Easing.in(Easing.cubic);

// Whether the person asked for less motion (iOS's Reduce Motion, Android's Remove animations), asked once and kept.
let reduced = false;
let asked = false;
const listeners = new Set<() => void>();
function setReduced(value: boolean) {
    if (value === reduced) return;
    reduced = value;
    for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void) {
    if (!asked) {
        asked = true;
        AccessibilityInfo.isReduceMotionEnabled?.().then(setReduced, () => undefined);
        AccessibilityInfo.addEventListener?.("reduceMotionChanged", setReduced);
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Whether to keep still: pieces then fade in place instead of sliding or growing. */
export const useReducedMotion = () => useSyncExternalStore(subscribe, () => reduced);
export const reducedMotion = () => reduced;

/** Runs `value` to `toValue` on the native driver: coming in when it rises, going when it falls. */
export function animate(
    value: Animated.Value,
    toValue: number,
    options: { duration?: number; easing?: (t: number) => number } = {}
): Animated.CompositeAnimation {
    const entering = toValue > 0;
    return Animated.timing(value, {
        toValue,
        duration: reduced ? REDUCED_MS : (options.duration ?? (entering ? ENTER_MS : LEAVE_MS)),
        easing: options.easing ?? (entering ? ENTER_EASING : LEAVE_EASING),
        useNativeDriver: true,
        isInteraction: false,
    });
}

/**
 * Shows a piece while `value` is there, and keeps the last one on screen while it leaves once `value` is null.
 * `progress` runs from 0 (gone) to 1 (there) on the native driver; `leaving` is true while it goes, when it takes no
 * taps.
 */
export function usePresence<T>(value: T | null): {
    shown: T | null;
    progress: Animated.Value;
    leaving: boolean;
} {
    const progress = useRef(new Animated.Value(0)).current;
    const last = useRef<T | null>(value);
    if (value !== null) last.current = value;
    const present = value !== null;
    const [gone, setGone] = useState(!present);
    const there = useRef(false);
    // Started as the change commits, so it is on its way before anything else the JavaScript thread does.
    useLayoutEffect(() => {
        if (present) {
            there.current = true;
            setGone(false);
            animate(progress, 1).start();
            return;
        }
        if (!there.current) return;
        there.current = false;
        animate(progress, 0).start(({ finished }) => {
            if (!finished) return;
            last.current = null;
            setGone(true);
        });
    }, [present, progress]);
    useEffect(() => () => progress.stopAnimation(), [progress]);
    return {
        shown: present ? value : gone ? null : last.current,
        progress,
        leaving: !present,
    };
}

/** A piece's opacity and a little travel (points, from where it rests) as it comes in: none under Reduce Motion. */
export function fadeSlide(
    progress: Animated.Value,
    still: boolean,
    from: { x?: number; y?: number; scale?: number }
) {
    const transform: Array<
        | { translateX: Animated.AnimatedInterpolation<number> }
        | { translateY: Animated.AnimatedInterpolation<number> }
        | { scale: Animated.AnimatedInterpolation<number> }
    > = [];
    if (!still && from.x)
        transform.push({
            translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [from.x, 0] }),
        });
    if (!still && from.y)
        transform.push({
            translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [from.y, 0] }),
        });
    if (!still && from.scale !== undefined)
        transform.push({
            scale: progress.interpolate({ inputRange: [0, 1], outputRange: [from.scale, 1] }),
        });
    return { opacity: progress, transform };
}
