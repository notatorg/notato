import {
    type RefObject,
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
import {
    BackHandler,
    KeyboardAvoidingView,
    PixelRatio,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { routeName } from "../annotation.ts";
import type { Shot } from "../capture.ts";
import { NotatoError } from "../client.ts";
import type { Host, NotatoController, NotatoState } from "../controller.ts";
import { ulid } from "../ids.ts";
import {
    appElements,
    canInspect,
    elementFor,
    inspect,
    instanceAt,
    type Picked,
} from "../inspect.ts";
import { query, SelectorError } from "../selectors.ts";
import { fiberOf, measure, type TreeElement } from "../tree.ts";
import { Composer, type Draft } from "./Composer.tsx";
import { INSETS, onScreen, type Point, type Rect, toRect } from "./geometry.ts";
import { BottomSheet, PinDot } from "./parts.tsx";
import { placePins } from "./pinLayout.ts";
import { backFrom, type Sheet, SheetView } from "./sheets.tsx";
import { HintBar, Toolbar } from "./Toolbar.tsx";
import { BAR, BRAND, PROBLEM_DOT } from "./theme.ts";
import { usePlacedPins } from "./usePins.ts";
import { useScreenshots } from "./useScreenshots.ts";

/** How long a toast stays. */
const TOAST_MS = 3200;

/** How often the screen is looked at, so a move to one that redraws nothing of Notato's is noticed. */
const ROUTE_CHECK_MS = 500;

/** The element a note is being written about, with its pin, its screenshots and what the composer calls it. */
interface Selection {
    picked: Picked;
    rect: Rect;
    pin: number;
    id: string;
    shots: { full?: Shot; crop?: Shot };
    title: string;
    subtitle?: string;
}

/** What a selection is called in the composer: the component and the view, then where it is and what it says. */
function titleOf(element: TreeElement): { title: string; subtitle?: string } {
    const component = element.path[element.path.length - 1];
    const title = component ? `${component} › ${element.tag}` : element.tag;
    const said = element.testId
        ? `#${element.testId}`
        : element.text
          ? `“${element.text.slice(0, 40)}”`
          : element.label;
    const where = element.path.slice(0, -1).slice(-3).join(" › ");
    const subtitle = [said, where].filter(Boolean).join(" · ");
    return subtitle ? { title, subtitle } : { title };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Everything Notato draws over the app, and the host the runtime picks and photographs through. */
export function Overlay(props: {
    notato: NotatoController;
    state: NotatoState;
    /** The view the overlay and the app share. */
    outer: RefObject<View | null>;
    /** The app's own view. */
    app: RefObject<View | null>;
    route: () => string;
}) {
    const { notato, state, outer, app } = props;
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [sheet, setSheet] = useState<Sheet | null>(null);
    const [selection, setSelection] = useState<Selection | null>(null);
    const [toast, flash] = useToast();
    const route = useRoute(props.route);

    /** Where the overlay is on the page, so the page's frames can be drawn on it. */
    const origin = useCallback(async (): Promise<Point> => {
        const fiber = fiberOf(outer.current);
        const frame = fiber ? await measure(fiber) : null;
        return { x: frame?.left ?? 0, y: frame?.top ?? 0 };
    }, [outer]);

    const { capturing, capture } = useScreenshots({ notato, outer, app, origin, size });

    /** Finds an element by selector or view instance, now. */
    const resolve = useCallback(
        async (target: string | object): Promise<Picked> => {
            const elements = appElements(app.current, notato.maskInputs);
            let element: TreeElement | undefined;
            if (typeof target === "string") {
                let found: TreeElement[];
                try {
                    found = query(elements, target);
                } catch (e) {
                    throw new NotatoError(
                        e instanceof SelectorError
                            ? `Not a selector Notato reads: ${e.message}`
                            : String(e)
                    );
                }
                // The first one on screen; else the first laid out at all (scrolled away, say).
                const at = await origin();
                let laidOut: TreeElement | undefined;
                for (const candidate of found) {
                    const frame = await measure(candidate.fiber);
                    if (!frame) continue;
                    laidOut ??= candidate;
                    if (onScreen(toRect(frame, at), size)) {
                        element = candidate;
                        break;
                    }
                }
                element ??= laidOut;
                if (!element) throw new NotatoError(`Nothing on this screen matches "${target}".`);
            } else {
                element = elementFor(elements, target);
                if (!element) throw new NotatoError("That view is not in the app Notato wraps.");
            }
            const picked = await inspect(element);
            if (!picked) throw new NotatoError("That element is not on screen.");
            return picked;
        },
        [app, notato, origin, size]
    );

    /**
     * Makes an element the selection: outlined, photographed, and the composer opened on it. Picking another element
     * while writing keeps the note's pin and id, and what is written.
     */
    const choose = useCallback(
        async (picked: Picked, keep?: Selection | null) => {
            const pin = keep?.pin ?? notato.nextPin(route);
            const id = keep?.id ?? ulid();
            const at = await origin();
            const shots = await capture(picked, pin, id);
            setSheet(null);
            setSelection({
                picked,
                rect: toRect(picked.frame, at),
                pin,
                id,
                shots,
                ...titleOf(picked.element),
            });
        },
        [notato, route, origin, capture]
    );

    // The runtime picks and photographs through this overlay while it is mounted: through a host that stays the same,
    // and calls what this render made.
    const hostRef = useRef<Host | undefined>(undefined);
    hostRef.current = {
        resolve,
        capture,
        select: (picked) => {
            notato.startAnnotating();
            void choose(picked);
        },
        route: () => routeName(props.route()),
        device: () => {
            const version = Platform.constants?.reactNativeVersion;
            return {
                os: Platform.OS,
                osVersion: String(Platform.Version),
                ...(version
                    ? { reactNative: `${version.major}.${version.minor}.${version.patch}` }
                    : {}),
                viewport: { w: size.width, h: size.height },
                dpr: PixelRatio.get(),
            };
        },
        toast: flash,
    };
    useEffect(() => {
        const current = () => hostRef.current as Host;
        const host: Host = {
            resolve: (target) => current().resolve(target),
            capture: (picked, pin, id) => current().capture(picked, pin, id),
            select: (picked) => current().select(picked),
            route: () => current().route(),
            device: () => current().device(),
            toast: (message) => current().toast(message),
        };
        notato.attachHost(host);
        return () => notato.detachHost(host);
    }, [notato]);

    const pickAt = async (x: number, y: number) => {
        try {
            const instance = await instanceAt(app.current, x, y);
            const element = elementFor(appElements(app.current, notato.maskInputs), instance);
            const picked = element ? await inspect(element) : null;
            if (!picked) {
                flash("Nothing to annotate there.");
                return;
            }
            await choose(picked, selection);
        } catch (e) {
            flash(`Could not select that: ${messageOf(e)}`);
        }
    };

    /**
     * The composer's Parent: selects the nearest view around the selection that is bigger (a wrapper the same size
     * says nothing new).
     */
    const selectParent = async () => {
        if (!selection) return;
        const f = selection.picked.frame;
        for (let element = selection.picked.element.parent; element; element = element.parent) {
            const picked = await inspect(element);
            if (
                picked &&
                (picked.frame.width > f.width + 0.5 || picked.frame.height > f.height + 0.5)
            ) {
                await choose(picked, selection);
                return;
            }
        }
        flash("Nothing around this one to select.");
    };

    const cancel = useCallback(() => {
        setSelection(null);
        notato.stopAnnotating();
    }, [notato]);

    const send = async (draft: Draft) => {
        if (!selection) return;
        const chosen = selection;
        setSelection(null);
        notato.stopAnnotating();
        try {
            const { problem } = await notato.createNote(chosen.picked, draft, {
                id: chosen.id,
                pin: chosen.pin,
                ...chosen.shots,
            });
            flash(
                problem ??
                    (notato.hasServer ? "Sent" : "Saved on this device. Package it from the menu.")
            );
        } catch (e) {
            flash(`Not saved: ${messageOf(e)}`);
        }
    };

    const startAnnotating = useCallback(() => {
        setSheet(null);
        if (!canInspect()) {
            flash("Annotating needs a development build of the app.");
            return;
        }
        notato.startAnnotating();
    }, [notato, flash]);

    // Annotating stopped from code: drop the selection with it.
    useEffect(() => {
        if (!state.annotating) setSelection(null);
    }, [state.annotating]);

    // Android's Back closes a sheet or the composer, or stops annotating, before it reaches the app.
    const busy = sheet !== null || selection !== null || state.annotating;
    useEffect(() => {
        if (!busy) return;
        const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
            if (sheet) setSheet(backFrom(sheet));
            else cancel();
            return true;
        });
        return () => subscription.remove();
    }, [busy, sheet, cancel]);

    const here = notato.notesOn(route);
    const pinnable = notato.pinsOn(route);
    const pins = usePlacedPins({
        notato,
        app,
        pinnable,
        wanted: state.pinsVisible && !selection && !state.annotating,
        origin,
        size,
    });
    const spots = useMemo(
        () =>
            placePins(
                pins.map((p) => p.rect),
                size.width,
                INSETS.top - 9
            ),
        [pins, size.width]
    );

    const problemDot =
        state.connection === "connecting" ||
        state.connection === "offline" ||
        state.connection === "refused"
            ? PROBLEM_DOT[state.connection]
            : undefined;
    // While a screenshot is taken, nothing of Notato's shows but the outline and the covers.
    const hide = capturing !== null;
    const outline =
        capturing ?? (selection ? { rect: selection.rect, pin: selection.pin, covers: [] } : null);
    // The composer goes where it hides nothing of the selection: above it when it is in the lower half.
    const composerAtTop = selection
        ? selection.rect.y + selection.rect.h / 2 > size.height / 2
        : false;

    return (
        <View
            style={StyleSheet.absoluteFill}
            pointerEvents="box-none"
            onLayout={(e) =>
                setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
            }
        >
            {/* Takes the taps that pick while annotating; Notato's own controls sit above it. */}
            {state.annotating && !sheet ? (
                <View
                    style={StyleSheet.absoluteFill}
                    onStartShouldSetResponder={() => true}
                    onResponderRelease={({ nativeEvent: e }) =>
                        void pickAt(e.locationX, e.locationY)
                    }
                    testID="NotatoPicker"
                />
            ) : null}

            {capturing?.covers.map((c) => (
                <View
                    key={`${c.x},${c.y},${c.w},${c.h}`}
                    pointerEvents="none"
                    style={[styles.cover, { left: c.x, top: c.y, width: c.w, height: c.h }]}
                />
            ))}

            {outline ? (
                <View
                    pointerEvents="none"
                    style={[
                        styles.outline,
                        {
                            left: outline.rect.x - 2,
                            top: outline.rect.y - 2,
                            width: outline.rect.w + 4,
                            height: outline.rect.h + 4,
                        },
                    ]}
                >
                    <View style={styles.outlinePin}>
                        <Text style={styles.pinText}>{outline.pin}</Text>
                    </View>
                </View>
            ) : null}

            <View
                style={[StyleSheet.absoluteFill, hide && styles.hidden]}
                pointerEvents={hide ? "none" : "box-none"}
            >
                {pins.map((pin, i) => {
                    const spot = spots[i] ?? { x: pin.rect.x, y: pin.rect.y };
                    const a = pin.record.annotation;
                    return (
                        <Pressable
                            key={a.id}
                            accessibilityRole="button"
                            accessibilityLabel={`Note ${pin.number}, ${a.status.replace(/_/g, " ")}`}
                            onPress={() => setSheet({ kind: "pin", id: a.id, fromList: false })}
                            hitSlop={6}
                            style={[
                                styles.pin,
                                { left: spot.x, top: spot.y },
                                pin.detached && styles.detached,
                            ]}
                        >
                            <PinDot
                                number={pin.number}
                                status={a.status}
                                pending={pin.record.pending}
                            />
                        </Pressable>
                    );
                })}

                {state.annotating && !selection && !sheet ? (
                    <View style={[styles.hint, { top: INSETS.top - 4 }]} pointerEvents="box-none">
                        <HintBar done={cancel} />
                    </View>
                ) : null}

                {state.toolbarVisible && !selection && size.width > 0 ? (
                    <Toolbar
                        room={{
                            width: size.width,
                            height: size.height,
                            top: INSETS.top,
                            bottom: INSETS.bottom,
                        }}
                        place={state.toolbar}
                        corner={notato.configuration?.toolbarPosition ?? "bottom-right"}
                        folded={state.toolbar.folded}
                        annotating={state.annotating}
                        count={here.length}
                        problem={problemDot}
                        problemLabel={notato.describeConnection()}
                        onAnnotate={() => (state.annotating ? cancel() : startAnnotating())}
                        onMenu={() => setSheet({ kind: "menu" })}
                        onFold={(folded) => notato.setFolded(folded)}
                        onMoved={(x, y) => notato.placeToolbar(x, y)}
                    />
                ) : null}

                {selection ? (
                    <KeyboardAvoidingView
                        behavior="padding"
                        style={[
                            StyleSheet.absoluteFill,
                            styles.composer,
                            composerAtTop
                                ? { justifyContent: "flex-start", paddingTop: INSETS.top }
                                : { justifyContent: "flex-end", paddingBottom: INSETS.bottom },
                        ]}
                        pointerEvents="box-none"
                    >
                        <Composer
                            key={selection.id}
                            title={selection.title}
                            subtitle={selection.subtitle}
                            screenshotsOff={!notato.screenshotsOn}
                            canParent={!!selection.picked.element.parent}
                            onParent={() => void selectParent()}
                            onCancel={cancel}
                            onSend={(draft) => void send(draft)}
                        />
                    </KeyboardAvoidingView>
                ) : null}

                {sheet ? (
                    <KeyboardAvoidingView
                        behavior="padding"
                        style={StyleSheet.absoluteFill}
                        pointerEvents="box-none"
                    >
                        <BottomSheet
                            close={() => setSheet(null)}
                            maxHeight={Math.max(240, size.height - INSETS.top - 16)}
                            top={INSETS.top - 8}
                        >
                            <SheetView
                                sheet={sheet}
                                notato={notato}
                                state={state}
                                here={here}
                                pins={pinnable.length}
                                open={setSheet}
                                annotate={startAnnotating}
                                toast={flash}
                            />
                        </BottomSheet>
                    </KeyboardAvoidingView>
                ) : null}

                {toast ? (
                    <View
                        style={[styles.toastWrap, { top: INSETS.top - 5 }]}
                        pointerEvents="none"
                        accessibilityLiveRegion="polite"
                    >
                        <Text style={styles.toast}>{toast}</Text>
                    </View>
                ) : null}
            </View>
        </View>
    );
}

/** A message shown for a few seconds at the top: the newest replaces the one showing. */
function useToast(): [string | null, (message: string) => void] {
    const [toast, setToast] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const flash = useCallback((message: string) => {
        setToast(message);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setToast(null), TOAST_MS);
    }, []);
    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        []
    );
    return [toast, flash];
}

/**
 * The screen the person is on, as the app names it. It is read as the overlay draws; a move to another screen that
 * redraws nothing of Notato's (one with no pins, say) is noticed by looking twice a second, and drawn then.
 */
function useRoute(read: () => string): string {
    const route = routeName(read());
    const readRef = useRef(read);
    readRef.current = read;
    const drawn = useRef(route);
    drawn.current = route;
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        const timer = setInterval(() => {
            if (routeName(readRef.current()) !== drawn.current) redraw();
        }, ROUTE_CHECK_MS);
        return () => clearInterval(timer);
    }, []);
    return route;
}

const styles = StyleSheet.create({
    cover: { position: "absolute", backgroundColor: BRAND.cover, borderRadius: 4 },
    outline: {
        position: "absolute",
        borderWidth: 2,
        borderColor: BRAND.selection,
        backgroundColor: "rgba(229,72,77,0.08)",
        borderRadius: 4,
    },
    outlinePin: {
        position: "absolute",
        top: -12,
        right: -12,
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: BRAND.selection,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 2,
        borderColor: "#fff",
    },
    pinText: { color: "#fff", fontSize: 12, fontWeight: "800" },
    hidden: { opacity: 0 },
    pin: { position: "absolute" },
    detached: { opacity: 0.55 },
    hint: { position: "absolute", left: 0, right: 0, alignItems: "center" },
    composer: { paddingHorizontal: 10, paddingTop: 10, paddingBottom: 10 },
    toastWrap: { position: "absolute", left: 16, right: 16, alignItems: "center" },
    toast: {
        overflow: "hidden",
        fontSize: 13.5,
        fontWeight: "600",
        textAlign: "center",
        color: BAR.text,
        backgroundColor: BAR.bar,
        borderColor: BAR.line,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 16,
        paddingVertical: 9,
    },
});
