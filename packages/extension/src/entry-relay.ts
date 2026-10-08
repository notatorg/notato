import { CHANNEL, type ToRelay } from "./protocol.ts";
import { createRelay } from "./relay.ts";
import { loadSites } from "./sites.ts";

// The content script in the extension's own world: the only part in the page that may talk to the extension.
const flag = "__notatoRelay";
const holder = globalThis as unknown as Record<string, unknown>;

if (!holder[flag]) {
    holder[flag] = true;
    createRelay({
        fromPage(handler) {
            const onMessage = (event: MessageEvent) => {
                if (event.source !== window) return;
                const data = event.data as Partial<ToRelay> | null;
                if (data?.channel === CHANNEL && data.to === "relay") handler(data as ToRelay);
            };
            window.addEventListener("message", onMessage);
            return () => window.removeEventListener("message", onMessage);
        },
        toPage: (message) => window.postMessage(message, window.location.origin),
        ask: (message) => chrome.runtime.sendMessage(message),
        connect: () => chrome.runtime.connect({ name: "events" }),
        loadConfig: async () => (await loadSites())[window.location.origin] ?? null,
    });
}
