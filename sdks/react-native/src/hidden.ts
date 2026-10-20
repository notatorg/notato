import { sha256 } from "@noble/hashes/sha2.js";
import type { Annotation } from "@notato/schema";
import { strToU8 } from "fflate";

export const isCompleted = (a: Annotation) =>
    ["resolved", "reverted", "dismissed"].includes(a.status);

/** Device preferences only: notes and their server copies are never changed. */
export class HiddenAnnotations {
    private signature?: string;
    private key = "";
    private groups: Record<string, string[]> = {};
    encoded?: string;
    ids: ReadonlySet<string> = new Set();

    select(parts: Array<string | undefined>, encoded?: string): void {
        const signature = JSON.stringify(parts);
        if (signature === this.signature && encoded === this.encoded) return;
        this.signature = signature;
        this.encoded = encoded;
        this.key = Array.from(sha256(strToU8(signature)), (b) =>
            b.toString(16).padStart(2, "0")
        ).join("");
        try {
            const saved: unknown = JSON.parse(encoded ?? "{}");
            this.groups =
                saved && typeof saved === "object" && !Array.isArray(saved)
                    ? (saved as Record<string, string[]>)
                    : {};
        } catch {
            this.groups = {};
        }
        const ids = this.groups[this.key];
        this.ids = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
    }

    hide(annotations: Iterable<Annotation>): boolean {
        const ids = new Set(this.ids);
        for (const a of annotations) if (isCompleted(a)) ids.add(a.id);
        if (ids.size === this.ids.size) return false;
        this.ids = ids;
        this.save();
        return true;
    }

    clear(): void {
        this.ids = new Set();
        this.save();
    }

    private save(): void {
        this.groups[this.key] = [...this.ids];
        this.encoded = JSON.stringify(this.groups);
    }
}
