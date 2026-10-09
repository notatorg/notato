// @vitest-environment happy-dom
import type { AnnotationRecord } from "@notato/core";
import { type Annotation, type Status, sampleAnnotation } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPins } from "../src/ui/pins.ts";
import { STYLES } from "../src/ui/styles.ts";
import { useReducedMotion } from "./support/motion.ts";

useReducedMotion();

let layer: HTMLElement;
beforeEach(() => {
    layer = document.createElement("div");
    document.body.append(layer);
});
afterEach(() => layer.remove());

const record = (status: Status, over: Partial<Annotation> = {}): AnnotationRecord => ({
    annotation: { ...sampleAnnotation, id: "a1", status, thread: [], ...over } as Annotation,
    assets: new Map(),
});

function mount(status: Status, options: Partial<Parameters<typeof createPins>[0]> = {}) {
    let current = record(status);
    let route = sampleAnnotation.route;
    const pins = createPins({
        layer,
        records: () => [current],
        currentRoute: () => route,
        ...options,
    });
    pins.refresh();
    const pin = layer.querySelector(".pin") as HTMLButtonElement;
    return {
        pins,
        pin,
        card: () => layer.querySelector<HTMLElement>(".card") as HTMLElement,
        /** The server changed the note. */
        set(next: Status, over: Partial<Annotation> = {}) {
            current = record(next, over);
            pins.refresh();
        },
        goTo(next: string) {
            route = next;
            pins.refresh();
        },
    };
}

const button = (root: ParentNode, label: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as
        | HTMLButtonElement
        | undefined;
const type = (box: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    box.value = value;
    box.dispatchEvent(new Event("input"));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const shown = (el: HTMLElement) => el.style.display === "block";

describe("a card is always drawn from where the note is now", () => {
    it("after a request finishes while its card is closed, opening it shows the note as it is, not as it was", async () => {
        let answer: () => void = () => {};
        const onRequestRevert = vi.fn(
            () => new Promise<void>((resolve) => (answer = () => resolve()))
        );
        const onCancelRevert = vi.fn(async () => {});
        const t = mount("resolved", { onRequestRevert, onCancelRevert });
        t.pin.click();
        button(t.card(), "Revert this change")?.click();
        button(t.card(), "Ask the agent to revert")?.click();
        t.card().querySelector<HTMLButtonElement>(".card-x")?.click(); // closed before the server answers
        expect(shown(t.card())).toBe(false);
        t.set("revert_requested");
        answer();
        await settle();
        t.set("reverted"); // the agent did it, while nobody was looking
        t.pin.dispatchEvent(new Event("mouseenter"));
        expect(shown(t.card())).toBe(true);
        expect(t.card().querySelector(".badge.status")?.textContent).toBe("Reverted");
        expect(button(t.card(), "Cancel request")).toBeUndefined();
        expect(onCancelRevert).not.toHaveBeenCalled();
    });

    it("a button drawn for an earlier state does not act on the note's new one", () => {
        const onCancelRevert = vi.fn(async () => {});
        const t = mount("revert_requested", { onCancelRevert });
        t.pin.click();
        const cancel = button(t.card(), "Cancel request") as HTMLButtonElement;
        t.set("reverted");
        cancel.click(); // a click already on its way to the old button
        expect(onCancelRevert).not.toHaveBeenCalled();
    });

    it("a form left open for a state the note has left does not hide the reply line", () => {
        const t = mount("resolved", { onRequestRevert: async () => {}, onReply: async () => {} });
        t.pin.click();
        button(t.card(), "Revert this change")?.click();
        expect(t.card().querySelector(".say")).toBeNull(); // one thing at a time while the form is open
        t.set("open"); // reopened: there is nothing to revert any more
        expect(t.card().querySelector("textarea")).toBeNull();
        expect(t.card().querySelector(".say")).not.toBeNull();
    });
});

describe("someone typing in a card while the server updates it", () => {
    it("keeps the reply they are writing, where their caret is, and their focus", () => {
        const t = mount("open", { onReply: async () => {} });
        t.pin.click();
        const say = t.card().querySelector(".say") as HTMLInputElement;
        say.focus();
        type(say, "half a sentence");
        say.setSelectionRange(4, 6);
        t.set("acknowledged"); // the agent picked it up
        const after = t.card().querySelector(".say") as HTMLInputElement;
        expect(t.card().querySelector(".badge.status")?.textContent).toBe("Acknowledged");
        expect(after.value).toBe("half a sentence");
        expect(document.activeElement).toBe(after);
        expect([after.selectionStart, after.selectionEnd]).toEqual([4, 6]);
    });

    it("keeps a revert reason and its focus the same way", () => {
        const t = mount("resolved", { onRequestRevert: async () => {}, onReply: async () => {} });
        t.pin.click();
        button(t.card(), "Revert this change")?.click();
        const box = t.card().querySelector("textarea") as HTMLTextAreaElement;
        box.focus();
        type(box, "it broke");
        t.set("resolved", {
            thread: [
                {
                    id: "r1",
                    author: { kind: "agent", name: "Codex" },
                    body: "Done.",
                    createdAt: "2026-10-07T10:00:00.000Z",
                } as Annotation["thread"][number],
            ],
        });
        const after = t.card().querySelector("textarea") as HTMLTextAreaElement;
        expect(t.card().textContent).toContain("Done.");
        expect(after.value).toBe("it broke");
        expect(document.activeElement).toBe(after);
    });

    it("does not take focus for a card nobody was typing in", () => {
        const t = mount("open", { onReply: async () => {} });
        t.pin.click();
        const outside = document.createElement("input");
        document.body.append(outside);
        outside.focus();
        t.set("acknowledged");
        expect(document.activeElement).toBe(outside);
        outside.remove();
    });
});

describe("a pinned card that went out of sight", () => {
    it("comes back with its pin when the pins are shown again", () => {
        const t = mount("open");
        t.pin.click();
        expect(shown(t.card())).toBe(true);
        t.pins.setVisible(false);
        expect(shown(t.card())).toBe(false);
        t.pins.setVisible(true);
        expect(shown(t.card())).toBe(true);
    });

    it("comes back when the page it is on is shown again", () => {
        const t = mount("open");
        t.pin.click();
        t.goTo("/elsewhere");
        expect(shown(t.card())).toBe(false);
        t.goTo(sampleAnnotation.route);
        expect(shown(t.card())).toBe(true);
    });

    it("a card that was only hovered does not come back on its own", () => {
        const t = mount("open");
        t.pin.dispatchEvent(new Event("mouseenter"));
        expect(shown(t.card())).toBe(true);
        t.pins.setVisible(false);
        t.pins.setVisible(true);
        expect(shown(t.card())).toBe(false);
    });
});

describe("a note the server refused", () => {
    it("says so on its card and marks its pin", () => {
        const t = mount("open", { refusal: () => "the annotation is too large" });
        t.pin.click();
        expect(t.card().textContent).toContain("Not sent: the annotation is too large");
        expect(t.pin.dataset.refused).toBe("true");
    });
});

describe("a long thread", () => {
    it("scrolls inside the card, so the reply line and buttons stay within reach", () => {
        const card = /\.card \{[^}]*\}/.exec(STYLES)?.[0] ?? "";
        expect(card).toContain("max-height: calc(100vh - 16px)");
        expect(card).toContain("overflow-y: auto");
    });
});
