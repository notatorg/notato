// @vitest-environment happy-dom
import { DETAILS, type Detail } from "@notato/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CopyMenu, copyText, createCopyMenu } from "../src/ui/copy-menu.ts";

let layer: HTMLElement;
beforeEach(() => {
    vi.useFakeTimers();
    layer = document.createElement("div");
    document.body.append(layer);
});
afterEach(() => {
    vi.useRealTimers();
    layer.remove();
});

describe("createCopyMenu", () => {
    let menu: CopyMenu;
    let remembered: Detail;
    let picked: Detail[];
    const anchor = { left: 400, top: 700, width: 100 };
    const items = () => [...layer.querySelectorAll<HTMLButtonElement>(".menu-item")];
    const openMenu = () => menu.open(anchor, (detail) => picked.push(detail));
    /** Presses the mouse somewhere, as the browser orders it: on the target, bubbling up to the window. */
    const mousedown = (target: Element) =>
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    const pressEscape = () =>
        document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );

    beforeEach(() => {
        remembered = "standard";
        picked = [];
        menu = createCopyMenu(layer, () => remembered);
    });
    afterEach(() => menu.destroy());

    it("offers the four levels of detail, least first", () => {
        openMenu();
        expect(menu.isOpen).toBe(true);
        expect(items().map((b) => b.querySelector("strong")?.textContent)).toEqual([
            "Compact",
            "Standard",
            "Detailed",
            "Forensic",
        ]);
        expect(
            items().every(
                (b) => b.getAttribute("role") === "menuitem" && b.querySelector("span")?.textContent
            )
        ).toBe(true);
    });

    it("marks the level that was used last", () => {
        remembered = "detailed";
        openMenu();
        expect(items().map((b) => b.getAttribute("aria-checked"))).toEqual([
            "false",
            "false",
            "true",
            "false",
        ]);
    });

    it("puts keyboard focus on the first item", () => {
        openMenu();
        expect(document.activeElement).toBe(items()[0]);
    });

    it.each(DETAILS.map((d, i) => [d, i] as const))(
        "choosing %s calls back with it and closes",
        (detail, index) => {
            openMenu();
            items()[index]?.click();
            expect(picked).toEqual([detail]);
            expect(menu.isOpen).toBe(false);
            expect(layer.querySelector(".menu")).toBeNull();
        }
    );

    it("closes on Escape, and keeps that key from reaching the page", () => {
        const heard: string[] = [];
        const onKey = (ev: KeyboardEvent) => heard.push(ev.key);
        document.addEventListener("keydown", onKey);
        openMenu();
        pressEscape();
        expect(menu.isOpen).toBe(false);
        expect(layer.querySelector(".menu")).toBeNull();
        expect(heard).toEqual([]);
        expect(picked).toEqual([]);

        pressEscape(); // closed now: the page gets Escape as usual
        expect(heard).toEqual(["Escape"]);
        document.removeEventListener("keydown", onKey);
    });

    it("ignores other keys", () => {
        openMenu();
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
        expect(menu.isOpen).toBe(true);
    });

    it("closes on a press outside it, but not on the click that opened it", () => {
        openMenu();
        mousedown(document.body); // the opening click's own mousedown/up, before it has finished
        expect(menu.isOpen).toBe(true);
        vi.advanceTimersByTime(0);
        mousedown(document.body);
        expect(menu.isOpen).toBe(false);
        expect(picked).toEqual([]);
    });

    it("stays open for a press inside it", () => {
        openMenu();
        vi.advanceTimersByTime(0);
        mousedown(items()[1] as Element);
        mousedown(layer.querySelector(".menu-title") as Element);
        expect(menu.isOpen).toBe(true);
    });

    it("replaces an open menu when opened again, with the new callback", () => {
        const second: Detail[] = [];
        openMenu();
        menu.open(anchor, (detail) => second.push(detail));
        expect(layer.querySelectorAll(".menu")).toHaveLength(1);
        items()[3]?.click();
        expect(picked).toEqual([]);
        expect(second).toEqual(["forensic"]);
    });

    it("sits above the anchor, centred on it, and inside the window", () => {
        const view = { w: window.innerWidth, h: window.innerHeight };
        Object.assign(window, { innerWidth: 1000, innerHeight: 700 });
        try {
            const style = () => (layer.querySelector(".menu") as HTMLElement).style;
            menu.open({ left: 400, top: 600, width: 100 }, () => {});
            // 220px wide (it has no layout here), so centred on x = 450 starts at 340; its bottom edge is 8px above the anchor.
            expect([style().left, style().bottom]).toEqual(["340px", "108px"]);
            menu.open({ left: 0, top: 600, width: 20 }, () => {});
            expect(style().left).toBe("8px");
            menu.open({ left: 990, top: 600, width: 20 }, () => {});
            expect(style().left).toBe("772px"); // 1000 - 220 - 8
        } finally {
            Object.assign(window, { innerWidth: view.w, innerHeight: view.h });
        }
    });
});

describe("copyText", () => {
    let execCommand: ReturnType<typeof vi.fn>;
    /** What the hidden textarea held, and whether it was selected, at the moment `execCommand("copy")` ran. */
    let seen: { value: string; selected: boolean; readOnly: boolean } | undefined;

    const clipboard = (writeText: (text: string) => Promise<void>) =>
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    beforeEach(() => {
        seen = undefined;
        execCommand = vi.fn((command: string) => {
            const box = document.querySelector("textarea");
            if (command === "copy" && box)
                seen = {
                    value: box.value,
                    selected: box.selectionStart === 0 && box.selectionEnd === box.value.length,
                    readOnly: box.hasAttribute("readonly"),
                };
            return true;
        });
        Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    });
    afterEach(() => {
        Reflect.deleteProperty(navigator, "clipboard");
        Reflect.deleteProperty(document, "execCommand");
    });

    it("uses the clipboard API when it works", async () => {
        const writeText = vi.fn(async () => {});
        clipboard(writeText);
        expect(await copyText("hello")).toBe(true);
        expect(writeText).toHaveBeenCalledWith("hello");
        expect(execCommand).not.toHaveBeenCalled();
    });

    it("falls back to selecting a hidden textarea and copying when the clipboard API refuses", async () => {
        clipboard(() =>
            Promise.reject(new DOMException("Document is not focused", "NotAllowedError"))
        );
        expect(await copyText("# Notato\n- fix it")).toBe(true);
        expect(execCommand).toHaveBeenCalledWith("copy");
        expect(seen).toEqual({ value: "# Notato\n- fix it", selected: true, readOnly: true });
        expect(document.querySelector("textarea")).toBeNull(); // and it does not stay on the page
    });

    it("falls back when the page may not use the clipboard API at all", async () => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
        expect(await copyText("hello")).toBe(true);
        expect(seen?.value).toBe("hello");
    });

    it("falls back when the API throws at once instead of rejecting", async () => {
        clipboard(() => {
            throw new TypeError("not allowed");
        });
        expect(await copyText("hello")).toBe(true);
        expect(execCommand).toHaveBeenCalledOnce();
    });

    it("reports failure when the old way is refused too", async () => {
        clipboard(() => Promise.reject(new Error("no")));
        execCommand.mockReturnValue(false);
        expect(await copyText("hello")).toBe(false);
        expect(document.querySelector("textarea")).toBeNull();
    });

    it("reports failure, and cleans up, when the old way throws", async () => {
        clipboard(() => Promise.reject(new Error("no")));
        execCommand.mockImplementation(() => {
            throw new Error("not supported");
        });
        expect(await copyText("hello")).toBe(false);
        expect(document.querySelector("textarea")).toBeNull();
    });
});
