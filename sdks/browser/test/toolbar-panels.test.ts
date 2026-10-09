// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettings } from "../src/settings.ts";
import { createCopyMenu } from "../src/ui/copy-menu.ts";
import { isolateFromPage } from "../src/ui/dom.ts";
import { createPackageDialog } from "../src/ui/package-dialog.ts";
import { createPicker } from "../src/ui/picker.ts";
import { createSettingsPanel } from "../src/ui/settings-panel.ts";
import { createToolbar } from "../src/ui/toolbar.ts";
import { useReducedMotion } from "./support/motion.ts";

useReducedMotion();

let layer: HTMLElement;
beforeEach(() => {
    window.localStorage.clear();
    layer = document.createElement("div");
    document.body.append(layer);
});
afterEach(() => {
    layer.remove();
    window.localStorage.clear();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const mouse = (target: Element, type: string) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true }));
/** A full click on a button, as the browser sends it: the press first, then the click. */
const clickLikeAPerson = (target: HTMLElement) => {
    mouse(target, "mousedown");
    mouse(target, "mouseup");
    target.click();
};

describe("the button that opens a menu closes it again", () => {
    it("the Export button", async () => {
        const menu = createCopyMenu(layer, () => "standard");
        const owner = document.createElement("button");
        layer.append(owner);
        owner.addEventListener("click", () => {
            if (menu.isOpen) return menu.close();
            menu.open({ left: 0, top: 0, width: 10 }, () => {}, { owner });
        });
        clickLikeAPerson(owner);
        await tick();
        expect(menu.isOpen).toBe(true);
        clickLikeAPerson(owner);
        expect(menu.isOpen).toBe(false);
        // and a press anywhere else still closes it
        clickLikeAPerson(owner);
        await tick();
        mouse(document.body, "mousedown");
        expect(menu.isOpen).toBe(false);
        menu.destroy();
    });

    it("the Settings button", async () => {
        const settings = createSettings();
        const owner = document.createElement("button");
        layer.append(owner);
        const panel = createSettingsPanel({
            layer,
            settings,
            anchor: () => ({ left: 0, top: 0, width: 10 }),
            serverScreenshots: () => true,
            onHide: () => {},
            owner: () => owner,
        });
        owner.addEventListener("click", () => panel.toggle());
        clickLikeAPerson(owner);
        await tick();
        expect(panel.isOpen).toBe(true);
        clickLikeAPerson(owner);
        expect(panel.isOpen).toBe(false);
        panel.destroy();
        settings.destroy();
    });
});

describe("the zip in the Export menu", () => {
    const zipItem = () =>
        [...layer.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) =>
            b.textContent?.includes("Download zip")
        ) as HTMLButtonElement;

    it("can be had from a page with no notes, since it holds every page's", () => {
        const menu = createCopyMenu(layer, () => "standard");
        menu.open({ left: 0, top: 0, width: 10 }, () => {}, {
            count: 0,
            zip: { description: "3 notes", count: 3, onPick: () => {} },
        });
        expect(zipItem().disabled).toBe(false);
        // the Markdown levels are about this page, and there is nothing on it
        expect(layer.querySelector<HTMLButtonElement>(".menu-item")?.disabled).toBe(true);
        menu.destroy();
    });

    it("cannot be had when there are no notes anywhere", () => {
        const menu = createCopyMenu(layer, () => "standard");
        menu.open({ left: 0, top: 0, width: 10 }, () => {}, {
            count: 0,
            zip: { description: "0 notes", count: 0, onPick: () => {} },
        });
        expect(zipItem().disabled).toBe(true);
        menu.destroy();
    });
});

describe("the name in the settings", () => {
    it("is saved when the panel is closed with it still being typed", () => {
        const settings = createSettings();
        const panel = createSettingsPanel({
            layer,
            settings,
            anchor: () => ({ left: 0, top: 0, width: 10 }),
            serverScreenshots: () => true,
            onHide: () => {},
        });
        panel.open();
        const input = layer.querySelector<HTMLInputElement>('input[aria-label="Your name"]');
        if (!input) throw new Error("no name field");
        input.value = "Ana";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(panel.isOpen).toBe(false);
        expect(settings.get().name).toBe("Ana");
        settings.destroy();
    });
});

describe("the package dialog", () => {
    const open = (onSubmit: () => Promise<string>, clearable?: boolean) => {
        const dialog = createPackageDialog(layer);
        dialog.open({
            count: 2,
            routes: 1,
            destination: null,
            name: "Ana",
            clearable,
            onSubmit,
            onCancel: () => dialog.close(),
        });
        return dialog;
    };
    const nameField = () =>
        layer.querySelector<HTMLInputElement>('input[aria-label="Your name"]') as HTMLInputElement;
    const enter = () =>
        nameField().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    it("packages once however many times Enter is pressed", async () => {
        let finish: (message: string) => void = () => {};
        const onSubmit = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
        const dialog = open(onSubmit);
        enter();
        enter();
        finish("Downloaded");
        await tick();
        enter(); // done: it is not packaged again either
        expect(onSubmit).toHaveBeenCalledTimes(1);
        dialog.close();
    });

    it("can be tried again after it failed", async () => {
        const onSubmit = vi.fn(async () => {
            throw new Error("no room");
        });
        const dialog = open(onSubmit);
        enter();
        await tick();
        enter();
        expect(onSubmit).toHaveBeenCalledTimes(2);
        dialog.close();
    });

    it("offers to remove the notes from this browser only where that means something", () => {
        let dialog = open(async () => "ok");
        expect(layer.querySelector('input[type="checkbox"]')).not.toBeNull();
        dialog.close();
        dialog = open(async () => "ok", false);
        expect(layer.querySelector('input[type="checkbox"]')).toBeNull();
        dialog.close();
    });
});

describe("the toolbar's fold chevron", () => {
    it("turns when the bar is moved to the other side", () => {
        const toolbar = createToolbar({
            position: "bottom-right",
            onToggleAnnotate: () => {},
            onTogglePins: () => {},
        });
        document.body.append(toolbar.el);
        const chevron = () => toolbar.el.querySelector(".tb-collapse path")?.getAttribute("d");
        expect(chevron()).toBe("M9 6l6 6-6 6"); // folds to the right
        const grip = toolbar.el.querySelector(".tb-grip") as HTMLElement;
        for (let i = 0; i < 80; i++)
            grip.dispatchEvent(
                new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true })
            );
        expect(chevron()).toBe("M15 6l-6 6 6 6"); // now at the left edge, it folds to the left
        toolbar.destroy();
        toolbar.el.remove();
    });
});

describe("a drag on the page that ends over Notato", () => {
    it("still ends for the page", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const stop = isolateFromPage(host);
        const inner = document.createElement("button");
        host.append(inner);
        const heard: string[] = [];
        const listen = (ev: Event) => heard.push(ev.type);
        for (const type of ["mouseup", "pointerup"]) document.addEventListener(type, listen);

        // a slider on the page, dragged over the toolbar and let go there
        mouse(document.body, "pointerdown");
        mouse(document.body, "mousedown");
        mouse(inner, "pointerup");
        mouse(inner, "mouseup");
        expect(heard).toEqual(["pointerup", "mouseup"]);

        // a press on Notato's own button is still kept from the page
        heard.length = 0;
        mouse(inner, "pointerdown");
        mouse(inner, "mousedown");
        mouse(inner, "pointerup");
        mouse(inner, "mouseup");
        expect(heard).toEqual([]);

        for (const type of ["mouseup", "pointerup"]) document.removeEventListener(type, listen);
        stop();
        host.remove();
    });

    it("an area being drawn is let go of, not left on the page", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const inner = document.createElement("button");
        host.append(inner);
        const target = document.createElement("div");
        document.body.append(target);
        const picker = createPicker({ host, layer, describe: () => "div", onPick: () => {} });
        picker.setActive(true);
        const at = (el: Element, type: string, x: number, y: number) =>
            el.dispatchEvent(
                new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    clientX: x,
                    clientY: y,
                    buttons: 1,
                })
            );
        at(target, "mousedown", 10, 10);
        at(target, "mousemove", 120, 120);
        const box = layer.querySelector<HTMLElement>(".drag") as HTMLElement;
        expect(box.style.display).not.toBe("none");
        at(inner, "mouseup", 130, 130); // let go over the toolbar
        expect(box.style.display).toBe("none");
        at(target, "mousemove", 200, 200); // and moving on draws nothing
        expect(box.style.display).toBe("none");
        picker.destroy();
        host.remove();
        target.remove();
    });
});
