import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExpoFile, type ExpoFs, fileStorage, WRITE_DELAY_MS } from "../src/storage.ts";
import { annotation } from "./fixtures.ts";

/** expo-file-system's files, in memory, with every write and move recorded. */
function fakeFs(options: { moveSync?: boolean } = {}) {
    const files = new Map<string, string | Uint8Array>();
    const log: string[] = [];
    const path = (parts: unknown[]) =>
        parts.map((p) => (typeof p === "string" ? p : (p as { path: string }).path)).join("/");
    class File implements ExpoFile {
        path: string;
        constructor(...parts: unknown[]) {
            this.path = path(parts);
        }
        get exists() {
            return files.has(this.path);
        }
        get uri() {
            return `file://${this.path}`;
        }
        write(content: string | Uint8Array) {
            log.push(`write ${this.path}`);
            files.set(this.path, content);
        }
        textSync() {
            return String(files.get(this.path));
        }
        bytesSync() {
            return files.get(this.path) as Uint8Array;
        }
        delete() {
            files.delete(this.path);
        }
        declare moveSync?: ExpoFile["moveSync"];
        declare move?: ExpoFile["move"];
    }
    const relocate = (from: File, to: ExpoFile) => {
        const target = (to as File).path;
        log.push(`move ${from.path} ${target}`);
        files.set(target, files.get(from.path) as string);
        files.delete(from.path);
    };
    if (options.moveSync !== false)
        File.prototype.moveSync = function (this: File, to: ExpoFile) {
            relocate(this, to);
        };
    else
        File.prototype.move = function (this: File, to: ExpoFile) {
            if ((to as File).exists) throw new Error("there is a file there");
            relocate(this, to);
        };
    class Directory {
        path: string;
        constructor(...parts: unknown[]) {
            this.path = path(parts);
        }
        exists = true;
        create() {}
    }
    const fs: ExpoFs = { Paths: { document: { path: "docs" } }, File, Directory };
    return { fs, files, log };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("fileStorage", () => {
    it("writes notes once a burst of changes is over, whole, then moves them into place", () => {
        vi.useFakeTimers();
        const { fs, files, log } = fakeFs();
        const storage = fileStorage("shop", fs);
        if (!storage) throw new Error("no storage");
        const a = annotation({ id: "a" });
        for (let i = 0; i < 20; i++) storage.saveNotes([{ annotation: a, pending: true }]);
        expect(log).toEqual([]);
        // What has not been written yet is what a load reads.
        expect(storage.loadNotes()).toEqual([{ annotation: a, pending: true }]);
        vi.advanceTimersByTime(WRITE_DELAY_MS);
        expect(log).toEqual([
            "write docs/notato/shop/notes.json.tmp",
            "move docs/notato/shop/notes.json.tmp docs/notato/shop/notes.json",
        ]);
        expect(JSON.parse(files.get("docs/notato/shop/notes.json") as string)).toEqual([
            { annotation: a, pending: true },
        ]);
        expect(fileStorage("shop", fs)?.loadNotes()).toEqual([{ annotation: a, pending: true }]);
    });

    it("replaces the file with an older expo-file-system too, and reads one a write left beside it", () => {
        vi.useFakeTimers();
        const { fs, files } = fakeFs({ moveSync: false });
        const storage = fileStorage("shop", fs);
        storage?.saveNotes([]);
        vi.advanceTimersByTime(WRITE_DELAY_MS);
        storage?.saveNotes([{ annotation: annotation({ id: "b" }), pending: true }]);
        vi.advanceTimersByTime(WRITE_DELAY_MS);
        expect(
            fileStorage("shop", fs)
                ?.loadNotes()
                .map((n) => n.annotation.id)
        ).toEqual(["b"]);
        // Stopped between taking the old file away and moving the new one in.
        files.set(
            "docs/notato/shop/notes.json.tmp",
            files.get("docs/notato/shop/notes.json") as string
        );
        files.delete("docs/notato/shop/notes.json");
        expect(
            fileStorage("shop", fs)
                ?.loadNotes()
                .map((n) => n.annotation.id)
        ).toEqual(["b"]);
    });
});
