// @vitest-environment happy-dom
import { DETAILS } from "@notato/core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
    createSettings,
    DEFAULT_SETTINGS,
    loadSettings,
    MARKER_COLORS,
    type Settings,
} from "../src/settings.ts";
import {
    createSettingsPanel,
    type ServerInfo,
    type ServerLinks,
    type SettingsPanel,
} from "../src/ui/settings-panel.ts";
import type { ConnectionState } from "../src/ui/toolbar.ts";

const real = window.localStorage;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

let layer: HTMLElement;
let settings: ReturnType<typeof createSettings>;
let panel: SettingsPanel;
let onHide: Mock<() => void>;

interface MountOptions {
    server?: ServerLinks;
    /** What the server says about screenshots. */
    screenshots?: boolean;
    /** Settings already stored before the panel is made. */
    stored?: Partial<Settings>;
}

/** A panel over a real settings store, in a layer in the page. Nothing is open yet. */
function mount({ server, screenshots = true, stored = {} }: MountOptions = {}) {
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

const dialog = () => layer.querySelector<HTMLElement>(".spanel");
const root = () => dialog() as HTMLElement;
const text = () => dialog()?.textContent ?? "";
const field = <T extends HTMLElement>(selector: string) => root().querySelector(selector) as T;
const nameInput = () => field<HTMLInputElement>('input[aria-label="Your name"]');
const sw = (label: string) =>
    field<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
const note = (label: string) =>
    (sw(label).closest(".srow") as HTMLElement).querySelector(".shelp")?.textContent;
const radios = (group: string) => [
    ...root().querySelectorAll<HTMLButtonElement>(
        `[role="radiogroup"][aria-label="${group}"] button`
    ),
];
const checked = (group: string) =>
    radios(group)
        .filter((b) => b.getAttribute("aria-checked") === "true")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent);
const button = (label: string) =>
    [...root().querySelectorAll("button")].find((b) =>
        b.textContent?.includes(label)
    ) as HTMLButtonElement;
const title = () => field(".stitle").textContent;
const press = (target: Element, type = "mousedown") =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true }));
const pressKey = (key: string, target: EventTarget = document.body) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
/** Types into the name field and leaves it, which is when it is saved. */
const typeName = (value: string) => {
    const input = nameInput();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
};

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

describe("opening and closing", () => {
    it("opens a dialog in the layer, and is open while it is there", () => {
        mount();
        expect(dialog()).toBeNull();
        expect(panel.isOpen).toBe(false);
        panel.open();
        expect(panel.isOpen).toBe(true);
        expect(dialog()?.getAttribute("role")).toBe("dialog");
        expect(dialog()?.getAttribute("aria-label")).toBe("Notato settings");
        expect(dialog()?.parentElement).toBe(layer);
        expect(title()).toBe("Notato settings");
    });

    it("opening it again does not make a second one", () => {
        mount();
        panel.open();
        const first = dialog();
        panel.open();
        expect(layer.querySelectorAll(".spanel")).toHaveLength(1);
        expect(dialog()).toBe(first);
    });

    it("sits above the toolbar button it came from, and stays on screen", () => {
        mount();
        panel.open();
        // the anchor is 700 down and 700 across in a window much smaller than that, so it is held inside it
        expect(root().style.bottom).toBe(`${Math.max(8, window.innerHeight - 700 + 8)}px`);
        expect(Number.parseInt(root().style.left, 10)).toBeGreaterThanOrEqual(8);
        expect(Number.parseInt(root().style.left, 10)).toBeLessThanOrEqual(window.innerWidth - 8);
    });

    it("closes with close(), and the dialog is gone", () => {
        mount();
        panel.open();
        panel.close();
        expect(dialog()).toBeNull();
        expect(panel.isOpen).toBe(false);
    });

    it("closes with the cross in its header", () => {
        mount();
        panel.open();
        field<HTMLButtonElement>('button[aria-label="Close settings"]').click();
        expect(dialog()).toBeNull();
    });

    it("closes with Escape, and the page does not hear that Escape", () => {
        mount();
        const page = vi.fn();
        document.addEventListener("keydown", page);
        panel.open();
        pressKey("Escape");
        document.removeEventListener("keydown", page);
        expect(dialog()).toBeNull();
        expect(page).not.toHaveBeenCalled();
    });

    it("stays open for any other key, and the page hears those", () => {
        mount();
        const page = vi.fn();
        document.addEventListener("keydown", page);
        panel.open();
        pressKey("a");
        pressKey("Enter");
        document.removeEventListener("keydown", page);
        expect(dialog()).not.toBeNull();
        expect(page).toHaveBeenCalledTimes(2);
    });

    it("does not take Escape from the page once it is closed", () => {
        mount();
        const page = vi.fn();
        document.addEventListener("keydown", page);
        panel.open();
        panel.close();
        pressKey("Escape");
        document.removeEventListener("keydown", page);
        expect(page).toHaveBeenCalledTimes(1);
    });

    it("closes on a mouse press outside it, once the click that opened it is over", async () => {
        mount();
        panel.open();
        press(document.body); // still the opening gesture: it does not close it at once
        expect(dialog()).not.toBeNull();
        await tick();
        press(document.body);
        expect(dialog()).toBeNull();
    });

    it("is not closed by a press on the panel itself", async () => {
        mount();
        panel.open();
        await tick();
        press(root());
        press(sw("Component names"));
        press(nameInput());
        expect(dialog()).not.toBeNull();
    });

    it("is not closed by the click on the button that opened it", async () => {
        mount();
        const opener = document.createElement("button");
        document.body.append(opener);
        opener.addEventListener("click", () => panel.toggle());
        opener.click();
        await tick();
        expect(dialog()).not.toBeNull();
        opener.remove();
    });

    it("does not listen for presses once it has been closed before the opening gesture finished", async () => {
        mount();
        const listen = vi.spyOn(window, "addEventListener");
        panel.open();
        panel.close();
        await tick();
        expect(listen.mock.calls.map(([type]) => type)).not.toContain("mousedown");
    });

    it("lets go of every listener it put on the window when it closes", async () => {
        mount();
        const added = vi.spyOn(window, "addEventListener");
        const removed = vi.spyOn(window, "removeEventListener");
        panel.open();
        await tick();
        panel.close();
        const mine = added.mock.calls.filter(
            ([type]) => type === "keydown" || type === "mousedown"
        );
        expect(mine.map(([type]) => type).sort()).toEqual(["keydown", "mousedown"]);
        for (const [type, listener] of mine) {
            expect(
                removed.mock.calls.some(([t, l]) => t === type && l === listener),
                `${type} listener removed`
            ).toBe(true);
        }
    });

    it("toggle opens it when closed and closes it when open", () => {
        mount();
        panel.toggle();
        expect(dialog()).not.toBeNull();
        panel.toggle();
        expect(dialog()).toBeNull();
        panel.toggle();
        expect(panel.isOpen).toBe(true);
    });

    it("destroy removes it", () => {
        mount();
        panel.open();
        panel.destroy();
        expect(dialog()).toBeNull();
    });

    it("opens at the main view again after being closed in the server view", async () => {
        mount({ server: links() });
        panel.open();
        button("Server and agent").click();
        expect(title()).toBe("Server and agent");
        panel.close();
        panel.open();
        expect(title()).toBe("Notato settings");
        await tick();
    });
});

describe("the name", () => {
    it("starts with the name already saved, in a field that cannot take more than 60 characters", () => {
        mount({ stored: { name: "Ada Lovelace" } });
        panel.open();
        expect(nameInput().value).toBe("Ada Lovelace");
        expect(nameInput().getAttribute("maxlength")).toBe("60");
    });

    it("is saved when the field changes", () => {
        mount();
        panel.open();
        typeName("  Ada Lovelace ");
        expect(settings.get().name).toBe("Ada Lovelace");
        expect(real.getItem("notato:author")).toBe("Ada Lovelace");
    });

    it("is not saved while it is being typed, so the field is never replaced under the cursor", () => {
        mount();
        panel.open();
        const input = nameInput();
        input.value = "Do";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        expect(settings.get().name).toBe("");
        expect(nameInput()).toBe(input);
    });

    it("is committed by Enter, which leaves the field", () => {
        mount();
        panel.open();
        const input = nameInput();
        input.focus();
        expect(document.activeElement).toBe(input);
        const blur = vi.spyOn(input, "blur");
        input.value = "Ana";
        pressKey("Enter", input);
        expect(blur).toHaveBeenCalledTimes(1);
        expect(document.activeElement).not.toBe(input);
    });

    it("is not committed by other keys", () => {
        mount();
        panel.open();
        const input = nameInput();
        input.focus();
        const blur = vi.spyOn(input, "blur");
        pressKey("a", input);
        pressKey("Tab", input);
        expect(blur).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(input);
    });

    it("can be cleared again", () => {
        mount({ stored: { name: "Dom" } });
        panel.open();
        typeName("");
        expect(settings.get().name).toBe("");
    });
});

describe("the Only my notes switch needs a name", () => {
    const MINE = "Only my notes";
    const WHY = "Add your name above first, so your notes can be told apart.";
    const HELP = "Hide what other people wrote on this page.";

    it("is disabled, and says why, until there is a name", () => {
        mount();
        panel.open();
        expect(sw(MINE).disabled).toBe(true);
        expect(note(MINE)).toBe(WHY);
    });

    it("is enabled, with its own help, when a name was saved before", () => {
        mount({ stored: { name: "Dom" } });
        panel.open();
        expect(sw(MINE).disabled).toBe(false);
        expect(note(MINE)).toBe(HELP);
    });

    it("becomes enabled as soon as a name is saved, without the panel being drawn again", () => {
        mount();
        panel.open();
        const input = nameInput();
        const mine = sw(MINE);
        typeName("Dom");
        expect(nameInput()).toBe(input);
        expect(sw(MINE)).toBe(mine);
        expect(input.value).toBe("Dom");
        expect(mine.disabled).toBe(false);
        expect(note(MINE)).toBe(HELP);
    });

    it("becomes disabled again when the name is taken away", () => {
        mount({ stored: { name: "Dom" } });
        panel.open();
        typeName("");
        expect(sw(MINE).disabled).toBe(true);
        expect(note(MINE)).toBe(WHY);
    });

    it("does not count spaces as a name", () => {
        mount();
        panel.open();
        typeName("    ");
        expect(sw(MINE).disabled).toBe(true);
    });

    it("shows as off while it cannot be used, even if it was left on", () => {
        mount({ stored: { mineOnly: true } });
        panel.open();
        expect(settings.get().mineOnly).toBe(true);
        expect(sw(MINE).getAttribute("aria-checked")).toBe("false");
        typeName("Dom");
        expect(sw(MINE).getAttribute("aria-checked")).toBe("true");
    });
});

describe("the switches", () => {
    const SWITCHES = [
        ["Component names", "components"],
        ["Computed styles", "styles"],
        ["Screenshots", "screenshots"],
        ["Only my notes", "mineOnly"],
    ] as const;

    it("are four, each a switch with a label and a line of help", () => {
        mount({ stored: { name: "Dom" } });
        panel.open();
        expect(
            [...root().querySelectorAll('button[role="switch"]')].map((b) =>
                b.getAttribute("aria-label")
            )
        ).toEqual(SWITCHES.map(([label]) => label));
        for (const [label] of SWITCHES) {
            expect(sw(label).type).toBe("button");
            expect(note(label)).not.toBe("");
        }
    });

    it.each(SWITCHES)("%s shows its setting, whichever way it is", (label, key) => {
        for (const on of [true, false]) {
            real.clear();
            mount({ stored: { name: "Dom", [key]: on } });
            panel.open();
            expect(sw(label).getAttribute("aria-checked"), `${key} ${on}`).toBe(String(on));
            panel.destroy();
            settings.destroy();
        }
    });

    it.each(SWITCHES)("%s flips when clicked, and the change is kept", (label, key) => {
        mount({ stored: { name: "Dom", [key]: true } });
        panel.open();
        const before = settings.get()[key];
        expect(before).toBe(true);

        sw(label).click();
        expect(settings.get()[key]).toBe(false);
        expect(sw(label).getAttribute("aria-checked")).toBe("false");
        expect(loadSettings()[key]).toBe(false);

        sw(label).click();
        expect(settings.get()[key]).toBe(true);
        expect(sw(label).getAttribute("aria-checked")).toBe("true");
        expect(loadSettings()[key]).toBe(true);
    });

    it("changing one leaves the others as they were", () => {
        mount({ stored: { name: "Dom" } });
        panel.open();
        sw("Computed styles").click();
        expect(settings.get()).toEqual({ ...DEFAULT_SETTINGS, name: "Dom", styles: false });
    });

    it("Screenshots is locked, and says the server has them off, when the server does", () => {
        mount({ screenshots: false });
        panel.open();
        expect(sw("Screenshots").disabled).toBe(true);
        expect(sw("Screenshots").getAttribute("aria-checked")).toBe("false");
        expect(note("Screenshots")).toBe("The server has screenshots turned off.");
    });

    it("Screenshots cannot be changed while it is locked, and what the person chose is kept for later", () => {
        mount({ screenshots: false });
        panel.open();
        sw("Screenshots").click();
        expect(settings.get().screenshots).toBe(true);
        expect(real.getItem("notato:settings")).toBeNull();
    });

    it("Screenshots is an ordinary switch when the server allows them", () => {
        mount();
        panel.open();
        expect(sw("Screenshots").disabled).toBe(false);
        expect(note("Screenshots")).toBe("Take a screenshot with each note.");
    });

    it("asks the server again each time the panel opens", () => {
        const { state } = mount();
        state.screenshots = false;
        panel.open();
        expect(sw("Screenshots").disabled).toBe(true);
        panel.close();
        state.screenshots = true;
        panel.open();
        expect(sw("Screenshots").disabled).toBe(false);
    });
});

describe("how much to copy as Markdown", () => {
    it("offers the four levels, as radio buttons in a group", () => {
        mount();
        panel.open();
        expect(radios("Copy as Markdown").map((b) => b.textContent)).toEqual([...DETAILS]);
        expect(DETAILS).toHaveLength(4);
        for (const b of radios("Copy as Markdown")) {
            expect(b.getAttribute("role")).toBe("radio");
            expect(b.title, b.textContent ?? "").not.toBe("");
        }
    });

    it("has the saved level chosen, and only that one", () => {
        mount();
        panel.open();
        expect(checked("Copy as Markdown")).toEqual(["standard"]);
        panel.destroy();
        settings.destroy();
        real.clear();
        mount({ stored: { copyDetail: "compact" } });
        panel.open();
        expect(checked("Copy as Markdown")).toEqual(["compact"]);
    });

    it("choosing one sets it, moves the choice to it, and keeps it", () => {
        mount();
        panel.open();
        for (const detail of ["forensic", "compact", "detailed", "standard"] as const) {
            radios("Copy as Markdown")
                .find((b) => b.textContent === detail)
                ?.click();
            expect(settings.get().copyDetail).toBe(detail);
            expect(checked("Copy as Markdown")).toEqual([detail]);
            expect(real.getItem("notato:copy-detail")).toBe(detail);
        }
    });

    it("choosing one leaves the rest of the settings alone", () => {
        mount({ stored: { name: "Dom", markerColor: "pink" } });
        panel.open();
        radios("Copy as Markdown")
            .find((b) => b.textContent === "forensic")
            ?.click();
        expect(settings.get()).toEqual({
            ...DEFAULT_SETTINGS,
            name: "Dom",
            markerColor: "pink",
            copyDetail: "forensic",
        });
    });
});

describe("the pin colour", () => {
    it("offers a swatch for each of the seven colours, labelled with its name", () => {
        mount();
        panel.open();
        const swatches = radios("Pin colour");
        expect(swatches).toHaveLength(7);
        expect(swatches.map((b) => b.getAttribute("aria-label"))).toEqual(
            MARKER_COLORS.map((c) => c.name)
        );
        for (const b of swatches) {
            expect(b.getAttribute("role")).toBe("radio");
            expect(b.title).toBe(b.getAttribute("aria-label"));
        }
    });

    it("has the saved colour chosen, and only that one", () => {
        mount({ stored: { markerColor: "pink" } });
        panel.open();
        expect(checked("Pin colour")).toEqual(["Pink"]);
    });

    it("starts on teal", () => {
        mount();
        panel.open();
        expect(checked("Pin colour")).toEqual(["Teal"]);
    });

    it("choosing one sets it, moves the choice to it, and keeps it", () => {
        mount();
        panel.open();
        for (const colour of MARKER_COLORS) {
            radios("Pin colour")
                .find((b) => b.getAttribute("aria-label") === colour.name)
                ?.click();
            expect(settings.get().markerColor).toBe(colour.id);
            expect(checked("Pin colour")).toEqual([colour.name]);
            expect(loadSettings().markerColor).toBe(colour.id);
        }
    });

    it("paints each swatch in its own colour", () => {
        mount();
        panel.open();
        const probe = document.createElement("span");
        for (const [i, colour] of MARKER_COLORS.entries()) {
            probe.style.background = colour.hex;
            expect(radios("Pin colour")[i]?.style.background).toBe(probe.style.background);
            expect(probe.style.background).not.toBe("");
        }
    });
});

describe("hiding Notato", () => {
    it("closes the panel and hides Notato", () => {
        mount();
        let openWhenHidden: boolean | undefined;
        panel.open();
        onHide.mockImplementation(() => {
            openWhenHidden = dialog() !== null;
        });
        button("Hide Notato until this page is reloaded").click();
        expect(onHide).toHaveBeenCalledTimes(1);
        expect(openWhenHidden).toBe(false);
        expect(dialog()).toBeNull();
    });

    it("does not hide it for anything else done in the panel", () => {
        mount({ stored: { name: "Dom" } });
        panel.open();
        sw("Component names").click();
        typeName("Ana");
        panel.close();
        expect(onHide).not.toHaveBeenCalled();
    });
});

const info = (over: Partial<ServerInfo> = {}): ServerInfo => ({
    version: "0.3.1",
    mode: "dev",
    pages: 2,
    screenshots: "on",
    ...over,
});
function links(over: Partial<ServerLinks> = {}): ServerLinks {
    return {
        url: "http://localhost:4747",
        project: "checkout-web",
        connection: () => "connected",
        status: async () => info(),
        ...over,
    };
}
/** The panel open on its server view, with the server's answers in. */
async function openServer(over: Partial<ServerLinks> = {}, options: MountOptions = {}) {
    const mounted = mount({ ...options, server: links(over) });
    panel.open();
    button("Server and agent").click();
    await tick();
    return mounted;
}

describe("the server view", () => {
    it("has no way into it when there is no server", () => {
        mount();
        panel.open();
        expect(root().querySelector(".snav")).toBeNull();
        expect(text()).not.toContain("Coding agent");
        expect(text()).not.toContain("npx notato init");
    });

    it("is reached from a row on the main view, and replaces it", async () => {
        mount({ server: links() });
        panel.open();
        expect(button("Server and agent")).toBeDefined();
        button("Server and agent").click();
        expect(title()).toBe("Server and agent");
        expect(root().querySelector('button[aria-label="Back"]')).not.toBeNull();
        expect(root().querySelector("input")).toBeNull();
        expect(root().querySelector('[role="switch"]')).toBeNull();
        expect(text()).toContain("npx notato init");
        await tick();
    });

    it("the back arrow returns to the main view", async () => {
        await openServer();
        root().querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
        expect(title()).toBe("Notato settings");
        expect(root().querySelector('button[aria-label="Back"]')).toBeNull();
        expect(nameInput()).not.toBeNull();
        expect(sw("Component names")).not.toBeNull();
        expect(dialog()).not.toBeNull();
    });

    it("the main view shows what was changed before going away and back", async () => {
        mount({ server: links() });
        panel.open();
        radios("Pin colour")
            .find((b) => b.getAttribute("aria-label") === "Orange")
            ?.click();
        sw("Component names").click();
        button("Server and agent").click();
        await tick();
        root().querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
        expect(checked("Pin colour")).toEqual(["Orange"]);
        expect(sw("Component names").getAttribute("aria-checked")).toBe("false");
    });

    it("can still be closed from the server view", async () => {
        await openServer();
        field<HTMLButtonElement>('button[aria-label="Close settings"]').click();
        expect(dialog()).toBeNull();
    });

    describe("connection", () => {
        it.each<[ConnectionState, string]>([
            ["connected", "Connected"],
            ["connecting", "Connecting…"],
            ["offline", "Cannot reach it"],
        ])("says %s as “%s”, and marks the dot with the state", async (state, word) => {
            await openServer({ connection: () => state });
            expect(field(".sdot").getAttribute("data-state")).toBe(state);
            expect(root().querySelector(".sfield .slabel")?.textContent?.trim()).toBe(word);
        });

        it("shows where the server is and which project this is", async () => {
            await openServer({ url: "http://localhost:5252", project: "marketing-site" });
            expect(text()).toContain("http://localhost:5252 · project marketing-site");
        });
    });

    describe("what the server says about itself", () => {
        it("shows that it is checking until the server answers", async () => {
            const answer = deferred<ServerInfo | null>();
            mount({ server: links({ status: () => answer.promise }) });
            panel.open();
            button("Server and agent").click();
            expect(text()).toContain("Checking…");
            answer.resolve(info());
            await tick();
            expect(text()).not.toContain("Checking…");
        });

        it("then lists the version, mode, pages and screenshots", async () => {
            await openServer();
            expect(text()).toContain(
                "Notato 0.3.1 · dev mode · 2 pages connected · screenshots on"
            );
        });

        it("says one page rather than one pages, and shows none as 0", async () => {
            await openServer({ status: async () => info({ pages: 1, screenshots: "off" }) });
            expect(text()).toContain("1 page connected · screenshots off");
            expect(text()).not.toContain("1 pages");
            panel.destroy();
            settings.destroy();
            await openServer({ status: async () => info({ pages: 0 }) });
            expect(text()).toContain("0 pages connected");
        });

        it("leaves out what the server did not tell", async () => {
            await openServer({ status: async () => ({ version: "0.3.1" }) });
            expect(text()).toContain("Notato 0.3.1");
            expect(text()).not.toContain("mode");
            expect(text()).not.toContain("connected ·");
            expect(text()).not.toContain("screenshots on");
        });

        it("says so when the server did not answer", async () => {
            await openServer({ status: async () => null });
            expect(text()).toContain("The server did not answer.");
            expect(text()).not.toContain("Checking…");
        });
    });

    describe("the coding agent", () => {
        // The last field of the server view is the agent's.
        const claude = () =>
            [...root().querySelectorAll<HTMLElement>(".sfield")].at(-1) as HTMLElement;

        it("says how to set Notato up for an agent until the server says one is there", async () => {
            const answer = deferred<ServerInfo | null>();
            mount({ server: links({ status: () => answer.promise }) });
            panel.open();
            button("Server and agent").click();
            expect(claude().textContent).toContain("npx notato init");
            answer.resolve(info());
            await tick();
            expect(claude().textContent).toContain("npx notato init");
            expect(claude().textContent).not.toContain("Connected");
        });

        it("says so when an agent is connected and watching, and how to keep things from it", async () => {
            await openServer({
                status: async () => info({ agent: { connected: true, watching: true } }),
            });
            expect(claude().querySelector(".shelp.ok")?.textContent).toBe(
                "Connected, and watching for notes."
            );
            expect(claude().textContent).toContain("Everything you write reaches it.");
            expect(claude().textContent).toContain("People only");
            expect(claude().textContent).not.toContain("@agent");
            expect(claude().textContent).not.toContain("npx notato init");
            expect(claude().textContent).not.toContain("Ask it to watch");
        });

        it("asks for a watch when an agent is connected but not watching", async () => {
            await openServer({
                status: async () => info({ agent: { connected: true, watching: false } }),
            });
            expect(claude().querySelector(".shelp.ok")?.textContent).toBe(
                "Connected, not watching for notes yet."
            );
            expect(claude().textContent).toContain(
                "Ask it to watch Notato, or use the notato skill."
            );
            expect(claude().textContent).toContain("Everything you write reaches it.");
        });

        it("shows how to register it when no agent is connected, or the server did not answer", async () => {
            await openServer({
                status: async () => info({ agent: { connected: false, watching: false } }),
            });
            expect(claude().textContent).toContain("npx notato init");
            expect(claude().textContent).not.toContain("Everything you write reaches it.");
            panel.destroy();
            settings.destroy();
            await openServer({ status: async () => null });
            expect(claude().textContent).toContain("npx notato init");
        });

        it("names the agents the server says are connected, and is a coding agent until it knows", async () => {
            await openServer({
                status: async () =>
                    info({ agent: { connected: true, watching: true, names: ["Codex"] } }),
            });
            expect(claude().querySelector(".slabel")?.textContent).toBe("Codex");
            panel.destroy();
            settings.destroy();
            await openServer({
                status: async () => info({ agent: { connected: false, watching: false } }),
            });
            expect(claude().querySelector(".slabel")?.textContent).toBe("Coding agent");
            expect(claude().textContent).toContain("Claude Code, Codex, Cursor");
        });

        it("has nothing about webhooks: they are set up on the server", async () => {
            await openServer({
                status: async () => info({ agent: { connected: true, watching: true } }),
            });
            expect(text().toLowerCase()).not.toContain("webhook");
        });
    });

    describe("leaving before the server has answered", () => {
        it("going back does not throw, and the answer does not land in the main view", async () => {
            const status = deferred<ServerInfo | null>();
            mount({ server: links({ status: () => status.promise }) });
            panel.open();
            button("Server and agent").click();
            const checking = [...root().querySelectorAll(".shelp")].find(
                (n) => n.textContent === "Checking…"
            ) as Element;
            expect(checking).toBeDefined();
            root().querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
            const before = root().innerHTML;

            status.resolve(info({ agent: { connected: true, watching: true } }));
            await tick();

            expect(checking.textContent).toBe("Checking…");
            expect(root().innerHTML).toBe(before);
            expect(title()).toBe("Notato settings");
            expect(text()).not.toContain("watching for notes");
        });

        it("closing the panel does not throw, and nothing is written into the page", async () => {
            const status = deferred<ServerInfo | null>();
            mount({ server: links({ status: () => status.promise }) });
            panel.open();
            button("Server and agent").click();
            const gone = root();
            panel.close();
            status.resolve(info({ agent: { connected: true, watching: true } }));
            await tick();
            expect(dialog()).toBeNull();
            expect(layer.childElementCount).toBe(0);
            expect(gone.textContent).not.toContain("Notato 0.3.1");
            expect(gone.textContent).not.toContain("watching for notes");
        });

        it("an answer that comes after leaving and coming back does not mix into the new view", async () => {
            const first = deferred<ServerInfo | null>();
            const second = deferred<ServerInfo | null>();
            const answers = [first, second];
            const status = vi.fn(() => (answers.shift() as typeof first).promise);
            mount({ server: links({ status }) });
            panel.open();
            button("Server and agent").click();
            root().querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
            button("Server and agent").click();
            expect(status).toHaveBeenCalledTimes(2);

            first.resolve(
                info({ version: "0.0.1-old", agent: { connected: true, watching: true } })
            );
            await tick();
            expect(text()).not.toContain("0.0.1-old");
            expect(text()).not.toContain("watching for notes");
            second.resolve(info({ version: "0.3.2" }));
            await tick();
            expect(text()).toContain("Notato 0.3.2");
            expect(text()).not.toContain("0.0.1-old");
            expect(text()).toContain("npx notato init");
        });
    });
});
