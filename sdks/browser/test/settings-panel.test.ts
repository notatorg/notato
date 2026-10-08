// @vitest-environment happy-dom
import { DETAILS } from "@notato/core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, MARKER_COLORS } from "../src/settings.ts";
import {
    button,
    checked,
    dialog,
    field,
    layer,
    links,
    mount,
    nameInput,
    note,
    onHide,
    panel,
    press,
    pressKey,
    radios,
    real,
    root,
    settings,
    sw,
    tick,
    title,
    typeName,
    useSettingsPanel,
} from "./support/settings-panel.ts";

useSettingsPanel();

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
