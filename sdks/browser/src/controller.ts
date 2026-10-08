import {
    type AnnotationRecord,
    buildBundle,
    type CapturePlugin,
    createMemoryStore,
    createPipeline,
    type Detail,
    type IdentityPlugin,
    peopleOnlyRecord,
    renderAnnotations,
    type SinkPlugin,
} from "@notato/core";
import type { Annotation, Rect } from "@notato/schema";
import { authHeaders } from "./auth.ts";
import { onHistoryChange } from "./history.ts";
import { addServer, net, setTransport } from "./net.ts";
import { createIdbPersistence } from "./persist.ts";
import { animationsPlugin } from "./plugins/animations.ts";
import { angularIdentityPlugin } from "./plugins/identity-angular.ts";
import {
    accessibleName,
    DEFAULT_TEST_ID_ATTRIBUTES,
    domIdentityPlugin,
    roleOf,
    safeText,
    testIdOf,
} from "./plugins/identity-dom.ts";
import { reactSourceIdentityPlugin } from "./plugins/identity-react-source.ts";
import { sourceAttributeIdentityPlugin } from "./plugins/identity-source.ts";
import { stylesIdentityPlugin } from "./plugins/identity-styles.ts";
import { routePlugin, routeString } from "./plugins/route.ts";
import {
    blobFromBase64,
    ensureVisible,
    ROOT_ATTR,
    screenshotPlugin,
} from "./plugins/screenshot.ts";
import { stepsPlugin } from "./plugins/steps.ts";
import { createPolicy } from "./policy.ts";
import { querySelectorDeep } from "./resolve.ts";
import { createSettings, MARKER_COLORS } from "./settings.ts";
import { type Queued, serverSink } from "./sinks/server.ts";
import { bundleFilename, bundleToZip, downloadZip, zipSink } from "./sinks/zip.ts";
import { type AnnotateRequest, createServerSync } from "./sync.ts";
import type {
    AnnotateArgs,
    NotatoApi,
    NotatoPlugin,
    NotatoProps,
    PackagedBundle,
} from "./types.ts";
import { copyText, createCopyMenu, createToast } from "./ui/copy-menu.ts";
import {
    h,
    ICONS,
    isolateFromPage,
    matchesShortcut,
    parseShortcut,
    shortcutLabel,
} from "./ui/dom.ts";
import { viewportRect, watchFrames } from "./ui/frames.ts";
import { animationsOn, createFreezer } from "./ui/freeze.ts";
import { createPackageDialog } from "./ui/package-dialog.ts";
import { createPicker, type PickEvent, type Selection, toPageRect } from "./ui/picker.ts";
import { createPins, nextPinNumber } from "./ui/pins.ts";
import { createPopover } from "./ui/popover.ts";
import { createSettingsPanel } from "./ui/settings-panel.ts";
import { addSheet, setStyleNonce } from "./ui/sheet.ts";
import { STYLES } from "./ui/styles.ts";
import { type ConnectionState, createToolbar } from "./ui/toolbar.ts";
import { createVariants, VARIANT_ATTR, VARIANT_NAME_ATTR } from "./ui/variants.ts";
import { redactUrl } from "./url.ts";
import { SDK } from "./version.ts";

export interface NotatoController {
    setAnnotateMode(on: boolean): void;
    annotate(args: AnnotateArgs): Promise<Annotation>;
    list(): Annotation[];
    /** Builds the bundle zip; with `send`, also hands it to the sinks (download, upload). */
    package(options?: {
        send?: boolean;
        name?: string;
    }): Promise<PackagedBundle & { zip: Uint8Array }>;
    destroy(): void;
}

/** Standard base64 of raw bytes, in chunks so large zips do not overflow the call stack. */
function toBase64(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
        out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(out);
}

declare global {
    interface Window {
        /** Notes not yet on the server when the toolbar was torn down (HMR, StrictMode), for the one that follows. */
        __notatoUnsent?: { key: string; items: Array<Queued & { refused?: string }> };
    }
}

/** A field the page's user types into, where Alt and Shift combinations type characters and move the caret. */
const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
function isEditable(target: EventTarget | undefined): boolean {
    if (!target || (target as Node).nodeType !== 1) return false;
    const el = target as HTMLElement;
    const tag = el.localName;
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") return TEXT_INPUTS.has((el.getAttribute("type") ?? "").toLowerCase());
    return (
        el.isContentEditable ||
        el.closest('[contenteditable]:not([contenteditable="false"])') !== null
    );
}

const isIdentity = (p: NotatoPlugin): p is IdentityPlugin => "resolve" in p;
const isCapture = (p: NotatoPlugin): p is CapturePlugin => "capture" in p;
const isSink = (p: NotatoPlugin): p is SinkPlugin => "deliver" in p;

/** Built-ins first; a user plugin with the same id takes the built-in's place. */
export function mergePlugins<T extends { id: string }>(defaults: T[], extra: T[]): T[] {
    const out = [...defaults];
    for (const plugin of extra) {
        const at = out.findIndex((p) => p.id === plugin.id);
        if (at >= 0) out[at] = plugin;
        else out.push(plugin);
    }
    return out;
}

export function unionPageRect(elements: Element[]): Rect {
    const rects = elements.map((e) => toPageRect(viewportRect(e)));
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const right = Math.max(...rects.map((r) => r.x + r.w));
    const bottom = Math.max(...rects.map((r) => r.y + r.h));
    return { x, y, w: right - x, h: bottom - y };
}

/** A label for the element under the pointer, short enough for one line. */
const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The label over the element the pointer is on, worked out for every element the pointer crosses: only what is cheap
 * to read (its role, its name, its test id), never the full identity, which is worked out for what is picked.
 */
export function hoverLabel(el: Element, testIdAttributes = DEFAULT_TEST_ID_ATTRIBUTES): string {
    const kind = roleOf(el) ?? el.tagName.toLowerCase();
    const named = accessibleName(el);
    // Text only names small elements: a container's whole text is noise in a one-line label.
    const text = named ? undefined : safeText(el, 61).replace(/\s+/g, " ").trim();
    const name = named ?? (text && text.length <= 60 ? text : undefined);
    const testId = testIdOf(el, testIdAttributes);
    const base = name ? `${kind} “${clip(name, 40)}”` : kind;
    return testId ? `${base} · ${clip(testId, 40)}` : base;
}

export function createController(props: NotatoProps): NotatoController {
    window.__notatoDestroy?.();
    setTransport(props.transport);
    setStyleNonce(props.nonce);

    const mode = props.mode ?? "dev";
    const hashRoutes = props.hashRoutes ?? false;
    const userPlugins = props.plugins ?? [];
    const currentRoute = () => routeString(window.location, hashRoutes);

    // What this person has chosen for themselves in this browser (the settings panel). The server's own settings win.
    const settings = createSettings();
    /** A plugin that does nothing while its setting is off, so the panel can turn it on and off live. */
    const whileOn = (plugin: IdentityPlugin, on: () => boolean): IdentityPlugin => ({
        ...plugin,
        resolve: (el) => (on() ? plugin.resolve(el) : {}),
    });
    const identity = mergePlugins<IdentityPlugin>(
        [
            domIdentityPlugin({ testIdAttributes: props.testIdAttributes }),
            whileOn(reactSourceIdentityPlugin(), () => settings.get().components),
            whileOn(angularIdentityPlugin(), () => settings.get().components),
            sourceAttributeIdentityPlugin(),
            ...(props.styles === false
                ? []
                : [whileOn(stylesIdentityPlugin(), () => settings.get().styles)]),
        ],
        userPlugins.filter(isIdentity)
    );
    // What the server allows, asked before each screenshot; this page's own `screenshots` prop can only narrow it.
    const policy = createPolicy({ baseUrl: props.server?.replace(/\/$/, ""), token: props.token });
    const screenshotsOn = async () =>
        props.screenshots !== false && settings.get().screenshots && (await policy.screenshots());
    const capture = mergePlugins<CapturePlugin>(
        [
            routePlugin({ hash: hashRoutes }),
            screenshotPlugin({ maskInputs: props.maskInputs, enabled: screenshotsOn }),
            animationsPlugin(),
            // An agent's annotation says how it got there; people do not need that recorded.
            ...(mode === "agent"
                ? [stepsPlugin({ testIdAttributes: props.testIdAttributes })]
                : []),
        ],
        userPlugins.filter(isCapture)
    );
    const server = props.server?.replace(/\/$/, "");
    // Dev and agent mode post each annotation as it is made; test mode sends only packaged bundles.
    const live = Boolean(server) && mode !== "test";
    const sink =
        server && live
            ? serverSink({
                  baseUrl: server,
                  project: props.project,
                  token: props.token,
                  onPending: () => describeConnection(),
                  onSent: (id) => {
                      if (kept.has(id)) persistence?.setUnsent(id, null).catch(copyFailed);
                      release(id);
                  },
                  onRefused: (id, message) => {
                      if (kept.has(id))
                          persistence?.setUnsent(id, { refused: message }).catch(copyFailed);
                      toast.show(`The server refused a note: ${message}`, 6000);
                      syncUi(); // its pin and card say so
                  },
                  onProblem: (message) => {
                      describeConnection();
                      if (message) toast.show(`Notes are waiting: ${message}`, 6000);
                  },
              })
            : undefined;
    const modeSinks: SinkPlugin[] = [
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
    ];
    const sinks = mergePlugins<SinkPlugin>(modeSinks, userPlugins.filter(isSink));
    // The page holds the only copy in test and agent mode, so it must survive a reload. Kept per mode so a
    // tester's notes never end up in an agent's bundle.
    const persistence =
        (props.persist ?? mode !== "dev") ? createIdbPersistence(`${props.project}:${mode}`) : null;
    /** The notes this page made that are kept in this browser: the server's changes to them are kept too. */
    const kept = new Set<string>();
    const authorName = () => props.author ?? (settings.get().name || undefined);

    const store = createMemoryStore();
    /**
     * In dev mode the server keeps a note's screenshots, and nothing in the page shows them again: once it has them, the
     * page lets them go rather than hold them for as long as it is open. Test and agent mode keep them for the zip.
     */
    const release = (id: string) => {
        if (mode === "dev") store.get(id)?.assets.clear();
    };
    /** After a note made here is in the store: its screenshots go if the server already has them. */
    const releaseIfSent = (id: string) => {
        if (sink && !sink.unsent().includes(id)) release(id);
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
    const warn = (message: string, error?: unknown) =>
        console.warn(`[notato] ${message}`, error ?? "");
    const copyFailed = (error: unknown) => warn("could not update this browser's copy", error);

    const pipeline = createPipeline({
        mode,
        projectId: props.project,
        appName: props.appName,
        appVersion: props.appVersion,
        author: () => ({ kind: "human", name: authorName() }),
        identity,
        capture,
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

    // ---- shadow root ------------------------------------------------------------------------------------
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

    const describe = (el: Element): string => {
        const id: Record<string, unknown> = {};
        for (const plugin of identity) {
            try {
                Object.assign(id, plugin.resolve(el));
            } catch {
                // a failing plugin only costs the label some detail
            }
        }
        const label = (id.role as string | undefined) ?? el.tagName.toLowerCase();
        // Text only labels small elements; a container's whole text is noise in a one-line label.
        const text = id.text as string | undefined;
        const name =
            (id.name as string | undefined) ?? (text && text.length <= 60 ? text : undefined);
        const component = (id.component as { name: string } | undefined)?.name;
        const base = name
            ? `${label} “${name.length > 40 ? `${name.slice(0, 39)}…` : name}”`
            : label;
        return component ? `${base} in <${component}>` : base;
    };

    // ---- state ------------------------------------------------------------------------------------------
    let draft: Selection | null = null;

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
    /** The coding agents connected to the server, by name, as it last said (see sync.ts). */
    let agentNames: string[] = [];
    /** The agent's name when exactly one is connected: the cards and the switcher say who they are asking. */
    const agentName = () => (agentNames.length === 1 ? agentNames[0] : undefined);
    const pins = createPins({
        layer,
        records: shown,
        currentRoute,
        onDelete: (id) => void deleteAnnotation(id),
        // Asking the agent to undo a change only means something when there is a server it can read the request from.
        onRequestRevert:
            server && live
                ? (id, note) =>
                      changeStatus(id, "revert_requested", note || "Please revert this change.")
                : undefined,
        onCancelRevert:
            server && live
                ? (id) => changeStatus(id, "resolved", "Revert request cancelled.")
                : undefined,
        // Choosing between versions, and asking for different ones, are conversations with the agent through the server.
        fallbackAnchor: (a) => (a.variants ? variants.anchor(a.variants.group) : null),
        onTakeBackVariant: server && live ? (id) => chooseVariant(id, null) : undefined,
        onReply: server && live ? (id, note, aside) => replyInThread(id, note, aside) : undefined,
        // Live with a server, or kept here with none; a server that cannot be reached cannot record it.
        onPeopleOnly: !server || live ? (id, on) => setPeopleOnly(id, on) : undefined,
        agentName: () => agentName(),
        refusal: (id) => sink?.refusal(id),
    });
    const popover = createPopover(layer);
    const packageDialog = createPackageDialog(layer);
    const shortcut = props.shortcut ?? "Alt+Shift+KeyA";
    const parsedShortcut = parseShortcut(shortcut);
    const annotateKeys = shortcutLabel(shortcut);
    const pauseKeys = shortcutLabel("Alt+Shift+KeyP");

    const toolbar = createToolbar({
        position: props.position ?? "bottom-right",
        shortcutLabel: annotateKeys,
        onToggleAnnotate: () => setAnnotateMode(!picker.active),
        onTogglePins: (visible) => {
            pins.setVisible(visible);
        },
        onCollapse: () => {
            if (copyMenu.isOpen) copyMenu.close();
            if (settingsPanel.isOpen) settingsPanel.close();
        },
    });
    layer.append(toolbar.el);
    // Pause freezes animations, transitions and media where they are, so the moment can be annotated.
    const pauseButton = toolbar.addButton({
        label: "",
        title: `Pause animations (${pauseKeys})`,
        icon: ICONS.pause,
        className: "tb-pause",
        onClick: () => freezer.toggle(),
    });
    const freezer = createFreezer(
        () => frames.windows(),
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
    const copyMenu = createCopyMenu(layer, () => lastDetail());
    const toast = createToast(layer);
    const settingsButton = toolbar.addButton({
        label: "",
        title: "Settings",
        icon: ICONS.gear,
        onClick: () => {
            if (hidden) return;
            settingsPanel.toggle();
        },
    });
    // Markdown at four levels and, in test and agent mode, a zip of the lot.
    const exportButton = toolbar.addButton({
        label: "",
        title: "Export: copy as Markdown, or download a zip",
        icon: ICONS.export,
        onClick: () => {
            const r = exportButton.el.getBoundingClientRect();
            if (copyMenu.isOpen) return copyMenu.close();
            const all = store.list().length;
            copyMenu.open(
                { left: r.left, top: r.top, width: r.width, height: r.height },
                (detail) => void copyAnnotations(detail),
                {
                    count: countOnRoute(),
                    zip:
                        mode === "dev"
                            ? undefined
                            : {
                                  description: `${all} note${all === 1 ? "" : "s"} with screenshots and a feedback.md${mode === "test" && server ? ", also sent to the server" : ""}`,
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
    /** Hidden until the page is reloaded (or annotate mode is asked for again). */
    let hidden = false;
    const setHidden = (next: boolean) => {
        hidden = next;
        host.style.display = next ? "none" : "";
        if (next) setAnnotateMode(false);
    };
    const settingsPanel = createSettingsPanel({
        layer,
        settings,
        anchor: () => {
            const r = settingsButton.el.getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, height: r.height };
        },
        serverScreenshots: () => policy.screenshotsNow(),
        onHide: () => setHidden(true),
        onToggle: (open) => settingsButton.setExpanded(open),
        owner: () => settingsButton.el,
        server:
            server && live
                ? {
                      url: server,
                      project: props.project,
                      connection: () => connection,
                      status: async () => {
                          try {
                              const res = await net.fetch(`${server}/status`, {
                                  headers: authHeaders(props.token),
                              });
                              if (!res.ok) return null;
                              const body = (await res.json()) as {
                                  version?: string;
                                  mode?: string;
                                  pages?: number;
                                  config?: { screenshots?: "on" | "off" };
                                  agents?: {
                                      connected?: boolean;
                                      watching?: boolean;
                                      names?: string[];
                                  };
                              };
                              return {
                                  version: body.version,
                                  mode: body.mode,
                                  pages: body.pages,
                                  screenshots: body.config?.screenshots,
                                  agent: body.agents
                                      ? {
                                            connected: Boolean(body.agents.connected),
                                            watching: Boolean(body.agents.watching),
                                            names: body.agents.names,
                                        }
                                      : undefined,
                              };
                          } catch {
                              return null;
                          }
                      },
                  }
                : undefined,
    });

    const picker = createPicker({
        host,
        layer,
        describe: (el) => hoverLabel(el, props.testIdAttributes),
        onPick,
    });

    let connection: ConnectionState = "connecting";
    function describeConnection() {
        // Only dev and agent mode keep a live connection; test mode just uploads a bundle on request.
        if (!server || !live) return;
        const waiting = sink?.pending() ?? 0;
        const problem = sink?.problem();
        const unsent = waiting
            ? ` ${waiting} annotation${waiting === 1 ? "" : "s"} waiting to be sent.${problem ? ` The server said: ${problem}` : ""}`
            : "";
        const title =
            connection === "connected"
                ? `Notato server connected (${server}).${unsent}`
                : connection === "connecting"
                  ? `Connecting to the Notato server (${server})…${unsent}`
                  : `Cannot reach the Notato server (${server}). Annotations are kept in this page and sent when it is back.${unsent}`;
        toolbar.setConnection(connection, title);
    }
    const sync =
        server && live
            ? createServerSync({
                  baseUrl: server,
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
                  onApplied: ({ updated, removed }) => {
                      for (const a of updated)
                          if (kept.has(a.id)) persistence?.update(a).catch(copyFailed);
                      for (const id of removed)
                          if (kept.delete(id)) persistence?.remove(id).catch(copyFailed);
                  },
              })
            : undefined;
    void policy.refresh();
    describeConnection();

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

    function anchorOf(sel: Selection) {
        return {
            left: sel.rect.x - window.scrollX,
            top: sel.rect.y - window.scrollY,
            width: sel.rect.w,
            height: sel.rect.h,
        };
    }

    function popoverText(sel: Selection) {
        const targets = sel.elements.map(describe);
        if (sel.kind === "text") {
            const quote = sel.selectedText ?? "";
            return {
                title: "Text selection",
                targets: [`“${quote.length > 60 ? `${quote.slice(0, 59)}…` : quote}”`, ...targets],
            };
        }
        if (sel.kind === "area") return { title: "Area", targets: [`in ${targets[0] ?? "page"}`] };
        return {
            title: sel.elements.length > 1 ? `${sel.elements.length} elements` : "1 element",
            targets,
        };
    }

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
        const text = popoverText(sel);
        const hintNow = () => {
            const add =
                sel.kind === "element" || sel.kind === "multi"
                    ? "Cmd/Ctrl-click adds or removes elements."
                    : undefined;
            const off =
                props.screenshots === false ||
                !settings.get().screenshots ||
                !policy.screenshotsNow();
            const moving = sel.elements.flatMap((e) => animationsOn(e)).slice(0, 3);
            const animating = moving.length
                ? `Animating: ${moving
                      .map(
                          (a) =>
                              `${a.name ?? a.property ?? a.kind}${a.duration !== undefined ? ` ${Math.round(a.duration)}ms` : ""}${a.progress !== undefined ? ` (${a.state} at ${Math.round(a.progress * 100)}%)` : ""}`
                      )
                      .join(", ")}.${freezer.frozen ? "" : " Pause first to annotate a frame."}`
                : undefined;
            return (
                [
                    add,
                    animating,
                    off ? "No screenshot will be taken: they are turned off." : undefined,
                ]
                    .filter(Boolean)
                    .join(" ") || undefined
            );
        };
        if (popover.isOpen) {
            popover.update({ ...text, anchor: anchorOf(sel), hint: hintNow() });
            return;
        }
        // The server's setting can change at any time, so ask again as the popover opens and correct the line if it did.
        void policy.refresh().then(() => {
            if (popover.isOpen) popover.update({ hint: hintNow() });
        });
        popover.open({
            ...text,
            // Versions are put in the code by the agent, which is on the other end of a server.
            variants: Boolean(server && live),
            hint: hintNow(),
            anchor: anchorOf(sel),
            onCancel: closeDraft,
            onSave: async ({ comment, severity, intent, peopleOnly }) => {
                const current = draft;
                if (!current) return;
                await oneAtATime(async () => {
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
                    store.add(record);
                    keep(record);
                    releaseIfSent(record.annotation.id);
                });
                closeDraft();
            },
        });
    }

    // ---- keeping pins attached ----------------------------------------------------------------------------
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
        variants.schedule();
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
        layer.style.setProperty("--pf-accent", color.hex);
    };
    applyColor();
    const unsubscribeSettings = settings.subscribe(() => {
        shownNow = undefined;
        applyColor();
        syncUi(); // "only my notes" and a changed name change which pins there are
    });

    const reposition = () => {
        pins.schedule();
        popover.reposition();
        variants.schedule();
    };
    const pauseShortcut = parseShortcut("Alt+Shift+KeyP");
    const nextVariant = parseShortcut("Alt+Shift+ArrowRight");
    const previousVariant = parseShortcut("Alt+Shift+ArrowLeft");
    const lastDetail = (): Detail => settings.get().copyDetail;
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
                ? `Copied ${list.length} annotation${list.length === 1 ? "" : "s"} as Markdown (${detail})`
                : "Could not copy: the browser blocked the clipboard"
        );
    }
    const onKey = (ev: KeyboardEvent) => {
        if (ev.composedPath().includes(host)) return;
        // In a field, Alt and Shift with a key type a character (⌥⇧A is Å on a Mac) or select by word: the keys are
        // the field's. A shortcut with Ctrl or Cmd in it types nothing, so it still works there.
        const typing = isEditable(ev.composedPath()[0]);
        const ours = (combo: ReturnType<typeof parseShortcut>) =>
            matchesShortcut(ev, combo) && (!typing || combo.ctrl || combo.meta);
        if (ours(parsedShortcut)) {
            ev.preventDefault();
            setAnnotateMode(!picker.active);
        } else if (ours(pauseShortcut)) {
            ev.preventDefault();
            freezer.toggle();
        } else if (ours(nextVariant) || ours(previousVariant)) {
            // Only when there is something to switch between; otherwise the keys are the page's.
            if (variants.list().length === 0) return;
            ev.preventDefault();
            const shown = variants.step(matchesShortcut(ev, nextVariant) ? 1 : -1);
            if (shown) {
                const at = shown.options.indexOf(shown.active) + 1;
                toast.show(`Showing “${shown.active}” (${at} of ${shown.options.length})`);
            }
        } else if (ev.key === "Escape" && picker.active) {
            // Ours: do not let it also close the modal underneath.
            ev.preventDefault();
            ev.stopPropagation();
            if (popover.isOpen) closeDraft();
            else setAnnotateMode(false);
        }
    };
    /**
     * What the page watchers listen for. Elements coming and going, and the attributes that move things on the page or
     * say what an element is: any other attribute (an `aria-busy`, a `data-` value an app keeps state in) moves nothing,
     * and on a busy app changes many times a second.
     */
    const identityAttributes = ["id", ...(props.testIdAttributes ?? DEFAULT_TEST_ID_ATTRIBUTES)];
    const WATCHED = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
            "class",
            "style",
            "hidden",
            "open",
            VARIANT_ATTR,
            VARIANT_NAME_ATTR,
            ...identityAttributes,
        ],
    };
    const onPageChange = (records: MutationRecord[]) => {
        // Elements came or went, or one changed what it answers to: the pins look for theirs again, as far as needed.
        let changed = false;
        const touched: Element[] = [];
        for (const r of records) {
            if (r.type === "childList") {
                changed = true;
                for (const node of Array.from(r.addedNodes))
                    if (node.nodeType === 1) touched.push(node as Element);
            } else if (r.attributeName !== null && identityAttributes.includes(r.attributeName)) {
                changed = true;
                touched.push(r.target as Element);
            }
        }
        if (changed) pins.domChanged(touched);
        reposition();
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    // Versions an agent has put in the page for the person to compare: a switcher over each, and a pick to send back.
    const variants = createVariants({
        layer,
        windows: () => frames.windows(),
        annotations: () => store.list().map((r) => r.annotation),
        namespace: props.project,
        onChoose: server && live ? (id, name) => chooseVariant(id, name) : undefined,
        agentName: () => agentName(),
    });
    // Pins that sit inside an iframe move when that frame scrolls, resizes or changes, which the page never hears of.
    const frames = watchFrames(window, (win) => {
        if (win === window) return undefined;
        win.addEventListener("scroll", reposition, true);
        win.addEventListener("resize", reposition);
        const watch = new MutationObserver(onPageChange);
        watch.observe(win.document, WATCHED);
        pins.domChanged(); // pins that point into this frame can find their elements now
        return () => {
            win.removeEventListener("scroll", reposition, true);
            win.removeEventListener("resize", reposition);
            watch.disconnect();
        };
    });
    window.addEventListener("keydown", onKey, true);
    const mutations = new MutationObserver(onPageChange);
    mutations.observe(document.body, WATCHED);
    const resizes = new ResizeObserver(reposition);
    resizes.observe(document.documentElement);

    const onRouteChange = () => {
        syncUi();
        reposition();
    };
    const stopHistory = onHistoryChange(onRouteChange);
    window.addEventListener("popstate", onRouteChange);
    window.addEventListener("hashchange", onRouteChange);

    // ---- packaging and deleting ---------------------------------------------------------------------------
    async function deleteAnnotation(id: string) {
        try {
            // Not sent yet: it must not go out after all, and there is nothing on the server to delete. One on its way is
            // waited for, so the delete comes after it.
            if (sink && (await sink.discard(id))) {
                const res = await net.fetch(`${server}/annotations/${encodeURIComponent(id)}`, {
                    method: "DELETE",
                    headers: authHeaders(props.token),
                });
                if (!res.ok && res.status !== 404)
                    throw new Error(`the server answered ${res.status}`);
            }
            store.remove(id);
            kept.delete(id);
            await persistence?.remove(id);
        } catch (error) {
            warn("could not delete the annotation", error);
        }
    }

    /** A request to the server as the person. Rejects with a message fit to show. */
    async function asPerson(path: string, method: string, body: Record<string, unknown>) {
        if (!server || !live) throw new Error("Not connected to the Notato server.");
        const since = sync?.mark() ?? 0;
        let res: Response;
        try {
            res = await net.fetch(`${server}${path}`, {
                method,
                headers: { "content-type": "application/json", ...authHeaders(props.token) },
                body: JSON.stringify({ ...body, author: { kind: "human", name: authorName() } }),
            });
        } catch {
            throw new Error("Cannot reach the Notato server.");
        }
        if (!res.ok) {
            const detail = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(detail?.error ?? `The server answered ${res.status}.`);
        }
        // The server answers with the note as it is now, which makes the card right straight away. (It also pushes the
        // change.) Only an answer that is not a note, from an older server, has the list read again for it.
        const answer = (await res.json().catch(() => null)) as { annotation?: unknown } | null;
        if (sync && !sync.apply(answer?.annotation, since)) await sync.refresh().catch(() => {});
    }

    /** Moves an annotation to a status on the server, as the person. */
    const changeStatus = (id: string, status: "revert_requested" | "resolved", note: string) =>
        asPerson(`/annotations/${encodeURIComponent(id)}`, "PATCH", { status, note });

    /** Picks one of the versions an agent offered, or (with `null`) takes the pick back. */
    const chooseVariant = (id: string, name: string | null) =>
        asPerson(`/annotations/${encodeURIComponent(id)}/variants/choose`, "POST", { name });

    /** Writes in an annotation's thread as the person; an aside is for the people on it, kept from the agent. */
    const replyInThread = (id: string, body: string, aside = false) =>
        asPerson(`/annotations/${encodeURIComponent(id)}/replies`, "POST", {
            body,
            ...(aside ? { aside } : {}),
        });

    /**
     * Turns People only on or off: on the server, which records the change in the thread, or with no server (test mode)
     * here, recording it the same way, so a bundle carries it.
     */
    const setPeopleOnly = async (id: string, on: boolean) => {
        if (server)
            return asPerson(`/annotations/${encodeURIComponent(id)}`, "PATCH", { peopleOnly: on });
        store.update(id, (a) => {
            const { peopleOnly: _was, ...rest } = a;
            return {
                ...rest,
                ...(on ? { peopleOnly: true } : {}),
                thread: [...a.thread, peopleOnlyRecord(on, authorName())],
            };
        });
    };

    async function packageBundle(options: { send?: boolean; name?: string } = {}) {
        const records = store.list();
        if (records.length === 0)
            throw new Error("nothing to package yet: make at least one annotation");
        const { bundle, assets } = buildBundle(records, {
            projectId: props.project,
            author: { name: options.name ?? authorName() },
            appName: props.appName,
            appVersion: props.appVersion,
        });
        const delivery: PackagedBundle["delivery"] = [];
        if (options.send) {
            const results = await Promise.allSettled(sinks.map((s) => s.deliver(bundle, assets)));
            results.forEach((r, i) => {
                const id = sinks[i]?.id ?? "unknown";
                if (r.status === "fulfilled") delivery.push({ sink: id, ok: true });
                else
                    delivery.push({
                        sink: id,
                        ok: false,
                        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
                    });
            });
        }
        const zip = await bundleToZip(bundle, assets);
        return {
            bundleId: bundle.id,
            filename: bundleFilename(props.project),
            annotations: records.length,
            zipBase64: "",
            zip,
            delivery,
        };
    }

    function openPackageDialog() {
        const records = store.list();
        if (records.length === 0) return;
        packageDialog.open({
            count: records.length,
            routes: new Set(records.map((r) => r.annotation.route)).size,
            destination: mode === "test" ? (server ?? null) : null,
            name: authorName() ?? "",
            // Notes that live on a server would only come back from it: there is nothing to remove from here.
            clearable: !(server && live),
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
                    kept.clear();
                    await persistence?.clear();
                }
                const upload = result.delivery.find((d) => d.sink === "server" && !d.ok);
                return upload
                    ? `Downloaded ${result.filename}, but it was not uploaded: ${upload.error}`
                    : `Downloaded ${result.filename}: ${result.annotations} annotation${result.annotations === 1 ? "" : "s"}.`;
            },
        });
    }

    // ---- window.__notato ---------------------------------------------------------------------------------
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
            const record: AnnotationRecord = await pipeline.create({
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
            store.add(record);
            keep(record);
            releaseIfSent(record.annotation.id);
            return record.annotation;
        });
    }

    /** Runs an annotate request relayed from `notato_annotate` and reports the outcome to the server. */
    async function answerRelay(request: AnnotateRequest) {
        let outcome: { ok: true; annotationId: string } | { ok: false; error: string };
        try {
            const annotation = await annotate(request.args);
            outcome = { ok: true, annotationId: annotation.id };
        } catch (error) {
            outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        try {
            await net.fetch(`${server}/relay/${encodeURIComponent(request.requestId)}/result`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders(props.token) },
                body: JSON.stringify(outcome),
            });
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
            const items = [
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
        stopHistory();
        window.removeEventListener("popstate", onRouteChange);
        window.removeEventListener("hashchange", onRouteChange);
        freezer.destroy();
        variants.destroy();
        copyMenu.destroy();
        toolbar.destroy();
        toast.destroy();
        frames.destroy();
        window.removeEventListener("scroll", reposition, true);
        window.removeEventListener("resize", reposition);
        window.removeEventListener("keydown", onKey, true);
        mutations.disconnect();
        resizes.disconnect();
        unsubscribe();
        if (uiFrame) cancelAnimationFrame(uiFrame);
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

    // ---- what this page had before ------------------------------------------------------------------------
    /** Keeps a note this page made in this browser, marked unsent while the server does not have it. */
    function keep(record: AnnotationRecord) {
        if (!persistence) return;
        const id = record.annotation.id;
        kept.add(id);
        const refused = sink?.refusal(id);
        persistence
            .save(record, { unsent: sink ? sink.unsent().includes(id) : undefined })
            .then(() => (refused ? persistence.setUnsent(id, { refused }) : undefined))
            .catch((error) => warn("could not save the annotation in this browser", error));
    }

    /** Takes back notes from before: a remount's that had not been sent, then what this browser kept. */
    function adopt(items: Array<Queued & { refused?: string }>) {
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
        if (!persistence) return;
        try {
            const [records, unsent] = await Promise.all([persistence.load(), persistence.unsent()]);
            if (destroyed) return;
            const waiting: Array<Queued & { refused?: string }> = [];
            for (const record of records) {
                kept.add(record.annotation.id);
                const state = sink && unsent.get(record.annotation.id);
                if (state) waiting.push({ ...record, refused: state.refused });
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

    return { setAnnotateMode, annotate, list, package: packageBundle, destroy };
}
