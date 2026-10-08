// @vitest-environment happy-dom
import type { DraftAnnotation } from "@notato/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { animationsPlugin } from "../src/plugins/animations.ts";
import { animationsOn, createFreezer, FREEZE_MARKER, type Freezer } from "../src/ui/freeze.ts";
import { sheetsIn } from "../src/ui/sheet.ts";

/** The browser's animation object, as far as the freezer can tell: it is paused and played, and it knows its state. */
class FakeAnimation {
    paused = 0;
    played = 0;
    constructor(
        public playState = "running",
        private fails: { pause?: boolean; play?: boolean } = {}
    ) {}
    pause() {
        if (this.fails.pause) throw new DOMException("finished", "InvalidStateError");
        this.paused += 1;
        this.playState = "paused";
    }
    play() {
        if (this.fails.play) throw new DOMException("cancelled", "InvalidStateError");
        this.played += 1;
        this.playState = "running";
    }
}

/** Gives a document the `getAnimations` of a browser, answering with whatever the test has running. */
const animate = (doc: Document, list: () => FakeAnimation[]) =>
    Object.defineProperty(doc, "getAnimations", { configurable: true, value: list });

let running: FakeAnimation[];
let freezer: Freezer;
const changes: boolean[] = [];
/** The freezer's rules in a document, however the browser took them (a constructed sheet, or a style element). */
const styleIn = (doc: Document) => sheetsIn(doc, FREEZE_MARKER);

beforeEach(() => {
    vi.useFakeTimers();
    running = [];
    changes.length = 0;
    animate(document, () => running);
    freezer = createFreezer(
        () => [window],
        (frozen) => changes.push(frozen)
    );
});
afterEach(() => {
    freezer.destroy();
    vi.useRealTimers();
    Reflect.deleteProperty(document, "getAnimations");
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.adoptedStyleSheets = [];
});

describe("freezing the page", () => {
    it("pauses what is running, where it is, and leaves the rest alone", () => {
        const moving = new FakeAnimation("running");
        const idle = new FakeAnimation("idle");
        const finished = new FakeAnimation("finished");
        running.push(moving, idle, finished);
        freezer.freeze();
        expect(freezer.frozen).toBe(true);
        expect(moving.playState).toBe("paused");
        expect(idle.paused + finished.paused).toBe(0);
    });

    it("stops CSS animations that have not started yet with a style on the document, which thawing removes", () => {
        freezer.freeze();
        const styles = styleIn(document);
        expect(styles).toHaveLength(1);
        expect(styles[0]).toContain("animation-play-state: paused !important");
        freezer.thaw();
        expect(styleIn(document)).toHaveLength(0);
    });

    it("picks up animations that start while frozen, until it is thawed", () => {
        freezer.freeze();
        const late = new FakeAnimation("running");
        running.push(late);
        expect(late.playState).toBe("running");
        vi.advanceTimersByTime(500);
        expect(late.playState).toBe("paused");
        expect(styleIn(document)).toHaveLength(1); // one style, however many times it looks

        freezer.thaw();
        const after = new FakeAnimation("running");
        running.push(after);
        vi.advanceTimersByTime(500);
        expect(after.paused).toBe(0);
    });

    it("is the same freeze however many times it is asked for", () => {
        freezer.freeze();
        freezer.freeze();
        expect(changes).toEqual([true]);
        expect(styleIn(document)).toHaveLength(1);
    });

    it("does not fail on a browser or a document without getAnimations", () => {
        Reflect.deleteProperty(document, "getAnimations");
        expect(() => freezer.freeze()).not.toThrow();
        expect(styleIn(document)).toHaveLength(1);
    });

    it("is not stopped by a document that throws when asked, or an animation that cannot be paused", () => {
        animate(document, () => {
            throw new Error("document is going away");
        });
        expect(() => freezer.freeze()).not.toThrow();
        freezer.thaw();

        const stuck = new FakeAnimation("running", { pause: true });
        const fine = new FakeAnimation("running");
        animate(document, () => [stuck, fine]);
        freezer.freeze();
        expect(fine.playState).toBe("paused");
    });
});

describe("thawing the page", () => {
    it("plays what it paused", () => {
        const moving = new FakeAnimation("running");
        running.push(moving);
        freezer.freeze();
        freezer.thaw();
        expect(freezer.frozen).toBe(false);
        expect(moving.played).toBe(1);
        expect(moving.playState).toBe("running");
    });

    it("plays an animation that began while it was frozen", () => {
        freezer.freeze();
        const late = new FakeAnimation("running");
        running.push(late);
        vi.advanceTimersByTime(500);
        freezer.thaw();
        expect(late.played).toBe(1);
    });

    it("does not start what the page itself had paused", () => {
        const byPage = new FakeAnimation("paused");
        const moving = new FakeAnimation("running");
        running.push(byPage, moving);
        freezer.freeze();
        freezer.thaw();
        expect(byPage.played).toBe(0);
        expect(byPage.playState).toBe("paused");
        expect(moving.played).toBe(1);
    });

    it("plays nothing twice, however often the page is frozen and thawed", () => {
        const moving = new FakeAnimation("running");
        running.push(moving);
        freezer.freeze();
        freezer.thaw();
        freezer.freeze(); // it runs again, so it is paused again, by this freeze
        freezer.thaw();
        expect(moving.paused).toBe(2);
        expect(moving.played).toBe(2);
        freezer.thaw();
        expect(moving.played).toBe(2);
    });

    it("keeps going when one animation cannot be resumed", () => {
        const cancelled = new FakeAnimation("running", { play: true });
        const fine = new FakeAnimation("running");
        running.push(cancelled, fine);
        freezer.freeze();
        expect(() => freezer.thaw()).not.toThrow();
        expect(fine.played).toBe(1);
    });

    it("does nothing, and says nothing, when it was not frozen", () => {
        freezer.thaw();
        expect(changes).toEqual([]);
    });

    it("is what destroy does", () => {
        const moving = new FakeAnimation("running");
        running.push(moving);
        freezer.freeze();
        freezer.destroy();
        expect(moving.played).toBe(1);
        expect(styleIn(document)).toHaveLength(0);
    });
});

describe("toggle and notification", () => {
    it("toggles between frozen and thawed, telling the owner each time", () => {
        freezer.toggle();
        expect(freezer.frozen).toBe(true);
        freezer.toggle();
        expect(freezer.frozen).toBe(false);
        expect(changes).toEqual([true, false]);
    });
});

describe("media", () => {
    const media = (tag: "video" | "audio", playing: boolean) => {
        const el = document.createElement(tag);
        document.body.append(el);
        if (playing) void el.play();
        return el;
    };

    it("pauses what is playing and plays only that again", () => {
        const video = media("video", true);
        const audio = media("audio", true);
        const stopped = media("video", false);
        freezer.freeze();
        expect([video.paused, audio.paused, stopped.paused]).toEqual([true, true, true]);
        freezer.thaw();
        expect([video.paused, audio.paused, stopped.paused]).toEqual([false, false, true]);
    });

    it("picks up media that starts while frozen", () => {
        freezer.freeze();
        const video = media("video", true);
        vi.advanceTimersByTime(500);
        expect(video.paused).toBe(true);
        freezer.thaw();
        expect(video.paused).toBe(false);
    });

    it("does not raise when the browser refuses to resume playback", async () => {
        const video = media("video", true);
        video.play = () =>
            Promise.reject(new DOMException("play() was blocked", "NotAllowedError"));
        freezer.freeze();
        expect(() => freezer.thaw()).not.toThrow();
        await vi.advanceTimersByTimeAsync(0); // an unhandled rejection would fail the run here
    });
});

describe("iframes", () => {
    it("freezes each window it is given, and ones that come later", () => {
        const frame = document.createElement("iframe");
        document.body.append(frame);
        const inner = frame.contentDocument as Document;
        const innerRunning = new FakeAnimation("running");
        animate(inner, () => [innerRunning]);

        let windows: Array<Pick<Window, "document">> = [window];
        const both = createFreezer(() => windows);
        both.freeze();
        expect(styleIn(inner)).toHaveLength(0);

        windows = [window, { document: inner }]; // a frame appeared since
        vi.advanceTimersByTime(500);
        expect(styleIn(inner)).toHaveLength(1);
        expect(innerRunning.playState).toBe("paused");

        both.thaw();
        expect(styleIn(inner)).toHaveLength(0);
        expect(styleIn(document)).toHaveLength(0);
        expect(innerRunning.played).toBe(1);
    });
});

describe("animationsOn", () => {
    /** An element answering `getAnimations` as the browser does, with these animations. */
    const animating = (...list: unknown[]) => {
        const el = document.createElement("div");
        const calls: unknown[] = [];
        el.getAnimations = ((options: unknown) => {
            calls.push(options);
            return list;
        }) as typeof el.getAnimations;
        return Object.assign(el, { calls });
    };
    interface Init {
        state?: string;
        name?: string;
        property?: string;
        id?: string;
        timing?: Record<string, unknown>;
        options?: Record<string, unknown>;
        keyframes?: Array<Record<string, unknown>>;
    }
    const anim = ({
        state = "running",
        name,
        property,
        id,
        timing,
        options,
        keyframes,
    }: Init = {}) => ({
        playState: state,
        animationName: name,
        transitionProperty: property,
        id,
        pause() {},
        play() {},
        effect: {
            getComputedTiming: () => timing ?? {},
            getTiming: () => options ?? { easing: "linear" },
            getKeyframes: () => keyframes ?? [],
        },
    });

    it("describes a CSS animation: name, timing, how far along it is, and its keyframes", () => {
        const el = animating(
            anim({
                name: "pulse",
                timing: { duration: 800, delay: 200, iterations: 3, progress: 0.33333 },
                options: { easing: "linear" },
                keyframes: [
                    {
                        offset: 0,
                        opacity: "0",
                        easing: "ease-in-out",
                        composite: "auto",
                        computedOffset: 0,
                    },
                    {
                        offset: 1,
                        opacity: "1",
                        easing: "ease-in-out",
                        composite: "auto",
                        computedOffset: 1,
                    },
                ],
            })
        );
        expect(animationsOn(el)).toEqual([
            {
                kind: "css-animation",
                name: "pulse",
                state: "running",
                duration: 800,
                delay: 200,
                // the animation itself says linear; the timing function is on its keyframes
                easing: "ease-in-out",
                iterations: 3,
                progress: 0.333,
                keyframes: [
                    { offset: 0, opacity: "0" },
                    { offset: 1, opacity: "1" },
                ],
            },
        ]);
    });

    it("describes a CSS transition by the property that is changing", () => {
        const [info] = animationsOn(
            animating(
                anim({ property: "background-color", timing: { duration: 150, progress: 0.5 } })
            )
        );
        expect(info).toMatchObject({
            kind: "css-transition",
            property: "background-color",
            duration: 150,
            progress: 0.5,
        });
        expect(info).not.toHaveProperty("name");
    });

    it("describes a web animation, named by its id when it has one", () => {
        expect(animationsOn(animating(anim({ id: "slide-in" })))[0]).toMatchObject({
            kind: "web-animation",
            name: "slide-in",
        });
        expect(animationsOn(animating(anim()))[0]).not.toHaveProperty("name");
    });

    it("takes the easing from the animation's own timing when it is not linear", () => {
        const options = { easing: "cubic-bezier(0.4, 0, 0.2, 1)" };
        const keyframes = [{ offset: 0, easing: "ease-out" }];
        expect(animationsOn(animating(anim({ name: "x", options, keyframes })))[0]?.easing).toBe(
            options.easing
        );
    });

    it("says nothing of a delay of zero, and calls an endless animation infinite", () => {
        const [info] = animationsOn(
            animating(
                anim({ name: "spin", timing: { delay: 0, iterations: Number.POSITIVE_INFINITY } })
            )
        );
        expect(info).not.toHaveProperty("delay");
        expect(info?.iterations).toBe("infinite");
    });

    it("leaves out progress and duration when the browser has none to give", () => {
        const [info] = animationsOn(
            animating(anim({ name: "x", timing: { progress: null, duration: "auto" } }))
        );
        expect(info).not.toHaveProperty("progress");
        expect(info).not.toHaveProperty("duration");
    });

    it("keeps keyframes short: six frames, six properties each, no empty values", () => {
        const frame = (i: number) => ({
            offset: i / 10,
            a: 1,
            b: "two",
            c: null,
            d: undefined,
            e: "e",
            f: "f",
            g: "g",
            h: "h",
        });
        const keyframes = Array.from({ length: 9 }, (_, i) => frame(i));
        const [info] = animationsOn(animating(anim({ name: "x", keyframes })));
        expect(info?.keyframes).toHaveLength(6);
        expect(Object.keys(info?.keyframes?.[0] ?? {})).toEqual([
            "offset",
            "a",
            "b",
            "e",
            "f",
            "g",
        ]);
        expect(info?.keyframes?.[1]).toMatchObject({ offset: 0.1, a: 1, b: "two" });
    });

    it("reports at most eight animations, or as many as it is told to", () => {
        const el = animating(...Array.from({ length: 12 }, () => anim({ name: "x" })));
        expect(animationsOn(el)).toHaveLength(8);
        expect(animationsOn(el, 3)).toHaveLength(3);
    });

    it("asks for the animations inside the element as well", () => {
        const el = animating();
        animationsOn(el);
        expect(el.calls).toEqual([{ subtree: true }]);
    });

    it("is empty for an element that cannot say, or whose browser throws", () => {
        const plain = document.createElement("div");
        (plain as { getAnimations?: unknown }).getAnimations = undefined;
        expect(animationsOn(plain)).toEqual([]);
        plain.getAnimations = () => {
            throw new Error("detached");
        };
        expect(animationsOn(plain)).toEqual([]);
    });
});

describe("animationsPlugin", () => {
    const animating = (...names: string[]) => {
        const el = document.createElement("div");
        el.getAnimations = (() =>
            names.map((name) => ({
                playState: "running",
                animationName: name,
                effect: { getComputedTiming: () => ({ duration: 300, progress: 0.25 }) },
            }))) as unknown as typeof el.getAnimations;
        return el;
    };
    const capture = (...elements: Element[]) =>
        animationsPlugin().capture({ elements } as unknown as DraftAnnotation);

    it("records what is animating on every annotated element in the context", async () => {
        const result = await capture(animating("fade", "slide"), animating("spin"));
        expect(result?.context?.animations).toEqual([
            {
                kind: "css-animation",
                name: "fade",
                state: "running",
                duration: 300,
                progress: 0.25,
            },
            {
                kind: "css-animation",
                name: "slide",
                state: "running",
                duration: 300,
                progress: 0.25,
            },
            {
                kind: "css-animation",
                name: "spin",
                state: "running",
                duration: 300,
                progress: 0.25,
            },
        ]);
    });

    it("records nothing when nothing is animating", async () => {
        expect(animationsPlugin().id).toBe("animations");
        expect(await capture(document.createElement("div"), animating())).toBeUndefined();
    });
});
