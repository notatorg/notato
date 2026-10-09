import {
    type AnnotationRecord,
    createMemoryStore,
    createPipeline,
    type Detail,
    peopleOnlyRecord,
    renderAnnotations,
} from "@notato/core";
import type { Annotation } from "@notato/schema";
import { ROOT_ATTR } from "./attributes.ts";
import { describeElement, hoverLabel, pickHint, selectionSummary } from "./labels.ts";
import { createLocalCopy } from "./local-copy.ts";
import { addServer, setTransport } from "./net.ts";
import { type PackagedZip, packageNotes, toBase64 } from "./package.ts";
import { watchPage } from "./page-watch.ts";
import { createIdbPersistence } from "./persist.ts";
import { animationsOn } from "./plugins/animations.ts";
import { capturePlugins, identityPlugins, sinkPlugins } from "./plugins/defaults.ts";
import { DEFAULT_TEST_ID_ATTRIBUTES } from "./plugins/identity-dom.ts";
import { routeString } from "./plugins/route.ts";
import { blobFromBase64, ensureVisible } from "./plugins/screenshot.ts";
import { createPolicy } from "./policy.ts";
import { querySelectorDeep } from "./resolve.ts";
import { createServerActions, type RelayOutcome } from "./server-actions.ts";
import { createSettings, MARKER_COLORS } from "./settings.ts";
import { type Queued, serverSink } from "./sinks/server.ts";
import { downloadZip, zipSink } from "./sinks/zip.ts";
import { type AnnotateRequest, createServerSync } from "./sync.ts";
import { messageOf, plural } from "./text.ts";
import type { AnnotateArgs, NotatoApi, NotatoProps } from "./types.ts";
import { copyText, createCopyMenu } from "./ui/copy-menu.ts";
import { h, ICONS, isolateFromPage } from "./ui/dom.ts";
import { createFrames } from "./ui/frame.ts";
import { viewportRect } from "./ui/frames.ts";
import { createFreezer } from "./ui/freeze.ts";
import {
    ANNOTATE_SHORTCUT,
    isEditable,
    matchesShortcut,
    NEXT_VARIANT_SHORTCUT,
    PAUSE_SHORTCUT,
    PREVIOUS_VARIANT_SHORTCUT,
    parseShortcut,
    type Shortcut,
    shortcutLabel,
} from "./ui/keys.ts";
import { createPackageDialog } from "./ui/package-dialog.ts";
import {
    createPicker,
    type PickEvent,
    type Selection,
    toPageRect,
    unionPageRect,
} from "./ui/picker.ts";
import { createPins, nextPinNumber } from "./ui/pins.ts";
import { createPopover } from "./ui/popover.ts";
import { createSettingsPanel } from "./ui/settings-panel.ts";
import { addSheet, setStyleNonce } from "./ui/sheet.ts";
import { STYLES } from "./ui/styles.ts";
import { createToast } from "./ui/toast.ts";
import { type ConnectionState, createToolbar } from "./ui/toolbar.ts";
import { createVariants } from "./ui/variants.ts";
import { redactUrl } from "./url.ts";
import { SDK } from "./version.ts";

export interface NotatoController {
    /** Turns annotate mode on or off, as the toolbar's Annotate button and the shortcut do. */
    setAnnotateMode(on: boolean): void;
    /** Makes a note on an element as an agent: what `window.__notato.annotate` does. */
    annotate(args: AnnotateArgs): Promise<Annotation>;
    /** Every note the page has. */
    list(): Annotation[];
    /** Builds the bundle zip; with `send`, also hands it to the sinks (download, upload). */
    package(options?: { send?: boolean; name?: string }): Promise<PackagedZip>;
    /** Takes the toolbar off the page. Notes not yet on the server go on with the next toolbar started on it. */
    destroy(): void;
}

/** A note a remounted toolbar carries on with: not on the server yet, or refused by it (and why). */
type Carried = Queued & { refused?: string };

declare global {
    interface Window {
        /** Notes not yet on the server when the toolbar was torn down (HMR, StrictMode), for the one that follows. */
        __notatoUnsent?: { key: string; items: Carried[] };
    }
}

/**
 * Puts the Notato toolbar on the page: pins for the notes, the picker to make new ones, and the connection to the
 * server they go to. A toolbar already on the page is taken off first, so calling it again (HMR, StrictMode) is safe.
 */
export function createController(props: NotatoProps): NotatoController {
    window.__notatoDestroy?.();
    setTransport(props.transport);
    setStyleNonce(props.nonce);

    const mode = props.mode ?? "dev";
    const server = props.server?.replace(/\/$/, "");
    /** The server each note is posted to as it is made: dev and agent mode. Test mode sends it only bundles. */
    const liveServer = mode === "test" ? undefined : server;
    const currentRoute = () => routeString(window.location, props.hashRoutes ?? false);
    const warn = (message: string, error?: unknown) =>
        console.warn(`[notato] ${message}`, error ?? "");

    // What this person has chosen for themselves in this browser (the settings panel). The server's own settings win.
    const settings = createSettings();
    const authorName = () => props.author ?? (settings.get().name || undefined);
    // What the server allows, asked before each screenshot; this page's own `screenshots` prop can only narrow it.
    const policy = createPolicy({ baseUrl: server, token: props.token });
    const screenshotsOn = async () =>
        props.screenshots !== false && settings.get().screenshots && (await policy.screenshots());
    const identity = identityPlugins(props, settings);

    // ---- the server -----------------------------------------------------------------------------------------
    const store = createMemoryStore();
    const sink = liveServer
        ? serverSink({
              baseUrl: liveServer,
              project: props.project,
              token: props.token,
              onPending: () => describeConnection(),
              onSent: (id) => {
                  localCopy.sent(id);
                  release(id);
              },
              onRefused: (id, message) => {
                  localCopy.refused(id, message);
                  toast.show(`The server refused a note: ${message}`, 6000);
                  syncUi(); // its pin and card say so
              },
              onProblem: (message) => {
                  describeConnection();
                  if (message) toast.show(`Notes are waiting: ${message}`, 6000);
              },
          })
        : undefined;
    const sinks = sinkPlugins(props, [
        ...(mode === "test" ? [zipSink()] : []),
        ...(sink ? [sink] : []),
        ...(server && mode === "test"
            ? [
                  serverSink({
                      baseUrl: server,
                      project: props.project,
                      token: props.token,
                      delivers: "bundles",
                  }),
              ]
            : []),
    ]);
    const sync = liveServer
        ? createServerSync({
              baseUrl: liveServer,
              project: props.project,
              token: props.token,
              store,
              onState: (state) => {
                  connection = state;
                  describeConnection();
              },
              onConnected: () => void sink?.flush(),
              // In agent mode this page can take `notato_annotate` requests relayed from the server.
              agent: mode === "agent",
              onAnnotateRequest: (request) => void answerRelay(request),
              onAgent: (info) => {
                  agentNames = info.names;
              },
              // Not on the server yet, or refused by it: still this page's, whatever the server's list says.
              keep: () => sink?.unsent() ?? [],
              onApplied: (change) => localCopy.applied(change),
          })
        : undefined;
    const actions =
        liveServer && sync
            ? createServerActions({
                  server: liveServer,
                  token: props.token,
                  sync,
                  author: authorName,
              })
            : undefined;
    let connection: ConnectionState = "connecting";
    /** The coding agents connected to the server, by name, as it last said (see sync.ts). */
    let agentNames: string[] = [];
    /** The agent's name when exactly one is connected: the cards and the switcher say who they are asking. */
    const agentName = () => (agentNames.length === 1 ? agentNames[0] : undefined);

    // ---- making notes ---------------------------------------------------------------------------------------
    // The page holds the only copy in test and agent mode, so it must survive a reload. Kept per mode so a tester's
    // notes never end up in an agent's bundle.
    const localCopy = createLocalCopy(
        (props.persist ?? mode !== "dev") ? createIdbPersistence(`${props.project}:${mode}`) : null,
        warn
    );
    /**
     * In dev mode the server keeps a note's screenshots, and nothing in the page shows them again: once it has them, the
     * page lets them go rather than hold them for as long as it is open. Test and agent mode keep them for the zip.
     */
    const release = (id: string) => {
        if (mode === "dev") store.get(id)?.assets.clear();
    };
    /** A note made in this page: into the store, kept in this browser, and its screenshots let go if the server has them. */
    const addMade = (record: AnnotationRecord) => {
        const id = record.annotation.id;
        const unsent = sink?.unsent().includes(id);
        store.add(record);
        localCopy.keep(record, { unsent, refused: sink?.refusal(id) });
        if (sink && !unsent) release(id);
    };
    /**
     * Annotations are made one at a time. Each scrolls the page and captures it, which two at once would do over each
     * other, and each takes the next pin number as it starts, so two at once (an agent's relayed requests) would get the
     * same one.
     */
    let making: Promise<unknown> = Promise.resolve();
    const oneAtATime = <T>(make: () => Promise<T>): Promise<T> => {
        const run = making.then(make, make);
        making = run.catch(() => {});
        return run;
    };
    const pipeline = createPipeline({
        mode,
        projectId: props.project,
        appName: props.appName,
        appVersion: props.appVersion,
        author: () => ({ kind: "human", name: authorName() }),
        identity,
        capture: capturePlugins(props, screenshotsOn),
        sinks,
        // The URL as recorded: what reaches the agent, webhooks and bundles. Secrets in it are blanked out.
        locate: () => ({ url: redactUrl(window.location.href), route: currentRoute() }),
        environment: () => ({
            userAgent: navigator.userAgent,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            dpr: window.devicePixelRatio || 1,
            platform: "web",
            sdk: { ...SDK },
        }),
        // Asked as each annotation starts. They are made one at a time (see `oneAtATime`), so the one before is in the
        // store by then.
        nextNumber: () => nextPinNumber(store.list()),
        onWarn: warn,
    });
    const teardownPlugins = pipeline.setup();

    // ---- shadow root ----------------------------------------------------------------------------------------
    const host = h("div", {
        [ROOT_ATTR]: "",
        style: {
            all: "initial",
            position: "fixed",
            inset: "0",
            zIndex: "2147483647",
            pointerEvents: "none",
        },
    });
    const shadow = host.attachShadow({ mode: "open" });
    const layer = h("div", { class: "layer" });
    shadow.append(layer);
    addSheet(shadow, STYLES, "data-notato-styles");
    const stopIsolating = isolateFromPage(host);
    document.body.append(host);

    // Everything drawn over the page that follows it (pins, versions switchers, the popover, the picker's outlines) is
    // measured and placed in one frame, all the measuring first: see frame.ts.
    const frames = createFrames();

    // ---- pins -----------------------------------------------------------------------------------------------
    /** Whether this person wrote it: their name on a note a person made. Without a name nothing can be told apart. */
    const isMine = (a: Annotation) =>
        a.author.kind === "human" &&
        Boolean(settings.get().name) &&
        a.author.name === settings.get().name;
    /**
     * The notes with pins: not dismissed ones (the server's list leaves them out anyway), nor others', if asked. Worked out
     * once for each change to the notes or the settings: it is asked for several times a frame, over every note.
     */
    let shownNow: AnnotationRecord[] | undefined;
    const shown = () =>
        (shownNow ??= store
            .list()
            .filter(
                (r) =>
                    r.annotation.status !== "dismissed" &&
                    (!settings.get().mineOnly || isMine(r.annotation))
            ));
    const pins = createPins({
        layer,
        records: shown,
        currentRoute,
        onDelete: (id) => void deleteAnnotation(id),
        // Asking the agent to undo a change only means something when there is a server it can read the request from.
        onRequestRevert: actions
            ? (id, note) =>
                  actions.changeStatus(id, "revert_requested", note || "Please revert this change.")
            : undefined,
        onCancelRevert: actions
            ? (id) => actions.changeStatus(id, "resolved", "Revert request cancelled.")
            : undefined,
        // Choosing between versions, and asking for different ones, are conversations with the agent through the server.
        fallbackAnchor: (a) => (a.variants ? variants.anchor(a.variants.group) : null),
        onTakeBackVariant: actions ? (id) => actions.chooseVariant(id, null) : undefined,
        onReply: actions ? (id, note, aside) => actions.reply(id, note, aside) : undefined,
        // Recorded on the live server, or here when there is no server. Test mode's server takes only bundles.
        onPeopleOnly: !server || actions ? (id, on) => setPeopleOnly(id, on) : undefined,
        agentName,
        refusal: (id) => sink?.refusal(id),
        frames,
    });

    /** Read once: reading the page's location for each of thousands of notes is most of the time a count takes. */
    const countOnRoute = () => {
        const route = currentRoute();
        let count = 0;
        for (const r of shown()) if (r.annotation.route === route) count += 1;
        return count;
    };
    let destroyed = false;
    const syncUi = () => {
        if (destroyed) return;
        pins.refresh();
        variants.redraw();
        toolbar.setCount(countOnRoute());
    };
    // The store says so for each note it takes, reading the server's list hands it hundreds at once, and a busy project
    // sends many changes a second: the pins are brought up to date at most once a frame, after the lot.
    let uiFrame = 0;
    const unsubscribe = store.subscribe(() => {
        shownNow = undefined;
        if (uiFrame) return;
        uiFrame = requestAnimationFrame(() => {
            uiFrame = 0;
            syncUi();
        });
    });
    const applyColor = () => {
        const color =
            MARKER_COLORS.find((c) => c.id === settings.get().markerColor) ?? MARKER_COLORS[0];
        layer.style.setProperty("--notato-accent", color.hex);
    };
    applyColor();
    const unsubscribeSettings = settings.subscribe(() => {
        shownNow = undefined;
        applyColor();
        syncUi(); // "only my notes" and a changed name change which pins there are
    });

    // ---- the toolbar and what opens from it -----------------------------------------------------------------
    const popover = createPopover(layer, frames);
    const packageDialog = createPackageDialog(layer);
    const shortcut = props.shortcut ?? ANNOTATE_SHORTCUT;
    const pauseKeys = shortcutLabel(PAUSE_SHORTCUT);
    const toolbar = createToolbar({
        position: props.position ?? "bottom-right",
        shortcutLabel: shortcutLabel(shortcut),
        onToggleAnnotate: () => setAnnotateMode(!picker.active),
        onTogglePins: (visible) => pins.setVisible(visible),
        onCollapse: () => {
            if (copyMenu.isOpen) copyMenu.close();
            if (settingsPanel.isOpen) settingsPanel.close();
        },
    });
    layer.append(toolbar.el);
    const toast = createToast(layer);
    /** Hidden until the page is reloaded (or annotate mode is asked for again). */
    let hidden = false;
    const setHidden = (next: boolean) => {
        hidden = next;
        host.style.display = next ? "none" : "";
        if (next) setAnnotateMode(false);
    };

    // Pause freezes animations, transitions and media where they are, so the moment can be annotated.
    const pauseButton = toolbar.addButton({
        title: `Pause animations (${pauseKeys})`,
        icon: ICONS.pause,
        className: "tb-pause",
        onClick: () => freezer.toggle(),
    });
    const freezer = createFreezer(
        () => page.frames.windows(),
        (frozen) => {
            pauseButton.setPressed(frozen);
            pauseButton.setIcon(frozen ? ICONS.play : ICONS.pause);
            pauseButton.setTitle(
                frozen ? `Resume animations (${pauseKeys})` : `Pause animations (${pauseKeys})`
            );
            toast.show(
                frozen ? "Paused: animations and media are frozen where they are" : "Resumed"
            );
        }
    );

    const settingsButton = toolbar.addButton({
        title: "Settings",
        icon: ICONS.gear,
        onClick: () => {
            if (!hidden) settingsPanel.toggle();
        },
    });
    const settingsPanel = createSettingsPanel({
        layer,
        settings,
        anchor: () => settingsButton.el.getBoundingClientRect(),
        serverScreenshots: () => policy.screenshotsNow(),
        onHide: () => setHidden(true),
        onToggle: (open) => settingsButton.setExpanded(open),
        owner: () => settingsButton.el,
        server:
            liveServer && actions
                ? {
                      url: liveServer,
                      project: props.project,
                      connection: () => connection,
                      status: () => actions.status(),
                  }
                : undefined,
    });

    // Markdown at four levels and, in test and agent mode, a zip of the lot.
    const copyMenu = createCopyMenu(layer, () => settings.get().copyDetail);
    const exportButton = toolbar.addButton({
        title: "Export: copy as Markdown, or download a zip",
        icon: ICONS.export,
        onClick: () => {
            if (copyMenu.isOpen) return copyMenu.close();
            const all = store.list().length;
            const uploaded = mode === "test" && server ? ", also sent to the server" : "";
            copyMenu.open(
                exportButton.el.getBoundingClientRect(),
                (detail) => void copyAnnotations(detail),
                {
                    count: countOnRoute(),
                    zip:
                        mode === "dev"
                            ? undefined
                            : {
                                  description: `${plural(all, "note")} with screenshots and a feedback.md${uploaded}`,
                                  count: all,
                                  onPick: () => openPackageDialog(),
                              },
                    onClose: () => exportButton.setExpanded(false),
                    owner: exportButton.el,
                }
            );
            exportButton.setExpanded(true);
        },
    });

    function describeConnection() {
        // Only dev and agent mode keep a live connection; test mode just uploads a bundle on request.
        if (!liveServer) return;
        const waiting = sink?.pending() ?? 0;
        const problem = sink?.problem();
        const unsent = waiting
            ? ` ${plural(waiting, "annotation")} waiting to be sent.${problem ? ` The server said: ${problem}` : ""}`
            : "";
        const title =
            connection === "connected"
                ? `Notato server connected (${liveServer}).${unsent}`
                : connection === "connecting"
                  ? `Connecting to the Notato server (${liveServer})…${unsent}`
                  : `Cannot reach the Notato server (${liveServer}). Annotations are kept in this page and sent when it is back.${unsent}`;
        toolbar.setConnection(connection, title);
    }
    void policy.refresh();
    describeConnection();

    /** Copies this page's annotations as Markdown at the chosen level, and says how many. */
    async function copyAnnotations(detail: Detail) {
        settings.set({ copyDetail: detail });
        const route = currentRoute();
        const list = shown()
            .map((r) => r.annotation)
            .filter((a) => a.route === route);
        if (list.length === 0) {
            toast.show("No annotations on this page yet");
            return;
        }
        const text = renderAnnotations(list, {
            detail,
            title: `Feedback for ${props.project} on ${route}`,
        });
        const ok = await copyText(text);
        toast.show(
            ok
                ? `Copied ${plural(list.length, "annotation")} as Markdown (${detail})`
                : "Could not copy: the browser blocked the clipboard"
        );
    }

    // ---- picking and the new-note popover -------------------------------------------------------------------
    let draft: Selection | null = null;
    const picker = createPicker({
        host,
        layer,
        describe: (el) => hoverLabel(el, props.testIdAttributes),
        onPick,
        frames,
    });

    function setAnnotateMode(on: boolean) {
        if (on && hidden) setHidden(false);
        if (on) void policy.refresh(); // so the hint on the popover is current
        picker.setActive(on);
        toolbar.setActive(on);
        if (!on) closeDraft();
    }

    function closeDraft() {
        popover.close();
        picker.clearDraft();
        draft = null;
    }

    /** Where a selection is in the viewport, for the popover to sit beside. */
    const anchorOf = (sel: Selection) => ({
        left: sel.rect.x - window.scrollX,
        top: sel.rect.y - window.scrollY,
        width: sel.rect.w,
        height: sel.rect.h,
    });

    function onPick(ev: PickEvent) {
        if (ev.additive && draft && (draft.kind === "element" || draft.kind === "multi")) {
            const el = ev.elements[0] as Element;
            const elements = draft.elements.includes(el)
                ? draft.elements.filter((e) => e !== el)
                : [...draft.elements, el];
            if (elements.length === 0) return closeDraft();
            draft = {
                kind: elements.length > 1 ? "multi" : "element",
                elements,
                rect: unionPageRect(elements),
            };
        } else {
            draft = {
                kind: ev.kind,
                elements: ev.elements,
                rect: ev.rect,
                selectedText: ev.selectedText,
            };
        }
        const sel = draft;
        picker.showDraft(sel.elements, sel.kind === "area" ? sel.rect : undefined);
        const summary = selectionSummary(sel, (el) => describeElement(el, identity));
        const hintNow = () =>
            pickHint({
                kind: sel.kind,
                animations: sel.elements.flatMap((e) => animationsOn(e)),
                frozen: freezer.frozen,
                screenshotsOff:
                    props.screenshots === false ||
                    !settings.get().screenshots ||
                    !policy.screenshotsNow(),
            });
        if (popover.isOpen) {
            popover.update({ ...summary, anchor: anchorOf(sel), hint: hintNow() });
            return;
        }
        // The server's setting can change at any time, so ask again as the popover opens and correct the line if it did.
        void policy.refresh().then(() => {
            if (popover.isOpen) popover.update({ hint: hintNow() });
        });
        popover.open({
            ...summary,
            // Versions are put in the code by the agent, which is on the other end of a server.
            variants: Boolean(liveServer),
            hint: hintNow(),
            anchor: anchorOf(sel),
            onCancel: closeDraft,
            onSave: async ({ comment, severity, intent, peopleOnly }) => {
                const current = draft;
                if (!current) return;
                // The composer goes at once and the note's pin is there: the screenshot, the identity and the upload
                // follow in the background, and the pin becomes the note's own once it is made. A server that refuses
                // it, or cannot be reached, says so as it would anyway: a toast, and the pin.
                const pending = pins.pending({
                    number: nextPinNumber(store.list()) + saving,
                    route: currentRoute(),
                    elements: current.elements,
                    rect: current.rect,
                });
                closeDraft();
                saving += 1;
                void oneAtATime(async () => {
                    // Copying the page for the screenshot holds up everything else in it: the composer is let go first,
                    // so its closing is under way (on the compositor, which carries on meanwhile).
                    await afterPaint();
                    const record = await pipeline.create({
                        kind: current.kind,
                        elements: current.elements,
                        rect: current.rect,
                        selectedText: current.selectedText,
                        comment,
                        severity,
                        intent,
                        peopleOnly,
                    });
                    addMade(record);
                    pending.done(record.annotation.id);
                })
                    .catch((error) => {
                        pending.cancel();
                        warn("could not make the annotation", error);
                        toast.show(`Could not save the note: ${messageOf(error)}`, 6000);
                    })
                    .finally(() => {
                        saving -= 1;
                    });
            },
        });
    }
    /** Notes saved from the composer and still being made: the next one's pending pin numbers after them. */
    let saving = 0;
    /** Resolves once the browser has drawn a frame, and is past it. */
    const afterPaint = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    // ---- keys ---------------------------------------------------------------------------------------------------
    const annotateShortcut = parseShortcut(shortcut);
    const pauseShortcut = parseShortcut(PAUSE_SHORTCUT);
    const nextVariant = parseShortcut(NEXT_VARIANT_SHORTCUT);
    const previousVariant = parseShortcut(PREVIOUS_VARIANT_SHORTCUT);
    const onKey = (ev: KeyboardEvent) => {
        if (ev.composedPath().includes(host)) return;
        // In a field, Alt and Shift with a key type a character (⌥⇧A is Å on a Mac) or select by word: the keys are
        // the field's. A shortcut with Ctrl or Cmd in it types nothing, so it still works there.
        const typing = isEditable(ev.composedPath()[0]);
        const ours = (combo: Shortcut) =>
            matchesShortcut(ev, combo) && (!typing || combo.ctrl || combo.meta);
        if (ours(annotateShortcut)) {
            ev.preventDefault();
            setAnnotateMode(!picker.active);
        } else if (ours(pauseShortcut)) {
            ev.preventDefault();
            freezer.toggle();
        } else if (ours(nextVariant) || ours(previousVariant)) {
            // Only when there is something to switch between; otherwise the keys are the page's.
            if (variants.list().length === 0) return;
            ev.preventDefault();
            const group = variants.step(matchesShortcut(ev, nextVariant) ? 1 : -1);
            if (group) {
                const at = group.options.indexOf(group.active) + 1;
                toast.show(`Showing “${group.active}” (${at} of ${group.options.length})`);
            }
        } else if (ev.key === "Escape" && picker.active) {
            // Ours: do not let it also close the modal underneath.
            ev.preventDefault();
            ev.stopPropagation();
            if (popover.isOpen) closeDraft();
            else setAnnotateMode(false);
        }
    };
    window.addEventListener("keydown", onKey, true);

    // ---- keeping up with the page -------------------------------------------------------------------------------
    const reposition = () => {
        pins.schedule();
        popover.reposition();
        variants.reposition();
    };
    // Versions an agent has put in the page for the person to compare: a switcher over each, and a pick to send back.
    const variants = createVariants({
        layer,
        windows: () => page.frames.windows(),
        annotations: () => store.list().map((r) => r.annotation),
        namespace: props.project,
        onChoose: actions ? (id, name) => actions.chooseVariant(id, name) : undefined,
        agentName,
        frames,
    });
    const page = watchPage({
        identityAttributes: ["id", ...(props.testIdAttributes ?? DEFAULT_TEST_ID_ATTRIBUTES)],
        onMove: reposition,
        onElementsChanged: (touched) => pins.domChanged(touched),
        onVariantsChanged: (found) => variants.pageChanged(found),
        onRouteChange: () => {
            syncUi();
            reposition();
        },
    });

    // ---- deleting, People only and packaging --------------------------------------------------------------------
    async function deleteAnnotation(id: string) {
        try {
            // Not sent yet: it must not go out after all, and there is nothing on the server to delete. One on its way is
            // waited for, so the delete comes after it.
            if (sink && (await sink.discard(id))) await actions?.remove(id);
            store.remove(id);
            await localCopy.forget(id);
        } catch (error) {
            warn("could not delete the annotation", error);
        }
    }

    /**
     * Turns People only on or off: on the server, which records the change in the thread, or with no server (test mode)
     * here, recording it the same way, so a bundle carries it.
     */
    const setPeopleOnly = async (id: string, on: boolean) => {
        if (actions) return actions.setPeopleOnly(id, on);
        store.update(id, (a) => {
            const { peopleOnly: _was, ...rest } = a;
            return {
                ...rest,
                ...(on ? { peopleOnly: true } : {}),
                thread: [...a.thread, peopleOnlyRecord(on, authorName())],
            };
        });
    };

    const packageBundle = (options: { send?: boolean; name?: string } = {}) =>
        packageNotes(store.list(), {
            project: props.project,
            appName: props.appName,
            appVersion: props.appVersion,
            author: options.name ?? authorName(),
            sinks,
            send: options.send,
        });

    function openPackageDialog() {
        const records = store.list();
        if (records.length === 0) return;
        packageDialog.open({
            count: records.length,
            routes: new Set(records.map((r) => r.annotation.route)).size,
            destination: mode === "test" ? (server ?? null) : null,
            name: authorName() ?? "",
            // Notes that live on a server would only come back from it: there is nothing to remove from here.
            clearable: !liveServer,
            onCancel: () => packageDialog.close(),
            onSubmit: async ({ name, clear }) => {
                if (name) settings.set({ name });
                const result = await packageBundle({ send: true, name });
                // Test mode has a zip sink (or one of the page's own in its place). Elsewhere the zip is downloaded
                // here. Either way nothing is cleared until the download has happened.
                const zip = result.delivery.find((d) => d.sink === "zip");
                if (zip && !zip.ok) throw new Error(zip.error ?? "could not build the zip");
                if (!zip) downloadZip(result.zip, result.filename);
                if (clear) {
                    store.clear();
                    await localCopy.forgetAll();
                }
                const upload = result.delivery.find((d) => d.sink === "server" && !d.ok);
                return upload
                    ? `Downloaded ${result.filename}, but it was not uploaded: ${upload.error}`
                    : `Downloaded ${result.filename}: ${plural(result.annotations, "annotation")}.`;
            },
        });
    }

    // ---- window.__notato ----------------------------------------------------------------------------------------
    const list = () => store.list().map((r) => r.annotation);

    function annotate(args: AnnotateArgs): Promise<Annotation> {
        return oneAtATime(async () => {
            const el =
                typeof args.target === "string" ? querySelectorDeep(args.target) : args.target;
            if (!el)
                throw new Error(`notato.annotate: no element matches "${String(args.target)}"`);
            // A driver's screenshot shows the page as it was: scrolling now would move the element, and the fields to
            // cover, away from where its pixels have them.
            if (!args.screenshot) await ensureVisible(el);
            const record = await pipeline.create({
                kind: "element",
                elements: [el],
                rect: toPageRect(viewportRect(el)),
                comment: args.comment,
                severity: args.severity,
                intent: args.intent,
                steps: args.steps,
                screenshot: args.screenshot ? blobFromBase64(args.screenshot) : undefined,
                mode: "agent",
                author: { kind: "agent", name: args.author },
            });
            addMade(record);
            return record.annotation;
        });
    }

    /** Runs an annotate request relayed from `notato_annotate` and reports the outcome to the server. */
    async function answerRelay(request: AnnotateRequest) {
        let outcome: RelayOutcome;
        try {
            const annotation = await annotate(request.args);
            outcome = { ok: true, annotationId: annotation.id };
        } catch (error) {
            outcome = { ok: false, error: messageOf(error) };
        }
        try {
            await actions?.reportRelay(request.requestId, outcome);
        } catch (error) {
            warn("could not report the annotate result to the server", error);
        }
    }

    const api: NotatoApi = {
        version: 1,
        annotate,
        list,
        variants: {
            list: () => {
                variants.update(); // a driver asks right after the page changed, so look now rather than at the next frame
                return variants.list();
            },
            select: (group, name) => variants.select(group, name),
        },
        async package(options) {
            const { zip, ...rest } = await packageBundle({
                send: options?.send ?? false,
                name: options?.name,
            });
            return { ...rest, zipBase64: toBase64(zip) };
        },
    };
    window.__notato = api;

    const destroy = () => {
        destroyed = true;
        // What has not reached the server goes on with the toolbar that replaces this one (HMR, StrictMode).
        if (sink) {
            const items: Carried[] = [
                ...sink.queued(),
                ...sink.unsent().flatMap((id) => {
                    const refused = sink.refusal(id);
                    const record = refused ? store.get(id) : undefined;
                    return record
                        ? [{ annotation: record.annotation, assets: record.assets, refused }]
                        : [];
                }),
            ];
            if (items.length) window.__notatoUnsent = { key: carryKey, items };
        }
        if (window.__notato === api) window.__notato = undefined;
        if (window.__notatoDestroy === destroy) window.__notatoDestroy = undefined;
        freezer.destroy();
        variants.destroy();
        copyMenu.destroy();
        toolbar.destroy();
        toast.destroy();
        page.destroy();
        window.removeEventListener("keydown", onKey, true);
        unsubscribe();
        if (uiFrame) cancelAnimationFrame(uiFrame);
        frames.destroy();
        unsubscribeSettings();
        settingsPanel.destroy();
        settings.destroy();
        sync?.stop();
        picker.destroy();
        popover.destroy();
        packageDialog.close();
        pins.destroy();
        teardownPlugins();
        stopIsolating();
        unregister();
        host.remove();
    };
    window.__notatoDestroy = destroy;

    // ---- what this page had before ------------------------------------------------------------------------------
    /** Takes back notes from before: a remount's that had not been sent, then what this browser kept. */
    function adopt(items: Carried[]) {
        for (const item of items)
            if (!store.get(item.annotation.id))
                store.add({ annotation: item.annotation, assets: new Map(item.assets) });
        sink?.restore(items);
    }
    const carryKey = `${server ?? ""}|${props.project}|${mode}`;
    const carried = window.__notatoUnsent;
    window.__notatoUnsent = undefined;
    if (carried?.key === carryKey) adopt(carried.items);

    async function restore() {
        try {
            const saved = await localCopy.load();
            if (destroyed || saved.length === 0) return;
            const waiting: Carried[] = [];
            for (const { record, unsent } of saved) {
                if (sink && unsent) waiting.push({ ...record, refused: unsent.refused });
                // Anything the store has already is at least as new as this browser's copy.
                else if (!store.get(record.annotation.id)) store.add(record);
            }
            adopt(waiting);
        } catch (error) {
            warn("could not restore annotations saved in this browser", error);
        }
    }
    // The server's list is read only after: so it is compared with everything this page had, and corrects it.
    const unregister = server ? addServer(server) : () => {};
    void restore().then(() => {
        if (!destroyed) sync?.start();
    });

    syncUi();
    variants.schedule(); // the versions the page has already

    return { setAnnotateMode, annotate, list, package: packageBundle, destroy };
}
