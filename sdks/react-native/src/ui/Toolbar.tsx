import { useEffect, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, Text, View } from "react-native";
import { Icon, Potato } from "./parts.tsx";
import { BAR, BRAND } from "./theme.ts";

const HEIGHT = 54;
const MARGIN = 12;

export interface ToolbarProps {
    /** The room the toolbar moves in, and how far from each edge it keeps. */
    room: { width: number; height: number; top: number; bottom: number };
    /** Where it was left, as fractions of that room; the configured corner until then. */
    place: { x?: number; y?: number };
    corner: "bottom-right" | "bottom-left" | "top-right" | "top-left";
    folded: boolean;
    annotating: boolean;
    count: number;
    /** A dot on ⋯ (or the folded button) while connecting, or when the server cannot be reached. */
    problem?: string;
    problemLabel?: string;
    onAnnotate(): void;
    onMenu(): void;
    onFold(folded: boolean): void;
    onMoved(x: number, y: number): void;
}

const countText = (n: number) => (n > 99 ? "99+" : String(n));

/**
 * The toolbar: grip, Annotate with the count of notes on this screen, ⋯ and the chevron that folds it into a round
 * button with the potato. The whole bar drags; where it is left is kept.
 */
export function Toolbar(props: ToolbarProps) {
    const [openWidth, setOpenWidth] = useState(252);
    const width = props.folded ? HEIGHT : openWidth;
    const { room } = props;
    const spanX = Math.max(0, room.width - width - MARGIN * 2);
    const spanY = Math.max(0, room.height - room.top - room.bottom - HEIGHT);
    const fx = props.place.x ?? (props.corner.endsWith("right") ? 1 : 0);
    const fy = props.place.y ?? (props.corner.startsWith("bottom") ? 1 : 0);
    const left = MARGIN + fx * spanX;
    const top = room.top + fy * spanY;
    // Held to the side it is nearest, so it folds and opens towards the middle.
    const heldRight = fx > 0.5;

    const drag = useRef(new Animated.ValueXY()).current;
    const latest = useRef({ left, top, spanX, spanY, width, room });
    latest.current = { left, top, spanX, spanY, width, room };
    const moved = useRef(props.onMoved);
    moved.current = props.onMoved;
    const pan = useRef(
        PanResponder.create({
            onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
            onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
            onPanResponderMove: Animated.event([null, { dx: drag.x, dy: drag.y }], {
                useNativeDriver: false,
            }),
            onPanResponderRelease: (_, g) => {
                const l = latest.current;
                const x = l.spanX
                    ? Math.min(1, Math.max(0, (l.left + g.dx - MARGIN) / l.spanX))
                    : 0;
                const y = l.spanY
                    ? Math.min(1, Math.max(0, (l.top + g.dy - l.room.top) / l.spanY))
                    : 0;
                drag.setValue({ x: 0, y: 0 });
                moved.current(x, y);
            },
            onPanResponderTerminate: () => drag.setValue({ x: 0, y: 0 }),
        })
    ).current;

    // A fold or an opening fades the bar's parts across.
    const fade = useRef(new Animated.Value(1)).current;
    // biome-ignore lint/correctness/useExhaustiveDependencies: runs each time the bar folds or opens
    useEffect(() => {
        fade.setValue(0.3);
        Animated.timing(fade, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    }, [props.folded, fade]);

    const dot = props.problem;
    return (
        <Animated.View
            {...pan.panHandlers}
            style={{
                position: "absolute",
                left,
                top,
                height: HEIGHT,
                width: props.folded ? HEIGHT : undefined,
                borderRadius: props.folded ? HEIGHT / 2 : 16,
                backgroundColor: BAR.bar,
                borderWidth: 1,
                borderColor: BAR.line,
                shadowColor: "#0f1114",
                shadowOpacity: 0.45,
                shadowRadius: 14,
                shadowOffset: { width: 0, height: 10 },
                elevation: 12,
                transform: drag.getTranslateTransform(),
            }}
        >
            {props.folded ? (
                <Pressable
                    onPress={() => props.onFold(false)}
                    accessibilityRole="button"
                    accessibilityLabel="Show the Notato toolbar"
                    accessibilityValue={
                        props.count ? { text: `${props.count} on this screen` } : undefined
                    }
                    style={{
                        width: HEIGHT - 2,
                        height: HEIGHT - 2,
                        alignItems: "center",
                        justifyContent: "center",
                    }}
                >
                    <Animated.View style={{ opacity: fade }}>
                        <Potato size={40} />
                    </Animated.View>
                    {props.count > 0 ? (
                        <View
                            style={{
                                position: "absolute",
                                top: -8,
                                right: -8,
                                padding: 2,
                                borderRadius: 999,
                                backgroundColor: BAR.bar,
                            }}
                        >
                            <Text
                                style={{
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
                                }}
                            >
                                {countText(props.count)}
                            </Text>
                        </View>
                    ) : null}
                    {dot ? (
                        <View
                            style={{
                                position: "absolute",
                                left: -2,
                                bottom: -2,
                                padding: 2,
                                borderRadius: 999,
                                backgroundColor: BAR.bar,
                            }}
                        >
                            <View
                                style={{
                                    width: 10,
                                    height: 10,
                                    borderRadius: 5,
                                    backgroundColor: dot,
                                }}
                            />
                        </View>
                    ) : null}
                </Pressable>
            ) : (
                <Animated.View
                    onLayout={(e) => {
                        const w = Math.round(e.nativeEvent.layout.width) + 2;
                        if (Math.abs(w - openWidth) > 1) setOpenWidth(w);
                    }}
                    style={{
                        flexDirection: "row",
                        alignItems: "center",
                        padding: 4,
                        gap: 2,
                        opacity: fade,
                    }}
                >
                    <View
                        style={{
                            width: 20,
                            height: 44,
                            alignItems: "center",
                            justifyContent: "center",
                        }}
                    >
                        <Icon name="grip" size={14} color={BAR.muted} />
                    </View>
                    <Pressable
                        onPress={props.onAnnotate}
                        accessibilityRole="button"
                        accessibilityLabel="Annotate"
                        accessibilityState={{ selected: props.annotating }}
                        accessibilityValue={{ text: `${props.count} on this screen` }}
                        testID="NotatoAnnotate"
                        style={({ pressed }) => ({
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 8,
                            height: 44,
                            paddingLeft: 12,
                            paddingRight: 10,
                            borderRadius: 12,
                            backgroundColor: props.annotating
                                ? BAR.accent
                                : pressed
                                  ? BAR.pressed
                                  : "transparent",
                        })}
                    >
                        <Icon
                            name="crosshair"
                            size={18}
                            color={props.annotating ? BAR.onAccent : BAR.text}
                        />
                        <Text
                            style={{
                                fontSize: 15,
                                fontWeight: "700",
                                color: props.annotating ? BAR.onAccent : BAR.text,
                            }}
                        >
                            Annotate
                        </Text>
                        <Text
                            style={{
                                minWidth: 22,
                                paddingHorizontal: 7,
                                paddingVertical: 1,
                                borderRadius: 999,
                                overflow: "hidden",
                                textAlign: "center",
                                fontSize: 12.5,
                                fontWeight: "700",
                                fontVariant: ["tabular-nums"],
                                color: props.annotating ? BAR.onAccent : BAR.text,
                                backgroundColor: props.annotating
                                    ? "rgba(11,31,27,0.16)"
                                    : BAR.pressed,
                            }}
                        >
                            {countText(props.count)}
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={props.onMenu}
                        accessibilityRole="button"
                        accessibilityLabel="Notato menu"
                        accessibilityValue={dot ? { text: props.problemLabel ?? "" } : undefined}
                        testID="NotatoMenu"
                        style={({ pressed }) => ({
                            width: 44,
                            height: 44,
                            borderRadius: 12,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: pressed ? BAR.pressed : "transparent",
                        })}
                    >
                        <Icon name="more" size={18} color={BAR.text} />
                        {dot ? (
                            <View
                                style={{
                                    position: "absolute",
                                    top: 9,
                                    right: 9,
                                    width: 8,
                                    height: 8,
                                    borderRadius: 4,
                                    borderWidth: 1.5,
                                    borderColor: BAR.bar,
                                    backgroundColor: dot,
                                }}
                            />
                        ) : null}
                    </Pressable>
                    <Pressable
                        onPress={() => props.onFold(true)}
                        accessibilityRole="button"
                        accessibilityLabel="Collapse the toolbar"
                        style={({ pressed }) => ({
                            width: 28,
                            height: 44,
                            borderRadius: 12,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: pressed ? BAR.pressed : "transparent",
                        })}
                    >
                        <Icon
                            name={heldRight ? "chevronRight" : "chevronLeft"}
                            size={16}
                            color={BAR.muted}
                        />
                    </Pressable>
                </Animated.View>
            )}
        </Animated.View>
    );
}

/** The hint at the top while annotating. */
export function HintBar({ done }: { done(): void }) {
    return (
        <View
            style={{
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
            }}
        >
            <Text style={{ fontSize: 14, fontWeight: "600", color: BAR.text }}>
                Tap what you want to comment on
            </Text>
            <Pressable
                onPress={done}
                accessibilityRole="button"
                hitSlop={8}
                style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: BAR.accent,
                }}
            >
                <Text style={{ fontSize: 14, fontWeight: "700", color: BAR.onAccent }}>Done</Text>
            </Pressable>
        </View>
    );
}

export const PROBLEM_DOT = {
    connecting: BRAND.connecting,
    offline: BRAND.offline,
    refused: BRAND.offline,
} as const;
