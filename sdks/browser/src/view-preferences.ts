import { sha256 } from "@noble/hashes/sha2.js";
import type { Annotation } from "@notato/schema";

/** Scope local drafts/preferences to destination AND credential; never store the credential in a database name. */
export async function privateScope(parts: Array<string | undefined>): Promise<string> {
    // Pure SHA-256 also works on a LAN HTTP origin where Web Crypto is unavailable.
    const digest = sha256(new TextEncoder().encode(JSON.stringify(parts)));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
export const isFinished = (a: Annotation) =>
    ["resolved", "reverted", "dismissed"].includes(a.status);

/** Hiding is local to this browser and credential. Unfinished notes (including new questions) always reappear. */
export function createHiddenNotes(scope: Promise<string>, changed: () => void) {
    let key: string | undefined;
    const hidden = new Set<string>();
    const save = () => {
        try {
            if (key) localStorage.setItem(key, JSON.stringify([...hidden].slice(-2000)));
        } catch {
            /* optional preference */
        }
    };
    const ready = scope.then((s) => {
        key = `notato:hidden:${s}`;
        try {
            const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
            if (Array.isArray(saved))
                for (const id of saved.slice(-2000)) if (typeof id === "string") hidden.add(id);
        } catch {
            /* optional preference */
        }
        changed();
    });
    return {
        ready,
        has: (a: Annotation) => isFinished(a) && hidden.has(a.id),
        async hide(a: Annotation) {
            await ready;
            if (isFinished(a)) {
                hidden.add(a.id);
                save();
                changed();
            }
        },
        clear() {
            hidden.clear();
            save();
            changed();
        },
        count: () => hidden.size,
    };
}
