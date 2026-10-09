// @vitest-environment happy-dom
import type { AnnotationRecord } from "@notato/core";
import { sampleAnnotation } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrames } from "../src/ui/frame.ts";
import {
    animateIn,
    animateOut,
    ENTER_MS,
    EXIT_MS,
    isLeaving,
    POP,
    RISE,
    settle,
} from "../src/ui/motion.ts";
import { createPins, type Pins } from "../src/ui/pins.ts";
import { createPopover } from "../src/ui/popover.ts";
import { createToast } from "../src/ui/toast.ts";
import { reducedMotion } from "./support/motion.ts";

/**
 * An animation the test finishes when it likes. happy-dom's own finish on a timer; these say what they were asked to
 * do, and finish, reverse and cancel the way a browser's do.
 */
class FakeAnimation {
    playState: AnimationPlayState = "running";
    reversed = false;
    readonly finished: Promise<FakeAnimation>;
    private resolve!: (a: FakeAnimation) => void;
    private reject!: (e: unknown) => void;
    constructor(
        readonly target: Element,
        readonly keyframes: Keyframe[],
        readonly options: KeyframeAnimationOptions
    ) {
        this.finished = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        this.finished.catch(() => {});
    }
    finish() {
        if (this.playState !== "running") return;
        this.playState = "finished";
        this.resolve(this);
    }
    cancel() {
        if (this.playState === "running") this.reject(new DOMException("cancelled", "AbortError"));
        this.playState = "idle";
    }
    reverse() {
        this.reversed = !this.reversed;
    }
}

let animations: FakeAnimation[];
let layer: HTMLElement;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Finishes every animation under way, and lets what waits on them run. */
const finishAll = async () => {
    for (const a of animations) a.finish();
    await tick();
};
const on = (el: Element) => animations.filter((a) => a.target === el);

beforeEach(() => {
    animations = [];
    vi.spyOn(Element.prototype, "animate").mockImplementation(function (
        this: Element,
        keyframes,
        options
    ) {
        const a = new FakeAnimation(
            this,
            keyframes as Keyframe[],
            options as KeyframeAnimationOptions
        );
        animations.push(a);
        return a as unknown as Animation;
    });
    layer = document.createElement("div");
    document.body.append(layer);
});
afterEach(() => {
    vi.restoreAllMocks();
    layer.remove();
});

describe("animateIn and animateOut", () => {
    const box = () => {
        const el = document.createElement("div");
        layer.append(el);
        return el;
    };

    it("bring an element in from where it is said to start, quickly and slowing as it arrives", () => {
        const el = box();
        animateIn(el, RISE);
        const [a] = on(el);
        expect(a?.keyframes).toEqual([{ ...RISE, offset: 0 }]);
        expect(a?.options).toMatchObject({ duration: ENTER_MS, fill: "backwards" });
        expect(String(a?.options.easing)).toMatch(/^cubic-bezier/);
    });

    it("take it out, and only then do what follows (remove it, hide it)", async () => {
        const el = box();
        const done = vi.fn(() => el.remove());
        animateOut(el, done, POP);
        expect(isLeaving(el)).toBe(true);
        expect(on(el)[0]?.options).toMatchObject({ duration: EXIT_MS, fill: "forwards" });
        await tick();
        expect(done).not.toHaveBeenCalled();
        expect(el.isConnected).toBe(true);
        await finishAll();
        expect(done).toHaveBeenCalledOnce();
        expect(el.isConnected).toBe(false);
        // its fill is let go, so it does not hold the element faded the next time it is shown
        expect(on(el)[0]?.playState).toBe("idle");
    });

    it("turn around an element coming back on its way out, which then stays", async () => {
        const el = box();
        const done = vi.fn();
        animateOut(el, done);
        animateIn(el);
        expect(on(el)).toHaveLength(1); // the same animation, played back from where it got to
        expect(on(el)[0]?.reversed).toBe(true);
        expect(isLeaving(el)).toBe(false);
        await finishAll();
        expect(done).not.toHaveBeenCalled();
    });

    it("turn around an element going while it still comes in, and then do what follows", async () => {
        const el = box();
        const done = vi.fn();
        animateIn(el);
        animateOut(el, done);
        expect(on(el)).toHaveLength(1);
        expect(on(el)[0]?.reversed).toBe(true);
        await finishAll();
        expect(done).toHaveBeenCalledOnce();
    });

    it("do it all at once for someone who asked for less motion", () => {
        reducedMotion();
        const el = box();
        const done = vi.fn();
        animateIn(el);
        animateOut(el, done);
        expect(animations).toHaveLength(0);
        expect(done).toHaveBeenCalledOnce();
    });

    it("do it at once for an element not in the page", () => {
        const el = document.createElement("div");
        const done = vi.fn();
        animateOut(el, done);
        expect(done).toHaveBeenCalledOnce();
    });

    it("can be cut short: settle ends an exit now", () => {
        const el = box();
        const done = vi.fn();
        animateOut(el, done);
        settle(el);
        expect(done).toHaveBeenCalledOnce();
        expect(isLeaving(el)).toBe(false);
        expect(on(el)[0]?.playState).toBe("idle");
    });
});

describe("the toast", () => {
    const toasts = () => [...layer.querySelectorAll(".toast")];

    it("fades in, and fades out before it is taken away", async () => {
        vi.useFakeTimers();
        const toast = createToast(layer);
        toast.show("Copied", 500);
        expect(on(toasts()[0] as Element)).toHaveLength(1);
        vi.advanceTimersByTime(500);
        expect(toasts()).toHaveLength(1); // still fading
        vi.useRealTimers();
        await finishAll();
        expect(toasts()).toHaveLength(0);
        toast.destroy();
    });

    it("comes back with a newer message when one arrives as it fades", async () => {
        vi.useFakeTimers();
        const toast = createToast(layer);
        toast.show("First", 500);
        vi.advanceTimersByTime(500);
        toast.show("Second", 500);
        expect(toasts().map((t) => t.textContent)).toEqual(["Second"]);
        expect(isLeaving(toasts()[0] as Element)).toBe(false);
        vi.useRealTimers();
        await finishAll();
        expect(toasts().map((t) => t.textContent)).toEqual(["Second"]);
        toast.destroy();
        expect(toasts()).toHaveLength(0);
    });
});

describe("the composer", () => {
    const init = {
        title: "1 element",
        targets: ["button.pay"],
        anchor: { left: 100, top: 100, width: 80, height: 24 },
        onSave: async () => {},
        onCancel: () => {},
    };

    it("comes in, and once closed is closed at once while it fades, and takes no more typing", async () => {
        const popover = createPopover(layer);
        popover.open(init);
        const el = layer.querySelector(".popover") as HTMLElement;
        expect(on(el)[0]?.keyframes).toEqual([{ ...RISE, offset: 0 }]);
        await finishAll();
        popover.close();
        expect(popover.isOpen).toBe(false);
        expect(el.inert).toBe(true);
        expect(el.isConnected).toBe(true);
        await finishAll();
        expect(el.isConnected).toBe(false);
    });

    it("opened again while the last one fades, the last one goes at once", () => {
        const popover = createPopover(layer);
        popover.open(init);
        popover.close();
        popover.open(init);
        expect(layer.querySelectorAll(".popover")).toHaveLength(1);
        popover.destroy();
        expect(layer.querySelectorAll(".popover")).toHaveLength(0);
    });

    it("is placed again with everything else, once a frame however often it is asked", async () => {
        const frames = createFrames();
        const scheduled = vi.spyOn(frames, "schedule");
        const popover = createPopover(layer, frames);
        popover.open(init);
        popover.reposition();
        popover.reposition();
        expect(scheduled).toHaveBeenCalledTimes(2);
        const el = layer.querySelector(".popover") as HTMLElement;
        el.style.left = "";
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(el.style.left).not.toBe("");
        popover.destroy();
    });
});

describe("pins", () => {
    let pins: Pins | undefined;
    afterEach(() => {
        pins?.destroy();
        pins = undefined;
    });
    const record = (id: string): AnnotationRecord => ({
        annotation: { ...sampleAnnotation, id, status: "open", thread: [] },
        assets: new Map(),
    });

    it("are placed by a transform, and grow in when they are made", () => {
        pins = createPins({
            layer,
            records: () => [record("a1")],
            currentRoute: () => sampleAnnotation.route,
        });
        pins.refresh();
        const pin = layer.querySelector(".pin") as HTMLElement;
        expect(pin.style.transform).toMatch(/^translate3d\(/);
        expect(pin.style.left).toBe("");
        expect(on(pin).length).toBeGreaterThan(0);
        // Placed again, it does not grow again.
        const before = animations.length;
        pins.refresh();
        expect(animations).toHaveLength(before);
    });

    it("open their card with a pop, and hide it only once it has gone", async () => {
        pins = createPins({
            layer,
            records: () => [record("a1")],
            currentRoute: () => sampleAnnotation.route,
        });
        pins.refresh();
        const pin = layer.querySelector(".pin") as HTMLButtonElement;
        pin.click();
        const card = layer.querySelector(".card") as HTMLElement;
        expect(card.style.display).toBe("block");
        expect(on(card)[0]?.keyframes).toEqual([{ ...POP, offset: 0 }]);
        await finishAll();
        pin.click();
        expect(card.style.display).toBe("block");
        expect(pin.getAttribute("aria-expanded")).toBe("false");
        await finishAll();
        expect(card.style.display).toBe("none");
    });

    it("show a note being made at once, and hand its pin over to the note when it is made", () => {
        let records: AnnotationRecord[] = [];
        pins = createPins({
            layer,
            records: () => records,
            currentRoute: () => sampleAnnotation.route,
        });
        pins.refresh();
        const el = document.createElement("button");
        document.body.append(el);
        const pending = pins.pending({
            number: 1,
            route: sampleAnnotation.route,
            elements: [el],
            rect: { x: 0, y: 0, w: 10, h: 10 },
        });
        const ghost = layer.querySelector(".pin") as HTMLElement;
        expect(ghost.dataset.pending).toBe("true");
        expect(ghost.textContent).toBe("1");
        expect(ghost.style.display).toBe("block");

        records = [record("a1")];
        pending.done("a1");
        const grown = animations.length;
        pins.refresh();
        const now = layer.querySelectorAll(".pin");
        expect(now).toHaveLength(1);
        expect(now[0]).toBe(ghost); // the same pin, now the note's own
        expect(ghost.dataset.pending).toBeUndefined();
        expect(ghost.getAttribute("aria-controls")).toBe("notato-card-a1");
        expect(animations).toHaveLength(grown); // already there: it does not grow in again
        el.remove();
    });

    it("take a pending pin away when its note is not made after all", async () => {
        pins = createPins({
            layer,
            records: () => [],
            currentRoute: () => sampleAnnotation.route,
        });
        const pending = pins.pending({
            number: 3,
            route: sampleAnnotation.route,
            elements: [],
            rect: { x: 5, y: 5, w: 10, h: 10 },
        });
        expect(layer.querySelectorAll(".pin")).toHaveLength(1);
        pending.cancel();
        await finishAll();
        expect(layer.querySelectorAll(".pin")).toHaveLength(0);
    });
});

describe("one frame for everything over the page", () => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    it("measures for every job before any of them writes, and runs each once however often asked", async () => {
        const frames = createFrames();
        const log: string[] = [];
        const job = (name: string) => ({
            read: () => log.push(`read ${name}`),
            write: () => log.push(`write ${name}`),
        });
        const a = job("a");
        const b = job("b");
        frames.schedule(a);
        frames.schedule(b);
        frames.schedule(a);
        await frame();
        expect(log).toEqual(["read a", "read b", "write a", "write b"]);
    });

    it("leaves a job asked for while it writes to the frame after", async () => {
        const frames = createFrames();
        let runs = 0;
        const job = {
            write: () => {
                runs += 1;
                if (runs === 1) frames.schedule(job);
            },
        };
        frames.schedule(job);
        await frame();
        expect(runs).toBe(1);
        await frame();
        expect(runs).toBe(2);
    });

    it("keeps going when one job fails", async () => {
        const frames = createFrames();
        const reported = vi.fn();
        vi.stubGlobal("reportError", reported);
        const ran = vi.fn();
        frames.schedule({
            read: () => {
                throw new Error("boom");
            },
        });
        frames.schedule({ write: ran });
        await frame();
        expect(ran).toHaveBeenCalledOnce();
        expect(reported).toHaveBeenCalledOnce();
        vi.unstubAllGlobals();
    });

    it("asks for no frame once every job is taken back", () => {
        const frames = createFrames();
        const cancel = vi.spyOn(window, "cancelAnimationFrame");
        const job = { read: () => {} };
        frames.schedule(job);
        frames.cancel(job);
        expect(cancel).toHaveBeenCalledOnce();
    });
});
