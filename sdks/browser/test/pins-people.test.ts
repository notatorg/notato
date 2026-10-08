// @vitest-environment happy-dom
import type { AnnotationRecord } from "@notato/core";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { colorForName, initialsOf } from "../src/settings.ts";
import { createPins, type Pins } from "../src/ui/pins.ts";

type Author = Annotation["author"];

let layer: HTMLElement;
let pins: Pins;
beforeEach(() => {
    layer = document.createElement("div");
    document.body.append(layer);
});
afterEach(() => {
    pins?.destroy();
    layer.remove();
});

const human = (name?: string): Author => ({
    kind: "human",
    ...(name === undefined ? {} : { name }),
});
const agent = (name?: string): Author => ({
    kind: "agent",
    ...(name === undefined ? {} : { name }),
});

const note = (id: string, author: Author, over: Partial<Annotation> = {}): AnnotationRecord => ({
    annotation: { ...sampleAnnotation, id, author, thread: [], ...over } as Annotation,
    assets: new Map(),
});

/** Pins over a list of notes that the test can change, then refresh to take the change in. */
function show(initial: AnnotationRecord[]) {
    let current = initial;
    pins = createPins({
        layer,
        records: () => current,
        currentRoute: () => sampleAnnotation.route,
    });
    pins.refresh();
    return {
        set(next: AnnotationRecord[]) {
            current = next;
            pins.refresh();
        },
    };
}

/** The pin for a note, found by the number it is given: the first note is pin 1. */
const pinAt = (n: number) =>
    [...layer.querySelectorAll<HTMLButtonElement>(".pin")].find(
        (p) => p.textContent === String(n)
    ) as HTMLButtonElement;
const badge = (n: number) => pinAt(n).dataset.by;
const colour = (n: number) => pinAt(n).style.getPropertyValue("--by");
/** Opens the card of pin `n` the way a click does, and returns it: each card sits right after its pin. */
const card = (n: number) => {
    const pin = pinAt(n);
    pin.click();
    return pin.nextElementSibling as HTMLElement;
};
/** How the page would paint a colour, so colours compare however it spells them back. */
const painted = (value: string) => {
    const probe = document.createElement("span");
    probe.style.background = value;
    return probe.style.background;
};
const noBadge = (n: number) => {
    expect(pinAt(n).hasAttribute("data-by"), `pin ${n} data-by`).toBe(false);
    expect(pinAt(n).style.getPropertyValue("--by"), `pin ${n} --by`).toBe("");
};

describe("which notes are whose, on the pins", () => {
    it("puts the author's initials and colour on each pin when two different people have written notes", () => {
        show([note("a", human("Ada Lovelace")), note("b", human("Ana"))]);
        expect(badge(1)).toBe("AL");
        expect(badge(2)).toBe("A");
        expect(colour(1)).toBe(colorForName("Ada Lovelace"));
        expect(colour(2)).toBe(colorForName("Ana"));
        expect(colour(1)).not.toBe(colour(2));
    });

    it("takes the initials the way a person is shown elsewhere", () => {
        show([note("a", human("  ana  maria   lopez ")), note("b", human("Dom"))]);
        expect(badge(1)).toBe(initialsOf("  ana  maria   lopez "));
        expect(badge(1)).toBe("AL");
    });

    it("gives every note by the same person the same badge and colour", () => {
        show([note("a", human("Dom")), note("b", human("Ana")), note("c", human("Dom"))]);
        expect(badge(1)).toBe("D");
        expect(badge(3)).toBe("D");
        expect(colour(3)).toBe(colour(1));
        expect(colour(2)).not.toBe(colour(1));
    });

    it("puts no badge on any pin when every note is by one person", () => {
        show([note("a", human("Dom")), note("b", human("Dom")), note("c", human("Dom"))]);
        for (const n of [1, 2, 3]) noBadge(n);
    });

    it("puts no badge on a pin when there is only one note", () => {
        show([note("a", human("Dom"))]);
        noBadge(1);
    });

    it("puts no badge on a pin when there are no names to tell apart", () => {
        show([note("a", human()), note("b", human()), note("c", human(""))]);
        for (const n of [1, 2, 3]) noBadge(n);
    });

    it("puts no badge on notes written by an agent, however many agents there are", () => {
        show([note("a", agent("Claude")), note("b", agent("Cursor")), note("c", agent())]);
        for (const n of [1, 2, 3]) noBadge(n);
    });

    it("does not count an agent as a second person", () => {
        show([note("a", human("Dom")), note("b", agent("Claude")), note("c", human("Dom"))]);
        for (const n of [1, 2, 3]) noBadge(n);
    });

    it("does not count a human without a name as a second person", () => {
        show([note("a", human("Dom")), note("b", human()), note("c", human(""))]);
        for (const n of [1, 2, 3]) noBadge(n);
    });

    it("badges only the named humans when others are mixed in, and they still tell two apart", () => {
        show([
            note("a", human("Dom")),
            note("b", agent("Claude")),
            note("c", human()),
            note("d", human("Ana")),
            note("e", agent()),
        ]);
        expect(badge(1)).toBe("D");
        expect(badge(4)).toBe("A");
        for (const n of [2, 3, 5]) noBadge(n);
    });

    it("starts badging pins that are already there when a second person's note arrives", () => {
        const { set } = show([note("a", human("Dom")), note("b", human("Dom"))]);
        const first = pinAt(1);
        noBadge(1);
        set([note("a", human("Dom")), note("b", human("Dom")), note("c", human("Ana"))]);
        expect(pinAt(1)).toBe(first);
        expect(badge(1)).toBe("D");
        expect(badge(2)).toBe("D");
        expect(badge(3)).toBe("A");
    });

    it("takes the badges off again when the second person's note is removed", () => {
        const { set } = show([
            note("a", human("Dom")),
            note("b", human("Ana")),
            note("c", human("Dom")),
        ]);
        expect(badge(1)).toBe("D");
        expect(colour(1)).not.toBe("");
        set([note("a", human("Dom")), note("c", human("Dom"))]);
        expect(layer.querySelectorAll(".pin")).toHaveLength(2);
        noBadge(1);
        expect(pinAt(2).hasAttribute("data-by")).toBe(false);
        expect(pinAt(2).style.getPropertyValue("--by")).toBe("");
    });

    it("takes the badge off the last remaining pin of the first person too", () => {
        const { set } = show([note("a", human("Dom")), note("b", human("Ana"))]);
        set([note("b", human("Ana"))]);
        expect(layer.querySelectorAll(".pin")).toHaveLength(1);
        noBadge(1);
    });

    it("takes the badges off when the second person's notes turn into an agent's", () => {
        const { set } = show([note("a", human("Dom")), note("b", human("Ana"))]);
        set([note("a", human("Dom")), note("b", agent("Ana"))]);
        noBadge(1);
        noBadge(2);
    });

    it("does not rebuild a pin to change its badge, so a pin being hovered or focused is not lost", () => {
        const { set } = show([note("a", human("Dom")), note("b", human("Dom"))]);
        const pin = pinAt(1);
        set([note("a", human("Dom")), note("b", human("Ana"))]);
        expect(pinAt(1)).toBe(pin);
        expect(badge(1)).toBe("D");
    });

    it("keeps the badge when a note changes in some other way", () => {
        const { set } = show([note("a", human("Dom")), note("b", human("Ana"))]);
        set([note("a", human("Dom"), { status: "resolved" }), note("b", human("Ana"))]);
        expect(badge(1)).toBe("D");
        expect(pinAt(1).dataset.status).toBe("resolved");
    });
});

describe("which notes are whose, on the cards", () => {
    const dots = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".who")];

    it("shows a dot in the author's colour beside the name of a named human", () => {
        show([note("a", human("Ada Lovelace"))]);
        const c = card(1);
        expect(dots(c)).toHaveLength(1);
        expect(dots(c)[0]?.style.background).toBe(painted(colorForName("Ada Lovelace")));
        expect(c.textContent).toContain(`Ada Lovelace · ${sampleAnnotation.route}`);
    });

    it("shows the dot even when every note is by that one person, and no pin is badged", () => {
        show([note("a", human("Dom")), note("b", human("Dom"))]);
        noBadge(1);
        expect(dots(card(1))).toHaveLength(1);
    });

    it("shows no dot for a human who gave no name", () => {
        show([note("a", human())]);
        const c = card(1);
        expect(dots(c)).toHaveLength(0);
        expect(c.textContent).toContain("Someone");
    });

    it("shows no dot for a human whose name is empty", () => {
        show([note("a", human(""))]);
        expect(dots(card(1))).toHaveLength(0);
    });

    it("shows no dot for an agent, named or not", () => {
        show([note("a", agent("Claude")), note("b", agent())]);
        const named = card(1);
        expect(dots(named)).toHaveLength(0);
        expect(named.textContent).toContain("Claude");
        pinAt(1).click(); // close it, so the next card is the one for pin 2
        const unnamed = card(2);
        expect(dots(unnamed)).toHaveLength(0);
        expect(unnamed.textContent).toContain("Agent");
    });

    it("shows one dot, for the note's author, and none beside the people who replied", () => {
        show([
            note("a", human("Dom"), {
                thread: [
                    {
                        id: "r1",
                        author: human("Ana"),
                        body: "Agreed",
                        createdAt: "2026-10-05T10:05:00.000Z",
                    },
                    {
                        id: "r2",
                        author: agent("Claude"),
                        body: "Done",
                        createdAt: "2026-10-05T10:06:00.000Z",
                    },
                ],
            } as Partial<Annotation>),
        ]);
        const c = card(1);
        expect(c.textContent).toContain("Agreed");
        expect(dots(c)).toHaveLength(1);
        expect(dots(c)[0]?.style.background).toBe(painted(colorForName("Dom")));
    });

    it("gives each card the colour of its own author", () => {
        show([note("a", human("Dom")), note("b", human("Ana"))]);
        const first = dots(card(1))[0];
        pinAt(1).click();
        const second = dots(card(2))[0];
        expect(first?.style.background).toBe(painted(colorForName("Dom")));
        expect(second?.style.background).toBe(painted(colorForName("Ana")));
        expect(first?.style.background).not.toBe(second?.style.background);
    });
});

describe("who replied, beside each reply", () => {
    const reply = (id: string, author: Author) => ({
        id,
        author,
        body: `From ${author.name ?? "nobody"}`,
        createdAt: "2026-10-07T10:00:00.000Z",
    });
    const avatars = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".reply .av")];

    it("puts a known agent's own logo on its badge, in that agent's colours", () => {
        show([
            note("a", human("Dom"), {
                thread: [reply("r1", agent("Claude")), reply("r2", agent("Codex"))],
            } as Partial<Annotation>),
        ]);
        const [claude, codex] = avatars(card(1));
        expect(claude?.classList.contains("brand")).toBe(true);
        expect(claude?.querySelector("svg path")).not.toBeNull();
        expect(claude?.textContent).toBe("");
        expect(claude?.style.background).toBe(painted("#d97757"));
        expect(codex?.querySelector("svg path")?.getAttribute("d")).not.toBe(
            claude?.querySelector("svg path")?.getAttribute("d")
        );
    });

    it("leaves a black-and-white logo's colours to the theme", () => {
        show([
            note("a", human("Dom"), {
                thread: [reply("r1", agent("Cursor"))],
            } as Partial<Annotation>),
        ]);
        const [cursor] = avatars(card(1));
        expect(cursor?.className).toBe("av brand ink");
        expect(cursor?.style.background).toBe("");
        expect(cursor?.querySelector("svg")).not.toBeNull();
    });

    it("gives an agent it doesn't know its initial in the accent colour, and a nameless one an A", () => {
        show([
            note("a", human("Dom"), {
                thread: [reply("r1", agent("Robo")), reply("r2", agent())],
            } as Partial<Annotation>),
        ]);
        const [robo, nameless] = avatars(card(1));
        expect(robo?.className).toBe("av agent");
        expect(robo?.textContent).toBe("R");
        expect(nameless?.textContent).toBe("A");
        expect(robo?.querySelector("svg")).toBeNull();
    });

    it("never gives a person an agent's logo, even one called Claude", () => {
        show([
            note("a", human("Dom"), {
                thread: [reply("r1", human("Claude"))],
            } as Partial<Annotation>),
        ]);
        const [person] = avatars(card(1));
        expect(person?.className).toBe("av");
        expect(person?.textContent).toBe("C");
        expect(person?.style.background).toBe(painted(colorForName("Claude")));
    });
});

describe("the same person looks the same on the pin and on the card", () => {
    it("has the same colour for the same name", () => {
        show([note("a", human("Ada Lovelace")), note("b", human("Ana Lopez"))]);
        for (const [n, name] of [
            [1, "Ada Lovelace"],
            [2, "Ana Lopez"],
        ] as const) {
            const dot = card(n).querySelector<HTMLElement>(".who");
            expect(colour(n), name).toBe(colorForName(name));
            expect(dot?.style.background, name).toBe(painted(colour(n)));
            pinAt(n).click();
        }
    });

    it("has the same colour whichever note it is, and the same colour as every other note by that person", () => {
        show([note("a", human("Dom")), note("b", human("Ana")), note("c", human("Dom"))]);
        const first = card(1).querySelector<HTMLElement>(".who")?.style.background;
        pinAt(1).click();
        const third = card(3).querySelector<HTMLElement>(".who")?.style.background;
        expect(third).toBe(first);
        expect(colour(1)).toBe(colour(3));
    });

    it("is the colour that the settings give that name, with nothing to configure", () => {
        show([note("a", human("Ana")), note("b", human("Dom"))]);
        expect(colour(1)).toBe(colorForName("Ana"));
        expect(colorForName("Ana")).toBe(colorForName("Ana"));
    });
});
