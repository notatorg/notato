import { DEFAULT_SERVER, projectFor, type SiteConfig } from "./protocol.ts";

const KEY = "sites";
const SCRIPT_PREFIX = "notato:";

/** The sites that have been set up, by origin. */
export async function loadSites(): Promise<Record<string, SiteConfig>> {
    const stored = (await chrome.storage.local.get(KEY))[KEY] as
        | Record<string, SiteConfig>
        | undefined;
    return stored ?? {};
}

export async function saveSite(origin: string, config: SiteConfig): Promise<void> {
    const sites = await loadSites();
    sites[origin] = config;
    await chrome.storage.local.set({ [KEY]: sites });
}

/** What a site starts with: the server on this machine, and the page's own host as the project. */
export function defaultConfig(origin: string): SiteConfig {
    let host = origin;
    try {
        host = new URL(origin).host;
    } catch {
        // keep the text
    }
    return { enabled: false, server: DEFAULT_SERVER, project: projectFor(host) };
}

/** Only http and https pages can be annotated: not the browser's own pages, the store, or a file. */
export function annotatable(url: string | undefined): string | null {
    try {
        const parsed = new URL(url ?? "");
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
    } catch {
        return null;
    }
}

const idsFor = (origin: string) => [
    `${SCRIPT_PREFIX}relay:${origin}`,
    `${SCRIPT_PREFIX}main:${origin}`,
];

/** Has Notato load itself on every page of a site, from now on. The relay first, so it is there to answer the page. */
export async function registerSite(origin: string): Promise<void> {
    await unregisterSite(origin);
    await chrome.scripting.registerContentScripts([
        {
            id: idsFor(origin)[0] as string,
            matches: [`${origin}/*`],
            js: ["relay.js"],
            world: "ISOLATED",
            runAt: "document_start",
            persistAcrossSessions: true,
        },
        {
            id: idsFor(origin)[1] as string,
            matches: [`${origin}/*`],
            js: ["main.js"],
            world: "MAIN",
            runAt: "document_idle",
            persistAcrossSessions: true,
        },
    ]);
}

export async function unregisterSite(origin: string): Promise<void> {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: idsFor(origin) });
    if (existing.length)
        await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
}

/** Loads Notato into a tab that is already open, which registering does not reach. */
export async function injectNow(tabId: number): Promise<void> {
    await chrome.scripting.executeScript({
        target: { tabId },
        files: ["relay.js"],
        world: "ISOLATED",
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["main.js"], world: "MAIN" });
}

/** Takes Notato off a tab that is already open. */
export async function removeNow(tabId: number): Promise<void> {
    await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
            const w = window as unknown as {
                __notatoDestroy?: () => void;
                __notatoExtension?: boolean;
            };
            w.__notatoDestroy?.();
            w.__notatoExtension = false;
        },
    });
}

/** After the browser or the extension updates: makes sure every site that is turned on is registered. */
export async function reregisterAll(): Promise<void> {
    const sites = await loadSites();
    for (const [origin, config] of Object.entries(sites)) {
        if (config.enabled) await registerSite(origin);
    }
}
