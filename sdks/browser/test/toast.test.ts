// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToast } from "../src/ui/toast.ts";
import { useReducedMotion } from "./support/motion.ts";

useReducedMotion();

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

describe("createToast", () => {
    const toasts = () => [...layer.querySelectorAll(".toast")];

    it("shows the message as a status", () => {
        const toast = createToast(layer);
        toast.show("Copied 3 annotations");
        expect(toasts()).toHaveLength(1);
        expect(toasts()[0]?.textContent).toBe("Copied 3 annotations");
        expect(toasts()[0]?.getAttribute("role")).toBe("status");
    });

    it("goes away on its own after 2.6 seconds, or as long as it is asked to stay", () => {
        const toast = createToast(layer);
        toast.show("Copied");
        vi.advanceTimersByTime(2599);
        expect(toasts()).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(toasts()).toHaveLength(0);

        toast.show("Saved", 500);
        vi.advanceTimersByTime(499);
        expect(toasts()).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(toasts()).toHaveLength(0);
    });

    it("shows one message at a time, and the newer one gets its full time", () => {
        const toast = createToast(layer);
        toast.show("First");
        vi.advanceTimersByTime(2000);
        toast.show("Second");
        expect(toasts().map((t) => t.textContent)).toEqual(["Second"]);
        vi.advanceTimersByTime(1000); // the first one's time is up, but it is not the first one's toast any more
        expect(toasts().map((t) => t.textContent)).toEqual(["Second"]);
        vi.advanceTimersByTime(1600);
        expect(toasts()).toHaveLength(0);
    });

    it("is removed at once by destroy", () => {
        const toast = createToast(layer);
        toast.show("Copied");
        toast.destroy();
        expect(toasts()).toHaveLength(0);
        expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    });
});
