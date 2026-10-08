import type { StorageProvider } from "./storage.ts";

/** Who annotates, and where the notes go: the same three modes as every Notato SDK. */
export type NotatoMode = "dev" | "test" | "agent";

/** The corner the toolbar starts in. */
export type ToolbarCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

/** How `<Notato>` is set up. Everything but `project` has a default. */
export interface NotatoConfig {
    /** The project the notes belong to on the server. Letters, digits and `. _ - @`, not only dots. */
    project: string;
    /**
     * `dev` (default): notes go live to `notato dev` and your agent. `test`: notes stay on the device until packaged
     * as a zip. `agent`: like dev, and the app also takes `notato_annotate` requests from the agent.
     */
    mode?: NotatoMode;
    /**
     * The Notato server. Default `http://localhost:4747` in dev and agent mode, which the iOS simulator reaches as it
     * is (for the Android emulator, forward it first: `adb reverse tcp:4747 tcp:4747`); none in test mode, where a
     * server set here gets the packages. `null` for none in any mode: notes stay on the device.
     */
    server?: string | null;
    /** A project token (`notato_…`), for a shared server (`notato serve`). It is only ever sent to `server`. */
    token?: string;
    /** The app's name and version, recorded on every note. Default "React Native app". */
    appName?: string;
    appVersion?: string;
    /** The name on this person's notes. They can change it in the toolbar's settings. */
    author?: string;
    /**
     * The screen the person is on, as your navigation names it (`"Checkout"`), or a function that says it: notes are
     * filed under it and its pins shown on it. With React Navigation: `() => navigationRef.getCurrentRoute()?.name`.
     */
    route?: string | (() => string | undefined);
    /** Whether Notato is on at launch (default: development builds). The app can switch it at runtime. */
    enabled?: boolean;
    /** Show the toolbar at launch (default true). Without it the app can still drive Notato from code. */
    showToolbar?: boolean;
    /** The corner the toolbar starts in. People can drag it; where they leave it is remembered. */
    toolbarPosition?: ToolbarCorner;
    /** Take screenshots. A server that has them off wins either way. */
    screenshots?: boolean;
    /**
     * Cover text fields in screenshots and leave their values out of notes. Default: on in test and agent mode.
     * Password fields (`secureTextEntry`) always are; `<NotatoMask private={false}>` opts a field out.
     */
    maskInputs?: boolean;
    /** Keep runtime choices (on or off, toolbar, name, a server typed in, the toolbar's place) across launches. */
    rememberRuntimeState?: boolean;
    /** Attach the app's recent `console.warn` and `console.error` messages to each note. */
    captureLogs?: boolean;
    /** How many of those messages are kept: the newest, 50 by default, at most 1000. */
    logLimit?: number;
    /** Pixels per point screenshots are kept at, at most. Phones are 2x to 3.5x; 2x is plenty. */
    maxScreenshotScale?: number;
    /**
     * Where notes, screenshots and choices are kept between launches, and how a package is shared:
     * `expoStorage` from `@notato/react-native/expo`. Without one they are kept in memory, until the app restarts.
     */
    storage?: StorageProvider;
}

/** Where `notato dev` listens: the server in dev and agent mode unless one is given. */
const DEFAULT_SERVER = "http://localhost:4747";

/** The configuration with its defaults filled in. */
export interface Resolved {
    project: string;
    mode: NotatoMode;
    server?: string;
    token?: string;
    appName: string;
    appVersion?: string;
    author?: string;
    enabled: boolean;
    showToolbar: boolean;
    toolbarPosition: ToolbarCorner;
    screenshots: boolean;
    maskInputs: boolean;
    rememberRuntimeState: boolean;
    captureLogs: boolean;
    logLimit: number;
    maxScreenshotScale: number;
}

declare const __DEV__: boolean | undefined;

/** Whether this is a development build (React Native's `__DEV__`). */
export const isDev = () => typeof __DEV__ !== "undefined" && __DEV__ === true;

/** A server address as Notato keeps it: trimmed, without a trailing slash. */
export const normalizeServer = (server: string) => server.trim().replace(/\/+$/, "");

/** Whether a server address is one Notato can talk to: http or https, with a host. */
export const isHttpUrl = (server: string) => /^https?:\/\/[^/\s]+/i.test(server);

export function resolveConfig(config: NotatoConfig): Resolved {
    const mode = config.mode ?? "dev";
    const server =
        config.server === null
            ? undefined
            : config.server
              ? normalizeServer(config.server)
              : mode === "test"
                ? undefined
                : DEFAULT_SERVER;
    return {
        project: config.project,
        mode,
        ...(server ? { server } : {}),
        ...(config.token ? { token: config.token } : {}),
        appName: config.appName?.trim() || "React Native app",
        ...(config.appVersion ? { appVersion: config.appVersion } : {}),
        ...(config.author ? { author: config.author } : {}),
        enabled: config.enabled ?? isDev(),
        showToolbar: config.showToolbar ?? true,
        toolbarPosition: config.toolbarPosition ?? "bottom-right",
        screenshots: config.screenshots ?? true,
        maskInputs: config.maskInputs ?? mode !== "dev",
        rememberRuntimeState: config.rememberRuntimeState ?? true,
        captureLogs: config.captureLogs ?? true,
        logLimit: Math.min(Math.max(Math.round(config.logLimit ?? 50), 0), 1000),
        maxScreenshotScale: config.maxScreenshotScale ?? 2,
    };
}

/**
 * Why the configuration cannot be used, or undefined. The project id is checked as the server checks it, which also
 * makes it a safe folder name.
 */
export function configProblem(config: Resolved): string | undefined {
    if (!config.project) return 'Notato needs a project: <Notato project="shop">.';
    if (!/^(?!\.+$)[A-Za-z0-9_.@-]{1,128}$/.test(config.project))
        return `Notato's project "${config.project}" may only use letters, digits and . _ - @ (at most 128), and not only dots.`;
    if (config.server && !isHttpUrl(config.server))
        return `Notato's server "${config.server}" is not an http(s) address.`;
    if (!(config.maxScreenshotScale >= 1 && config.maxScreenshotScale <= 4))
        return "Notato's maxScreenshotScale must be between 1 and 4.";
    return undefined;
}

/** The server as people know it: `localhost:4747`. */
export const hostOf = (server: string) => server.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
