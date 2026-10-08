// @vitest-environment happy-dom
import type { DraftAnnotation } from "@notato/core";
import { describe, expect, it } from "vitest";
import { animationsOn, animationsPlugin } from "../src/plugins/animations.ts";

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
