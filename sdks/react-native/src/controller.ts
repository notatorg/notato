import type { AgentStep, Annotation, Author, Intent, Severity } from "@notato/schema";
import {
    buildAnnotation,
    type DeviceInfo,
    type NetworkEntry,
    settingPeopleOnly,
} from "./annotation.ts";
import { writeBundle } from "./bundle.ts";
import type { Shot } from "./capture.ts";
import {
    type Connection,
    httpTransport,
    NotatoError,
    type RelayResult,
    type StoredAnnotation,
    type Transport,
} from "./client.ts";
import {
    configProblem,
    hostOf,
    isHttpUrl,
    type NotatoConfig,
    type NotatoMode,
    normalizeServer,
    type Resolved,
    resolveConfig,
} from "./config.ts";
import type { ServerEvent } from "./events.ts";
import { identityOf } from "./identity.ts";
import { ulid } from "./ids.ts";
import type { Picked } from "./inspect.ts";
import { captureConsole, type LogEntry } from "./logs.ts";
import { type NoteEdit, type NoteRecord, NoteStore, type NumberedNote } from "./notes.ts";
import { parseComponentStack, symbolicate } from "./stack.ts";
import {
    type LocalNote,
    memoryStorage,
    type NotatoStorage,
    type StorageProvider,
} from "./storage.ts";

/** How Notato stands with its server. */
export type ConnectionState =
    /** Notato is switched off. */
    | "disabled"
    /** No server: notes stay on the device (test mode) until packaged. */
    | "local"
    | "connecting"
    | "connected"
    /** The server cannot be reached. Notes are kept and sent when it can. */
    | "offline"
    /** The server refused this app (a missing or wrong token, a project the token cannot use). */
    | "refused";

/** Notato's state, as `useNotato()` gives it. A new object on every change. */
export interface NotatoState {
    /** Whether Notato is on: the overlay is drawn and the connection open. */
    enabled: boolean;
    toolbarVisible: boolean;
    /** The next tap selects what is under it. */
    annotating: boolean;
    pinsVisible: boolean;
    connection: ConnectionState;
    /** The last connection problem, fit to show to a person. */
    connectionDetail?: string;
    /** Why Notato cannot start (a bad project id, say). */
    problem?: string;
    /** The project's notes, from the server and from this device, in the order Notato came to know them. */
    notes: readonly NoteRecord[];
    /** Notes made here that have not reached the server yet. */
    pendingCount: number;
    /** The agents connected to the project, by name. */
    agents: readonly string[];
    /** False when the server has screenshots turned off. */
    serverScreenshots: boolean;
    mode: NotatoMode;
    project?: string;
    /** The server notes go to, or none. */
    server?: string;
    /** The name on this person's notes. */
    author?: string;
    /** Whether this person wants screenshots (the server can still say no). */
    screenshots: boolean;
    /** Where the person left the toolbar (fractions of the room it has), and whether it is folded. */
    toolbar: { x?: number; y?: number; folded: boolean };
}

/** Optional details for `notato.annotate`. */
export interface AnnotateOptions {
    severity?: Severity;
    intent?: Intent;
    /** Recorded as this agent's note when set; a person's otherwise. */
    agentName?: string;
    steps?: AgentStep[];
    /** Take a screenshot (when allowed). Default true. */
    screenshot?: boolean;
    /** People only: the note and its thread stay between people. A person's note only. */
    peopleOnly?: boolean;
}

/** What a note says, as the composer or `annotate` hands it over. */
type NoteDraft = Omit<AnnotateOptions, "screenshot"> & { comment: string };

/** What the overlay does for the runtime: it knows the app's views and draws over them. */
export interface Host {
    /** The element a selector (`ProductCard > Text#price`) or a view's instance names, inspected. Throws when none. */
    resolve(target: string | object): Promise<Picked>;
    /** The screenshots for a note: the screen with the element outlined and numbered, and a crop of it. */
    capture(picked: Picked, pin: number, id: string): Promise<{ full?: Shot; crop?: Shot }>;
    /** Opens the composer on an element, as a tap would. */
    select(picked: Picked): void;
    /** The screen the person is on. */
    route(): string;
    device(): DeviceInfo;
    toast(message: string): void;
}

/** What a person chose at runtime, kept across launches unless `rememberRuntimeState` is off. */
interface Settings {
    enabled?: boolean;
    toolbarVisible?: boolean;
    author?: string;
    server?: string;
    screenshots?: boolean;
    pinsVisible?: boolean;
    toolbarX?: number;
    toolbarY?: number;
    folded?: boolean;
}

/** An annotate request relayed from the agent (`notato_annotate`). */
interface AnnotateRequest {
    requestId: string;
    args: {
        target: string;
        comment: string;
        severity?: Severity;
        intent?: Intent;
        steps?: AgentStep[];
        author?: string;
    };
}

/** What came of sending a note. */
type SendOutcome =
    | { kind: "sent" }
    /** The server will never take it as it is: marked failed, kept, and the notes after it still go. */
    | { kind: "refused"; reason: string }
    /** Not now: no connection, or the server answered and did not take it. It and the notes after it wait. */
    | { kind: "held"; error: NotatoError }
    /** Nothing was sent: no server, or it was sent, refused or deleted already, or is on its way. */
    | { kind: "skipped" };

/** What to tell the person who just made the note, or undefined when it went. */
function problemOf(outcome: SendOutcome): string | undefined {
    switch (outcome.kind) {
        case "refused":
            return `The server refused it: ${outcome.reason}`;
        case "held":
            return outcome.error.status === undefined
                ? "Saved. It's sent when the server can be reached."
                : `Saved on this device, not sent: ${outcome.error.message}`;
        default:
            return undefined;
    }
}

/** A change the server's events bring: a note as it is now, or one it deleted. */
type Change = { annotation: Annotation } | { deleted: string };

/** How many of the app's recorded requests later notes carry: the newest. */
const NETWORK_LIMIT = 50;

/** How long the server's changes are gathered before they are applied together: about a frame. */
const BATCH_MS = 16;

/** A reason as the end of a sentence. */
const sentence = (reason: string) => reason.replace(/\.?$/, ".");

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The ids of a note's screenshots. */
const screenshotIds = (annotation: Annotation) =>
    [annotation.screenshots?.full.id, annotation.screenshots?.crop?.id].filter(
        (id): id is string => !!id
    );

/**
 * Notato at runtime: one per app, `notato`. `<Notato>` configures it; the app can switch it on and off, show the
 * toolbar, select an element or annotate one from code, and read its state with `useNotato()`. The overlay drives the
 * rest through the methods it alone calls (`configure`, `attachHost`, `createNote` and the like).
 */
export class NotatoController {
    private config?: Resolved;
    private provider?: StorageProvider;
    private storage: NotatoStorage = memoryStorage();
    private settings: Settings = {};
    /** The project whose notes kept on the device have been read in. */
    private loadedFor?: string;
    private readonly store = new NoteStore();
    /** The screenshots of notes not on the server yet, by id: read from here first, from storage after a restart. */
    private readonly assets = new Map<string, Uint8Array>();

    // What the state says.
    private enabled = false;
    private toolbarVisible = true;
    private annotating = false;
    private connection: ConnectionState = "disabled";
    private connectionDetail?: string;
    private problem?: string;
    private agents: string[] = [];
    private serverScreenshots = true;
    private snapshot: NotatoState;
    private readonly listeners = new Set<() => void>();

    /** The `<Notato>` mounted last: only it stops Notato when it goes. */
    private owner?: object;
    /** `<Notato>` went away: the next `configure` starts Notato again, even with the same options. */
    private detached = false;
    /** The overlay, while it is mounted. */
    private host?: Host;

    /**
     * Counts the connections Notato has opened. An answer that comes back after its connection was closed or replaced
     * (Notato switched off, another server) sees the count has moved on, and is dropped.
     */
    private generation = 0;
    private stream?: { stop(): void; retry(): void };
    /** Notes on their way to the server now, and what will come of it. */
    private readonly inflight = new Map<string, Promise<SendOutcome>>();
    /** Deleted here while a copy was on its way: the server's word of them is not taken back in. */
    private readonly deletedHere = new Set<string>();
    /** The server's changes not applied yet: those that come within a frame are applied together. */
    private incoming: Change[] = [];
    private applyTimer?: ReturnType<typeof setTimeout>;
    /** While the server's list is being read: the changes that came meanwhile, applied again over it. */
    private listing?: Change[];
    /** The agent's annotate requests, answered one at a time: two at once would photograph each other's outlines. */
    private relays: Promise<void> = Promise.resolve();

    /** The app's recent warnings and errors, while `captureLogs` has the console wrapped. */
    private readonly logs: LogEntry[] = [];
    private releaseConsole?: () => void;
    /** The requests the app recorded with `recordRequest`, the newest last. */
    private readonly network: NetworkEntry[] = [];

    constructor(private readonly transport: Transport = httpTransport) {
        this.snapshot = this.build();
    }

    // ---- state, for useSyncExternalStore ------------------------------------------------------------------------

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getState = (): NotatoState => this.snapshot;

    private build(): NotatoState {
        const c = this.config;
        return {
            enabled: this.enabled,
            toolbarVisible: this.toolbarVisible,
            annotating: this.annotating,
            pinsVisible: this.settings.pinsVisible ?? true,
            connection: this.connection,
            ...(this.connectionDetail ? { connectionDetail: this.connectionDetail } : {}),
            ...(this.problem ? { problem: this.problem } : {}),
            notes: this.store.all,
            pendingCount: this.store.pendingCount,
            agents: this.agents,
            serverScreenshots: this.serverScreenshots,
            mode: this.mode,
            ...(c ? { project: c.project } : {}),
            ...(this.server ? { server: this.server } : {}),
            ...(this.authorName ? { author: this.authorName } : {}),
            screenshots: this.screenshotsWanted,
            toolbar: {
                ...(this.settings.toolbarX !== undefined ? { x: this.settings.toolbarX } : {}),
                ...(this.settings.toolbarY !== undefined ? { y: this.settings.toolbarY } : {}),
                folded: this.settings.folded ?? false,
            },
        };
    }

    private emit() {
        this.snapshot = this.build();
        for (const listener of [...this.listeners]) listener();
    }

    // ---- what the rest of Notato reads ----------------------------------------------------------------------------

    get configuration(): Resolved | undefined {
        return this.config;
    }

    get mode(): NotatoMode {
        return this.config?.mode ?? "dev";
    }

    /** The server: one typed into settings, else the configuration's. */
    get server(): string | undefined {
        return this.settings.server ?? this.config?.server;
    }

    /** Whether notes go live to a server (not in test mode, which only uploads packages). */
    get hasServer(): boolean {
        return !!this.server && this.mode !== "test";
    }

    /** Whether notes get screenshots: the person wants them and the server takes them. */
    get screenshotsOn(): boolean {
        return this.screenshotsWanted && this.serverScreenshots;
    }

    get maskInputs(): boolean {
        return this.config?.maskInputs ?? false;
    }

    /** The server as people know it: `localhost:4747`. */
    get serverHost(): string | undefined {
        return this.server ? hostOf(this.server) : undefined;
    }

    private get authorName(): string | undefined {
        return this.settings.author ?? this.config?.author;
    }

    private get screenshotsWanted(): boolean {
        return this.settings.screenshots ?? this.config?.screenshots ?? true;
    }

    private get connectionInfo(): Connection | undefined {
        const c = this.config;
        return c && this.server ? this.connectionTo(c, this.server) : undefined;
    }

    /**
     * A connection to a server. The token goes only to the server the app was configured with: one typed into the
     * settings (a typo, someone else's) never gets it.
     */
    private connectionTo(config: Resolved, server: string): Connection {
        const own = config.server !== undefined && server === config.server;
        return {
            server,
            project: config.project,
            ...(own && config.token ? { token: config.token } : {}),
        };
    }

    private get me(): Author {
        return { kind: "human", ...(this.authorName ? { name: this.authorName } : {}) };
    }

    // ---- set-up --------------------------------------------------------------------------------------------------

    /** Called by `<Notato>` with its props: starts Notato, or restarts it when the project or server changed. */
    configure(config: NotatoConfig): void {
        const next = resolveConfig(config);
        const before = this.config;
        const same =
            before !== undefined &&
            before.project === next.project &&
            before.mode === next.mode &&
            before.server === next.server &&
            before.token === next.token &&
            this.provider === config.storage;
        const resumed = same && this.detached;
        this.config = next;
        this.detached = false;
        if (resumed && !this.problem) {
            // Mounted again with the same options (React's StrictMode runs effects twice; a parent remounted it):
            // Notato starts again where it was, with the notes it had.
            this.changeEnabled(this.settings.enabled ?? next.enabled, false);
            return;
        }
        if (same) {
            // Only options that need no restart changed (the app's name, masking, logs).
            this.syncConsole();
            this.emit();
            return;
        }
        this.stop();
        this.provider = config.storage;
        this.problem = configProblem(next);
        if (this.problem) {
            console.warn(`[notato] ${this.problem} Notato stays off.`);
            this.emit();
            return;
        }
        this.storage = this.openStorage(next.project);
        this.settings = next.rememberRuntimeState ? this.loadSettings() : {};
        this.store.replace([]);
        this.assets.clear();
        this.loadedFor = undefined;
        this.toolbarVisible = this.settings.toolbarVisible ?? next.showToolbar;
        this.changeEnabled(this.settings.enabled ?? next.enabled, false);
    }

    /**
     * Called by `<Notato>` when it mounts. Returns what it detaches with: a `<Notato>` that goes after another has
     * mounted (a remount, React's StrictMode) leaves Notato to the new one.
     */
    attach(): object {
        const owner = {};
        this.owner = owner;
        return owner;
    }

    /** Called when `<Notato>` unmounts: stops Notato, unless another `<Notato>` has mounted since. */
    detach(owner: object): void {
        if (owner !== this.owner) return;
        this.owner = undefined;
        this.stop();
        this.detached = true;
        this.emit();
    }

    /** The overlay, while it is mounted. */
    attachHost(host: Host): void {
        this.host = host;
    }

    /** The overlay unmounted: forgotten, unless another one has taken its place. */
    detachHost(host: Host): void {
        if (this.host === host) this.host = undefined;
    }

    /** The app's storage for a project, or memory when it has none (or opening it failed). */
    private openStorage(project: string): NotatoStorage {
        try {
            return this.provider?.open(project) ?? memoryStorage();
        } catch {
            return memoryStorage();
        }
    }

    private loadSettings(): Settings {
        try {
            return this.storage.loadSettings() as Settings;
        } catch {
            return {};
        }
    }

    /** Keeps the person's choices, when the app wants them kept. */
    private rememberSettings() {
        if (!this.config?.rememberRuntimeState) return;
        try {
            this.storage.saveSettings(this.settings as Record<string, unknown>);
        } catch {
            // a full disk: the choice holds for this run
        }
    }

    private stop() {
        this.closeStream();
        this.enabled = false;
        this.annotating = false;
        this.connection = "disabled";
        this.connectionDetail = undefined;
        this.syncConsole();
    }

    /** Wraps the console while Notato is on and `captureLogs` asks for it, and unwraps it otherwise. */
    private syncConsole() {
        const wanted = this.enabled && this.config?.captureLogs === true;
        if (wanted && !this.releaseConsole) {
            this.releaseConsole = captureConsole(() => this.config?.logLimit ?? 0, this.logs);
        } else if (!wanted && this.releaseConsole) {
            this.releaseConsole();
            this.releaseConsole = undefined;
        }
    }

    // ---- on and off ----------------------------------------------------------------------------------------------

    /** Switches Notato on. Remembered across launches unless `rememberRuntimeState` is off. */
    enable(): void {
        this.changeEnabled(true, true);
    }

    /** Switches Notato off: removes the overlay and closes the connection. Remembered like `enable()`. */
    disable(): void {
        this.changeEnabled(false, true);
    }

    /** `enable()` or `disable()`. */
    setEnabled(on: boolean): void {
        this.changeEnabled(on, true);
    }

    private changeEnabled(on: boolean, remember: boolean) {
        if (!this.config) return;
        if (on && this.problem) return;
        if (remember) {
            this.settings.enabled = on;
            this.rememberSettings();
        }
        if (on === this.enabled) {
            this.emit();
            return;
        }
        if (!on) {
            this.stop();
            this.emit();
            return;
        }
        this.enabled = true;
        this.syncConsole();
        this.loadLocal();
        this.restartSync();
        this.emit();
    }

    /** Forgets the choices made at runtime and goes back to the configuration. */
    resetRuntimeState(): void {
        const c = this.config;
        if (!c) return;
        const serverChanged = this.settings.server !== undefined;
        this.settings = {};
        this.rememberSettings();
        this.toolbarVisible = c.showToolbar;
        if (serverChanged) this.store.replace(this.store.all.filter((r) => r.pending));
        if (c.enabled !== this.enabled) this.changeEnabled(c.enabled, false);
        else if (this.enabled && serverChanged) this.restartSync();
        this.emit();
    }

    showToolbar(): void {
        this.setToolbar(true);
    }

    hideToolbar(): void {
        this.setToolbar(false);
    }

    private setToolbar(visible: boolean) {
        this.toolbarVisible = visible;
        this.settings.toolbarVisible = visible;
        if (!visible) this.annotating = false;
        this.rememberSettings();
        this.emit();
    }

    /** The next tap selects what is under it. */
    startAnnotating(): void {
        if (!this.enabled) return;
        this.annotating = true;
        this.emit();
    }

    stopAnnotating(): void {
        if (!this.annotating) return;
        this.annotating = false;
        this.emit();
    }

    togglePins(): void {
        this.settings.pinsVisible = !(this.settings.pinsVisible ?? true);
        this.rememberSettings();
        this.emit();
    }

    /** Where the toolbar was left, as fractions of the room it can move in. */
    placeToolbar(x: number, y: number): void {
        this.settings.toolbarX = Math.min(1, Math.max(0, x));
        this.settings.toolbarY = Math.min(1, Math.max(0, y));
        this.rememberSettings();
        this.emit();
    }

    setFolded(folded: boolean): void {
        this.settings.folded = folded;
        this.rememberSettings();
        this.emit();
    }

    /**
     * The settings sheet's Save. A server that is not http(s) is not taken. Returns what to tell the person, if
     * anything.
     */
    saveSettings(input: {
        name: string;
        screenshots: boolean;
        server: string;
    }): string | undefined {
        const name = input.name.trim();
        if (name) this.settings.author = name;
        else delete this.settings.author;
        if (input.screenshots === (this.config?.screenshots ?? true))
            delete this.settings.screenshots;
        else this.settings.screenshots = input.screenshots;
        const typed = normalizeServer(input.server);
        let message: string | undefined;
        let changed = false;
        if (!typed || typed === this.config?.server) {
            changed = this.settings.server !== undefined;
            delete this.settings.server;
        } else if (isHttpUrl(typed)) {
            changed = this.settings.server !== typed;
            this.settings.server = typed;
        } else {
            message = `"${typed}" is not an http(s) address; the server was not changed.`;
        }
        this.rememberSettings();
        if (changed) {
            // The old server's notes are not this one's; the notes not sent yet go to the new one.
            this.store.replace(this.store.all.filter((r) => r.pending));
            if (this.enabled) this.restartSync();
        }
        this.emit();
        return message;
    }

    /** The connection, in a few words for the menu and the settings sheet. */
    describeConnection(): string {
        const host = this.serverHost;
        switch (this.connection) {
            case "connected":
                return `Connected to ${host ?? "the server"}`;
            case "connecting":
                return `Connecting to ${host ?? "the server"}…`;
            case "offline":
                return this.connectionDetail ?? `Cannot reach ${host ?? "the server"}`;
            case "refused":
                return this.connectionDetail ?? `${host ?? "The server"} refused this app`;
            case "local":
                if (this.mode === "test")
                    return host
                        ? `Notes stay on this device; a package is uploaded to ${host}`
                        : "Notes stay on this device until packaged";
                return this.connectionDetail ?? "No server";
            default:
                return this.problem ?? "Off";
        }
    }

    // ---- notes on the device -------------------------------------------------------------------------------------

    /** Reads back the notes this device made and had not sent when the app last stopped. */
    private loadLocal() {
        const c = this.config;
        if (!c || this.loadedFor === c.project) return;
        this.loadedFor = c.project;
        let saved: LocalNote[];
        try {
            saved = this.storage.loadNotes();
        } catch {
            saved = [];
        }
        const known = new Set(this.store.all.map((r) => r.annotation.id));
        const loaded = saved
            .filter((n) => n?.annotation?.id && !known.has(n.annotation.id))
            .map<NoteRecord>((n) => ({
                annotation: n.annotation,
                pending: true,
                mine: true,
                ...(n.failed ? { failed: n.failed } : {}),
                ...(n.waiting ? { waiting: n.waiting } : {}),
            }));
        this.store.replace([...this.store.all, ...loaded]);
    }

    /** Writes the notes not on the server yet, so they survive a restart. */
    private persist() {
        try {
            this.storage.saveNotes(
                this.store.all
                    .filter((r) => r.pending)
                    .map((r) => ({
                        annotation: r.annotation,
                        pending: true,
                        ...(r.failed ? { failed: r.failed } : {}),
                        ...(r.waiting ? { waiting: r.waiting } : {}),
                    }))
            );
        } catch {
            // a full disk: they are kept in memory for this run
        }
    }

    /** Keeps a screenshot until its note is on the server: in memory, and in storage to outlive a restart. */
    private keepAsset({ ref, bytes }: Shot) {
        this.assets.set(ref.id, bytes);
        try {
            this.storage.saveAsset(ref.id, bytes);
        } catch {
            // a full disk: kept in memory for this run
        }
    }

    /** A screenshot kept for a note, or undefined when there is none (or its file cannot be read). */
    private loadAsset(id: string): Uint8Array | undefined {
        const kept = this.assets.get(id);
        if (kept) return kept;
        try {
            return this.storage.loadAsset(id);
        } catch {
            return undefined;
        }
    }

    private assetsOf(annotation: Annotation): Array<{ id: string; bytes: Uint8Array }> {
        return screenshotIds(annotation).flatMap((id) => {
            const bytes = this.loadAsset(id);
            return bytes ? [{ id, bytes }] : [];
        });
    }

    private dropAssets(annotation: Annotation) {
        for (const id of screenshotIds(annotation)) {
            this.assets.delete(id);
            try {
                this.storage.deleteAsset(id);
            } catch {
                // already gone
            }
        }
    }

    /** Test mode: forget the notes kept on this device. */
    clearLocal(): void {
        for (const r of this.store.all) if (r.pending) this.dropAssets(r.annotation);
        this.store.replace(this.store.all.filter((r) => !r.pending));
        this.persist();
        this.emit();
    }

    // ---- making a note -------------------------------------------------------------------------------------------

    /** The number the next note on this screen gets: one more than the notes already on it. */
    nextPin(route: string): number {
        return this.notesOn(route).length + 1;
    }

    /** The notes on a screen, oldest first, numbered as their pins are. The same list until one of them changes. */
    notesOn(route: string): readonly NumberedNote[] {
        return this.store.notesOn(route);
    }

    /** The notes on a screen that get a pin here: those made in a React Native app. */
    pinsOn(route: string): readonly NumberedNote[] {
        return this.store.pinsOn(route);
    }

    /**
     * Files a note on an element the overlay picked, with the screenshots it took: kept on the device first, then sent
     * when there is a server. Returns the note, and what to tell the person when it did not go.
     */
    async createNote(
        picked: Picked,
        draft: NoteDraft,
        shots: { id: string; pin: number; full?: Shot; crop?: Shot }
    ): Promise<{ annotation: Annotation; problem?: string }> {
        const c = this.config;
        const host = this.host;
        if (!c || !host) throw new NotatoError("Notato is not running.");
        const sources = await symbolicate(parseComponentStack(picked.componentStack));
        const identity = identityOf(picked, sources, {
            private: picked.element.private,
            maskValue: this.maskInputs && !picked.element.shown,
        });
        const full = this.screenshotsOn ? shots.full : undefined;
        const crop = full ? shots.crop : undefined;
        const { frame } = picked;
        const annotation = buildAnnotation({
            id: shots.id,
            project: c.project,
            mode: c.mode,
            appName: c.appName,
            appVersion: c.appVersion,
            route: host.route(),
            author: this.authorName,
            agentName: draft.agentName,
            identity,
            rect: { x: frame.left, y: frame.top, w: frame.width, h: frame.height },
            comment: draft.comment,
            intent: draft.intent,
            severity: draft.severity,
            peopleOnly: draft.peopleOnly,
            steps: draft.steps,
            pin: shots.pin,
            screenshots: full ? { full, crop } : undefined,
            device: host.device(),
            console: c.captureLogs ? [...this.logs] : undefined,
            network: [...this.network],
        });
        for (const shot of [full, crop]) if (shot) this.keepAsset(shot);
        this.store.edit((notes) => notes.put({ annotation, pending: true, mine: true }));
        this.persist();
        this.emit();
        const outcome = await this.send(annotation.id);
        return {
            annotation: this.store.get(annotation.id)?.annotation ?? annotation,
            problem: problemOf(outcome),
        };
    }

    /** Selects an element as if it had been tapped (a selector, or a view's ref), and opens the note for it. */
    async select(target: string | object): Promise<void> {
        const host = this.requireHost();
        host.select(await host.resolve(target));
    }

    /**
     * Makes a note with no UI, as a person or (with `agentName`) an agent: finds the element, takes the screenshot,
     * and files it. Resolves with the note; rejects when the element cannot be found.
     */
    async annotate(
        target: string | object,
        comment: string,
        options: AnnotateOptions = {}
    ): Promise<Annotation> {
        const host = this.requireHost();
        if (!comment.trim()) throw new NotatoError("A note needs a comment.");
        const picked = await host.resolve(target);
        const pin = this.nextPin(host.route());
        const id = ulid();
        const { screenshot = true, ...draft } = options;
        const shots = screenshot && this.screenshotsOn ? await host.capture(picked, pin, id) : {};
        const { annotation } = await this.createNote(
            picked,
            { ...draft, comment },
            { id, pin, ...shots }
        );
        return annotation;
    }

    private requireHost(): Host {
        if (!this.enabled || !this.host)
            throw new NotatoError("Notato is off, or <Notato> is not mounted.");
        return this.host;
    }

    /** Adds an HTTP request to the `network` context of later notes (the last 50 are kept, without query strings). */
    recordRequest(entry: Omit<NetworkEntry, "at"> & { at?: string }): void {
        this.network.push({
            method: entry.method.toUpperCase(),
            url: entry.url.replace(/[?#].*$/, ""),
            status: entry.status,
            durationMs: Math.round(entry.durationMs),
            at: entry.at ?? new Date().toISOString(),
        });
        if (this.network.length > NETWORK_LIMIT)
            this.network.splice(0, this.network.length - NETWORK_LIMIT);
    }

    // ---- sending -------------------------------------------------------------------------------------------------

    /** Sends one note now, unless it has gone already. One on its way gives what comes of that send. */
    private send(id: string): Promise<SendOutcome> {
        const going = this.inflight.get(id);
        if (going) return going;
        const conn = this.connectionInfo;
        const record = this.store.get(id);
        if (!this.hasServer || !conn || !record?.pending || record.failed)
            return Promise.resolve({ kind: "skipped" });
        const sending = this.sendNow(record, conn).finally(() => this.inflight.delete(id));
        this.inflight.set(id, sending);
        return sending;
    }

    private async sendNow(record: NoteRecord, conn: Connection): Promise<SendOutcome> {
        const id = record.annotation.id;
        const generation = this.generation;
        try {
            const stored = await this.transport.send(
                conn,
                record.annotation,
                this.assetsOf(record.annotation)
            );
            if (this.deletedHere.has(id)) {
                // Deleted here while it was on its way: delete it there too, even when Notato restarted meanwhile.
                this.dropAssets(record.annotation);
                await this.transport.remove(conn, stored.annotation.id).catch(() => undefined);
                return { kind: "skipped" };
            }
            if (generation !== this.generation) return { kind: "skipped" };
            this.dropAssets(record.annotation);
            // The server's events may have brought a newer copy while the answer was on its way: that one stays.
            this.store.update(id, (r) =>
                r.pending ? { annotation: stored.annotation, pending: false, mine: r.mine } : r
            );
            this.persist();
            this.emit();
            return { kind: "sent" };
        } catch (e) {
            const error = e instanceof NotatoError ? e : new NotatoError(messageOf(e));
            if (error.refusesNote) {
                this.store.update(id, (r) => ({ ...r, failed: error.message }));
                console.warn(`[notato] The server refused a note: ${error.message}`);
                this.persist();
                this.emit();
                return { kind: "refused", reason: error.message };
            }
            // The server's reason, when it answered: the note says why it waits.
            const waiting = error.status === undefined ? undefined : error.message;
            this.store.update(id, (r) => {
                const { waiting: _, ...rest } = r;
                return waiting ? { ...rest, waiting } : rest;
            });
            this.persist();
            this.emit();
            return { kind: "held", error };
        }
    }

    /**
     * Sends every note waiting to go, oldest first. A refused note is passed over (it is marked failed) and the rest
     * still go; anything else that stops one stops there, with it and everything after it still queued. Returns why.
     */
    private async flush(): Promise<NotatoError | undefined> {
        for (const r of this.store.all) {
            if (!r.pending || r.failed) continue;
            const outcome = await this.send(r.annotation.id);
            if (outcome.kind === "held") return outcome.error;
        }
        return undefined;
    }

    // ---- the server: live updates over server-sent events --------------------------------------------------------

    /** Closes the stream and forgets what came on it: answers on their way belong to a connection that is gone. */
    private closeStream() {
        this.generation++;
        this.stream?.stop();
        this.stream = undefined;
        this.dropIncoming();
        this.listing = undefined;
        this.agents = [];
    }

    /** Forgets the server's changes not applied yet. */
    private dropIncoming() {
        if (this.applyTimer) clearTimeout(this.applyTimer);
        this.applyTimer = undefined;
        this.incoming = [];
    }

    /** Opens a fresh connection to the server, or says there is none. */
    private restartSync() {
        this.closeStream();
        const conn = this.connectionInfo;
        if (!this.enabled || !conn || !this.hasServer) {
            this.connection = "local";
            this.connectionDetail =
                this.mode === "test" ? undefined : "No server is set: notes stay on this device.";
            return;
        }
        const generation = this.generation;
        this.connection = "connecting";
        this.stream = this.transport.follow(
            conn,
            this.mode === "agent",
            (event) => {
                if (generation === this.generation) void this.handle(event, conn);
            },
            (state, detail) => {
                if (generation !== this.generation || state === "connected") return;
                // Connected only once the server has said hello.
                this.connection = state;
                this.connectionDetail = detail;
                if (state !== "connecting") this.agents = [];
                this.emit();
            }
        );
    }

    /** Tries the server again now, instead of waiting out the pause between attempts (the menu's Retry). */
    retryConnection(): void {
        if (!this.enabled || !this.hasServer) return;
        if (this.stream) this.stream.retry();
        else this.restartSync();
    }

    private async handle({ event, data }: ServerEvent, conn: Connection) {
        const body = (data ?? {}) as {
            id?: string;
            annotation?: Annotation;
            agent?: { connected?: boolean; names?: string[] };
            connected?: boolean;
            names?: string[];
            requestId?: string;
            args?: AnnotateRequest["args"];
        };
        switch (event) {
            case "hello": {
                this.connection = "connected";
                this.connectionDetail = undefined;
                this.agents = body.agent?.connected ? (body.agent.names ?? []) : [];
                this.emit();
                const generation = this.generation;
                try {
                    const config = await this.transport.config(conn);
                    if (
                        generation === this.generation &&
                        typeof config?.screenshots === "boolean"
                    ) {
                        this.serverScreenshots = config.screenshots;
                    }
                } catch {
                    // the screenshots stay as they were
                }
                // The notes kept on the device go first, so the list read after them has them.
                const held = await this.flush();
                if (generation !== this.generation) return;
                await this.reload(conn, generation);
                if (held && held.status !== undefined)
                    this.host?.toast(`Notes not sent: ${held.message}`);
                return;
            }
            case "agent":
                this.agents = body.connected ? (body.names ?? []) : [];
                this.emit();
                return;
            case "created":
            case "updated":
            case "replied":
                if (body.annotation) this.receive({ annotation: body.annotation });
                return;
            case "deleted":
                if (body.id) this.receive({ deleted: body.id });
                return;
            case "annotate-request":
                if (body.requestId && body.args) {
                    const request = { requestId: body.requestId, args: body.args };
                    this.relays = this.relays.then(() => this.answerRelay(request, conn));
                }
                return;
        }
    }

    /** A change from the server's events: applied with the others that come within a frame. */
    private receive(change: Change) {
        this.incoming.push(change);
        this.listing?.push(change);
        this.applyTimer ??= setTimeout(() => this.applyIncoming(), BATCH_MS);
    }

    /** Applies the server's changes that came since the last frame, together: one copy of the list for them all. */
    private applyIncoming() {
        const changes = this.incoming;
        this.dropIncoming();
        if (changes.length && this.applyChanges(changes)) this.emit();
    }

    /** Applies the server's changes in order. Returns whether a note changed. */
    private applyChanges(changes: Change[]): boolean {
        let sent = false;
        const changed = this.store.edit((notes) => {
            for (const change of changes) {
                if ("deleted" in change) {
                    // Deleted there: forgotten here, unless it is a note of this device's that has not gone yet.
                    if (notes.get(change.deleted)?.pending === false) notes.remove(change.deleted);
                    this.deletedHere.delete(change.deleted);
                } else if (this.take(notes, change.annotation)) sent = true;
            }
        });
        if (sent) this.persist();
        return changed;
    }

    /**
     * Reads every note of the project, then forgets those the server no longer has. Nothing is forgotten unless every
     * page came: a list cut short would look like deletions. The changes that come while it is read are applied again
     * over it, since the list may be older than they are.
     */
    private async reload(conn: Connection, generation: number) {
        this.applyIncoming();
        const known = new Set(this.store.all.filter((r) => !r.pending).map((r) => r.annotation.id));
        const meanwhile: Change[] = [];
        this.listing = meanwhile;
        let items: StoredAnnotation[];
        try {
            items = await this.transport.list(conn);
        } catch {
            return;
        } finally {
            if (this.listing === meanwhile) this.listing = undefined;
        }
        if (generation !== this.generation) return;
        const byId = new Map(this.store.all.map((r) => [r.annotation.id, r]));
        const listed = new Set<string>();
        const added: NoteRecord[] = [];
        for (const item of items) {
            const a = item.annotation;
            if (a.projectId !== this.config?.project || this.deletedHere.has(a.id)) continue;
            listed.add(a.id);
            const existing = byId.get(a.id);
            if (existing) byId.set(a.id, { annotation: a, pending: false, mine: existing.mine });
            else added.push({ annotation: a, pending: false, mine: false });
            if (existing?.pending) this.dropAssets(existing.annotation);
        }
        // The server's: those it had before the load and lists no longer.
        const gone = new Set([...known].filter((id) => !listed.has(id)));
        this.store.replace([
            ...this.store.all
                .map((r) => byId.get(r.annotation.id) ?? r)
                .filter((r) => !gone.has(r.annotation.id) || r.pending),
            ...added,
        ]);
        // Every change not applied yet came while the list was read, so it is among these.
        this.dropIncoming();
        this.applyChanges(meanwhile);
        this.persist();
        this.emit();
    }

    /**
     * A note from the server, into the notes: replaces the one Notato has, or joins them. True when it replaced one
     * that was still on the device.
     */
    private take(notes: NoteEdit, annotation: Annotation): boolean {
        if (annotation.projectId !== this.config?.project || this.deletedHere.has(annotation.id))
            return false;
        const existing = notes.get(annotation.id);
        if (existing?.pending) this.dropAssets(existing.annotation);
        notes.put({ annotation, pending: false, mine: existing?.mine ?? false });
        return existing?.pending === true;
    }

    /** The server's answer to something the person did: the changes before it first, then it. */
    private upsert(annotation: Annotation) {
        this.applyIncoming();
        let sent = false;
        this.store.edit((notes) => {
            sent = this.take(notes, annotation);
        });
        if (sent) this.persist();
        this.emit();
    }

    /** Agent mode: an agent asked, through `notato_annotate`, for something in this app to be annotated. */
    private async answerRelay(request: AnnotateRequest, conn: Connection) {
        let result: RelayResult;
        try {
            const { target, comment, severity, intent, steps, author } = request.args;
            const annotation = await this.annotate(target, comment, {
                severity,
                intent,
                steps,
                agentName: author ?? "agent",
            });
            const record = this.store.get(annotation.id);
            // Made, but not on the server: reporting it filed would send the agent looking for a note the server does
            // not have.
            result =
                record && !record.pending
                    ? { ok: true, annotationId: annotation.id }
                    : { ok: false, error: this.notFiled(record) };
        } catch (e) {
            result = { ok: false, error: messageOf(e) };
        }
        try {
            await this.transport.relayResult(conn, request.requestId, result);
        } catch (e) {
            console.warn(`[notato] Could not report an annotate result: ${messageOf(e)}`);
        }
    }

    /** Why a note made for the agent is not on the server, said to the agent. */
    private notFiled(record: NoteRecord | undefined): string {
        if (!record)
            return "The note was made on the device, then deleted there before it was sent.";
        if (record.failed)
            return `The note was made on the device but the server did not take it: ${sentence(record.failed)}`;
        if (record.waiting)
            return `The note was made on the device but the server did not take it: ${sentence(record.waiting)} It is sent again on the next connection.`;
        return this.hasServer
            ? "The note was made on the device but not sent: the server could not be reached. It is sent again on the next connection."
            : "The note was made on the device but not sent: no server is set.";
    }

    // ---- acting on a note, as the person -------------------------------------------------------------------------

    private requireConnection(): Connection {
        const conn = this.connectionInfo;
        if (!this.hasServer || !conn) throw new NotatoError("Not connected to a Notato server.");
        return conn;
    }

    /** Replies on a note's thread. An aside is for the people on the thread: the agent never sees it. */
    async reply(id: string, text: string, aside = false): Promise<void> {
        const conn = this.requireConnection();
        const stored = await this.transport.reply(conn, id, text.trim(), this.me, aside);
        this.upsert(stored.annotation);
    }

    /**
     * Turns People only on or off, as the person. The server does it (and records it in the thread) once it has the
     * note; a note not sent yet is changed on the device, with the same entry in its thread.
     */
    async setPeopleOnly(id: string, on: boolean): Promise<void> {
        const record = this.store.get(id);
        if (!record) throw new NotatoError("That note is gone.");
        if (on === (record.annotation.peopleOnly === true)) return;
        if (!record.pending) {
            const conn = this.requireConnection();
            const stored = await this.transport.setPeopleOnly(conn, id, on, this.me);
            this.upsert(stored.annotation);
            return;
        }
        // On its way now: the server's copy, when it lands, would replace this change.
        if (this.inflight.has(id))
            throw new NotatoError("The note is being sent: try again in a moment.");
        this.store.update(id, (r) => ({
            ...r,
            annotation: settingPeopleOnly(r.annotation, on, this.me),
        }));
        this.persist();
        this.emit();
    }

    /** Asks the agent to undo the change it made for a resolved note. */
    async requestRevert(id: string, reason?: string): Promise<void> {
        const note = reason?.trim() || "Please undo this change.";
        const conn = this.requireConnection();
        const stored = await this.transport.setStatus(conn, id, "revert_requested", note, this.me);
        this.upsert(stored.annotation);
    }

    /** Takes back a revert request: the note is resolved again. */
    async cancelRevert(id: string): Promise<void> {
        const conn = this.requireConnection();
        const stored = await this.transport.setStatus(
            conn,
            id,
            "resolved",
            "Revert request taken back.",
            this.me
        );
        this.upsert(stored.annotation);
    }

    /** Deletes a note: on the server when it has it, and on the device. */
    async delete(id: string): Promise<void> {
        const record = this.store.get(id);
        if (record && !record.pending && this.hasServer)
            await this.transport.remove(this.requireConnection(), id);
        if (record) {
            // A copy on its way now is deleted on the server when it lands; one not sent yet never goes.
            if (this.inflight.has(id)) this.deletedHere.add(id);
            this.dropAssets(record.annotation);
        }
        this.store.update(id, () => undefined);
        this.persist();
        this.emit();
    }

    // ---- test mode: a bundle zip ---------------------------------------------------------------------------------

    /**
     * Packages this device's notes as a bundle zip (`feedback.md`, `annotations.json`, `shots/`), the format
     * `notato_import_bundle` reads, and uploads it when a server is set. Returns the zip, and where it was written
     * when there is storage to write it to.
     */
    async packageNotes(
        options: { upload?: boolean } = {}
    ): Promise<{ zip: Uint8Array; name: string; uri?: string; uploaded: boolean }> {
        const c = this.config;
        if (!c) throw new NotatoError("Notato has not been started.");
        const mine = this.store.all.filter((r) => r.pending || (this.mode === "test" && r.mine));
        if (!mine.length) throw new NotatoError("Nothing to package yet: make at least one note.");
        const { zip, name } = writeBundle(
            mine.map((r) => r.annotation),
            {
                project: c.project,
                ...(this.authorName ? { author: this.authorName } : {}),
                appName: c.appName,
                ...(c.appVersion ? { appVersion: c.appVersion } : {}),
            },
            (id) => this.loadAsset(id)
        );
        const uri = this.storage.writeShare(name, zip);
        let uploaded = false;
        if (options.upload !== false && this.server) {
            await this.transport.uploadBundle(this.connectionTo(c, this.server), zip);
            uploaded = true;
        }
        return { zip, name, ...(uri ? { uri } : {}), uploaded };
    }

    /** The menu's Package and share: the zip, uploaded when there is a server, and offered to the share sheet. */
    async packageAndShare(): Promise<string> {
        const result = await this.packageNotes({ upload: true });
        if (result.uri && this.provider?.share) {
            const shared = await this.provider.share(result.uri).catch(() => false);
            if (shared)
                return result.uploaded ? "Packaged, uploaded and shared" : "Packaged and shared";
        }
        if (result.uploaded) return "Packaged and uploaded to the server";
        if (result.uri) return `Packaged: ${result.name}`;
        throw new NotatoError(
            "Sharing a package needs storage: pass storage={expoStorage} to <Notato>, or set a server."
        );
    }
}
