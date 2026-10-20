import { createWorker } from "./background.ts";
import type { ConfigRequest, ToBackground } from "./protocol.ts";
import { closeToContentScripts, loadSites, reregisterAll } from "./sites.ts";

const worker = createWorker({
    fetch: (input, init) => fetch(input, init),
    extensionOrigin: chrome.runtime.getURL("").replace(/\/$/, ""),
    siteConfig: async (origin) => (await loadSites())[origin] ?? null,
});

// Each time the worker starts (installed, updated, the browser started, woken for a page), rather than trusting that a
// setting made once was kept.
void closeToContentScripts();

/** The origin the browser says a message came from. A page cannot choose it. */
const originOf = (sender: chrome.runtime.MessageSender): string => {
    if (sender.origin) return sender.origin;
    try {
        return new URL(sender.url ?? "").origin;
    } catch {
        return "";
    }
};

chrome.runtime.onMessage.addListener((message: ToBackground | ConfigRequest, sender, respond) => {
    if (message.kind === "config") {
        // Only ever the settings of the site the browser says is asking, and never its token.
        void worker.pageConfig(originOf(sender)).then(respond, () => respond(null));
        return true;
    }
    const fromExtension = (sender.url ?? "").startsWith(chrome.runtime.getURL(""));
    // Only the popup may check unsaved settings or supply a token. Pages stay bound to their saved configuration.
    if (message.kind === "check" && !fromExtension) return false;
    void worker.handle(originOf(sender), message).then(respond);
    return true; // the answer comes later
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "events") worker.stream(originOf(port.sender ?? {}), port);
});

chrome.runtime.onInstalled.addListener(() => void reregisterAll());
chrome.runtime.onStartup.addListener(() => void reregisterAll());
