// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolateFromPage } from "../src/ui/dom.ts";
import { createPicker, type PickEvent } from "../src/ui/picker.ts";

let host: HTMLElement;
let layer: HTMLElement;
let target: HTMLElement;
let picks: PickEvent[];
let heard: string[];
let picker: ReturnType<typeof createPicker>;
/** Page listeners added by a test, so each test starts with only its own. */
const unlisten: Array<() => void> = [];
const PRESS = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const;

/** What the app would hear on `document`, as a click-away hook does. */
const listen = (types: readonly string[], into: string[]) => {
    for (const type of types) {
        const fn = () => into.push(type);
        document.addEventListener(type, fn);
        unlisten.push(() => document.removeEventListener(type, fn));
    }
};

const fire = (el: Element, type: string, init: MouseEventInit = {}) =>
    el.dispatchEvent(
        new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: 10,
            clientY: 10,
            ...init,
        })
    );
/** The next frame: the pointer is followed at most once a frame. */
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
/** A full press on `el`: what a mouse does, in the order the browser sends it. */
const press = (el: Element, init: MouseEventInit = {}) => {
    for (const type of PRESS) fire(el, type, init);
};

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    layer = document.createElement("div");
    target = document.createElement("button");
    target.textContent = "Pay now";
    document.body.append(target);
    picks = [];
    heard = [];
    listen([...PRESS, "mousemove"], heard);
    picker = createPicker({ host, layer, describe: () => "button", onPick: (p) => picks.push(p) });
    picker.setActive(true);
});
afterEach(() => {
    for (const off of unlisten.splice(0)) off();
    picker.destroy();
    host.remove();
    target.remove();
});

describe("annotate mode takes the press, and the page does not hear it", () => {
    it("a plain press picks the element and reaches nobody else", () => {
        press(target);
        expect(picks).toHaveLength(1);
        expect(picks[0]?.elements[0]).toBe(target);
        expect(heard).toEqual([]);
    });

    it("does nothing once annotate mode is off", () => {
        picker.setActive(false);
        press(target);
        expect(picks).toHaveLength(0);
        expect(heard).toEqual([...PRESS]);
    });
});

describe("holding Shift uses the page instead", () => {
    it("passes the whole press through and picks nothing", () => {
        press(target, { shiftKey: true });
        expect(picks).toHaveLength(0);
        expect(heard).toEqual([...PRESS]);
    });

    it("keeps annotate mode on afterwards", () => {
        press(target, { shiftKey: true });
        expect(picker.active).toBe(true);
        press(target);
        expect(picks).toHaveLength(1);
    });

    it("decides when the press starts: letting go of Shift early still delivers the whole click", () => {
        fire(target, "pointerdown", { shiftKey: true });
        fire(target, "mousedown", { shiftKey: true });
        // Shift is released before the button is.
        fire(target, "pointerup");
        fire(target, "mouseup");
        fire(target, "click");
        expect(heard).toEqual([...PRESS]);
        expect(picks).toHaveLength(0);
    });

    it("and pressing Shift only at the end does not turn a pick into half a click", () => {
        fire(target, "pointerdown");
        fire(target, "mousedown");
        fire(target, "pointerup", { shiftKey: true });
        fire(target, "mouseup", { shiftKey: true });
        fire(target, "click", { shiftKey: true });
        expect(picks).toHaveLength(1);
        expect(heard).toEqual([]);
    });

    it("lets a click from the keyboard through when Shift is held, since there was no press to decide by", () => {
        fire(target, "click", { shiftKey: true });
        expect(heard).toEqual(["click"]);
        fire(target, "click");
        expect(heard).toEqual(["click"]);
    });

    it("starts each press afresh", () => {
        press(target, { shiftKey: true });
        heard.length = 0;
        press(target);
        expect(heard).toEqual([]);
        expect(picks).toHaveLength(1);
    });

    it("hides the outline while Shift is down, and brings it back on the next plain move", async () => {
        const outline = () => layer.querySelector<HTMLElement>(".hover")?.style.display;
        fire(target, "mousemove");
        await frame();
        expect(outline()).not.toBe("none");
        fire(target, "mousemove", { shiftKey: true });
        expect(outline()).toBe("none"); // at once: nothing is being picked
        // The page still hears the moves, so its own hover effects work.
        expect(heard.filter((t) => t === "mousemove")).toHaveLength(2);
        fire(target, "mousemove");
        await frame();
        expect(outline()).not.toBe("none");
    });
});

describe("isolateFromPage", () => {
    beforeEach(() => picker.setActive(false)); // these are about our UI, not about annotate mode

    it("stops what happens inside the Notato UI from bubbling out to the page", () => {
        isolateFromPage(host);
        const inner = document.createElement("button");
        host.append(inner);
        const types = [
            "mousedown",
            "mouseup",
            "click",
            "pointerdown",
            "pointerup",
            "focusin",
            "keydown",
            "touchstart",
        ];
        const pageHeard: string[] = [];
        listen(types, pageHeard);
        for (const type of types) fire(inner, type);
        expect(pageHeard).toEqual([]);
    });

    it("still lets the UI's own listeners run first", () => {
        isolateFromPage(host);
        const inner = document.createElement("button");
        host.append(inner);
        const own = vi.fn();
        inner.addEventListener("mousedown", own);
        fire(inner, "mousedown");
        expect(own).toHaveBeenCalledTimes(1);
    });

    it("leaves events on the page itself alone", () => {
        isolateFromPage(host);
        const pageHeard: string[] = [];
        listen(["mousedown"], pageHeard);
        fire(document.body, "mousedown");
        expect(pageHeard).toEqual(["mousedown"]);
    });
});

describe("what is under the pointer", () => {
    /** The rules that make disabled controls click-through while annotating: one of the sheets on the page now. */
    const clickThrough = () =>
        document.adoptedStyleSheets.find((s) =>
            [...s.cssRules].some((r) => r.cssText.includes(":disabled"))
        );
    let form: HTMLFormElement;
    let disabled: HTMLButtonElement;
    let plain: HTMLParagraphElement;
    let hits: number;
    let described: Element[];
    beforeEach(() => {
        form = document.createElement("form");
        disabled = document.createElement("button");
        disabled.disabled = true;
        disabled.getBoundingClientRect = () =>
            ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }) as DOMRect;
        form.append(disabled);
        plain = document.createElement("p");
        plain.textContent = "Some text";
        document.body.append(form, plain);
        // happy-dom does no hit testing. This answers as a browser does: over the form, the disabled button only while
        // the click-through rules are off, and the form itself (behind it) while they are on.
        hits = 0;
        document.elementFromPoint = (x: number) => {
            hits += 1;
            if (x > 100) return plain;
            return clickThrough()?.disabled ? disabled : form;
        };
        described = [];
        picker.destroy();
        picker = createPicker({
            host,
            layer,
            describe: (el) => {
                described.push(el);
                return el.localName;
            },
            onPick: (p) => picks.push(p),
        });
        picker.setActive(true);
    });
    afterEach(() => {
        Reflect.deleteProperty(document, "elementFromPoint");
        form.remove();
        plain.remove();
    });

    it("is hit-tested once a frame, however many moves the mouse reports in it", async () => {
        for (let i = 0; i < 5; i++) fire(plain, "mousemove", { clientX: 200 + i, clientY: 10 });
        expect(hits).toBe(0);
        await frame();
        expect(hits).toBe(1);
        expect(described).toEqual([plain]);
    });

    it("finds a disabled control by looking past the click-through rules, only where there is one", async () => {
        const toggled: boolean[] = [];
        const sheet = clickThrough();
        if (sheet) {
            let off = false;
            Object.defineProperty(sheet, "disabled", {
                configurable: true,
                get: () => off,
                set: (v: boolean) => {
                    off = v;
                    toggled.push(v);
                },
            });
        }
        fire(form, "mousemove", { clientX: 10, clientY: 10 });
        await frame();
        expect(described).toEqual([disabled]);
        expect(clickThrough()?.disabled).toBe(false); // and on again after
        const before = hits;
        fire(plain, "mousemove", { clientX: 200, clientY: 10 });
        await frame();
        expect(hits - before).toBe(1); // nothing to look past over the text
        expect(described).toEqual([disabled, plain]);
        expect(toggled).toEqual([true, false]); // lifted once, for the disabled control only
    });

    it("labels an element once while the pointer stays on it", async () => {
        for (let i = 0; i < 3; i++) {
            fire(plain, "mousemove", { clientX: 200 + i, clientY: 10 });
            await frame();
        }
        expect(described).toEqual([plain]);
    });
});
