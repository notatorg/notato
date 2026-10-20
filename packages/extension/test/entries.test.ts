import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CHANNEL, type SiteConfig, type ToPage } from "../src/protocol.ts";

// The background worker and the relay as the browser loads them, against a stand-in for the parts of `chrome` they use.

type OnMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (answer: unknown) => void
) => boolean;

const SITES: Record<string, SiteConfig> = {
    "https://app.example": {
        enabled: true,
        server: "http://localhost:4747",
        project: "shop",
        token: "notato_app",
    },
    "https://other.example": {
        enabled: true,
        server: "http://localhost:4747",
        project: "other",
        token: "notato_other",
    },
    "https://off.example": {
        enabled: false,
        server: "http://localhost:4747",
        project: "off",
        token: "notato_off",
    },
};

const onMessage: OnMessage[] = [];
const accessLevels: unknown[] = [];
const storageReads: string[] = [];
/** Who reads the extension's storage now: the worker, while it handles a message, and otherwise the relay. */
let reader: "worker" | "relay" = "worker";
const sentByRelay: unknown[] = [];
const pageHeard: unknown[] = [];
let fromPage: ((event: { source: unknown; data: unknown }) => void) | undefined;

const globals = globalThis as Record<string, unknown>;
const saved = { chrome: globals.chrome, window: globals.window };
const ignored = { addListener: () => {} };

beforeAll(async () => {
    globals.chrome = {
        storage: {
            local: {
                get: async (key: string) => {
                    storageReads.push(reader);
                    return { [key]: structuredClone(SITES) };
                },
                setAccessLevel: async (options: unknown) => {
                    accessLevels.push(options);
                },
            },
        },
        runtime: {
            onMessage: { addListener: (fn: OnMessage) => onMessage.push(fn) },
            onConnect: ignored,
            onInstalled: ignored,
            onStartup: ignored,
            getURL: (path: string) => `chrome-extension://notato/${path}`,
            // The relay's messages reach the worker as the browser would deliver them: from its page's origin.
            sendMessage: (message: unknown) => {
                sentByRelay.push(message);
                return ask(message, {
                    origin: "https://app.example",
                    url: "https://app.example/a",
                });
            },
            connect: () => ({}),
        },
    };
    const page = {
        location: { origin: "https://app.example" },
        addEventListener: (_type: string, fn: typeof fromPage) => {
            fromPage = fn;
        },
        removeEventListener: () => {},
        postMessage: (message: unknown) => pageHeard.push(message),
    };
    globals.window = page;
    await import("../src/entry-background.ts");
    reader = "relay";
    await import("../src/entry-relay.ts");
});

afterAll(() => {
    globals.chrome = saved.chrome;
    globals.window = saved.window;
    delete globals.__notatoRelay;
});

/** A message to the worker, from `sender`, and its answer. The worker reads its storage as it starts handling one. */
function ask(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    return new Promise((resolve) => {
        const was = reader;
        reader = "worker";
        try {
            if (!onMessage[0]?.(message, sender, resolve)) resolve(undefined);
        } finally {
            reader = was;
        }
    });
}

describe("the background worker", () => {
    it("refuses connection checks from pages, so they cannot choose a server or supply a token", async () => {
        expect(
            await ask(
                {
                    kind: "check",
                    server: "https://elsewhere.example",
                    project: "other",
                    token: "page_supplied",
                },
                { origin: "https://app.example", url: "https://app.example/" }
            )
        ).toBeUndefined();
    });

    it("keeps the extension's storage from content scripts as soon as it starts", () => {
        expect(accessLevels).toEqual([{ accessLevel: "TRUSTED_CONTEXTS" }]);
    });

    it("tells a page's relay its own site's settings, never another's, and never a token", async () => {
        expect(
            await ask(
                { kind: "config" },
                { origin: "https://app.example", url: "https://app.example/" }
            )
        ).toEqual({ enabled: true, server: "http://localhost:4747", project: "shop" });
        // The origin is the browser's, from the sender, whatever page the message names.
        expect(
            await ask(
                { kind: "config", origin: "https://other.example" },
                { origin: "https://app.example" }
            )
        ).toEqual({ enabled: true, server: "http://localhost:4747", project: "shop" });
        expect(await ask({ kind: "config" }, { origin: "https://off.example" })).toBeNull();
        expect(await ask({ kind: "config" }, { origin: "https://unknown.example" })).toBeNull();
        expect(await ask({ kind: "config" }, {})).toBeNull();
    });
});

describe("the relay", () => {
    it("gets its settings from the worker, never from the extension's storage, and hands the page no token", async () => {
        const before = pageHeard.length;
        fromPage?.({
            source: globals.window,
            data: { channel: CHANNEL, to: "relay", kind: "hello" },
        });
        const end = Date.now() + 2000;
        while (pageHeard.length === before && Date.now() < end)
            await new Promise((r) => setTimeout(r, 5));
        expect(pageHeard.at(-1) as ToPage).toEqual({
            channel: CHANNEL,
            to: "page",
            kind: "config",
            config: { enabled: true, server: "http://localhost:4747", project: "shop" },
        });
        expect(sentByRelay).toContainEqual({ kind: "config" });
        expect(storageReads).not.toContain("relay");
        expect(JSON.stringify(pageHeard)).not.toContain("notato_");
    });
});
