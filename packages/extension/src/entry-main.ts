import { createController } from "@notato/browser";
import { createPageTransport, requestConfig, windowBus } from "./page.ts";
import { projectOf } from "./protocol.ts";

// Runs in the page's own world, so it can read the app's React components and offer `window.__notato` to a driver.
// It cannot reach the server itself, so its requests go through the relay (see protocol.ts).
declare global {
    interface Window {
        __notatoExtension?: boolean;
    }
}

if (!window.__notatoExtension) {
    window.__notatoExtension = true;
    const bus = windowBus();
    void requestConfig(bus).then((config) => {
        if (!config) {
            window.__notatoExtension = false; // not turned on for this site (or the extension did not answer)
            return;
        }
        createController({
            mode: "dev",
            server: config.server.replace(/\/$/, ""),
            project: projectOf(config, window.location.origin),
            // No token: it stays in the extension, and the background worker adds it to each request (`asSite`).
            author: config.author || undefined,
            appName: window.location.host,
            persist: false,
            transport: createPageTransport(bus),
        });
    });
}
