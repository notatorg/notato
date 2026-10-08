import { useEffect, useState } from "react";

// Light or dark: whatever the system says until someone picks one here, then that, in this browser only.

export type Theme = "light" | "dark";

const KEY = "notato.theme";

function stored(): Theme | null {
    try {
        const v = localStorage.getItem(KEY);
        return v === "light" || v === "dark" ? v : null;
    } catch {
        return null;
    }
}

/** The pick, kept here too so a browser that refuses storage still switches for this visit. */
let chosen = stored();
const listeners = new Set<() => void>();
const dark = () => window.matchMedia("(prefers-color-scheme: dark)");

function apply() {
    if (chosen) document.documentElement.dataset.theme = chosen;
    else delete document.documentElement.dataset.theme;
}
// Before the first render, so the page never flashes the other theme.
apply();

export function setTheme(next: Theme) {
    chosen = next;
    try {
        localStorage.setItem(KEY, next);
    } catch {
        // switched for this visit only
    }
    apply();
    for (const fn of listeners) fn();
}

/** The theme in use, following the system while nothing is picked. */
export function useTheme(): Theme {
    const [, bump] = useState(0);
    useEffect(() => {
        const update = () => bump((n) => n + 1);
        const media = dark();
        listeners.add(update);
        media.addEventListener("change", update);
        return () => {
            listeners.delete(update);
            media.removeEventListener("change", update);
        };
    }, []);
    return chosen ?? (dark().matches ? "dark" : "light");
}
