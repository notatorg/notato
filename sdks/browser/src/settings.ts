import { type Detail, parseDetail } from "@notato/core";

/**
 * Pin colours to choose from. They avoid the colours a status already means (amber for acknowledged, green for
 * resolved, violet for a revert, teal for a pick), because the colour only applies to a pin nobody has acted on yet.
 */
export const MARKER_COLORS = [
    { id: "teal", name: "Teal", hex: "#1f8a78" },
    { id: "blue", name: "Blue", hex: "#2f6fde" },
    { id: "violet", name: "Violet", hex: "#7c5cff" },
    { id: "pink", name: "Pink", hex: "#d9488f" },
    { id: "orange", name: "Orange", hex: "#e0663f" },
    { id: "ink", name: "Ink", hex: "#1d1f22" },
    { id: "green", name: "Green", hex: "#6a9a1f" },
] as const;

/** Colours from before the palette changed, mapped to the nearest one now, so nobody's pick is lost. */
const OLD_COLORS: Record<string, MarkerColorId> = {
    indigo: "violet",
    sky: "blue",
    red: "orange",
    fuchsia: "pink",
    slate: "ink",
};

export type MarkerColorId = (typeof MARKER_COLORS)[number]["id"];

/** What a person can set for themselves, in this browser. The server's own settings are separate, and win. */
export interface Settings {
    /** Written on this person's notes and replies, so others can tell who wrote what. */
    name: string;
    /** The level the toolbar's copy button writes Markdown at. */
    copyDetail: Detail;
    /** Record the React components around an element. */
    components: boolean;
    /** Record an element's computed styles. */
    styles: boolean;
    /** Ask for a screenshot with each note. The server can still say no, and wins. */
    screenshots: boolean;
    markerColor: MarkerColorId;
    /** Show only the notes this person wrote. */
    mineOnly: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
    name: "",
    copyDetail: "standard",
    components: true,
    styles: true,
    screenshots: true,
    markerColor: "teal",
    mineOnly: false,
};

export interface SettingsStore {
    get(): Settings;
    set(patch: Partial<Settings>): void;
    /** Calls `fn` with the settings after every change, including one made in another tab. Returns how to stop. */
    subscribe(fn: (settings: Settings) => void): () => void;
    destroy(): void;
}

const KEY = "notato:settings";
// These two were kept on their own before there was a panel, so what people already have is still read.
const NAME_KEY = "notato:author";
const DETAIL_KEY = "notato:copy-detail";

const read = (key: string): string | null => {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
};
const write = (key: string, value: string) => {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // private mode or blocked storage: it is kept for this visit only
    }
};

const isColor = (v: unknown): v is MarkerColorId => MARKER_COLORS.some((c) => c.id === v);

/** Reads the stored settings, taking only what is valid and leaving everything else at its default. */
export function loadSettings(): Settings {
    let saved: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(read(KEY) ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            saved = parsed as Record<string, unknown>;
    } catch {
        // a stored value that is not JSON is ignored
    }
    const flag = (key: keyof Settings) =>
        typeof saved[key] === "boolean" ? (saved[key] as boolean) : undefined;
    return {
        name: (read(NAME_KEY) ?? "").trim().slice(0, 60).trim(),
        copyDetail: parseDetail(read(DETAIL_KEY)) ?? DEFAULT_SETTINGS.copyDetail,
        components: flag("components") ?? DEFAULT_SETTINGS.components,
        styles: flag("styles") ?? DEFAULT_SETTINGS.styles,
        screenshots: flag("screenshots") ?? DEFAULT_SETTINGS.screenshots,
        markerColor: isColor(saved.markerColor)
            ? saved.markerColor
            : typeof saved.markerColor === "string" && Object.hasOwn(OLD_COLORS, saved.markerColor)
              ? (OLD_COLORS[saved.markerColor] as MarkerColorId)
              : DEFAULT_SETTINGS.markerColor,
        mineOnly: flag("mineOnly") ?? DEFAULT_SETTINGS.mineOnly,
    };
}

export function createSettings(): SettingsStore {
    let current = loadSettings();
    const listeners = new Set<(settings: Settings) => void>();

    const persist = () => {
        write(NAME_KEY, current.name);
        write(DETAIL_KEY, current.copyDetail);
        const { name: _name, copyDetail: _detail, ...rest } = current;
        write(KEY, JSON.stringify(rest));
    };
    const tell = () => {
        for (const fn of [...listeners]) fn(current);
    };

    // Another tab changed one: follow it, so two tabs of the same app do not disagree.
    const onStorage = (ev: StorageEvent) => {
        if (ev.key !== KEY && ev.key !== NAME_KEY && ev.key !== DETAIL_KEY) return;
        current = loadSettings();
        tell();
    };
    window.addEventListener("storage", onStorage);

    return {
        get: () => current,
        set(patch) {
            const next = { ...current, ...patch };
            next.name = next.name.trim().slice(0, 60).trim();
            if (JSON.stringify(next) === JSON.stringify(current)) return;
            current = next;
            persist();
            tell();
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        destroy() {
            window.removeEventListener("storage", onStorage);
            listeners.clear();
        },
    };
}

/** A colour for a person, from their name: the same name is the same colour everywhere, with nothing to configure. */
export function colorForName(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(hash) % 360} 60% 42%)`;
}

/** Up to two letters to stand for a name: "Ada Lovelace" is AL, "ada" is A. */
export function initialsOf(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";
    const first = words[0] as string;
    const last = words.length > 1 ? (words[words.length - 1] as string) : "";
    return `${[...first][0] ?? ""}${[...last][0] ?? ""}`.toUpperCase();
}
