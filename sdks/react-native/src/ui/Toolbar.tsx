import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import type { ToolbarCorner } from "../config.ts";
import {
    animate,
    ENTER_EASING,
    ENTER_MS,
    fadeSlide,
    reducedMotion,
    useReducedMotion,
} from "./motion.ts";
import { Icon, Potato } from "./parts.tsx";
import { BAR } from "./theme.ts";

/** The bar's height, and the folded button's size. */
const HEIGHT = 54;
/** How far it keeps from the screen's sides. */
const MARGIN = 12;
/** The open bar's width until it has been laid out and measured. */
const OPEN_WIDTH = 252;
/** How far a finger moves before a touch is a drag rather than a tap. */
const DRAG_SLOP = 6;
/** The open bar's corners, and the width at which they have rounded into the folded button's circle. */
const RADIUS = 16;
const ROUND_BY = HEIGHT + 24;

/**
 * The open bar's width as it was last laid out, kept for as long as the app runs: a toolbar mounted again (Notato
 * switched off and on) opens at its width, and does not jump once it is measured.
 */
let openWidthSeen = OPEN_WIDTH;

export interface ToolbarProps {
    /** The room the toolbar moves in, and how far from each edge it keeps. */
    room: { width: number; height: number; top: number; bottom: number };
    /** Where it was left, as fractions of that room; the configured corner until then. */
    place: { x?: number; y?: number };
    corner: ToolbarCorner;
    folded: boolean;
    /** Hidden (the composer is open, or it was hidden from the menu): it fades out, and takes no taps. */
    visible: boolean;
    annotating: boolean;
    /** The notes on this screen. */
    count: number;
    /** The colour of a dot on ⋯ (or the folded button) while connecting, or when the server cannot be reached. */
    problem?: string;
    /** What the dot means, for screen readers. */
    problemLabel?: string;
    onAnnotate(): void;
    onMenu(): void;
    /** Folds or opens it; `x` is where it now is across the room, when that changed to keep its edge in place. */
    onFold(folded: boolean, x?: number): void;
    onMoved(x: number, y: number): void;
}

const countText = (n: number) => (n > 99 ? "99+" : String(n));
const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** Moves the bar's place or width, on the JavaScript driver: a width is layout, which the native driver cannot run. */
const glide = (value: Animated.Value, toValue: number, duration = ENTER_MS) =>
    Animated.timing(value, {
        toValue,
        duration: reducedMotion() ? 0 : duration,
        easing: ENTER_EASING,
        useNativeDriver: false,
        isInteraction: false,
    });

/** Where a bar of `width` goes in the room, from where it was left. */
function placeOf(props: Pick<ToolbarProps, "room" | "place" | "corner">, width: number) {
    const { room } = props;
    const spanX = Math.max(0, room.width - width - MARGIN * 2);
    const spanY = Math.max(0, room.height - room.top - room.bottom - HEIGHT);
    const fx = props.place.x ?? (props.corner.endsWith("right") ? 1 : 0);
    const fy = props.place.y ?? (props.corner.startsWith("bottom") ? 1 : 0);
    return { left: MARGIN + fx * spanX, top: room.top + fy * spanY, spanX, spanY, fx };
}

/**
 * The toolbar: grip, Annotate with the count of notes on this screen, ⋯ and the chevron that folds it into a round
 * button with the potato. The whole bar drags; where it is left is kept.
 *
 * Where it is and how wide are animated together on the JavaScript driver (a width is layout, which the native driver
 * cannot run), so the edge it is held by stays where it is while it folds and opens. Its coming and going and its
 * contents' fades run on the native driver, a layer inside.
 */
export const Toolbar = memo(function Toolbar(props: ToolbarProps) {
    const still = useReducedMotion();
    const [openWidth, setOpenWidth] = useState(openWidthSeen);
    const width = props.folded ? HEIGHT : openWidth;
    const { left, top, fx } = placeOf(props, width);
    // Held to the side it is nearest, so it folds and opens towards the middle.
    const heldRight = fx > 0.5;

    const x = useRef(new Animated.Value(left)).current;
    const y = useRef(new Animated.Value(top)).current;
    const w = useRef(new Animated.Value(width)).current;
    const radius = useMemo(
        () =>
            w.interpolate({
                inputRange: [HEIGHT, ROUND_BY],
                outputRange: [HEIGHT / 2, RADIUS],
                extrapolate: "clamp",
            }),
        [w]
    );
    // Where it is headed: a release sets it before the new place comes back as props, so that is not animated twice.
    const target = useRef({ left, top, width });
    const dragging = useRef(false);
    useEffect(() => {
        const t = target.current;
        if (dragging.current || (t.left === left && t.top === top && t.width === width)) return;
        target.current = { left, top, width };
        Animated.parallel([glide(x, left), glide(y, top), glide(w, width)]).start();
    }, [left, top, width, x, y, w]);

    // The pan responder is made once: it reads where the bar is, and who to tell, through these.
    const latest = useRef({ props, width });
    latest.current = { props, width };
    const pan = useRef(
        (() => {
            const from = { x: 0, y: 0 };
            return PanResponder.create({
                onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > DRAG_SLOP,
                onMoveShouldSetPanResponderCapture: (_, g) =>
                    Math.abs(g.dx) + Math.abs(g.dy) > DRAG_SLOP,
                onPanResponderGrant: () => {
                    dragging.current = true;
                    x.stopAnimation((v) => {
                        from.x = v;
                    });
                    y.stopAnimation((v) => {
                        from.y = v;
                    });
                },
                onPanResponderMove: (_, g) => {
                    x.setValue(from.x + g.dx);
                    y.setValue(from.y + g.dy);
                },
                onPanResponderRelease: (_, g) => {
                    dragging.current = false;
                    const { props: p, width: wide } = latest.current;
                    const { spanX, spanY } = placeOf(p, wide);
                    const nx = spanX ? clamp((from.x + g.dx - MARGIN) / spanX) : 0;
                    const ny = spanY ? clamp((from.y + g.dy - p.room.top) / spanY) : 0;
                    // It settles where it was let go of (kept in the room) from where it is: no jump back first,
                    // and the place that comes back as props is where it is already going.
                    const to = { left: MARGIN + nx * spanX, top: p.room.top + ny * spanY };
                    target.current = { ...to, width: wide };
                    Animated.parallel([glide(x, to.left, 200), glide(y, to.top, 200)]).start();
                    p.onMoved(nx, ny);
                },
                onPanResponderTerminate: () => {
                    dragging.current = false;
                    const t = target.current;
                    Animated.parallel([glide(x, t.left, 200), glide(y, t.top, 200)]).start();
                },
            });
        })()
    ).current;

    /** Folds or opens it with the edge it is held by kept where it is: its place across the room is moved to match. */
    const fold = (folded: boolean) => {
        const next = folded ? HEIGHT : openWidthSeen;
        const nextSpan = Math.max(0, props.room.width - next - MARGIN * 2);
        const edge = heldRight ? left + width : left;
        const nx = nextSpan ? clamp(((heldRight ? edge - next : edge) - MARGIN) / nextSpan) : 0;
        props.onFold(folded, Math.abs(nx - fx) > 1e-6 ? nx : undefined);
    };

    // Coming and going, on the native driver.
    const shown = useRef(new Animated.Value(props.visible ? 1 : 0)).current;
    useEffect(() => {
        animate(shown, props.visible ? 1 : 0).start();
    }, [props.visible, shown]);
    const presence = useMemo(() => fadeSlide(shown, still, { scale: 0.85 }), [shown, still]);

    // A fold or an opening fades the bar's parts across.
    const fade = useRef(new Animated.Value(1)).current;
    // biome-ignore lint/correctness/useExhaustiveDependencies: runs each time the bar folds or opens
    useEffect(() => {
        fade.setValue(0.3);
        animate(fade, 1, { duration: 160 }).start();
    }, [props.folded, fade]);

    const dot = props.problem;
    const tint = props.annotating ? BAR.onAccent : BAR.text;
    return (
        <Animated.View
            {...pan.panHandlers}
            pointerEvents={props.visible ? "auto" : "none"}
            accessibilityElementsHidden={!props.visible}
            importantForAccessibility={props.visible ? "auto" : "no-hide-descendants"}
            style={[styles.place, { width: w, transform: [{ translateX: x }, { translateY: y }] }]}
        >
            <Animated.View style={[styles.fill, presence]}>
                <Animated.View style={[styles.bar, { borderRadius: radius }]}>
                    <Animated.View style={[styles.clip, { borderRadius: radius }]}>
                        {props.folded ? (
                            <Pressable
                                onPress={() => fold(false)}
                                accessibilityRole="button"
                                accessibilityLabel="Show the Notato toolbar"
                                accessibilityValue={
                                    props.count
                                        ? { text: `${props.count} on this screen` }
                                        : undefined
                                }
                                style={styles.folded}
                            >
                                <Animated.View style={{ opacity: fade }}>
                                    <Potato size={40} />
                                </Animated.View>
                            </Pressable>
                        ) : (
                            // Laid out at its own width, whatever the bar's is as it opens; the bar shows what fits.
                            <View style={[styles.track, heldRight ? styles.right : styles.left]}>
                                <Animated.View
                                    onLayout={(e) => {
                                        const wide = Math.round(e.nativeEvent.layout.width) + 2;
                                        openWidthSeen = wide;
                                        if (Math.abs(wide - openWidth) > 1) setOpenWidth(wide);
                                    }}
                                    style={[styles.open, { opacity: fade }]}
                                >
                                    <View style={styles.grip}>
                                        <Icon name="grip" size={14} color={BAR.muted} />
                                    </View>
                                    <Pressable
                                        onPress={props.onAnnotate}
                                        accessibilityRole="button"
                                        accessibilityLabel="Annotate"
                                        accessibilityState={{ selected: props.annotating }}
                                        accessibilityValue={{
                                            text: `${props.count} on this screen`,
                                        }}
                                        testID="NotatoAnnotate"
                                        style={({ pressed }) => [
                                            styles.annotate,
                                            {
                                                backgroundColor: props.annotating
                                                    ? BAR.accent
                                                    : pressed
                                                      ? BAR.pressed
                                                      : "transparent",
                                            },
                                        ]}
                                    >
                                        <Icon name="crosshair" size={18} color={tint} />
                                        <Text style={[styles.annotateText, { color: tint }]}>
                                            Annotate
                                        </Text>
                                        <Text
                                            style={[
                                                styles.count,
                                                {
                                                    color: tint,
                                                    backgroundColor: props.annotating
                                                        ? "rgba(11,31,27,0.16)"
                                                        : BAR.pressed,
                                                },
                                            ]}
                                        >
                                            {countText(props.count)}
                                        </Text>
                                    </Pressable>
                                    <Pressable
                                        onPress={props.onMenu}
                                        accessibilityRole="button"
                                        accessibilityLabel="Notato menu"
                                        accessibilityValue={
                                            dot ? { text: props.problemLabel ?? "" } : undefined
                                        }
                                        testID="NotatoMenu"
                                        style={({ pressed }) => [
                                            styles.menu,
                                            pressed ? styles.pressed : null,
                                        ]}
                                    >
                                        <Icon name="more" size={18} color={BAR.text} />
                                        {dot ? (
                                            <View
                                                style={[styles.menuDot, { backgroundColor: dot }]}
                                            />
                                        ) : null}
                                    </Pressable>
                                    <Pressable
                                        onPress={() => fold(true)}
                                        accessibilityRole="button"
                                        accessibilityLabel="Collapse the toolbar"
                                        style={({ pressed }) => [
                                            styles.fold,
                                            pressed ? styles.pressed : null,
                                        ]}
                                    >
                                        <Icon
                                            name={heldRight ? "chevronRight" : "chevronLeft"}
                                            size={16}
                                            color={BAR.muted}
                                        />
                                    </Pressable>
                                </Animated.View>
                            </View>
                        )}
                    </Animated.View>
                </Animated.View>
                {/* Outside the clip: they sit over the button's edge. */}
                {props.folded && props.count > 0 ? (
                    <View style={styles.badgeRing} pointerEvents="none">
                        <Text style={styles.badge}>{countText(props.count)}</Text>
                    </View>
                ) : null}
                {props.folded && dot ? (
                    <View style={styles.foldedDotRing} pointerEvents="none">
                        <View style={[styles.foldedDot, { backgroundColor: dot }]} />
                    </View>
                ) : null}
            </Animated.View>
        </Animated.View>
    );
});

/** The hint at the top while annotating. */
export function HintBar({ done }: { done(): void }) {
    return (
        <View style={styles.hint}>
            <Text style={styles.hintText}>Tap what you want to comment on</Text>
            <Pressable onPress={done} accessibilityRole="button" hitSlop={8} style={styles.done}>
                <Text style={styles.doneText}>Done</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    place: { position: "absolute", left: 0, top: 0, height: HEIGHT },
    fill: { flex: 1 },
    bar: {
        flex: 1,
        backgroundColor: BAR.bar,
        borderWidth: 1,
        borderColor: BAR.line,
        shadowColor: "#0f1114",
        shadowOpacity: 0.45,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 10 },
        elevation: 12,
    },
    clip: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, overflow: "hidden" },
    track: {
        position: "absolute",
        top: 0,
        bottom: 0,
        width: 600,
        flexDirection: "row",
        alignItems: "center",
    },
    left: { left: 0, justifyContent: "flex-start" },
    right: { right: 0, justifyContent: "flex-end" },
    pressed: { backgroundColor: BAR.pressed },
    folded: {
        width: HEIGHT - 2,
        height: HEIGHT - 2,
        alignItems: "center",
        justifyContent: "center",
    },
    badgeRing: {
        position: "absolute",
        top: -8,
        right: -8,
        padding: 2,
        borderRadius: 999,
        backgroundColor: BAR.bar,
    },
    badge: {
        minWidth: 18,
        height: 18,
        lineHeight: 18,
        paddingHorizontal: 5,
        borderRadius: 9,
        overflow: "hidden",
        textAlign: "center",
        fontSize: 11,
        fontWeight: "800",
        color: BAR.onAccent,
        backgroundColor: BAR.accent,
    },
    foldedDotRing: {
        position: "absolute",
        left: -2,
        bottom: -2,
        padding: 2,
        borderRadius: 999,
        backgroundColor: BAR.bar,
    },
    foldedDot: { width: 10, height: 10, borderRadius: 5 },
    open: { flexDirection: "row", alignItems: "center", padding: 4, gap: 2 },
    grip: { width: 20, height: 44, alignItems: "center", justifyContent: "center" },
    annotate: {
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        height: 44,
        paddingLeft: 12,
        paddingRight: 10,
        borderRadius: 12,
    },
    annotateText: { fontSize: 15, fontWeight: "700" },
    count: {
        minWidth: 22,
        paddingHorizontal: 7,
        paddingVertical: 1,
        borderRadius: 999,
        overflow: "hidden",
        textAlign: "center",
        fontSize: 12.5,
        fontWeight: "700",
        fontVariant: ["tabular-nums"],
    },
    menu: {
        width: 44,
        height: 44,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
    },
    menuDot: {
        position: "absolute",
        top: 9,
        right: 9,
        width: 8,
        height: 8,
        borderRadius: 4,
        borderWidth: 1.5,
        borderColor: BAR.bar,
    },
    fold: {
        width: 28,
        height: 44,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
    },
    hint: {
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingLeft: 16,
        paddingRight: 6,
        paddingVertical: 6,
        borderRadius: 999,
        backgroundColor: BAR.bar,
        borderWidth: 1,
        borderColor: BAR.line,
        shadowColor: "#000",
        shadowOpacity: 0.28,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 10,
    },
    hintText: { fontSize: 14, fontWeight: "600", color: BAR.text },
    done: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 999,
        backgroundColor: BAR.accent,
    },
    doneText: { fontSize: 14, fontWeight: "700", color: BAR.onAccent },
});
