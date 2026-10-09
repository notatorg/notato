// @vitest-environment happy-dom
import type { AnnotationRecord } from "@notato/core";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPins, MAX_PINS, nextPinNumber, type Pins } from "../src/ui/pins.ts";
import { useReducedMotion } from "./support/motion.ts";

useReducedMotion();

let layer: HTMLElement;
let page: HTMLElement;
let pins: Pins | undefined;
beforeEach(() => {
    layer = document.createElement("div");
    page = document.createElement("main");
    document.body.append(page, layer);
});
afterEach(() => {
    pins?.destroy();
    pins = undefined;
    layer.remove();
    page.remove();
    vi.restoreAllMocks();
});

/** Note `n`, pointing at whatever answers to `selector`. */
const note = (
    n: number,
    over: Partial<Annotation> = {},
    selector = `[data-testid="row-${n}"]`
): AnnotationRecord => ({
    annotation: {
        ...sampleAnnotation,
        id: `note-${n}`,
        comment: `note ${n}`,
        thread: [],
        context: {},
        target: {
            ...sampleAnnotation.target,
            identity: [{ selector, tag: "p" }],
            rect: { x: 10, y: 10, w: 10, h: 10 },
        },
        ...over,
    } as Annotation,
    assets: new Map(),
});
const many = (count: number, over: Partial<Annotation> = {}) =>
    Array.from({ length: count }, (_, i) => note(i + 1, over));

/** An element laid out on screen, where a pin can go. */
const row = (n: number) => {
    const el = document.createElement("p");
    el.setAttribute("data-testid", `row-${n}`);
    el.getBoundingClientRect = () =>
        ({ left: 40, top: 40, width: 100, height: 20, right: 140, bottom: 60 }) as DOMRect;
    page.append(el);
    return el;
};

function show(
    records: () => AnnotationRecord[],
    options: Partial<Parameters<typeof createPins>[0]> = {}
) {
    pins = createPins({
        layer,
        records,
        currentRoute: () => sampleAnnotation.route,
        ...options,
    });
    pins.refresh();
    return pins;
}
const pinEls = () => [...layer.querySelectorAll<HTMLButtonElement>(".pin")];
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("a page with many notes", () => {
    it("draws the newest notes only, at most MAX_PINS of them, numbered as they would be among all", () => {
        show(() => many(MAX_PINS + 50));
        const drawn = pinEls();
        expect(drawn).toHaveLength(MAX_PINS);
        expect(drawn[0]?.textContent).toBe("51");
        expect(drawn.at(-1)?.textContent).toBe(String(MAX_PINS + 50));
    });

    it("makes nothing for the notes of other pages", () => {
        show(() => [...many(3, { route: "/elsewhere" }), note(9)]);
        expect(pinEls().map((p) => p.textContent)).toEqual(["4"]);
    });

    it("makes a card only once its pin is opened, and puts it right after the pin", () => {
        show(() => many(20));
        expect(layer.querySelectorAll(".card")).toHaveLength(0);
        const pin = pinEls()[3] as HTMLButtonElement;
        pin.click();
        expect(layer.querySelectorAll(".card")).toHaveLength(1);
        expect(pin.nextElementSibling?.classList.contains("card")).toBe(true);
    });

    it("leaves the pins of notes that did not change as they are", async () => {
        let records = many(30);
        show(() => records);
        const touched = new Set<Node>();
        const watch = new MutationObserver((changes) => {
            for (const c of changes)
                touched.add(c.target.nodeType === 1 ? c.target : (c.target.parentNode as Node));
        });
        watch.observe(layer, {
            subtree: true,
            attributes: true,
            childList: true,
            characterData: true,
        });
        records = records.map((r, i) =>
            i === 4 ? { ...r, annotation: { ...r.annotation, status: "resolved" } } : r
        );
        pins?.refresh();
        await Promise.resolve();
        watch.disconnect();
        expect([...touched]).toEqual([pinEls()[4]]);
    });

    it("finds a pin's element once, and looks again only as far as what changed in the page", async () => {
        row(1);
        const records = [note(1), note(2)]; // note 2's element is not in the page yet
        const query = vi.spyOn(document, "querySelector");
        show(() => records);
        expect(query).toHaveBeenCalledTimes(2); // each looked for once
        pins?.schedule();
        await frame();
        pins?.domChanged([]); // something went: nothing came that could be note 2's
        await frame();
        expect(query).toHaveBeenCalledTimes(2);

        const late = row(2); // it came: found among what was added, without searching the page
        pins?.domChanged([late]);
        await frame();
        expect(query).toHaveBeenCalledTimes(2);
        expect(pinEls()[1]?.dataset.detached).toBe("false");

        pins?.domChanged(); // too much changed to say: whoever is missing searches the page
        await frame();
        expect(query).toHaveBeenCalledTimes(2); // nobody was missing
    });

    it("looks again for an element that no longer answers to the note", async () => {
        const first = row(1);
        show(() => [note(1)]);
        expect(pinEls()[0]?.dataset.detached).toBe("false");
        first.setAttribute("data-testid", "renamed");
        const replacement = row(1);
        pins?.domChanged([first, replacement]);
        await frame();
        expect(pinEls()[0]?.dataset.detached).toBe("false");
        replacement.remove();
        pins?.domChanged([]);
        await frame();
        expect(pinEls()[0]?.dataset.detached).toBe("true"); // gone: placed where it was made
    });
});

describe("a pin and its card, for the keyboard", () => {
    const reply = async () => {};

    it("says what it opens, and whether it is open", () => {
        row(1);
        show(() => [note(1)], { onReply: reply });
        const pin = pinEls()[0] as HTMLButtonElement;
        expect(pin.getAttribute("aria-expanded")).toBe("false");
        expect(pin.getAttribute("aria-haspopup")).toBe("dialog");
        pin.click();
        const card = layer.querySelector(".card") as HTMLElement;
        expect(pin.getAttribute("aria-expanded")).toBe("true");
        expect(pin.getAttribute("aria-controls")).toBe(card.id);
        expect(card.getAttribute("role")).toBe("dialog");
        expect(card.getAttribute("aria-label")).toContain("note 1");
    });

    it("keeps the card open while focus is inside it, and closes it once focus leaves", () => {
        vi.useFakeTimers();
        row(1);
        show(() => [note(1)], { onReply: reply });
        const pin = pinEls()[0] as HTMLButtonElement;
        pin.focus();
        const card = layer.querySelector(".card") as HTMLElement;
        expect(card.style.display).toBe("block");
        // Tab from the pin to the first thing in the card, its close button.
        const close = card.querySelector(".card-x") as HTMLButtonElement;
        close.focus();
        vi.advanceTimersByTime(1000);
        expect(card.style.display).toBe("block");
        // The pointer passing over and away does not close it while focus is in it.
        pin.dispatchEvent(new Event("mouseenter"));
        pin.dispatchEvent(new Event("mouseleave"));
        vi.advanceTimersByTime(1000);
        expect(card.style.display).toBe("block");
        // Tab out of it, to the page.
        const outside = document.createElement("button");
        document.body.append(outside);
        outside.focus();
        vi.advanceTimersByTime(1000);
        expect(card.style.display).toBe("none");
        expect(pin.getAttribute("aria-expanded")).toBe("false");
        outside.remove();
        vi.useRealTimers();
    });

    it("keeps focus in the card, and the card open, when the server changes the note under it", () => {
        row(1);
        let records = [note(1)];
        show(() => records, { onReply: reply });
        const pin = pinEls()[0] as HTMLButtonElement;
        pin.focus();
        const card = layer.querySelector(".card") as HTMLElement;
        (card.querySelector(".card-x") as HTMLButtonElement).focus();
        records = [note(1, { status: "acknowledged" })]; // redrawn: the focused button is replaced
        pins?.refresh();
        expect(card.querySelector(".badge.status")?.textContent).toBe("Acknowledged");
        expect(card.contains(document.activeElement)).toBe(true);
        expect(card.style.display).toBe("block");
    });

    it("stays pinned open while someone types a reply in it, as before", () => {
        row(1);
        show(() => [note(1)], { onReply: reply });
        const pin = pinEls()[0] as HTMLButtonElement;
        pin.focus();
        const card = layer.querySelector(".card") as HTMLElement;
        (card.querySelector(".say") as HTMLInputElement).focus();
        const outside = document.createElement("button");
        document.body.append(outside);
        outside.focus();
        expect(card.style.display).toBe("block");
        outside.remove();
    });
});

describe("the next pin number", () => {
    it("is one past the highest, however many notes there are", () => {
        const records = Array.from({ length: 200_000 }, (_, i) => note(i + 1));
        expect(nextPinNumber(records)).toBe(200_001);
        expect(nextPinNumber([])).toBe(1);
    });
});
