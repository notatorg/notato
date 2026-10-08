import { afterEach, beforeEach, type Mock, vi } from "vitest";
import { createSettings, type Settings } from "../../src/settings.ts";
import {
    createSettingsPanel,
    type ServerInfo,
    type ServerLinks,
    type SettingsPanel,
} from "../../src/ui/settings-panel.ts";

// What the settings panel tests share: a panel over a real settings store, in a layer in the page, and ways to find
// and use what is in it. A test file calls `useSettingsPanel()` once, and each of its tests starts afresh.

export const real = window.localStorage;
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

export let layer: HTMLElement;
export let settings: ReturnType<typeof createSettings>;
export let panel: SettingsPanel;
export let onHide: Mock<() => void>;

export function useSettingsPanel(): void {
    beforeEach(() => {
        real.clear();
        layer = document.createElement("div");
        document.body.append(layer);
    });
    afterEach(() => {
        panel?.destroy();
        settings?.destroy();
        layer.remove();
        vi.restoreAllMocks();
        real.clear();
    });
}

export interface MountOptions {
    server?: ServerLinks;
    /** What the server says about screenshots. */
    screenshots?: boolean;
    /** Settings already stored before the panel is made. */
    stored?: Partial<Settings>;
}

/** A panel over a real settings store, in a layer in the page. Nothing is open yet. */
export function mount({ server, screenshots = true, stored = {} }: MountOptions = {}) {
    const { name, copyDetail, ...rest } = stored;
    if (name !== undefined) real.setItem("notato:author", name);
    if (copyDetail !== undefined) real.setItem("notato:copy-detail", copyDetail);
    if (Object.keys(rest).length > 0) real.setItem("notato:settings", JSON.stringify(rest));
    settings = createSettings();
    onHide = vi.fn<() => void>();
    const state = { screenshots };
    panel = createSettingsPanel({
        layer,
        settings,
        anchor: () => ({ left: 700, top: 700, width: 40 }),
        server,
        serverScreenshots: () => state.screenshots,
        onHide,
    });
    return { panel, settings, state };
}

export const dialog = () => layer.querySelector<HTMLElement>(".spanel");
export const root = () => dialog() as HTMLElement;
export const text = () => dialog()?.textContent ?? "";
export const field = <T extends HTMLElement>(selector: string) =>
    root().querySelector(selector) as T;
export const nameInput = () => field<HTMLInputElement>('input[aria-label="Your name"]');
export const sw = (label: string) =>
    field<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
export const note = (label: string) =>
    (sw(label).closest(".srow") as HTMLElement).querySelector(".shelp")?.textContent;
export const radios = (group: string) => [
    ...root().querySelectorAll<HTMLButtonElement>(
        `[role="radiogroup"][aria-label="${group}"] button`
    ),
];
export const checked = (group: string) =>
    radios(group)
        .filter((b) => b.getAttribute("aria-checked") === "true")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent);
export const button = (label: string) =>
    [...root().querySelectorAll("button")].find((b) =>
        b.textContent?.includes(label)
    ) as HTMLButtonElement;
export const title = () => field(".stitle").textContent;
export const press = (target: Element, type = "mousedown") =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true }));
export const pressKey = (key: string, target: EventTarget = document.body) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
/** Types into the name field and leaves it, which is when it is saved. */
export const typeName = (value: string) => {
    const input = nameInput();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
};

/** What a server says about itself, with what a test changes. */
export const info = (over: Partial<ServerInfo> = {}): ServerInfo => ({
    version: "0.3.1",
    mode: "dev",
    pages: 2,
    screenshots: "on",
    ...over,
});
/** A server for the panel to show: connected, and answering with `info()`. */
export function links(over: Partial<ServerLinks> = {}): ServerLinks {
    return {
        url: "http://localhost:4747",
        project: "checkout-web",
        connection: () => "connected",
        status: async () => info(),
        ...over,
    };
}
/** The panel open on its server view, with the server's answers in. */
export async function openServer(over: Partial<ServerLinks> = {}, options: MountOptions = {}) {
    const mounted = mount({ ...options, server: links(over) });
    panel.open();
    button("Server and agent").click();
    await tick();
    return mounted;
}
