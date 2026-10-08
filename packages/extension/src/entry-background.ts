import { createWorker } from "./background.ts";
import type { ToBackground } from "./protocol.ts";
import { loadSites, reregisterAll } from "./sites.ts";

const worker = createWorker({
    fetch: (input, init) => fetch(input, init),
    siteConfig: async (origin) => (await loadSites())[origin] ?? null,
});

/** The origin the browser says a message came from. A page cannot choose it. */
const originOf = (sender: chrome.runtime.MessageSender): string => {
    if (sender.origin) return sender.origin;
    try {
        return new URL(sender.url ?? "").origin;
    } catch {
        return "";
    }
};

chrome.runtime.onMessage.addListener((message: ToBackground, sender, respond) => {
    const fromExtension = (sender.url ?? "").startsWith(chrome.runtime.getURL(""));
    // `ping` is how the popup tests a server: not something a page's script may ask for.
    if (message.kind === "ping" && !fromExtension) return false;
    void worker.handle(originOf(sender), message).then(respond);
    return true; // the answer comes later
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "events") worker.stream(originOf(port.sender ?? {}), port);
});

chrome.runtime.onInstalled.addListener(() => void reregisterAll());
chrome.runtime.onStartup.addListener(() => void reregisterAll());
