import type { Annotation } from "@notato/schema";

/** A note kept on the device between launches: made here, and not on the server yet. */
export interface LocalNote {
    annotation: Annotation;
    /** Made here and not on the server yet (test mode keeps every note this way). */
    pending: boolean;
    /** The server refused it for good (malformed, too large): kept to read or delete, never sent again. */
    failed?: string;
    /** The server will not take it yet (an unknown project, a token that may not write): sent again later. */
    waiting?: string;
}

/**
 * What a device keeps between launches: its notes, their screenshots, and the person's choices. A `StorageProvider`
 * opens one per project.
 */
export interface NotatoStorage {
    /** The notes not on the server yet. */
    loadNotes(): LocalNote[];
    saveNotes(notes: LocalNote[]): void;
    /** A screenshot's PNG bytes, by its id. */
    loadAsset(id: string): Uint8Array | undefined;
    saveAsset(id: string, bytes: Uint8Array): void;
    deleteAsset(id: string): void;
    /** The choices a person made at runtime (on or off, the toolbar's place, a name). */
    loadSettings(): Record<string, unknown>;
    saveSettings(settings: Record<string, unknown>): void;
    /** Writes a file to share (a test-mode package), returning where it is, or undefined when it cannot write files. */
    writeShare(name: string, bytes: Uint8Array): string | undefined;
}

/** Where notes are kept between launches, and how a package is shared: `@notato/react-native/expo` is one. */
export interface StorageProvider {
    /** The storage for a project, or undefined when there can be none (Notato then keeps everything in memory). */
    open(project: string): NotatoStorage | undefined;
    /** Offers a written package to the share sheet. Resolves false when it could not. */
    share?(uri: string): Promise<boolean>;
}

/** Keeps everything in memory: what a bare app without expo-file-system gets. Gone when the app restarts. */
export function memoryStorage(): NotatoStorage {
    let notes: LocalNote[] = [];
    let settings: Record<string, unknown> = {};
    const assets = new Map<string, Uint8Array>();
    return {
        loadNotes: () => notes,
        saveNotes: (next) => {
            notes = next;
        },
        loadAsset: (id) => assets.get(id),
        saveAsset: (id, bytes) => void assets.set(id, bytes),
        deleteAsset: (id) => void assets.delete(id),
        loadSettings: () => settings,
        saveSettings: (next) => {
            settings = next;
        },
        writeShare: () => undefined,
    };
}

/** Ids that may name a file: the schema's SafeId, so one from the server (`../..`) can never leave the folder. */
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;
/** A project's folder: its id when that is a safe name (every id the server takes is), else one made from its bytes. */
function projectFolder(project: string): string {
    if (/^[A-Za-z0-9_.@-]+$/.test(project) && project !== "." && project !== "..") return project;
    return `p-${[...project].map((c) => c.charCodeAt(0).toString(16)).join("")}`;
}

/** A file as expo-file-system has it, as much of it as Notato uses. */
export interface ExpoFile {
    exists: boolean;
    uri: string;
    write(content: string | Uint8Array): void;
    textSync(): string;
    bytesSync(): Uint8Array;
    delete(): void;
    /** expo-file-system 55 and later. */
    moveSync?(destination: ExpoFile, options?: { overwrite?: boolean }): void;
    /** Before 55, the same, without replacing a file that is there. */
    move?(destination: ExpoFile): unknown;
}

/** What expo-file-system offers (its `File`, `Directory` and `Paths`), as much of it as Notato uses. */
export interface ExpoFs {
    Paths: { document: unknown };
    File: new (...parts: unknown[]) => ExpoFile;
    Directory: new (...parts: unknown[]) => { exists: boolean; create(options?: object): void };
}

/** How long notes wait to be written after a change: a burst of changes is one write. */
export const WRITE_DELAY_MS = 300;

/**
 * Keeps notes, screenshots and choices under the app's documents folder with expo-file-system, so test-mode notes and
 * unsent ones survive a restart. Undefined when the folder cannot be made.
 */
export function fileStorage(project: string, fs: ExpoFs): NotatoStorage | undefined {
    try {
        const root = new fs.Directory(fs.Paths.document, "notato", projectFolder(project));
        const shots = new fs.Directory(root, "shots");
        shots.create({ intermediates: true, idempotent: true });
        const file = (name: string) => new fs.File(root, name);
        const readJson = <T>(name: string, fallback: T): T => {
            for (const f of [file(name), file(`${name}.tmp`)]) {
                try {
                    // A write that stopped between taking the old file away and moving the new one in leaves it here.
                    if (f.exists) return JSON.parse(f.textSync()) as T;
                } catch {
                    // half a file: the next one, or the fallback
                }
            }
            return fallback;
        };
        /** Written whole beside the file, then moved over it, so a crash part way never leaves half a file. */
        const writeJson = (name: string, value: unknown) => {
            const tmp = file(`${name}.tmp`);
            const target = file(name);
            tmp.write(JSON.stringify(value));
            if (typeof tmp.moveSync === "function") {
                tmp.moveSync(target, { overwrite: true });
            } else {
                if (target.exists) target.delete();
                tmp.move?.(target);
            }
        };
        // Notes change as they are made, sent and replaced by the server's copies: a burst of changes is one write.
        let unwritten: LocalNote[] | undefined;
        let waiting = false;
        const writeNotes = () => {
            waiting = false;
            const notes = unwritten;
            unwritten = undefined;
            if (!notes) return;
            try {
                writeJson("notes.json", notes);
            } catch {
                // a full disk: they are kept in memory for this run
            }
        };
        return {
            loadNotes: () => unwritten ?? readJson<LocalNote[]>("notes.json", []),
            saveNotes: (notes) => {
                unwritten = notes;
                if (waiting) return;
                waiting = true;
                setTimeout(writeNotes, WRITE_DELAY_MS);
            },
            loadAsset: (id) => {
                if (!SAFE.test(id)) return undefined;
                const f = new fs.File(shots, `${id}.png`);
                return f.exists ? f.bytesSync() : undefined;
            },
            saveAsset: (id, bytes) => {
                if (SAFE.test(id)) new fs.File(shots, `${id}.png`).write(bytes);
            },
            deleteAsset: (id) => {
                if (!SAFE.test(id)) return;
                const f = new fs.File(shots, `${id}.png`);
                if (f.exists) f.delete();
            },
            loadSettings: () => readJson<Record<string, unknown>>("settings.json", {}),
            saveSettings: (settings) => writeJson("settings.json", settings),
            writeShare: (name, bytes) => {
                const f = new fs.File(root, name);
                f.write(bytes);
                return f.uri;
            },
        };
    } catch {
        return undefined;
    }
}
