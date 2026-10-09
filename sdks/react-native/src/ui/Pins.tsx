import { memo, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, Pressable, StyleSheet, type View } from "react-native";
import type { NotatoController } from "../controller.ts";
import { appElements, commitCount, watchApp } from "../inspect.ts";
import type { NumberedNote } from "../notes.ts";
import { indexOf, query, selectorToFind } from "../selectors.ts";
import { measure, type TreeElement } from "../tree.ts";
import { INSETS, onScreen, type Point, toRect } from "./geometry.ts";
import { animate, fadeSlide, useReducedMotion } from "./motion.ts";
import { PinDot } from "./parts.tsx";
import { placePins } from "./pinLayout.ts";
import { PinTracker, type PlacedPin } from "./pinTracker.ts";

/** The most pins drawn on one screen: the newest. The Notes list has every one. */
const MAX_PINS = 150;

/** Of the views a pin's selector finds (a list's rows, say), how many are measured to find the nearest. */
const MAX_CANDIDATES = 12;

/**
 * A screen's pins, on their elements, in a layer of their own: placing them draws this layer and nothing else of
 * Notato's. While `shown`, a `PinTracker` keeps them in place; while `paused` (a sheet is over them), it stops
 * looking and leaves them where they are.
 */
export const PinLayer = memo(function PinLayer(props: {
    notato: NotatoController;
    app: RefObject<View | null>;
    /** The screen's notes that get a pin. */
    pinnable: readonly NumberedNote[];
    shown: boolean;
    paused: boolean;
    /** Where the overlay is on the page. */
    origin(): Promise<Point>;
    size: { width: number; height: number };
    onOpen(id: string): void;
}) {
    const { notato, app, origin, size } = props;
    const [pins, setPins] = useState<PlacedPin[]>([]);
    const notes = useMemo(() => props.pinnable.slice(-MAX_PINS), [props.pinnable]);
    // Read as the tracker goes, so a new size does not make a new tracker.
    const sizeRef = useRef(size);
    sizeRef.current = size;
    const [tracker] = useState(
        () =>
            new PinTracker<TreeElement>({
                find: (list) => {
                    const elements = appElements(app.current, notato.maskInputs);
                    const index = indexOf(elements);
                    const found = new Map<string, TreeElement[]>();
                    for (const { record } of list) {
                        const identity = record.annotation.target.identity[0];
                        let views: TreeElement[] = [];
                        if (identity) {
                            try {
                                views = query(elements, selectorToFind(identity), index).slice(
                                    0,
                                    MAX_CANDIDATES
                                );
                            } catch {
                                // a selector this SDK cannot read: the pin stays where the note was made
                            }
                        }
                        found.set(record.annotation.id, views);
                    }
                    return found;
                },
                measurer: async () => {
                    // Listens through React's DevTools hook again if something took its place.
                    commitCount();
                    const at = await origin();
                    return async (element) => {
                        const frame = await measure(element.fiber);
                        return frame ? toRect(frame, at) : null;
                    };
                },
                onScreen: (rect) => onScreen(rect, sizeRef.current),
                show: setPins,
            })
    );

    // The app's own commits, not Notato's, are what can move its views.
    useEffect(() => {
        const stop = watchApp(
            () => app.current,
            () => tracker.appChanged()
        );
        tracker.commitsKnown = stop !== undefined;
        return stop;
    }, [app, tracker]);

    useEffect(() => tracker.setNotes(notes), [tracker, notes]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new size moves everything
    useEffect(() => tracker.invalidate(), [tracker, size]);

    // Nothing is looked at while the app is in the background.
    const [foreground, setForeground] = useState(AppState.currentState !== "background");
    useEffect(() => {
        const subscription = AppState.addEventListener("change", (s) =>
            setForeground(s === "active")
        );
        return () => subscription.remove();
    }, []);

    // Going, the layer fades out first and the pins are let go of after.
    const layer = useRef(new Animated.Value(props.shown ? 1 : 0)).current;
    const active = props.shown && notes.length > 0;
    useEffect(() => {
        if (!active) {
            animate(layer, 0).start(({ finished }) => {
                if (finished) tracker.stop();
            });
            return;
        }
        animate(layer, 1).start();
        if (props.paused || !foreground) tracker.pause();
        else tracker.start();
    }, [active, props.paused, foreground, tracker, layer]);
    useEffect(() => () => tracker.stop(), [tracker]);

    const spots = useMemo(
        () =>
            placePins(
                pins.map((p) => p.rect),
                size.width,
                INSETS.top - 9
            ),
        [pins, size.width]
    );

    if (!pins.length) return null;
    return (
        <Animated.View
            style={[StyleSheet.absoluteFill, { opacity: layer }]}
            pointerEvents={props.shown ? "box-none" : "none"}
        >
            {pins.map((pin, i) => (
                <PinMarker
                    key={pin.record.annotation.id}
                    pin={pin}
                    x={spots[i]?.x ?? pin.rect.x}
                    y={spots[i]?.y ?? pin.rect.y}
                    onOpen={props.onOpen}
                />
            ))}
        </Animated.View>
    );
});

/** A pin: it grows in where it first appears, and fades while its element moves. */
const PinMarker = memo(function PinMarker({
    pin,
    x,
    y,
    onOpen,
}: {
    pin: PlacedPin;
    x: number;
    y: number;
    onOpen(id: string): void;
}) {
    const still = useReducedMotion();
    const appear = useRef(new Animated.Value(0)).current;
    const steady = useRef(new Animated.Value(pin.moving ? 0 : 1)).current;
    useEffect(() => {
        animate(appear, 1).start();
    }, [appear]);
    useEffect(() => {
        animate(steady, pin.moving ? 0 : 1).start();
    }, [pin.moving, steady]);
    const opacity = useMemo(() => Animated.multiply(appear, steady), [appear, steady]);
    const { transform } = useMemo(() => fadeSlide(appear, still, { scale: 0.4 }), [appear, still]);
    const a = pin.record.annotation;
    return (
        <Animated.View
            style={[styles.pin, { left: x, top: y, opacity, transform }]}
            pointerEvents={pin.moving ? "none" : "auto"}
        >
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Note ${pin.number}, ${a.status.replace(/_/g, " ")}`}
                onPress={() => onOpen(a.id)}
                hitSlop={6}
                style={pin.detached ? styles.detached : null}
            >
                <PinDot number={pin.number} status={a.status} pending={pin.record.pending} />
            </Pressable>
        </Animated.View>
    );
});

const styles = StyleSheet.create({
    pin: { position: "absolute" },
    detached: { opacity: 0.55 },
});
