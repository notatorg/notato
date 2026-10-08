import { useColorScheme } from "react-native";

/**
 * Notato's colours: the web toolbar's, so the overlay reads as the same product as the board. The bar is always dark;
 * sheets and cards follow the app's light or dark.
 */
export const BAR = {
    bar: "#17181b",
    text: "#eceded",
    muted: "#8b8f97",
    /** A pressed button on the bar, and the count's badge. */
    pressed: "#2a2c31",
    line: "#33353a",
    accent: "#45bfa8",
    onAccent: "#0b1f1b",
} as const;

export const BRAND = {
    accent: "#1f8a78",
    accentPressed: "#187465",
    danger: "#d6453d",
    selection: "#e5484d",
    connected: "#2e9a5b",
    connecting: "#e9b44c",
    offline: "#ef6b5e",
    scrim: "rgba(18,20,24,0.32)",
} as const;

const LIGHT = {
    background: "#ffffff",
    text: "#1d1f22",
    muted: "#686c72",
    line: "#e4e4df",
    /** Icon tiles and text fields. */
    soft: "#f2f2ef",
};

const DARK: typeof LIGHT = {
    background: "#1d1e21",
    text: "#e6e7ea",
    muted: "#8f939b",
    line: "#2f3136",
    soft: "#26272b",
};

export type Palette = typeof LIGHT & typeof BRAND;

export function usePalette(): Palette {
    return { ...(useColorScheme() === "dark" ? DARK : LIGHT), ...BRAND };
}

/** A pin's colour for its note's status. */
export function statusColor(status: string): string {
    switch (status) {
        case "acknowledged":
            return "#d99a1e";
        case "resolved":
            return "#2e9a5b";
        case "revert_requested":
            return "#8b5cf6";
        case "variant_chosen":
            return "#0891b2";
        case "reverted":
            return "#64748b";
        case "dismissed":
            return "#9a9a9a";
        default:
            return BRAND.accent;
    }
}

/** "2h ago". */
export function ago(iso: string, now = Date.now()): string | undefined {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return undefined;
    const s = (now - t) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}
