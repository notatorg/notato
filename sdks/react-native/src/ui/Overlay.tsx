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
    StatusBar,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { routeName } from "../annotation.ts";
import { type Shot, shoot } from "../capture.ts";
import { NotatoError } from "../client.ts";
import type { Host, NotatoController, NotatoState, NoteRecord } from "../controller.ts";
import { ulid } from "../ids.ts";
import {
    appElements,
    canInspect,
    commitCount,
    currentContainer,
    elementFor,
    inspect,
    instanceAt,
    type Picked,
} from "../inspect.ts";
import { indexOf, query, SelectorError, selectorToFind } from "../selectors.ts";
import { serial } from "../serial.ts";
import { type Frame, fiberOf, maskedUnder, measure, type TreeElement } from "../tree.ts";
import { Composer, type Draft } from "./Composer.tsx";
import { BottomSheet, PinDot } from "./parts.tsx";
import { placePins } from "./pinLayout.ts";
import {
    ClearSheet,
    MenuSheet,
    NoteCard,
    NotesSheet,
    SettingsSheet,
    type Sheet,
} from "./sheets.tsx";
import { HintBar, PROBLEM_DOT, Toolbar } from "./Toolbar.tsx";
import { BAR, BRAND } from "./theme.ts";

/** The most pins drawn on one screen: the newest. The Notes list has every one. */
export const MAX_PINS = 150;

type Rect = { x: number; y: number; w: number; h: number };

interface Selection {
    picked: Picked;
    rect: Rect;
    pin: number;
    id: string;
    shots: { full?: Shot; crop?: Shot };
    title: string;
    subtitle?: string;
}

const nextFrames = () =>
    new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );

const insets = Platform.select({
    ios: { top: 59, bottom: 34 },
    default: { top: (StatusBar.currentHeight ?? 24) + 8, bottom: 48 },
});

/** A frame on the page as a rect on the overlay, which starts at `at`. */
const toRect = (frame: Frame, at: { x: number; y: number }): Rect => ({
    x: frame.left - at.x,
    y: frame.top - at.y,
    w: frame.width,
    h: frame.height,
});

type PinAt = { record: NoteRecord; number: number; rect: Rect; detached: boolean };

const samePins = (a: PinAt[], b: PinAt[]) =>
    a.length === b.length &&
    a.every((x, i) => {
        const y = b[i] as PinAt;
        return (
            x.record === y.record &&
            x.number === y.number &&
            x.detached === y.detached &&
            x.rect.x === y.rect.x &&
            x.rect.y === y.rect.y &&
            x.rect.w === y.rect.w &&
            x.rect.h === y.rect.h
        );
    });

/** Whether any of a rect is on the overlay. */
const onScreen = (r: Rect, size: { width: number; height: number }) =>
    r.x + r.w > 0 && r.y + r.h > 0 && r.x < size.width && r.y < size.height;

const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

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

/** Everything Notato draws over the app, and the host the runtime picks and photographs through. */
export function Overlay(props: {
    notato: NotatoController;
    state: NotatoState;
    outer: RefObject<View | null>;
    app: RefObject<View | null>;
    route: () => string;
}) {
    const { notato, state, outer, app } = props;
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [sheet, setSheet] = useState<Sheet | null>(null);
    const [selection, setSelection] = useState<Selection | null>(null);
    /** While a screenshot is taken: the outline, the masks, and nothing else of Notato's. */
    const [capturing, setCapturing] = useState<{ rect: Rect; pin: number; covers: Rect[] } | null>(
        null
    );
    const [toast, setToast] = useState<string | null>(null);
    const [pins, setPins] = useState<PinAt[]>([]);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const route = routeName(props.route());

    // The screen is read as the overlay draws. A move to another screen that redraws nothing of Notato's (one with no
    // pins, say) is noticed by looking twice a second, and drawn then.
    const readRoute = useRef(props.route);
    readRoute.current = props.route;
    const drawnRoute = useRef(route);
    drawnRoute.current = route;
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        const timer = setInterval(() => {
            if (routeName(readRoute.current()) !== drawnRoute.current) redraw();
        }, 500);
        return () => clearInterval(timer);
    }, []);

    const flash = useCallback((message: string) => {
        setToast(message);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 3200);
    }, []);
    useEffect(
        () => () => {
            if (toastTimer.current) clearTimeout(toastTimer.current);
        },
        []
    );

    /** Where the overlay is on the page, so the page's frames can be drawn on it. */
    const origin = useCallback(async () => {
        const fiber = fiberOf(outer.current);
        const frame = fiber ? await measure(fiber) : null;
        return { x: frame?.left ?? 0, y: frame?.top ?? 0 };
    }, [outer]);

    /**
     * What screenshots cover: private views, password fields, and text fields when `maskInputs` is on. A private view
     * with no place of its own (a Text inside a Text) is painted by the view around it, which is covered instead; and
     * then the crop, which would show it, is left out.
     */
    const coversFor = useCallback(
        async (at: { x: number; y: number }) => {
            const container = currentContainer(app.current);
            const masked = container ? maskedUnder(container, notato.maskInputs) : [];
            let around = false;
            const frames = await Promise.all(
                masked.map(async (view) => {
                    let frame = await measure(view.fiber);
                    for (let up = view.parent; !frame && up; up = up.parent) {
                        frame = await measure(up.fiber);
                        if (frame) around = true;
                    }
                    return frame;
                })
            );
            const covers = new Map<string, Rect>();
            for (const frame of frames) {
                if (!frame) continue;
                const rect = toRect(frame, at);
                covers.set(`${rect.x},${rect.y},${rect.w},${rect.h}`, rect);
            }
            return { covers: [...covers.values()], around };
        },
        [notato, app]
    );

    /**
     * Screenshots are taken one at a time (two notes at once: a relayed request and a tap), and the covers come off only
     * after the last: one finishing first must not uncover what the other is photographing.
     */
    const [oneAtATime] = useState(() => serial(() => setCapturing(null)));

    /** The screenshots for a note: the screen with the element outlined and numbered, masked, and a crop of it. */
    const photograph = useCallback(
        async (picked: Picked, pin: number, id: string): Promise<{ full?: Shot; crop?: Shot }> => {
            if (!notato.screenshotsOn) return {};
            const at = await origin();
            const rect = toRect(picked.frame, at);
            const { covers, around } = await coversFor(at);
            setCapturing({ rect, pin, covers });
            await nextFrames();
            const max = notato.configuration?.maxScreenshotScale ?? 2;
            const full = await shoot(
                outer.current,
                `${id}-full`,
                { width: size.width, height: size.height },
                max
            );
            // The crop is the view on its own, without the masks: left out when something private is in it.
            const coveredHere =
                around || picked.element.private || covers.some((c) => overlaps(c, rect));
            const crop =
                full && !coveredHere
                    ? await shoot(picked.view, `${id}-crop`, picked.frame, max)
                    : undefined;
            return { ...(full ? { full } : {}), ...(crop ? { crop } : {}) };
        },
        [notato, origin, coversFor, outer, size]
    );

    const capture = useCallback(
        (picked: Picked, pin: number, id: string) => oneAtATime(() => photograph(picked, pin, id)),
        [oneAtATime, photograph]
    );

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

    /** Makes an element the selection: outlined, photographed, and the composer opened on it. */
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

    // The runtime picks and photographs through this overlay while it is mounted.
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
        const host: Host = {
            resolve: (t) => (hostRef.current as Host).resolve(t),
            capture: (p, n, i) => (hostRef.current as Host).capture(p, n, i),
            select: (p) => (hostRef.current as Host).select(p),
            route: () => (hostRef.current as Host).route(),
            device: () => (hostRef.current as Host).device(),
            toast: (m) => (hostRef.current as Host).toast(m),
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
            flash(`Could not select that: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const parent = async () => {
        if (!selection) return;
        // The nearest view around it that is bigger: a wrapper the same size says nothing new.
        let element = selection.picked.element.parent;
        while (element) {
            const picked = await inspect(element);
            const f = selection.picked.frame;
            if (
                picked &&
                (picked.frame.width > f.width + 0.5 || picked.frame.height > f.height + 0.5)
            ) {
                await choose(picked, selection);
                return;
            }
            element = element.parent;
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
            flash(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
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
        const sub = BackHandler.addEventListener("hardwareBackPress", () => {
            if (sheet)
                setSheet(
                    sheet.kind === "pin" && sheet.fromList
                        ? { kind: "list" }
                        : sheet.kind === "list" ||
                            sheet.kind === "settings" ||
                            sheet.kind === "clear"
                          ? { kind: "menu" }
                          : null
                );
            else cancel();
            return true;
        });
        return () => sub.remove();
    }, [busy, sheet, cancel]);

    // ---- pins: where their elements are now, found again by their selectors twice a second --------------------------

    const here = notato.notesOn(route);
    const pinnable = notato.pinsOn(route);
    const shownHere = useMemo(() => pinnable.slice(-MAX_PINS), [pinnable]);
    // Read as the pins are placed, so the server's changes do not start the placing over.
    const shownRef = useRef(shownHere);
    shownRef.current = shownHere;
    const pinsWanted = state.pinsVisible && !selection && !state.annotating && shownHere.length > 0;
    useEffect(() => {
        if (!pinsWanted) {
            setPins((current) => (current.length ? [] : current));
            return;
        }
        let live = true;
        // The views each pin's selector found the last time the app's tree was read. When React has committed nothing
        // since and the notes are the same, they are the same views, and only where they are now is asked (a scroll
        // moves them without a commit).
        const found: {
            commits?: number;
            of?: typeof shownHere;
            views: Map<string, TreeElement[]>;
        } = { views: new Map() };
        const place = async () => {
            const shown = shownRef.current;
            const commits = commitCount();
            if (commits === undefined || commits !== found.commits || found.of !== shown) {
                const elements = appElements(app.current, notato.maskInputs);
                const index = indexOf(elements);
                found.views = new Map();
                for (const { record } of shown) {
                    const identity = record.annotation.target.identity[0];
                    let views: TreeElement[] = [];
                    if (identity) {
                        try {
                            views = query(elements, selectorToFind(identity), index).slice(0, 12);
                        } catch {
                            views = [];
                        }
                    }
                    found.views.set(record.annotation.id, views);
                }
                found.commits = commits;
                found.of = shown;
            }
            const at = await origin();
            const placed = await Promise.all(
                shown.map(async ({ record, number }) => {
                    const stored = record.annotation.target.rect;
                    // Of several alike (a list's rows), the one nearest where the note was made.
                    let best: { rect: Rect; d: number } | undefined;
                    for (const e of found.views.get(record.annotation.id) ?? []) {
                        const f = await measure(e.fiber);
                        if (!f) continue;
                        const r = toRect(f, at);
                        const d =
                            Math.hypot(r.x - stored.x, r.y - stored.y) +
                            Math.abs(r.w - stored.w) +
                            Math.abs(r.h - stored.h);
                        if (!best || d < best.d) best = { rect: r, d };
                    }
                    const rect = best?.rect;
                    return { record, number, rect: rect ?? stored, detached: !rect };
                })
            );
            // An element scrolled out of sight takes its pin with it. The same pins again are not set again: that would
            // draw the overlay for nothing.
            const next = placed.filter((p) => p.detached || onScreen(p.rect, size));
            if (live) setPins((current) => (samePins(current, next) ? current : next));
        };
        void place();
        const timer = setInterval(() => void place(), 600);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [pinsWanted, origin, app, notato, size]);

    const spots = useMemo(
        () =>
            placePins(
                pins.map((p) => p.rect),
                size.width,
                insets.top - 9
            ),
        [pins, size.width]
    );

    const problemDot =
        state.connection === "connecting" ||
        state.connection === "offline" ||
        state.connection === "refused"
            ? PROBLEM_DOT[state.connection]
            : undefined;
    const sheetRecord =
        sheet?.kind === "pin" ? state.notes.find((r) => r.annotation.id === sheet.id) : undefined;
    const sheetNumber =
        sheet?.kind === "pin"
            ? (here.find((n) => n.record.annotation.id === sheet.id)?.number ?? 0)
            : 0;
    const hide = capturing !== null;
    const outline =
        capturing ?? (selection ? { rect: selection.rect, pin: selection.pin, covers: [] } : null);
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
                style={[StyleSheet.absoluteFill, hide && { opacity: 0 }]}
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
                            style={{
                                position: "absolute",
                                left: spot.x,
                                top: spot.y,
                                opacity: pin.detached ? 0.55 : 1,
                            }}
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
                    <View style={[styles.hint, { top: insets.top - 4 }]} pointerEvents="box-none">
                        <HintBar done={cancel} />
                    </View>
                ) : null}

                {state.toolbarVisible && !selection && size.width > 0 ? (
                    <Toolbar
                        room={{
                            width: size.width,
                            height: size.height,
                            top: insets.top,
                            bottom: insets.bottom,
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
                            {
                                justifyContent: composerAtTop ? "flex-start" : "flex-end",
                                paddingHorizontal: 10,
                                paddingTop: composerAtTop ? insets.top : 10,
                                paddingBottom: composerAtTop ? 10 : insets.bottom,
                            },
                        ]}
                        pointerEvents="box-none"
                    >
                        <Composer
                            key={selection.id}
                            title={selection.title}
                            subtitle={selection.subtitle}
                            screenshotsOff={!notato.screenshotsOn}
                            sending={false}
                            canParent={!!selection.picked.element.parent}
                            onParent={() => void parent()}
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
                            maxHeight={Math.max(240, size.height - insets.top - 16)}
                            top={insets.top - 8}
                        >
                            {sheet.kind === "menu" ? (
                                <MenuSheet
                                    notato={notato}
                                    state={state}
                                    here={here.length}
                                    pins={pinnable.length}
                                    open={setSheet}
                                    annotate={startAnnotating}
                                    packageAndShare={() => {
                                        notato
                                            .packageAndShare()
                                            .then(flash)
                                            .catch((e: unknown) =>
                                                flash(e instanceof Error ? e.message : String(e))
                                            );
                                    }}
                                />
                            ) : sheet.kind === "list" ? (
                                <NotesSheet
                                    state={state}
                                    list={here}
                                    open={setSheet}
                                    annotate={startAnnotating}
                                />
                            ) : sheet.kind === "settings" ? (
                                <SettingsSheet
                                    notato={notato}
                                    state={state}
                                    open={setSheet}
                                    toast={flash}
                                />
                            ) : sheet.kind === "clear" ? (
                                <ClearSheet
                                    notato={notato}
                                    state={state}
                                    open={setSheet}
                                    toast={flash}
                                />
                            ) : sheetRecord ? (
                                <NoteCard
                                    key={sheetRecord.annotation.id}
                                    notato={notato}
                                    record={sheetRecord}
                                    number={sheetNumber}
                                    fromList={sheet.fromList}
                                    open={setSheet}
                                    toast={flash}
                                />
                            ) : (
                                <Text style={{ padding: 20, color: BRAND.danger }}>
                                    That note is gone.
                                </Text>
                            )}
                        </BottomSheet>
                    </KeyboardAvoidingView>
                ) : null}

                {toast ? (
                    <View style={[styles.toastWrap, { top: insets.top - 5 }]} pointerEvents="none">
                        <Text style={styles.toast}>{toast}</Text>
                    </View>
                ) : null}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    cover: { position: "absolute", backgroundColor: "#8b8f97", borderRadius: 4 },
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
    hint: { position: "absolute", left: 0, right: 0, alignItems: "center" },
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
