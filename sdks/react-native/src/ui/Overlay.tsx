import {
    type RefObject,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import {
    Animated,
    BackHandler,
    KeyboardAvoidingView,
    LayoutAnimation,
    PixelRatio,
    Platform,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { routeName } from "../annotation.ts";
import { NotatoError } from "../client.ts";
import type { Host, NotatoController } from "../controller.ts";
import { ulid } from "../ids.ts";
import {
    appElements,
    canInspect,
    elementAt,
    elementFor,
    inspect,
    instanceAt,
    type Picked,
} from "../inspect.ts";
import { query, SelectorError } from "../selectors.ts";
import { fiberOf, measure, type TreeElement } from "../tree.ts";
import { Composer, type Draft } from "./Composer.tsx";
import { INSETS, onScreen, type Point, toRect } from "./geometry.ts";
import {
    animate,
    fadeSlide,
    reducedMotion,
    SWAP_IN_MS,
    SWAP_OUT_MS,
    usePresence,
    useReducedMotion,
} from "./motion.ts";
import { PinLayer } from "./Pins.tsx";
import { BottomSheet } from "./parts.tsx";
import type { Stage } from "./Stage.tsx";
import { readShots, type Selection, selectionFor, shotsToSend } from "./selection.ts";
import { backFrom, type Sheet, SheetView } from "./sheets.tsx";
import { HintBar, Toolbar } from "./Toolbar.tsx";
import { BAR, PROBLEM_DOT } from "./theme.ts";
import { useScreenshots } from "./useScreenshots.ts";

/** How long a toast stays. */
const TOAST_MS = 3200;

/** How often the screen is looked at, so a move to one that redraws nothing of Notato's is noticed. */
const ROUTE_CHECK_MS = 500;

/** How far the toast, the hint and the composer travel as they come in. */
const TOP_TRAVEL = -14;
const COMPOSER_TRAVEL = 28;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Which sheet is which: another of them cross-fades in; the same one again only updates. */
const sheetKey = (sheet: Sheet | null) =>
    sheet ? (sheet.kind === "pin" ? `pin:${sheet.id}` : sheet.kind) : null;

/**
 * Everything Notato draws over the app, beside the view the screenshots are of, and the host the runtime picks and
 * photographs through. What goes into a screenshot (the outline and the covers) it draws on `stage`, inside that view.
 */
export function Overlay(props: {
    notato: NotatoController;
    /** The view the stage and the app share: the screenshots are of it. */
    outer: RefObject<View | null>;
    /** The app's own view. */
    app: RefObject<View | null>;
    stage: Stage;
    route: () => string;
}) {
    const { notato, outer, app, stage } = props;
    const state = useSyncExternalStore(notato.subscribe, notato.getState, notato.getState);
    const still = useReducedMotion();
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [sheet, setSheetNow] = useState<Sheet | null>(null);
    const [selection, setSelection] = useState<Selection | null>(null);
    const [toast, flash] = useToast();
    const route = useRoute(props.route);
    // Read by callbacks that stay the same from one draw to the next.
    const now = useRef({ sheet, selection, state });
    now.current = { sheet, selection, state };

    /** Where the overlay is on the page, so the page's frames can be drawn on it. */
    const origin = useCallback(async (): Promise<Point> => {
        const fiber = fiberOf(outer.current);
        const frame = fiber ? await measure(fiber) : null;
        return { x: frame?.left ?? 0, y: frame?.top ?? 0 };
    }, [outer]);

    const capture = useScreenshots({ notato, outer, app, stage, origin, size });

    // The selection's outline is drawn on the stage, into its screenshot, from the commit that opens the composer.
    useLayoutEffect(() => {
        stage.set({
            selected: selection ? { rect: selection.rect, pin: selection.pin } : undefined,
        });
    }, [selection, stage]);
    useEffect(() => () => stage.set({ selected: undefined, capturing: undefined }), [stage]);

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
     * Opens a sheet, or closes it (null). One sheet giving way to another fades its contents out, and the next in,
     * while the sheet takes the new height.
     */
    const contentFade = useRef(new Animated.Value(1)).current;
    const swaps = useRef(0);
    /** The swap whose sheet fades in once it is drawn (elsewhere than iOS, which waits for the new height). */
    const fadeInAfterDraw = useRef<number | null>(null);
    const fadeIn = useCallback(
        (token: number) => {
            // Another sheet asked for meanwhile, or closed: that one stands.
            if (token === swaps.current) animate(contentFade, 1, { duration: SWAP_IN_MS }).start();
        },
        [contentFade]
    );
    const openSheet = useCallback(
        (next: Sheet | null) => {
            const token = ++swaps.current;
            const current = now.current.sheet;
            if (!current || !next || sheetKey(current) === sheetKey(next) || reducedMotion()) {
                contentFade.setValue(1);
                setSheetNow(next);
                return;
            }
            animate(contentFade, 0, { duration: SWAP_OUT_MS }).start(() => {
                if (token !== swaps.current) return;
                // iOS animates the new height natively. Android's layout animations are left out: on the New
                // Architecture they can leave views behind mid-flight, and the fade covers the change well enough.
                // The contents fade in only after: started with the layout animation, the fade is overridden by it and
                // the sheet stays blank.
                if (Platform.OS === "ios") {
                    const duration = SWAP_IN_MS + 60;
                    LayoutAnimation.configureNext(
                        { duration, update: { type: LayoutAnimation.Types.easeInEaseOut } },
                        () => fadeIn(token)
                    );
                    // Should the layout animation never say it ended.
                    setTimeout(() => fadeIn(token), duration + 80);
                } else {
                    fadeInAfterDraw.current = token;
                }
                setSheetNow(next);
            });
        },
        [contentFade, fadeIn]
    );
    const shownKey = sheetKey(sheet);
    // biome-ignore lint/correctness/useExhaustiveDependencies: the sheet drawn is the trigger, not an input
    useEffect(() => {
        const token = fadeInAfterDraw.current;
        if (token === null) return;
        fadeInAfterDraw.current = null;
        fadeIn(token);
    }, [shownKey, fadeIn]);
    const closeSheet = useCallback(() => openSheet(null), [openSheet]);

    /**
     * Makes an element the selection: outlined, and the composer opened on it at once, while its screenshots are taken
     * behind it. Picking another element while writing keeps the note's pin and id, and what is written.
     */
    const choose = useCallback(
        async (picked: Picked, keep?: Selection | null) => {
            const next = selectionFor(picked, keep, {
                origin: await origin(),
                nextPin: () => notato.nextPin(route),
                newId: ulid,
                shoot: (pin, id) => capture(picked, pin, id),
            });
            openSheet(null);
            setSelection(next);
        },
        [notato, route, origin, capture, openSheet]
    );

    // The runtime picks and photographs through this overlay while it is mounted: through a host that stays the same,
    // and calls what this render made.
    const hostRef = useRef<Host | undefined>(undefined);
    hostRef.current = {
        resolve,
        capture: async (picked, pin, id) => readShots(await capture(picked, pin, id)),
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

    /** Picks what is under a tap: only that view and those around it are described, not the whole app. */
    const pickAt = useCallback(
        async (x: number, y: number) => {
            try {
                const instance = await instanceAt(app.current, x, y);
                const element = elementAt(app.current, instance, notato.maskInputs);
                const picked = element ? await inspect(element) : null;
                if (!picked) {
                    flash("Nothing to annotate there.");
                    return;
                }
                await choose(picked, now.current.selection);
            } catch (e) {
                flash(`Could not select that: ${messageOf(e)}`);
            }
        },
        [app, notato, flash, choose]
    );

    /**
     * The composer's Parent: selects the nearest view around the selection that is bigger (a wrapper the same size
     * says nothing new).
     */
    const selectParent = useCallback(async () => {
        const selected = now.current.selection;
        if (!selected) return;
        const f = selected.picked.frame;
        for (let element = selected.picked.element.parent; element; element = element.parent) {
            const picked = await inspect(element);
            if (
                picked &&
                (picked.frame.width > f.width + 0.5 || picked.frame.height > f.height + 0.5)
            ) {
                await choose(picked, selected);
                return;
            }
        }
        flash("Nothing around this one to select.");
    }, [choose, flash]);

    const cancel = useCallback(() => {
        setSelection(null);
        notato.stopAnnotating();
    }, [notato]);

    /** Sends the note: the composer goes at once, and the screenshots are waited for (and read) only now. */
    const send = useCallback(
        async (draft: Draft) => {
            const chosen = now.current.selection;
            if (!chosen) return;
            setSelection(null);
            notato.stopAnnotating();
            try {
                const shots = await shotsToSend(chosen);
                const { problem } = await notato.createNote(chosen.picked, draft, {
                    id: chosen.id,
                    pin: chosen.pin,
                    ...shots,
                });
                flash(
                    problem ??
                        (notato.hasServer
                            ? "Sent"
                            : "Saved on this device. Package it from the menu.")
                );
            } catch (e) {
                flash(`Not saved: ${messageOf(e)}`);
            }
        },
        [notato, flash]
    );

    const startAnnotating = useCallback(() => {
        openSheet(null);
        if (!canInspect()) {
            flash("Annotating needs a development build of the app.");
            return;
        }
        notato.startAnnotating();
    }, [notato, flash, openSheet]);

    // Annotating stopped from code: drop the selection with it.
    useEffect(() => {
        if (!state.annotating) setSelection(null);
    }, [state.annotating]);

    // Android's Back closes a sheet or the composer, or stops annotating, before it reaches the app.
    const busy = sheet !== null || selection !== null || state.annotating;
    useEffect(() => {
        if (!busy) return;
        const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
            const open = now.current.sheet;
            if (open) openSheet(backFrom(open));
            else cancel();
            return true;
        });
        return () => subscription.remove();
    }, [busy, openSheet, cancel]);

    // What the toolbar is handed stays the same from one draw to the next unless it changed, so it is not drawn again
    // for the rest of the overlay's changes.
    const room = useMemo(
        () => ({ width: size.width, height: size.height, top: INSETS.top, bottom: INSETS.bottom }),
        [size.width, size.height]
    );
    const onAnnotate = useCallback(
        () => (now.current.state.annotating ? cancel() : startAnnotating()),
        [cancel, startAnnotating]
    );
    const onMenu = useCallback(() => openSheet({ kind: "menu" }), [openSheet]);
    const onFold = useCallback(
        (folded: boolean, x?: number) => notato.setFolded(folded, x),
        [notato]
    );
    const onMoved = useCallback((x: number, y: number) => notato.placeToolbar(x, y), [notato]);
    const openPin = useCallback(
        (id: string) => openSheet({ kind: "pin", id, fromList: false }),
        [openSheet]
    );
    const onParent = useCallback(() => void selectParent(), [selectParent]);
    const onSend = useCallback((draft: Draft) => void send(draft), [send]);

    const here = notato.notesOn(route);
    const pinnable = notato.pinsOn(route);

    const problemDot =
        state.connection === "connecting" ||
        state.connection === "offline" ||
        state.connection === "refused"
            ? PROBLEM_DOT[state.connection]
            : undefined;

    // What comes and goes, kept on screen while it leaves.
    const composer = usePresence(selection);
    const sheets = usePresence(sheet);
    // A sheet on its way out shows what it showed: a note deleted from it does not turn into "That note is gone."
    const sheetData = useRef({ state, here });
    if (sheet) sheetData.current = { state, here };
    const hint = usePresence(state.annotating && !selection && !sheet ? true : null);
    const toasts = usePresence(toast);
    const shownSelection = composer.shown;
    // The composer goes where it hides nothing of the selection: above it when it is in the lower half.
    const composerAtTop = shownSelection
        ? shownSelection.rect.y + shownSelection.rect.h / 2 > size.height / 2
        : false;
    const composerMotion = useMemo(
        () =>
            fadeSlide(composer.progress, still, {
                y: composerAtTop ? -COMPOSER_TRAVEL : COMPOSER_TRAVEL,
            }),
        [composer.progress, still, composerAtTop]
    );
    const hintMotion = useMemo(
        () => fadeSlide(hint.progress, still, { y: TOP_TRAVEL }),
        [hint.progress, still]
    );
    const toastMotion = useMemo(
        () => fadeSlide(toasts.progress, still, { y: TOP_TRAVEL }),
        [toasts.progress, still]
    );

    return (
        <View
            style={StyleSheet.absoluteFill}
            pointerEvents="box-none"
            onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
            }}
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

            <PinLayer
                notato={notato}
                app={app}
                pinnable={pinnable}
                shown={state.pinsVisible && !selection && !state.annotating}
                paused={sheet !== null}
                origin={origin}
                size={size}
                onOpen={openPin}
            />

            {hint.shown ? (
                <Animated.View
                    style={[styles.hint, { top: INSETS.top - 4 }, hintMotion]}
                    pointerEvents={hint.leaving ? "none" : "box-none"}
                >
                    <HintBar done={cancel} />
                </Animated.View>
            ) : null}

            {size.width > 0 ? (
                <Toolbar
                    room={room}
                    place={state.toolbar}
                    corner={notato.configuration?.toolbarPosition ?? "bottom-right"}
                    folded={state.toolbar.folded}
                    visible={state.toolbarVisible && !selection}
                    annotating={state.annotating}
                    count={here.length}
                    problem={problemDot}
                    problemLabel={notato.describeConnection()}
                    onAnnotate={onAnnotate}
                    onMenu={onMenu}
                    onFold={onFold}
                    onMoved={onMoved}
                />
            ) : null}

            {shownSelection ? (
                <KeyboardAvoidingView
                    behavior="padding"
                    style={[
                        StyleSheet.absoluteFill,
                        styles.composer,
                        composerAtTop
                            ? { justifyContent: "flex-start", paddingTop: INSETS.top }
                            : { justifyContent: "flex-end", paddingBottom: INSETS.bottom },
                    ]}
                    pointerEvents={composer.leaving ? "none" : "box-none"}
                >
                    <Animated.View style={composerMotion}>
                        <Composer
                            key={shownSelection.id}
                            title={shownSelection.title}
                            subtitle={shownSelection.subtitle}
                            screenshotsOff={!notato.screenshotsOn}
                            canParent={!!shownSelection.picked.element.parent}
                            onParent={onParent}
                            onCancel={cancel}
                            onSend={onSend}
                        />
                    </Animated.View>
                </KeyboardAvoidingView>
            ) : null}

            {sheets.shown ? (
                <KeyboardAvoidingView
                    behavior="padding"
                    style={StyleSheet.absoluteFill}
                    pointerEvents="box-none"
                >
                    <BottomSheet
                        close={closeSheet}
                        maxHeight={Math.max(240, size.height - INSETS.top - 16)}
                        top={INSETS.top - 8}
                        progress={sheets.progress}
                        leaving={sheets.leaving}
                        content={contentFade}
                    >
                        <SheetView
                            sheet={sheets.shown}
                            notato={notato}
                            state={sheetData.current.state}
                            here={sheetData.current.here}
                            pins={pinnable.length}
                            open={openSheet}
                            annotate={startAnnotating}
                            toast={flash}
                        />
                    </BottomSheet>
                </KeyboardAvoidingView>
            ) : null}

            {toasts.shown ? (
                <Animated.View
                    style={[styles.toastWrap, { top: INSETS.top - 5 }, toastMotion]}
                    pointerEvents="none"
                    accessibilityLiveRegion="polite"
                >
                    <Text style={styles.toast}>{toasts.shown}</Text>
                </Animated.View>
            ) : null}
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
