// @vitest-environment happy-dom
import type { AnnotationRecord } from "@notato/core";
import { type Annotation, type Status, sampleAnnotation } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPins } from "../src/ui/pins.ts";

let layer: HTMLElement;
beforeEach(() => {
    layer = document.createElement("div");
    document.body.append(layer);
});
afterEach(() => layer.remove());

const record = (status: Status): AnnotationRecord => ({
    annotation: { ...sampleAnnotation, id: "a1", status, thread: [] } as Annotation,
    assets: new Map(),
});

/** Pins for one annotation, with its card pinned open the way a click on the pin does. */
function open(status: Status, options: Partial<Parameters<typeof createPins>[0]> = {}) {
    let current = record(status);
    const pins = createPins({
        layer,
        records: () => [current],
        currentRoute: () => sampleAnnotation.route,
        ...options,
    });
    pins.refresh();
    const pin = layer.querySelector<HTMLButtonElement>(".pin");
    pin?.click();
    return {
        pins,
        card: () => layer.querySelector<HTMLElement>(".card") as HTMLElement,
        set(next: Status) {
            current = record(next);
            pins.refresh();
        },
    };
}

const button = (root: ParentNode, label: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as
        | HTMLButtonElement
        | undefined;
const type = (box: HTMLTextAreaElement, value: string) => {
    box.value = value;
    box.dispatchEvent(new Event("input"));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("asking for a resolved change to be reverted", () => {
    it("asks the connected agent by name when the server says which it is", () => {
        const { card } = open("resolved", {
            onRequestRevert: vi.fn(async () => {}),
            agentName: () => "Codex",
        });
        button(card(), "Revert this change")?.click();
        expect(button(card(), "Ask Codex to revert")).toBeDefined();
        expect(card().textContent).toContain(
            "Codex will be asked to undo what it changed for this."
        );
    });

    it("a resolved card offers it, and it opens a form instead of acting at once", () => {
        const onRequestRevert = vi.fn(async () => {});
        const { card } = open("resolved", { onRequestRevert });
        expect(card().querySelector("textarea")).toBeNull();
        button(card(), "Revert this change")?.click();
        expect(card().querySelector("textarea")).not.toBeNull();
        expect(button(card(), "Ask the agent to revert")).toBeDefined();
        expect(onRequestRevert).not.toHaveBeenCalled();
    });

    it("sends the id and what the person wrote, then closes the form", async () => {
        const onRequestRevert = vi.fn(async () => {});
        const { card } = open("resolved", { onRequestRevert });
        button(card(), "Revert this change")?.click();
        type(
            card().querySelector("textarea") as HTMLTextAreaElement,
            "  It broke the mobile layout  "
        );
        button(card(), "Ask the agent to revert")?.click();
        expect(onRequestRevert).toHaveBeenCalledWith("a1", "It broke the mobile layout");
        await settle();
        expect(card().querySelector("textarea")).toBeNull();
    });

    it("can be sent with no reason", () => {
        const onRequestRevert = vi.fn(async () => {});
        const { card } = open("resolved", { onRequestRevert });
        button(card(), "Revert this change")?.click();
        button(card(), "Ask the agent to revert")?.click();
        expect(onRequestRevert).toHaveBeenCalledWith("a1", "");
    });

    it("locks the form while sending, so one click cannot ask twice", () => {
        const onRequestRevert = vi.fn(() => new Promise<void>(() => {}));
        const { card } = open("resolved", { onRequestRevert });
        button(card(), "Revert this change")?.click();
        button(card(), "Ask the agent to revert")?.click();
        expect(button(card(), "Ask the agent to revert")?.disabled).toBe(true);
        expect(card().querySelector("textarea")?.disabled).toBe(true);
        button(card(), "Ask the agent to revert")?.click();
        expect(onRequestRevert).toHaveBeenCalledTimes(1);
    });

    it("shows why it failed and keeps what was typed, so nothing is lost", async () => {
        const onRequestRevert = vi.fn(async () => {
            throw new Error("Cannot reach the Notato server.");
        });
        const { card } = open("resolved", { onRequestRevert });
        button(card(), "Revert this change")?.click();
        type(card().querySelector("textarea") as HTMLTextAreaElement, "my reason");
        button(card(), "Ask the agent to revert")?.click();
        await settle();
        expect(card().textContent).toContain("Cannot reach the Notato server.");
        expect((card().querySelector("textarea") as HTMLTextAreaElement).value).toBe("my reason");
        expect(button(card(), "Ask the agent to revert")?.disabled).toBe(false);
    });

    it("Cancel closes the form without asking", () => {
        const onRequestRevert = vi.fn(async () => {});
        const { card } = open("resolved", { onRequestRevert });
        button(card(), "Revert this change")?.click();
        button(card(), "Cancel")?.click();
        expect(card().querySelector("textarea")).toBeNull();
        expect(button(card(), "Revert this change")).toBeDefined();
        expect(onRequestRevert).not.toHaveBeenCalled();
    });

    it("keeps the form and its text when the card is redrawn by an update from the server", () => {
        const { card, pins } = open("resolved", { onRequestRevert: async () => {} });
        button(card(), "Revert this change")?.click();
        type(card().querySelector("textarea") as HTMLTextAreaElement, "half written");
        pins.refresh();
        expect((card().querySelector("textarea") as HTMLTextAreaElement).value).toBe(
            "half written"
        );
    });

    it("does not rebuild the card when focus or hover moves, so a click on it is never lost", () => {
        vi.useFakeTimers();
        try {
            const { card } = open("resolved", { onRequestRevert: async () => {} });
            const before = button(card(), "Revert this change");
            const pin = layer.querySelector(".pin") as HTMLElement;
            pin.dispatchEvent(new Event("blur")); // clicking a card button takes focus off the pin
            pin.dispatchEvent(new Event("mouseleave"));
            card().dispatchEvent(new Event("mouseenter"));
            vi.advanceTimersByTime(250); // past the hide delay
            expect(button(card(), "Revert this change")).toBe(before);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not rebuild an open form for an update that changes nothing it shows", () => {
        const { card, pins } = open("resolved", { onRequestRevert: async () => {} });
        button(card(), "Revert this change")?.click();
        const box = card().querySelector("textarea");
        pins.refresh();
        expect(card().querySelector("textarea")).toBe(box);
    });

    it("does redraw when the annotation really changed", () => {
        const { card, set } = open("resolved", {
            onRequestRevert: async () => {},
            onCancelRevert: async () => {},
        });
        set("revert_requested");
        expect(card().textContent).toContain("Waiting for the agent to undo it.");
    });

    it("offers nothing when there is no server to ask through", () => {
        const { card } = open("resolved");
        expect(card().textContent).not.toContain("Revert");
    });

    it("offers nothing on an annotation that has not been resolved, or is already reverted", () => {
        for (const status of ["open", "acknowledged", "reverted", "dismissed"] as const) {
            layer.replaceChildren();
            const { card } = open(status, {
                onRequestRevert: async () => {},
                onCancelRevert: async () => {},
            });
            expect(card().textContent, status).not.toContain("Revert this change");
            expect(card().textContent, status).not.toContain("Cancel request");
        }
    });
});

describe("a revert that is waiting for the agent", () => {
    it("says so, and lets the person take the request back", () => {
        const onCancelRevert = vi.fn(async () => {});
        const { card } = open("revert_requested", {
            onRequestRevert: async () => {},
            onCancelRevert,
        });
        expect(card().textContent).toContain("Waiting for the agent to undo it.");
        button(card(), "Cancel request")?.click();
        expect(onCancelRevert).toHaveBeenCalledWith("a1");
    });

    it("the pin and the badge carry the status, so the styles can tell it apart", () => {
        const { card } = open("revert_requested");
        expect(layer.querySelector(".pin")?.getAttribute("data-status")).toBe("revert_requested");
        expect(card().querySelector(".badge")?.getAttribute("data-v")).toBe("revert_requested");
    });

    it("turns into the revert form's starting point again once it is resolved", () => {
        const { card, set } = open("revert_requested", {
            onRequestRevert: async () => {},
            onCancelRevert: async () => {},
        });
        set("resolved");
        expect(button(card(), "Revert this change")).toBeDefined();
    });
});
