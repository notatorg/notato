// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    colorForName,
    createSettings,
    DEFAULT_SETTINGS,
    initialsOf,
    loadSettings,
    MARKER_COLORS,
    type SettingsStore,
} from "../src/settings.ts";
import { STYLES } from "../src/ui/styles.ts";

const KEY = "notato:settings";
const NAME_KEY = "notato:author";
const DETAIL_KEY = "notato:copy-detail";

/** The page's real storage, held on to so a test can look at it while the page is given something else. */
const real = window.localStorage;
const store = (key: string) => real.getItem(key);
const saved = (value: unknown) => real.setItem(KEY, JSON.stringify(value));
/** What another tab does: change storage, then the browser tells this tab with a `storage` event. */
const anotherTab = (key: string, value: string) => {
    real.setItem(key, value);
    window.dispatchEvent(new StorageEvent("storage", { key }));
};
/**
 * Puts a stand-in in front of the real storage that does what it does but can be watched, or made to fail. Spying on
 * `Storage.prototype` would not do: happy-dom hands out methods bound once, so a spy made later is never reached.
 */
const watchStorage = () => {
    const watched = {
        getItem: vi.fn((key: string) => real.getItem(key)),
        setItem: vi.fn((key: string, value: string) => real.setItem(key, value)),
        removeItem: vi.fn((key: string) => real.removeItem(key)),
    };
    vi.stubGlobal("localStorage", watched);
    return watched;
};
const denied = () => new DOMException("denied", "SecurityError");

/** Stores made by a test, so none of them keeps listening to the window after it. */
const made: SettingsStore[] = [];
const create = () => {
    const settings = createSettings();
    made.push(settings);
    return settings;
};

beforeEach(() => real.clear());
afterEach(() => {
    for (const settings of made.splice(0)) settings.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    real.clear();
});

describe("loadSettings", () => {
    it("gives the defaults when nothing is stored", () => {
        expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
        expect(DEFAULT_SETTINGS).toEqual({
            name: "",
            copyDetail: "standard",
            components: true,
            styles: true,
            screenshots: true,
            markerColor: "teal",
            mineOnly: false,
        });
    });

    it("reads the name from the key it was kept under before there was a panel", () => {
        real.setItem(NAME_KEY, "Ada Lovelace");
        expect(loadSettings().name).toBe("Ada Lovelace");
    });

    it("reads the copy level from the key it was kept under before there was a panel", () => {
        real.setItem(DETAIL_KEY, "forensic");
        expect(loadSettings().copyDetail).toBe("forensic");
    });

    it("reads everything else from the JSON under one key", () => {
        saved({
            components: false,
            styles: false,
            screenshots: false,
            markerColor: "pink",
            mineOnly: true,
        });
        expect(loadSettings()).toEqual({
            ...DEFAULT_SETTINGS,
            components: false,
            styles: false,
            screenshots: false,
            markerColor: "pink",
            mineOnly: true,
        });
    });

    it("takes the name and the copy level only from their own keys, never from the JSON", () => {
        saved({ name: "Someone Else", copyDetail: "forensic" });
        const loaded = loadSettings();
        expect(loaded.name).toBe("");
        expect(loaded.copyDetail).toBe("standard");
    });

    it("caps a stored name at 60 characters", () => {
        real.setItem(NAME_KEY, "n".repeat(100));
        expect(loadSettings().name).toBe("n".repeat(60));
    });

    it("falls back to the defaults, without throwing, when the JSON is garbage", () => {
        real.setItem(KEY, "{not json");
        expect(() => loadSettings()).not.toThrow();
        expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it("ignores JSON that is not an object", () => {
        for (const value of ["null", "[]", "[true]", "42", '"text"', "true"]) {
            real.setItem(KEY, value);
            expect(loadSettings(), value).toEqual(DEFAULT_SETTINGS);
        }
    });

    it("takes each field on its own: a wrong type loses that field and no other", () => {
        saved({ components: "yes", styles: 0, screenshots: false, markerColor: 7, mineOnly: true });
        expect(loadSettings()).toEqual({
            ...DEFAULT_SETTINGS,
            components: true,
            styles: true,
            screenshots: false,
            markerColor: "teal",
            mineOnly: true,
        });
    });

    it("falls back to teal for a colour id it does not know", () => {
        for (const markerColor of ["mauve", "BLUE", "", "#2563eb", "toString", null]) {
            saved({ markerColor, mineOnly: true });
            const loaded = loadSettings();
            expect(loaded.markerColor, String(markerColor)).toBe("teal");
            expect(loaded.mineOnly).toBe(true);
        }
    });

    it("moves a colour picked from the old palette to the nearest one now", () => {
        for (const [old, now] of [
            ["indigo", "violet"],
            ["sky", "blue"],
            ["red", "orange"],
            ["fuchsia", "pink"],
            ["slate", "ink"],
        ] as const) {
            saved({ markerColor: old });
            expect(loadSettings().markerColor, old).toBe(now);
        }
    });

    it("accepts every colour id it offers", () => {
        for (const { id } of MARKER_COLORS) {
            saved({ markerColor: id });
            expect(loadSettings().markerColor).toBe(id);
        }
    });

    it("falls back to standard for a copy level it does not know, and keeps the rest", () => {
        real.setItem(DETAIL_KEY, "everything");
        real.setItem(NAME_KEY, "Dom");
        saved({ screenshots: false });
        expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, name: "Dom", screenshots: false });
    });
});

describe("createSettings", () => {
    it("starts from what is stored", () => {
        real.setItem(NAME_KEY, "Dom");
        saved({ markerColor: "orange" });
        expect(create().get()).toEqual({ ...DEFAULT_SETTINGS, name: "Dom", markerColor: "orange" });
    });

    it("keeps a change, so the next visit reads it back", () => {
        const settings = create();
        settings.set({
            name: "Dom",
            copyDetail: "detailed",
            styles: false,
            markerColor: "violet",
            mineOnly: true,
        });
        const expected = {
            ...DEFAULT_SETTINGS,
            name: "Dom",
            copyDetail: "detailed",
            styles: false,
            markerColor: "violet",
            mineOnly: true,
        };
        expect(settings.get()).toEqual(expected);
        expect(loadSettings()).toEqual(expected);
    });

    it("writes the name and the copy level back under their own keys, and the rest as JSON without them", () => {
        const settings = create();
        settings.set({ name: "Dom", copyDetail: "compact", components: false });
        expect(store(NAME_KEY)).toBe("Dom");
        expect(store(DETAIL_KEY)).toBe("compact");
        expect(JSON.parse(store(KEY) as string)).toEqual({
            components: false,
            styles: true,
            screenshots: true,
            markerColor: "teal",
            mineOnly: false,
        });
    });

    it("trims the name", () => {
        const settings = create();
        settings.set({ name: "  Ada Lovelace \n" });
        expect(settings.get().name).toBe("Ada Lovelace");
        expect(store(NAME_KEY)).toBe("Ada Lovelace");
    });

    it("caps the name at 60 characters", () => {
        const settings = create();
        settings.set({ name: `   ${"x".repeat(80)}` });
        expect(settings.get().name).toBe("x".repeat(60));
        expect(store(NAME_KEY)).toBe("x".repeat(60));
    });

    it("turns a name of only spaces into no name", () => {
        const settings = create();
        settings.set({ name: "Dom" });
        settings.set({ name: "   " });
        expect(settings.get().name).toBe("");
    });

    it("tells subscribers once, with the new settings", () => {
        const settings = create();
        const heard = vi.fn();
        settings.subscribe(heard);
        settings.set({ markerColor: "orange", mineOnly: true });
        expect(heard).toHaveBeenCalledTimes(1);
        expect(heard).toHaveBeenCalledWith(settings.get());
        expect(heard.mock.calls[0]?.[0]).toMatchObject({ markerColor: "orange", mineOnly: true });
    });

    it("tells every subscriber, and one leaving while it is being told does not make another miss out", () => {
        const settings = create();
        const second = vi.fn();
        const third = vi.fn();
        const off = settings.subscribe(() => off());
        settings.subscribe(second);
        settings.subscribe(third);
        settings.set({ styles: false });
        expect(second).toHaveBeenCalledTimes(1);
        expect(third).toHaveBeenCalledTimes(1);
    });

    it("tells a subscriber added while it is telling about the next change, not the one in progress", () => {
        const settings = create();
        const late = vi.fn();
        let added = false;
        settings.subscribe(() => {
            if (added) return;
            added = true;
            settings.subscribe(late);
        });
        settings.set({ styles: false });
        expect(late).not.toHaveBeenCalled();
        settings.set({ styles: true });
        expect(late).toHaveBeenCalledTimes(1);
    });

    it("does nothing, and says nothing, when nothing changed", () => {
        const settings = create();
        settings.set({ name: "Dom", markerColor: "pink" });
        const heard = vi.fn();
        settings.subscribe(heard);
        const { setItem } = watchStorage();

        settings.set({});
        settings.set({ markerColor: "pink" });
        settings.set({ name: "Dom", components: true, copyDetail: "standard" });
        settings.set({ name: "  Dom  " }); // the same name once trimmed

        expect(heard).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();

        settings.set({ markerColor: "orange" }); // and the watching does see a real change
        expect(heard).toHaveBeenCalledTimes(1);
        expect(setItem).toHaveBeenCalled();
    });

    it("stops telling a subscriber that has unsubscribed, and goes on telling the others", () => {
        const settings = create();
        const gone = vi.fn();
        const kept = vi.fn();
        const off = settings.subscribe(gone);
        settings.subscribe(kept);
        settings.set({ components: false });
        off();
        settings.set({ components: true });
        expect(gone).toHaveBeenCalledTimes(1);
        expect(kept).toHaveBeenCalledTimes(2);
    });

    describe("when another tab changes it", () => {
        it.each([
            [NAME_KEY, "Ana", { name: "Ana" }],
            [DETAIL_KEY, "forensic", { copyDetail: "forensic" }],
            [
                KEY,
                JSON.stringify({ markerColor: "ink", mineOnly: true }),
                { markerColor: "ink", mineOnly: true },
            ],
        ])("follows a change to %s and tells subscribers", (key, value, expected) => {
            const settings = create();
            const heard = vi.fn();
            settings.subscribe(heard);
            anotherTab(key, value);
            expect(settings.get()).toMatchObject(expected);
            expect(heard).toHaveBeenCalledTimes(1);
            expect(heard).toHaveBeenCalledWith(settings.get());
        });

        it("ignores a change to any other key", () => {
            const settings = create();
            const heard = vi.fn();
            settings.subscribe(heard);
            const before = settings.get();
            anotherTab("something-else", "x");
            anotherTab("notato:other", "x");
            window.dispatchEvent(new StorageEvent("storage", { key: null })); // storage cleared as a whole
            expect(heard).not.toHaveBeenCalled();
            expect(settings.get()).toBe(before);
        });

        it("lets go of what the other tab removed", () => {
            real.setItem(NAME_KEY, "Dom");
            const settings = create();
            real.removeItem(NAME_KEY);
            window.dispatchEvent(new StorageEvent("storage", { key: NAME_KEY }));
            expect(settings.get().name).toBe("");
        });

        it("does not write anything itself when it only follows another tab", () => {
            const settings = create();
            real.setItem(NAME_KEY, "Ana");
            const { setItem } = watchStorage();
            window.dispatchEvent(new StorageEvent("storage", { key: NAME_KEY }));
            expect(settings.get().name).toBe("Ana");
            expect(setItem).not.toHaveBeenCalled();
        });
    });

    it("stops listening for other tabs, and drops its subscribers, once it is destroyed", () => {
        const settings = create();
        const heard = vi.fn();
        settings.subscribe(heard);
        settings.destroy();
        anotherTab(NAME_KEY, "Ana");
        expect(heard).not.toHaveBeenCalled();
        expect(settings.get().name).toBe("");
        settings.set({ markerColor: "orange" });
        expect(heard).not.toHaveBeenCalled();
    });

    describe("when storage is unavailable", () => {
        it("starts from the defaults when storage cannot be read", () => {
            real.setItem(NAME_KEY, "Dom");
            const { getItem } = watchStorage();
            getItem.mockImplementation(() => {
                throw denied();
            });
            expect(() => loadSettings()).not.toThrow();
            expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
            expect(create().get()).toEqual(DEFAULT_SETTINGS);
            expect(getItem).toHaveBeenCalled();
        });

        it("still changes, and tells subscribers, for the rest of the visit when it cannot be written", () => {
            const { setItem } = watchStorage();
            setItem.mockImplementation(() => {
                throw denied();
            });
            const settings = create();
            const heard = vi.fn();
            settings.subscribe(heard);
            expect(() => settings.set({ name: "Dom", markerColor: "orange" })).not.toThrow();
            expect(setItem).toHaveBeenCalled();
            expect(settings.get()).toMatchObject({ name: "Dom", markerColor: "orange" });
            expect(heard).toHaveBeenCalledTimes(1);
            settings.set({ markerColor: "orange" });
            expect(heard).toHaveBeenCalledTimes(1);
            expect(store(NAME_KEY)).toBeNull();
        });

        it("works when merely touching localStorage throws, as it does with cookies blocked", () => {
            const touched = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
                throw denied();
            });
            let settings: SettingsStore | undefined;
            expect(() => {
                settings = create();
                settings.set({ name: "Dom", mineOnly: true });
            }).not.toThrow();
            expect(touched).toHaveBeenCalled();
            expect(settings?.get()).toMatchObject({ name: "Dom", mineOnly: true });
            expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
        });
    });
});

describe("colorForName", () => {
    it("gives the same colour for the same name, every time", () => {
        expect(colorForName("Ada Lovelace")).toBe(colorForName("Ada Lovelace"));
        expect(colorForName("")).toBe(colorForName(""));
    });

    it("gives different colours to different names", () => {
        const names = ["Dom", "Ana", "Bob", "Maria Lopez", "Ada Lovelace", "Priya", "Chen"];
        const colours = names.map(colorForName);
        expect(new Set(colours).size).toBe(names.length);
    });

    it("tells names apart by case, because they are different names", () => {
        expect(colorForName("dom")).not.toBe(colorForName("Dom"));
    });

    it("is an hsl colour with a hue on the wheel, and the same saturation and lightness for everyone", () => {
        for (const name of [
            "",
            "a",
            "Dom",
            "A very long name indeed, with commas",
            "日本語",
            "😀",
            "\u0000",
        ]) {
            const match = /^hsl\((\d+) 60% 42%\)$/.exec(colorForName(name));
            expect(match, name).not.toBeNull();
            const hue = Number(match?.[1]);
            expect(hue).toBeGreaterThanOrEqual(0);
            expect(hue).toBeLessThan(360);
        }
    });

    it("does not overflow into a negative or non-finite hue for a very long name", () => {
        const colour = colorForName("zyxwvutsrqponmlkjihgfedcba".repeat(200));
        expect(colour).toMatch(/^hsl\(\d{1,3} 60% 42%\)$/);
    });
});

/** Half of a surrogate pair with nothing to pair with: what slicing through an emoji leaves. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("initialsOf", () => {
    it("is the first letters of the first and last name, in capitals", () => {
        expect(initialsOf("Ada Lovelace")).toBe("AL");
        expect(initialsOf("ana lopez")).toBe("AL");
    });

    it("is one letter for a single name, however long", () => {
        expect(initialsOf("dom")).toBe("D");
        expect(initialsOf("Cher")).toBe("C");
    });

    it("skips the middle names, and every kind of extra space", () => {
        expect(initialsOf("  ana  maria   lopez ")).toBe("AL");
        expect(initialsOf("Jean Claude Van Damme")).toBe("JD");
        expect(initialsOf("ana\tmaria\nlopez")).toBe("AL");
    });

    it("is nothing for no name, or one of only spaces", () => {
        expect(initialsOf("")).toBe("");
        expect(initialsOf("   ")).toBe("");
        expect(initialsOf(" \t\n ")).toBe("");
    });

    it("never splits a surrogate pair", () => {
        expect([...initialsOf("😀 Smith")]).toEqual(["😀", "S"]);
        expect([...initialsOf("Smith 😀")]).toEqual(["S", "😀"]);
        expect([...initialsOf("😀")]).toEqual(["😀"]);
        // an astral letter that has a capital form: both halves of the pair are kept and capitalised together
        expect(initialsOf("\u{10428} doe")).toBe("\u{10400}D");
        for (const name of ["😀 Smith", "Smith 😀", "👩‍💻 Dev", "\u{10428}\u{10428} \u{10428}"]) {
            expect(initialsOf(name), name).not.toMatch(LONE_SURROGATE);
        }
    });
});

describe("MARKER_COLORS", () => {
    it("offers seven colours, each with an id, a name and a six-digit hex", () => {
        expect(MARKER_COLORS).toHaveLength(7);
        for (const colour of MARKER_COLORS) {
            expect(colour.id).toMatch(/^[a-z]+$/);
            expect(colour.name).not.toBe("");
            expect(colour.hex).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it("has no id, name or colour twice", () => {
        expect(new Set(MARKER_COLORS.map((c) => c.id)).size).toBe(MARKER_COLORS.length);
        expect(new Set(MARKER_COLORS.map((c) => c.name)).size).toBe(MARKER_COLORS.length);
        expect(new Set(MARKER_COLORS.map((c) => c.hex)).size).toBe(MARKER_COLORS.length);
    });

    it("keeps the default colour among the ones on offer", () => {
        expect(MARKER_COLORS.map((c) => c.id)).toContain(DEFAULT_SETTINGS.markerColor);
    });

    describe("against the colours a status already means", () => {
        // Read from the styles, so a status colour added there is held to this too.
        const statusColours = [
            ...STYLES.matchAll(
                /\.pin\[data-status="[^"]+"\]\s*\{\s*background:\s*(#[0-9a-fA-F]{6})/g
            ),
        ].map((m) => (m[1] as string).toLowerCase());

        it("the styles still use the status colours this guards", () => {
            for (const hex of ["#d99a1e", "#2e9a5b", "#8b5cf6", "#0891b2"])
                expect(statusColours).toContain(hex);
        });

        it("none is the same as any of them, because a pin in a status colour would look acted on", () => {
            for (const colour of MARKER_COLORS)
                expect(statusColours, colour.id).not.toContain(colour.hex);
        });
    });
});
