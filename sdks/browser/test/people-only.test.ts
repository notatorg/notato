// @vitest-environment happy-dom
import type { AnnotationRecord } from "@notato/core";
import { type Annotation, type Reply, sampleAnnotation } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPins, type Pins } from "../src/ui/pins.ts";
import { createPopover, PEOPLE_ONLY_HINT, type PopoverInit } from "../src/ui/popover.ts";

let layer: HTMLElement;
let pins: Pins | undefined;
beforeEach(() => {
    layer = document.createElement("div");
    document.body.append(layer);
});
afterEach(() => {
    pins?.destroy();
    pins = undefined;
    layer.remove();
});

const button = (root: ParentNode, label: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as
        | HTMLButtonElement
        | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const reply = (body: string, over: Partial<Reply> = {}): Reply => ({
    id: `r-${body}`,
    author: { kind: "human", name: "Dom" },
    body,
    createdAt: "2026-10-07T09:00:00.000Z",
    ...over,
});

function mount(over: Partial<Annotation>, options: Partial<Parameters<typeof createPins>[0]> = {}) {
    let current: AnnotationRecord = {
        annotation: { ...sampleAnnotation, id: "a1", status: "open", thread: [], ...over },
        assets: new Map(),
    };
    pins = createPins({
        layer,
        records: () => [current],
        currentRoute: () => sampleAnnotation.route,
        ...options,
    });
    pins.refresh();
    (layer.querySelector(".pin") as HTMLButtonElement).click();
    return {
        card: () => layer.querySelector<HTMLElement>(".card") as HTMLElement,
        set(next: Partial<Annotation>) {
            current = { ...current, annotation: { ...current.annotation, ...next } };
            pins?.refresh();
        },
    };
}

describe("the composer", () => {
    let onSave: ReturnType<typeof vi.fn<PopoverInit["onSave"]>>;
    beforeEach(() => {
        onSave = vi.fn(async () => {});
    });
    const open = () => {
        const popover = createPopover(layer);
        popover.open({
            title: "1 element",
            targets: ["button.pay"],
            anchor: { left: 100, top: 100, width: 80, height: 24 },
            onSave,
            onCancel: () => {},
        });
        (layer.querySelector("textarea") as HTMLTextAreaElement).value = "is this green right?";
        return popover;
    };

    it("sends a note to the agent unless People only is pressed", async () => {
        const popover = open();
        const chip = button(layer, "People only") as HTMLButtonElement;
        expect(chip.getAttribute("aria-pressed")).toBe("false");
        expect(chip.title).toBe(PEOPLE_ONLY_HINT);
        button(layer, "Save")?.click();
        await settle();
        expect(onSave.mock.calls[0]?.[0]).toEqual({ comment: "is this green right?" });
        popover.destroy();
    });

    it("marks the note People only when it is", async () => {
        const popover = open();
        button(layer, "People only")?.click();
        expect(button(layer, "People only")?.getAttribute("aria-pressed")).toBe("true");
        button(layer, "Save")?.click();
        await settle();
        expect(onSave.mock.calls[0]?.[0]).toMatchObject({ peopleOnly: true });
        popover.destroy();
    });
});

describe("a card", () => {
    it("shows a People only note as one, and turns it off and on", async () => {
        const onPeopleOnly = vi.fn(async () => {});
        const t = mount({ peopleOnly: true }, { onPeopleOnly });
        expect(t.card().querySelector(".badge.people")?.textContent).toBe("People only");
        const toggle = t.card().querySelector(".card-foot .chip.people") as HTMLButtonElement;
        expect(toggle.getAttribute("aria-pressed")).toBe("true");
        toggle.click();
        await settle();
        expect(onPeopleOnly).toHaveBeenCalledWith("a1", false);
        t.set({ peopleOnly: undefined });
        expect(t.card().querySelector(".badge.people")).toBeNull();
        (t.card().querySelector(".card-foot .chip.people") as HTMLButtonElement).click();
        await settle();
        expect(onPeopleOnly).toHaveBeenLastCalledWith("a1", true);
    });

    it("says why when the change is refused, and offers no switch where it cannot be made", async () => {
        const t = mount(
            {},
            {
                onPeopleOnly: async () => {
                    throw new Error("Not connected to the Notato server.");
                },
            }
        );
        (t.card().querySelector(".card-foot .chip.people") as HTMLButtonElement).click();
        await settle();
        expect(t.card().textContent).toContain("Not connected to the Notato server.");
        pins?.destroy();
        layer.replaceChildren();
        const none = mount({});
        expect(none.card().querySelector(".chip.people")).toBeNull();
    });

    it("marks an aside in the thread", () => {
        const t = mount({ thread: [reply("make it blue"), reply("Sam, agree?", { aside: true })] });
        const bubbles = [...t.card().querySelectorAll(".bubble")];
        expect(bubbles.map((b) => b.classList.contains("aside"))).toEqual([false, true]);
        expect(bubbles[1]?.querySelector(".aside-tag")?.textContent).toBe("Aside");
    });

    it("sends a reply as an aside when Aside is pressed, then goes back to the agent", async () => {
        const onReply = vi.fn(async (_id: string, _note: string, _aside?: boolean) => {});
        const t = mount({}, { onReply });
        const send = (text: string) => {
            const say = t.card().querySelector(".say") as HTMLInputElement;
            say.value = text;
            say.dispatchEvent(new Event("input"));
            say.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        };
        (t.card().querySelector(".chip.aside") as HTMLButtonElement).click();
        send("just for Sam");
        await settle();
        expect(onReply).toHaveBeenLastCalledWith("a1", "just for Sam", true);
        expect(t.card().querySelector(".chip.aside")?.getAttribute("aria-pressed")).toBe("false");
        send("make it blue");
        await settle();
        expect(onReply).toHaveBeenLastCalledWith("a1", "make it blue", false);
    });

    it("offers Aside on a People only note too, which stays from the agent if the note is shared later", () => {
        const t = mount({ peopleOnly: true }, { onReply: async () => {} });
        expect(t.card().querySelector(".say")).not.toBeNull();
        expect(t.card().querySelector(".chip.aside")).not.toBeNull();
    });
});
