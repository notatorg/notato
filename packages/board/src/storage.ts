import { useCallback, useEffect, useState } from "react";

// What the board keeps for the person using it: small choices in this browser's storage, and a few things in this
// tab's memory only. Storage can be missing (a private window, a locked-down browser): every choice then lasts for the
// visit, and nothing breaks. The theme and what has been seen keep their own keys, in theme.ts and live.ts.

/** Where each choice is kept in this browser. */
export const KEYS = {
    /** The project looked at last, which the sidebar leads to from pages outside any project. */
    project: "notato.project",
    sort: "notato.sort",
    group: "notato.group",
    /** How much a note copied as Markdown says. */
    detail: "notato.detail",
    /** The platform picked last on the Connect page. */
    connect: "notato.connect",
    /** The agent picked last in Settings › Agents. */
    agent: "notato.agent",
    /** The name the board signs replies with. */
    name: "notato.board.name",
} as const;

/** A choice kept in this browser, or `fallback` when there is none or it is not one of `allowed` (null takes any). */
export function remembered<T extends string>(
    key: string,
    allowed: readonly T[] | null,
    fallback: T
): T {
    try {
        const saved = localStorage.getItem(key);
        if (!allowed) return (saved ?? fallback) as T;
        return (allowed as readonly string[]).includes(saved ?? "") ? (saved as T) : fallback;
    } catch {
        return fallback;
    }
}

export function remember(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // remembered for this visit only
    }
}

/** A choice kept in this browser, as state: choosing a new one also stores it. */
export function useRemembered<T extends string>(
    key: string,
    allowed: readonly T[],
    fallback: T
): [T, (next: T) => void] {
    const [value, setValue] = useState(() => remembered(key, allowed, fallback));
    const choose = useCallback(
        (next: T) => {
            setValue(next);
            remember(key, next);
        },
        [key]
    );
    return [value, choose];
}

// ---- the name on replies ----------------------------------------------------------------------------------------

/** The name the board signs replies with, or "" for none. */
export function boardName(): string {
    try {
        return localStorage.getItem(KEYS.name)?.trim() ?? "";
    } catch {
        return "";
    }
}

const nameListeners = new Set<() => void>();

export function setBoardName(name: string) {
    try {
        if (name.trim()) localStorage.setItem(KEYS.name, name.trim());
        else localStorage.removeItem(KEYS.name);
    } catch {
        // kept for this visit only
    }
    for (const fn of nameListeners) fn();
}

/** The name on replies, kept in step wherever it is changed (the sidebar, Settings). */
export function useBoardName(): string {
    const [, bump] = useState(0);
    useEffect(() => {
        const update = () => bump((n) => n + 1);
        nameListeners.add(update);
        return () => {
            nameListeners.delete(update);
        };
    }, []);
    return boardName();
}

// ---- this tab only ----------------------------------------------------------------------------------------------

/**
 * Tokens just made, by project, so the page that explains how to connect an app can show one after a move. Only in
 * memory: the server shows a token once, and so does the board.
 */
const freshTokens = new Map<string, string>();
export const keepFreshToken = (projectId: string, token: string) =>
    freshTokens.set(projectId, token);
export const freshToken = (projectId: string) => freshTokens.get(projectId) ?? null;
export const forgetFreshToken = (projectId: string) => freshTokens.delete(projectId);

/** Projects made in this tab, so the page that follows can say so. */
const madeHere = new Set<string>();
export const markMadeHere = (projectId: string) => madeHere.add(projectId);
export const wasMadeHere = (projectId: string) => madeHere.has(projectId);
export const forgetMadeHere = (projectId: string) => madeHere.delete(projectId);
