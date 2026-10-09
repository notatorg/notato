// @vitest-environment happy-dom
import type { AnnotationRecord } from "@notato/core";
import { type Annotation, type Status, sampleAnnotation, type Variants } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPins } from "../src/ui/pins.ts";
import { useReducedMotion } from "./support/motion.ts";

useReducedMotion();

let layer: HTMLElement;
let page: HTMLElement;
beforeEach(() => {
    layer = document.createElement("div");
    page = document.createElement("main");
    document.body.append(page, layer);
});
afterEach(() => {
    layer.remove();
    page.remove();
});

const offered = (extra: Partial<Variants> = {}): Variants => ({
    group: "header",
    options: [{ name: "Original" }, { name: "Stacked" }, { name: "Wide" }],
    offeredAt: "2026-10-05T10:00:00.000Z",
    ...extra,
});

const record = (
    status: Status,
    variants: Variants | null,
    elements?: Element[]
): AnnotationRecord => ({
    annotation: {
        ...sampleAnnotation,
        id: "a1",
        status,
        thread: [],
        variants: variants ?? undefined,
    } as Annotation,
    assets: new Map(),
    elements,
});

/** Pins for one annotation, with its card pinned open the way a click on the pin does. */
function open(
    status: Status,
    variants: Variants | null = offered(),
    options: Partial<Parameters<typeof createPins>[0]> = {},
    elements?: Element[]
) {
    let current = record(status, variants, elements);
    const pins = createPins({
        layer,
        records: () => [current],
        currentRoute: () => sampleAnnotation.route,
        ...options,
    });
    pins.refresh();
    layer.querySelector<HTMLButtonElement>(".pin")?.click();
    return {
        pins,
        pin: () => layer.querySelector<HTMLButtonElement>(".pin") as HTMLButtonElement,
        card: () => layer.querySelector<HTMLElement>(".card") as HTMLElement,
        /** What the server sends next for the same annotation. */
        update(change: Partial<Annotation>) {
            current = { ...current, annotation: { ...current.annotation, ...change } };
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
const ASK = "Ask for different versions";
const hint = (card: HTMLElement) => card.querySelector(".variants-hint")?.textContent;
const box = (card: HTMLElement) => card.querySelector("textarea") as HTMLTextAreaElement;
const error = (card: HTMLElement) => card.querySelector(".err")?.textContent;

describe("a card for versions that are ready", () => {
    it("says the versions are ready, and lists them by name", () => {
        const { card } = open("acknowledged");
        expect(hint(card())).toContain("Versions ready: Original, Stacked, Wide.");
    });

    it("says what was picked once the person has picked, and that it is waiting for the agent", () => {
        const { card } = open("variant_chosen", offered({ chosen: "Stacked" }));
        expect(hint(card())).toBe("You picked “Stacked”. Waiting for the agent to apply it.");
        expect(hint(card())).not.toContain("Versions ready");
    });

    it("shows the status on the card and on the pin, so the styles can tell it apart", () => {
        const { card, pin } = open("variant_chosen", offered({ chosen: "Stacked" }));
        expect(pin().getAttribute("data-status")).toBe("variant_chosen");
        expect(card().querySelector(".badge")?.getAttribute("data-v")).toBe("variant_chosen");
        expect(card().querySelector(".badge")?.textContent).toBe("Variant chosen");
    });

    it("keeps the pin's status in step with the annotation", () => {
        const { update, pin } = open("acknowledged");
        expect(pin().getAttribute("data-status")).toBe("acknowledged");
        update({ status: "variant_chosen", variants: offered({ chosen: "Wide" }) });
        expect(pin().getAttribute("data-status")).toBe("variant_chosen");
    });

    it("shows nothing about versions once the annotation is resolved, or before it has been acknowledged", () => {
        for (const status of [
            "open",
            "resolved",
            "revert_requested",
            "reverted",
            "dismissed",
        ] as const) {
            layer.replaceChildren();
            const { card } = open(status, offered({ chosen: "Stacked" }), {
                onReply: async () => {},
                onTakeBackVariant: async () => {},
            });
            expect(card().querySelector(".variants-hint"), status).toBeNull();
            expect(card().textContent, status).not.toContain(ASK);
            expect(card().textContent, status).not.toContain("Take back");
        }
    });

    it("shows nothing about versions when there are none", () => {
        for (const status of ["acknowledged", "variant_chosen"] as const) {
            layer.replaceChildren();
            const { card } = open(status, null, {
                onReply: async () => {},
                onTakeBackVariant: async () => {},
            });
            expect(card().querySelector(".variants-hint"), status).toBeNull();
            expect(card().textContent, status).not.toContain(ASK);
            expect(card().textContent, status).not.toContain("Take back");
        }
    });
});

describe("taking back a pick", () => {
    it("is offered on a pick, and only when there is a server to ask through", () => {
        const withServer = open("variant_chosen", offered({ chosen: "Stacked" }), {
            onTakeBackVariant: async () => {},
        });
        expect(button(withServer.card(), "Take back")).toBeDefined();

        layer.replaceChildren();
        const without = open("variant_chosen", offered({ chosen: "Stacked" }));
        expect(button(without.card(), "Take back")).toBeUndefined();
        expect(hint(without.card())).toContain("You picked");
    });

    it("is not offered while nothing has been picked", () => {
        const { card } = open("acknowledged", offered(), { onTakeBackVariant: async () => {} });
        expect(button(card(), "Take back")).toBeUndefined();
    });

    it("asks with the annotation's id, and is disabled while the request is out", () => {
        const onTakeBackVariant = vi.fn(() => new Promise<void>(() => {}));
        const { card } = open("variant_chosen", offered({ chosen: "Stacked" }), {
            onTakeBackVariant,
        });
        button(card(), "Take back")?.click();
        expect(onTakeBackVariant).toHaveBeenCalledExactlyOnceWith("a1");
        expect(button(card(), "Take back")?.disabled).toBe(true);
        button(card(), "Take back")?.click();
        expect(onTakeBackVariant).toHaveBeenCalledTimes(1);
    });

    it("can be tried again if the request failed", async () => {
        const onTakeBackVariant = vi.fn(async () => {
            throw new Error("Cannot reach the Notato server.");
        });
        const { card } = open("variant_chosen", offered({ chosen: "Stacked" }), {
            onTakeBackVariant,
        });
        button(card(), "Take back")?.click();
        await settle();
        expect(button(card(), "Take back")?.disabled).toBe(false);
        button(card(), "Take back")?.click();
        expect(onTakeBackVariant).toHaveBeenCalledTimes(2);
    });

    it("goes when the server's update says the pick is gone", async () => {
        const { card, update } = open("variant_chosen", offered({ chosen: "Stacked" }), {
            onTakeBackVariant: async () => {},
        });
        button(card(), "Take back")?.click();
        await settle();
        update({ status: "acknowledged", variants: offered() });
        expect(hint(card())).toContain("Versions ready");
        expect(button(card(), "Take back")).toBeUndefined();
    });
});

describe("asking for different versions", () => {
    it("is offered only when there is a server to write through", () => {
        const { card } = open("acknowledged");
        expect(card().textContent).not.toContain(ASK);

        layer.replaceChildren();
        const withServer = open("acknowledged", offered(), { onReply: async () => {} });
        expect(button(withServer.card(), ASK)).toBeDefined();
    });

    it("is offered after a pick as well, next to Take back", () => {
        const { card } = open("variant_chosen", offered({ chosen: "Wide" }), {
            onReply: async () => {},
            onTakeBackVariant: async () => {},
        });
        expect(button(card(), ASK)).toBeDefined();
        expect(button(card(), "Take back")).toBeDefined();
    });

    it("opens a note to write in, and does not send anything yet", () => {
        const onReply = vi.fn(async () => {});
        const { card } = open("acknowledged", offered(), { onReply });
        expect(card().querySelector("textarea")).toBeNull();
        button(card(), ASK)?.click();
        expect(box(card())).not.toBeNull();
        expect(box(card()).getAttribute("aria-label")).toBe("What to change about the versions");
        expect(document.activeElement).toBe(box(card()));
        expect(button(card(), "Send to the agent")).toBeDefined();
        expect(hint(card())).toContain("Versions ready"); // what it is about stays in view
        expect(onReply).not.toHaveBeenCalled();
    });

    it("refuses an empty note, and says why", () => {
        const onReply = vi.fn(async () => {});
        const { card } = open("acknowledged", offered(), { onReply });
        button(card(), ASK)?.click();
        button(card(), "Send to the agent")?.click();
        expect(error(card())).toBe("Write what should be different first.");
        expect(onReply).not.toHaveBeenCalled();
        expect(box(card())).not.toBeNull(); // still there to write in
    });

    it("refuses a note that is only spaces", () => {
        const onReply = vi.fn(async () => {});
        const { card } = open("acknowledged", offered(), { onReply });
        button(card(), ASK)?.click();
        type(box(card()), "   \n  ");
        button(card(), "Send to the agent")?.click();
        expect(error(card())).toBe("Write what should be different first.");
        expect(onReply).not.toHaveBeenCalled();
    });

    it("takes the message away once there is something to send", async () => {
        const { card } = open("acknowledged", offered(), { onReply: async () => {} });
        button(card(), ASK)?.click();
        button(card(), "Send to the agent")?.click();
        type(box(card()), "bolder");
        button(card(), "Send to the agent")?.click();
        expect(error(card())).toBeUndefined();
        await settle();
    });

    it("sends the id and the note without the spaces round it, then closes the form", async () => {
        const onReply = vi.fn(async () => {});
        const { card } = open("acknowledged", offered(), { onReply });
        button(card(), ASK)?.click();
        type(box(card()), "  one more with the image on the right \n");
        button(card(), "Send to the agent")?.click();
        expect(onReply).toHaveBeenCalledExactlyOnceWith(
            "a1",
            "one more with the image on the right"
        );
        await settle();
        expect(card().querySelector("textarea")).toBeNull();
        expect(button(card(), ASK)).toBeDefined();
    });

    it("locks the form while sending, so one click cannot send twice", () => {
        const onReply = vi.fn(() => new Promise<void>(() => {}));
        const { card } = open("acknowledged", offered(), { onReply });
        button(card(), ASK)?.click();
        type(box(card()), "bolder");
        button(card(), "Send to the agent")?.click();
        expect(button(card(), "Send to the agent")?.disabled).toBe(true);
        expect(button(card(), "Cancel")?.disabled).toBe(true);
        expect(box(card()).disabled).toBe(true);
        button(card(), "Send to the agent")?.click();
        expect(onReply).toHaveBeenCalledTimes(1);
    });

    it("shows why it failed and keeps what was typed, so nothing is lost", async () => {
        const onReply = vi.fn(async () => {
            throw new Error("Cannot reach the Notato server.");
        });
        const { card } = open("acknowledged", offered(), { onReply });
        button(card(), ASK)?.click();
        type(box(card()), "make it bolder");
        button(card(), "Send to the agent")?.click();
        await settle();
        expect(error(card())).toBe("Cannot reach the Notato server.");
        expect(box(card()).value).toBe("make it bolder");
        expect(box(card()).disabled).toBe(false);
        expect(button(card(), "Send to the agent")?.disabled).toBe(false);
    });

    it("shows a rejection that is not an Error as it is", async () => {
        const { card } = open("acknowledged", offered(), {
            onReply: () => Promise.reject("offline"),
        });
        button(card(), ASK)?.click();
        type(box(card()), "bolder");
        button(card(), "Send to the agent")?.click();
        await settle();
        expect(error(card())).toBe("offline");
    });

    it("can be sent again after a failure", async () => {
        const onReply = vi
            .fn()
            .mockRejectedValueOnce(new Error("nope"))
            .mockResolvedValueOnce(undefined);
        const { card } = open("acknowledged", offered(), { onReply });
        button(card(), ASK)?.click();
        type(box(card()), "bolder");
        button(card(), "Send to the agent")?.click();
        await settle();
        button(card(), "Send to the agent")?.click();
        await settle();
        expect(onReply).toHaveBeenCalledTimes(2);
        expect(onReply).toHaveBeenLastCalledWith("a1", "bolder");
        expect(card().querySelector("textarea")).toBeNull();
    });

    it("Cancel closes the form without sending", () => {
        const onReply = vi.fn(async () => {});
        const { card } = open("acknowledged", offered(), { onReply });
        button(card(), ASK)?.click();
        type(box(card()), "bolder");
        button(card(), "Cancel")?.click();
        expect(card().querySelector("textarea")).toBeNull();
        expect(button(card(), ASK)).toBeDefined();
        expect(onReply).not.toHaveBeenCalled();
    });

    it("keeps the form and its text when the card is redrawn by an update from the server", () => {
        const { card, update } = open("acknowledged", offered(), { onReply: async () => {} });
        button(card(), ASK)?.click();
        type(box(card()), "half written");
        update({ status: "variant_chosen", variants: offered({ chosen: "Wide" }) });
        expect(box(card()).value).toBe("half written");
        expect(hint(card())).toContain("You picked “Wide”");
    });

    describe("when the card is closed", () => {
        it("drops the form, so it opens as it started next time", () => {
            const { card, pin } = open("acknowledged", offered(), { onReply: async () => {} });
            button(card(), ASK)?.click();
            type(box(card()), "never sent");
            pin().click(); // unpins; nothing else keeps the card up
            expect(card().style.display).toBe("none");
            pin().click();
            expect(card().style.display).toBe("block");
            expect(card().querySelector("textarea")).toBeNull();
            expect(button(card(), ASK)).toBeDefined();
        });

        it("keeps it while it is sending, so the person comes back to the result", async () => {
            let answer: () => void = () => {};
            const onReply = vi.fn(() => new Promise<void>((resolve) => (answer = resolve)));
            const { card, pin } = open("acknowledged", offered(), { onReply });
            button(card(), ASK)?.click();
            type(box(card()), "bolder");
            button(card(), "Send to the agent")?.click();
            pin().click();
            expect(card().style.display).toBe("none");
            pin().click();
            expect(box(card()).value).toBe("bolder");
            expect(box(card()).disabled).toBe(true);

            answer();
            await settle();
            expect(card().querySelector("textarea")).toBeNull();
        });
    });
});

describe("redrawing the card", () => {
    it("redraws when the pick changes, though nothing else does", () => {
        const { card, update } = open("variant_chosen", offered({ chosen: "Stacked" }));
        expect(hint(card())).toContain("“Stacked”");
        update({ variants: offered({ chosen: "Wide" }) });
        expect(hint(card())).toContain("“Wide”");
        expect(hint(card())).not.toContain("“Stacked”");
    });

    it("redraws when the agent offers again, and says the new names", () => {
        const { card, update } = open("acknowledged", offered());
        update({
            variants: offered({
                options: [{ name: "Original" }, { name: "Compact" }],
                offeredAt: "2026-10-06T10:00:00.000Z",
            }),
        });
        expect(hint(card())).toContain("Original, Compact.");
    });

    it("does not rebuild the card for a refresh that changes nothing it shows", () => {
        const { card, pins, update } = open("acknowledged", offered(), { onReply: async () => {} });
        button(card(), ASK)?.click();
        const note = box(card());
        type(note, "half written");
        const say = card().querySelector(".variants-hint");

        pins.refresh();
        update({ appVersion: "9.9.9", context: { console: [] } }); // not something a card shows
        expect(box(card())).toBe(note);
        expect(card().querySelector(".variants-hint")).toBe(say);
        expect(note.value).toBe("half written");
    });

    it("does not rebuild the card when the same pick comes back in a fresh record", () => {
        const { card, update } = open("variant_chosen", offered({ chosen: "Stacked" }), {
            onTakeBackVariant: async () => {},
        });
        const take = button(card(), "Take back");
        update({ variants: offered({ chosen: "Stacked" }) });
        expect(button(card(), "Take back")).toBe(take);
    });
});

describe("a pin whose element is hidden", () => {
    let anchor: ReturnType<
        typeof vi.fn<NonNullable<Parameters<typeof createPins>[0]["fallbackAnchor"]>>
    >;
    beforeEach(() => {
        anchor = vi.fn(() => ({ left: 300, top: 200 }));
    });

    /** The element the annotation points at, in the page, laid out at `rect` (zero by default, as when it is hidden). */
    const element = (rect = { left: 0, top: 0, width: 0, height: 0 }) => {
        const el = document.createElement("div");
        el.getBoundingClientRect = () =>
            ({
                ...rect,
                right: rect.left + rect.width,
                bottom: rect.top + rect.height,
                x: rect.left,
                y: rect.top,
            }) as DOMRect;
        page.append(el);
        return el;
    };
    /** Whether a pin is shown, and where: it is placed by a transform from the top left of the window. */
    const placed = (pin: HTMLElement) => {
        const [, left, top] = /translate3d\((\S+), (\S+), 0\)/.exec(pin.style.transform) ?? [];
        return [pin.style.display, left, top];
    };

    it("goes where fallbackAnchor says, when the element takes up no room", () => {
        const { pin } = open("acknowledged", offered(), { fallbackAnchor: anchor }, [element()]);
        expect(placed(pin())).toEqual(["block", "300px", "200px"]);
        expect(pin().dataset.detached).toBe("false"); // the element is still there, only not on screen
    });

    it("is asked about the annotation it is for", () => {
        open("acknowledged", offered(), { fallbackAnchor: anchor }, [element()]);
        expect(anchor).toHaveBeenCalled();
        expect(anchor.mock.calls[0]?.[0]).toMatchObject({
            id: "a1",
            variants: { group: "header" },
        });
    });

    it("is hidden when fallbackAnchor has nowhere to put it", () => {
        anchor.mockReturnValue(null);
        const { pin } = open("acknowledged", offered(), { fallbackAnchor: anchor }, [element()]);
        expect(pin().style.display).toBe("none");
        expect(anchor).toHaveBeenCalled();
    });

    it("is hidden along with its open card once fallbackAnchor has nowhere to put it", () => {
        const { pin, card, pins } = open("acknowledged", offered(), { fallbackAnchor: anchor }, [
            element(),
        ]);
        expect(card().style.display).toBe("block");
        anchor.mockReturnValue(null);
        pins.refresh();
        expect(pin().style.display).toBe("none");
        expect(card().style.display).toBe("none");
    });

    it("is hidden when there is no fallbackAnchor at all", () => {
        const { pin } = open("acknowledged", offered(), {}, [element()]);
        expect(pin().style.display).toBe("none");
    });

    it("is not asked when the element has a real place on screen", () => {
        const { pin } = open("acknowledged", offered(), { fallbackAnchor: anchor }, [
            element({ left: 50, top: 60, width: 100, height: 20 }),
        ]);
        expect(placed(pin())).toEqual(["block", "50px", "60px"]);
        expect(anchor).not.toHaveBeenCalled();
    });

    it("is not asked when the element has a width but no height, which is still a place on screen", () => {
        const { pin } = open("acknowledged", offered(), { fallbackAnchor: anchor }, [
            element({ left: 50, top: 60, width: 100, height: 0 }),
        ]);
        expect(placed(pin())).toEqual(["block", "50px", "60px"]);
        expect(anchor).not.toHaveBeenCalled();
    });

    it("is hidden when the place it is given is off screen", () => {
        anchor.mockReturnValue({ left: 5000, top: 5000 });
        const { pin } = open("acknowledged", offered(), { fallbackAnchor: anchor }, [element()]);
        expect(pin().style.display).toBe("none");
    });

    it("follows the shown version as it changes", () => {
        const { pin, pins } = open("acknowledged", offered(), { fallbackAnchor: anchor }, [
            element(),
        ]);
        expect(placed(pin())).toEqual(["block", "300px", "200px"]);
        anchor.mockReturnValue({ left: 420, top: 90 });
        pins.refresh();
        expect(placed(pin())).toEqual(["block", "420px", "90px"]);
        anchor.mockReturnValue(null);
        pins.refresh();
        expect(pin().style.display).toBe("none");
        anchor.mockReturnValue({ left: 100, top: 100 });
        pins.refresh();
        expect(placed(pin())).toEqual(["block", "100px", "100px"]);
    });

    it("also moves at the next frame, the way a scroll or a resize does", async () => {
        const { pin, pins } = open("acknowledged", offered(), { fallbackAnchor: anchor }, [
            element(),
        ]);
        anchor.mockReturnValue({ left: 150, top: 250 });
        pins.schedule();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); // after the pins' own
        expect(placed(pin())).toEqual(["block", "150px", "250px"]);
    });
});
