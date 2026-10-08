import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    annotatable,
    defaultConfig,
    injectNow,
    loadSites,
    registerSite,
    removeNow,
    reregisterAll,
    saveSite,
    unregisterSite,
} from "../src/sites.ts";

interface Registered {
    id: string;
    matches: string[];
    js: string[];
    world: string;
    runAt: string;
    persistAcrossSessions: boolean;
}

let stored: Record<string, unknown>;
let registered: Registered[];
let injected: Array<Record<string, unknown>>;
const original = (globalThis as { chrome?: unknown }).chrome;

beforeEach(() => {
    stored = {};
    registered = [];
    injected = [];
    (globalThis as { chrome?: unknown }).chrome = {
        storage: {
            local: {
                get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}),
                set: async (values: Record<string, unknown>) => Object.assign(stored, values),
            },
        },
        scripting: {
            registerContentScripts: async (scripts: Registered[]) => {
                for (const s of scripts) {
                    if (registered.some((r) => r.id === s.id))
                        throw new Error(`Duplicate script ID '${s.id}'`);
                    registered.push(s);
                }
            },
            getRegisteredContentScripts: async ({ ids }: { ids: string[] }) =>
                registered.filter((r) => ids.includes(r.id)),
            unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
                registered = registered.filter((r) => !ids.includes(r.id));
            },
            executeScript: async (details: Record<string, unknown>) => {
                injected.push(details);
            },
        },
    };
});
afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = original;
});

describe("which pages", () => {
    it("only web pages, by their origin", () => {
        expect(annotatable("https://app.example.com/a/b?c=1#d")).toBe("https://app.example.com");
        expect(annotatable("http://localhost:5173/")).toBe("http://localhost:5173");
        for (const url of [
            "chrome://extensions",
            "chrome-extension://abc/popup.html",
            "file:///a.html",
            "about:blank",
            "",
            undefined,
            "nope",
        ])
            expect(annotatable(url as string | undefined), String(url)).toBeNull();
    });
});

describe("a site's settings", () => {
    it("start as the server on this machine and the page's own host as the project, and are off", () => {
        expect(defaultConfig("http://localhost:5173")).toEqual({
            enabled: false,
            server: "http://localhost:4747",
            project: "localhost-5173",
        });
    });

    it("are kept per origin, and one site's do not touch another's", async () => {
        expect(await loadSites()).toEqual({});
        await saveSite("https://a.example", {
            enabled: true,
            server: "http://localhost:4747",
            project: "a",
        });
        await saveSite("https://b.example", {
            enabled: false,
            server: "http://localhost:4747",
            project: "b",
        });
        await saveSite("https://a.example", {
            enabled: true,
            server: "http://localhost:4747",
            project: "a2",
        });
        const sites = await loadSites();
        expect(Object.keys(sites).sort()).toEqual(["https://a.example", "https://b.example"]);
        expect(sites["https://a.example"]?.project).toBe("a2");
        expect(sites["https://b.example"]?.enabled).toBe(false);
    });
});

describe("loading itself on a site", () => {
    it("registers the relay first, in the extension's world at document start, then the page script in the page's world", async () => {
        await registerSite("https://app.example.com");
        expect(registered.map((r) => [r.js[0], r.world, r.runAt])).toEqual([
            ["relay.js", "ISOLATED", "document_start"],
            ["main.js", "MAIN", "document_idle"],
        ]);
        for (const r of registered) {
            expect(r.matches).toEqual(["https://app.example.com/*"]);
            expect(r.persistAcrossSessions).toBe(true);
        }
    });

    it("registering again replaces rather than fails or doubles", async () => {
        await registerSite("https://app.example.com");
        await registerSite("https://app.example.com");
        expect(registered).toHaveLength(2);
    });

    it("two sites are separate registrations, and turning one off leaves the other", async () => {
        await registerSite("https://a.example");
        await registerSite("https://b.example");
        expect(registered).toHaveLength(4);
        await unregisterSite("https://a.example");
        expect(registered.map((r) => r.matches[0])).toEqual([
            "https://b.example/*",
            "https://b.example/*",
        ]);
        await unregisterSite("https://a.example"); // already gone: nothing to do
        expect(registered).toHaveLength(2);
    });

    it("an open tab gets the relay and then the page script, and can be taken off again", async () => {
        await injectNow(7);
        expect(injected.map((d) => [(d.files as string[])[0], d.world])).toEqual([
            ["relay.js", "ISOLATED"],
            ["main.js", "MAIN"],
        ]);
        await removeNow(7);
        expect(injected.at(-1)).toMatchObject({ target: { tabId: 7 }, world: "MAIN" });
        expect(typeof injected.at(-1)?.func).toBe("function");
    });

    it("after an update, only the sites that are on are registered again", async () => {
        await saveSite("https://on.example", {
            enabled: true,
            server: "http://localhost:4747",
            project: "on",
        });
        await saveSite("https://off.example", {
            enabled: false,
            server: "http://localhost:4747",
            project: "off",
        });
        await reregisterAll();
        expect([...new Set(registered.map((r) => r.matches[0]))]).toEqual(["https://on.example/*"]);
    });
});
