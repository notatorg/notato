import { afterEach, describe, expect, it } from "bun:test";
import { boardName, remember, remembered, setBoardName } from "../src/storage.ts";

/** A localStorage as far as the board uses one, or one that refuses everything, like a locked-down browser's. */
function useStorage(kind: "working" | "refusing") {
    const items = new Map<string, string>();
    const refuse = () => {
        throw new Error("storage is disabled");
    };
    globalThis.localStorage = (kind === "working"
        ? {
              getItem: (k: string) => items.get(k) ?? null,
              setItem: (k: string, v: string) => void items.set(k, v),
              removeItem: (k: string) => void items.delete(k),
          }
        : { getItem: refuse, setItem: refuse, removeItem: refuse }) as unknown as Storage;
    return items;
}

const original = globalThis.localStorage;
afterEach(() => {
    globalThis.localStorage = original;
});

describe("what the board remembers in this browser", () => {
    it("gives back a choice it kept, and the fallback for one it never saw", () => {
        useStorage("working");
        expect(remembered("notato.sort", ["activity", "newest"], "activity")).toBe("activity");
        remember("notato.sort", "newest");
        expect(remembered("notato.sort", ["activity", "newest"], "activity")).toBe("newest");
    });

    it("ignores a kept value that is no longer a choice, unless any text will do", () => {
        const items = useStorage("working");
        items.set("notato.sort", "retired-sort");
        expect(remembered("notato.sort", ["activity", "newest"], "activity")).toBe("activity");
        expect(remembered<string>("notato.sort", null, "")).toBe("retired-sort");
    });

    it("carries on without storage, remembering nothing", () => {
        useStorage("refusing");
        expect(() => remember("notato.sort", "newest")).not.toThrow();
        expect(remembered("notato.sort", ["activity", "newest"], "activity")).toBe("activity");
        expect(() => setBoardName("Ada")).not.toThrow();
        expect(boardName()).toBe("");
    });

    it("keeps the name on replies trimmed, and forgets it when it is cleared", () => {
        const items = useStorage("working");
        setBoardName("  Ada Lovelace ");
        expect(boardName()).toBe("Ada Lovelace");
        setBoardName("   ");
        expect(boardName()).toBe("");
        expect(items.size).toBe(0);
    });
});
