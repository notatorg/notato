// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createVariants } from "../src/ui/variants.ts";
import {
    deferred,
    display,
    frame,
    layer,
    make,
    offer,
    onChoose,
    pills,
    setAnnotations,
    styleTags,
    styleText,
    tabName,
    tabs,
    use,
    useVariantsPage,
    version,
    versions,
} from "./support/variants.ts";

const GROUP = "data-notato-variant";
const NAME = "data-notato-variant-name";

useVariantsPage();

describe("finding the versions of a group", () => {
    it("ignores a group that has one version: no rule, no switcher, not listed", () => {
        version("header", "Original");
        const v = make();
        expect(v.list()).toEqual([]);
        expect(styleTags()).toHaveLength(0);
        expect(pills()).toHaveLength(0);
    });

    it("counts elements that share a name as one version", () => {
        versions("header", "Original", "Original");
        expect(make().list()).toEqual([]);

        const [a1, a2, b] = [
            version("cta", "Original"),
            version("cta", "Original"),
            version("cta", "Stacked"),
        ];
        const v = make();
        expect(v.list()[0]?.options).toEqual(["Original", "Stacked"]);
        v.select("cta", "Stacked");
        expect([a1, a2, b].map(display)).toEqual(["none", "none", "block"]);
        v.select("cta", "Original");
        expect([a1, a2, b].map(display)).toEqual(["block", "block", "none"]);
    });

    it("gives an element with no name an Option N name, and writes it on the element", () => {
        const [original, second, third, blank] = [
            version("header", "Original"),
            version("header"),
            version("header"),
            version("header", "   "),
        ];
        const v = make();
        expect(v.list()[0]?.options).toEqual(["Original", "Option 2", "Option 3", "Option 4"]);
        expect(original.getAttribute(NAME)).toBe("Original");
        expect(second.getAttribute(NAME)).toBe("Option 2");
        expect(third.getAttribute(NAME)).toBe("Option 3");
        expect(blank.getAttribute(NAME)).toBe("Option 4");

        // written so the rule that hides it can address it
        v.select("header", "Option 3");
        expect([original, second, third, blank].map(display)).toEqual([
            "none",
            "none",
            "block",
            "none",
        ]);
    });

    it("ignores an element whose group is empty", () => {
        version("", "A");
        version("  ", "B");
        expect(make().list()).toEqual([]);
    });

    it("keeps groups apart, in the order they first appear in the page", () => {
        version("footer", "Original");
        version("header", "Original");
        version("footer", "Wide");
        version("header", "Stacked");
        expect(
            make()
                .list()
                .map((g) => [g.group, g.options])
        ).toEqual([
            ["footer", ["Original", "Wide"]],
            ["header", ["Original", "Stacked"]],
        ]);
    });
});

describe("the rule that hides the versions that are not shown", () => {
    it("is one sheet on the document that hides everything in the group but the shown version", () => {
        const [original, stacked, wide] = versions("header", "Original", "Stacked", "Wide");
        const other = version("footer", "Only");
        make();

        expect(styleTags()).toHaveLength(1);
        expect(styleText()).toContain(`[${GROUP}="header"]:not([${NAME}="Original"])`);
        expect(styleText()).toContain("display:none");
        expect(styleText()).not.toContain("Stacked");
        // happy-dom evaluates it, so the effect can be checked as well as the text
        expect([original, stacked, wide].map(display)).toEqual(["block", "none", "none"]);
        expect(display(other)).toBe("block");
    });

    it("moves to the version that is selected", () => {
        const [original, stacked, wide] = versions("header", "Original", "Stacked", "Wide");
        const v = make();
        v.select("header", "Wide");
        expect(styleText()).toContain(`:not([${NAME}="Wide"])`);
        expect([original, stacked, wide].map(display)).toEqual(["none", "none", "block"]);
    });

    it("keeps a rule for each group in the same style element", () => {
        const [a, b] = versions("header", "Original", "Stacked");
        const [c, d] = versions("footer", "Original", "Wide");
        make();
        expect(styleTags()).toHaveLength(1);
        expect(styleText()).toContain(`[${GROUP}="header"]`);
        expect(styleText()).toContain(`[${GROUP}="footer"]`);
        expect([a, b, c, d].map(display)).toEqual(["block", "none", "block", "none"]);
    });

    it("escapes quotes, backslashes and line breaks in names and groups so the selector stays valid", () => {
        const group = String.raw`we"ird\group`;
        const quoted = String.raw`He said "hi" \ bye`;
        const lines = "two\nlines";
        for (const name of ["Original", quoted, lines]) version(group, name);
        const v = make();
        expect(styleText()).toContain(String.raw`[${GROUP}="we\"ird\\group"]`);

        // happy-dom neither parses nor applies a selector with an escaped quote in it, which browsers do, so the effect
        // cannot be checked here. The rule is read back the way a CSS parser reads a string and has to say what was meant.
        const readRule = () => {
            const match = styleText().match(
                /^\[[\w-]+="((?:[^"\\]|\\.)*)"\]:not\(\[[\w-]+="((?:[^"\\]|\\.)*)"\]\)\{/
            );
            const decode = (s = "") =>
                s.replace(/\\([0-9a-f]{1,6} ?|.)/gi, (_, e: string) =>
                    /^[0-9a-f]/i.test(e) ? String.fromCodePoint(Number.parseInt(e, 16)) : e
                );
            return { group: decode(match?.[1]), hides: decode(match?.[2]) };
        };
        expect(readRule()).toEqual({ group, hides: "Original" });

        v.select(group, quoted);
        expect(readRule()).toEqual({ group, hides: quoted });
        expect(styleText()).toContain(String.raw`[${NAME}="He said \"hi\" \\ bye"]`);
        v.select(group, lines);
        expect(readRule()).toEqual({ group, hides: lines });
        expect(styleText()).toContain(String.raw`[${NAME}="two\a lines"]`);
    });

    it("rewrites the rule only when what it says changes", () => {
        versions("header", "Original", "Stacked");
        const v = make();
        const sheets = [...document.adoptedStyleSheets];
        expect(sheets).toHaveLength(1);
        v.update();
        v.update();
        expect(document.adoptedStyleSheets).toEqual(sheets); // the same sheet, untouched

        v.select("header", "Stacked");
        expect(styleTags()).toHaveLength(1);
        expect(styleText()).toContain(`"Stacked"`);
    });

    it("covers an element added later with the same markers, without another update", () => {
        versions("header", "Original", "Stacked");
        make();
        const rule = styleText();

        const lateStacked = version("header", "Stacked");
        const lateOriginal = version("header", "Original");
        expect(styleText()).toBe(rule);
        expect([lateStacked, lateOriginal].map(display)).toEqual(["none", "block"]);
    });

    it("is joined by a rule for a group that appears later, at the next update", () => {
        versions("header", "Original", "Stacked");
        const v = make();
        const [a, b] = versions("footer", "Original", "Wide");
        expect(display(b)).toBe("block"); // nothing has looked yet
        expect(pills()).toHaveLength(1);

        v.update();
        expect(pills()).toHaveLength(2);
        expect(v.list().map((g) => g.group)).toEqual(["header", "footer"]);
        expect(styleText()).toContain(`[${GROUP}="footer"]`);
        expect([a, b].map(display)).toEqual(["block", "none"]);
    });

    it("also picks up a new version of a group that is already there", () => {
        versions("header", "Original", "Stacked");
        const v = make();
        version("header", "Wide");
        v.update();
        expect(v.list()[0]?.options).toEqual(["Original", "Stacked", "Wide"]);
        expect(tabs().map(tabName)).toEqual(["Original", "Stacked", "Wide"]);
    });

    describe("when the markers go away", () => {
        it.each([
            [
                "the elements are removed",
                (els: HTMLElement[]) => {
                    for (const e of els) e.remove();
                },
            ],
            [
                "the attributes are removed",
                (els: HTMLElement[]) => {
                    for (const e of els) e.removeAttribute(GROUP);
                },
            ],
        ])("leaves no style and no switcher when %s", (_, remove) => {
            const els = versions("header", "Original", "Stacked");
            const v = make();
            expect(styleTags()).toHaveLength(1);
            expect(pills()).toHaveLength(1);
            remove(els);
            v.update();
            expect(styleTags()).toHaveLength(0);
            expect(pills()).toHaveLength(0);
            expect(v.list()).toEqual([]);
        });

        it("does the same when only one version is left, which is no longer a choice", () => {
            const [, stacked] = versions("header", "Original", "Stacked");
            const v = make();
            stacked.remove();
            v.update();
            expect(styleTags()).toHaveLength(0);
            expect(pills()).toHaveLength(0);
        });

        it("takes away only the switcher of the group that went", () => {
            const header = versions("header", "Original", "Stacked");
            versions("footer", "Original", "Wide");
            const v = make();
            for (const el of header) el.remove();
            v.update();
            expect(pills().map((p) => p.getAttribute("aria-label"))).toEqual([
                "Variants of footer",
            ]);
            expect(styleText()).not.toContain("header");
            expect(styleText()).toContain("footer");
        });
    });

    describe("destroy", () => {
        it("removes the style and the switchers even while the markers are still in the page", () => {
            const [, stacked] = versions("header", "Original", "Stacked");
            versions("footer", "Original", "Wide");
            const v = make();
            v.destroy();
            expect(styleTags()).toHaveLength(0);
            expect(pills()).toHaveLength(0);
            expect(layer.children).toHaveLength(0);
            expect(display(stacked)).toBe("block"); // nothing hides it any more
            expect(v.list()).toEqual([]);
        });

        it("does not redraw from a frame that was waiting when it was destroyed", async () => {
            versions("header", "Original", "Stacked");
            const v = make();
            v.schedule();
            v.destroy();
            await frame();
            expect(styleTags()).toHaveLength(0);
            expect(pills()).toHaveLength(0);
        });

        it.each([
            ["succeeds", (p: ReturnType<typeof deferred>) => p.resolve()],
            [
                "fails",
                (p: ReturnType<typeof deferred>) =>
                    p.reject(new Error("Cannot reach the Notato server.")),
            ],
        ])("is not undone by a pick that %s after it", async (_, finish) => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header")]);
            const v = make();
            const pending = deferred();
            onChoose.mockReturnValueOnce(pending.promise);
            use()?.click();

            v.destroy();
            finish(pending);
            await vi.advanceTimersByTimeAsync(6000); // the frame it asks for, and the timer that clears an error
            expect(styleTags()).toHaveLength(0);
            expect(pills()).toHaveLength(0);
        });
    });

    it("schedule() redraws at the next frame, once however many times it is called", async () => {
        versions("header", "Original", "Stacked");
        const v = make();
        const [a, b] = versions("footer", "Original", "Wide");
        v.schedule();
        v.schedule();
        v.schedule();
        expect(pills()).toHaveLength(1);
        await frame();
        expect(pills()).toHaveLength(2);
        expect([a, b].map(display)).toEqual(["block", "none"]);
    });
});

describe("which version is shown to begin with", () => {
    /** What a previous visit left behind: another instance chose, then the page went away. */
    const earlierVisit = (group: string, name: string, namespace = "ns") => {
        const earlier = make({ namespace });
        expect(earlier.select(group, name)).toBe(true);
        earlier.destroy();
    };

    it("is the one shown last time for this namespace and group", () => {
        versions("header", "Original", "Stacked", "Wide");
        versions("footer", "Original", "Wide");
        earlierVisit("header", "Wide");

        const v = make();
        const active = (group: string) => v.list().find((g) => g.group === group)?.active;
        expect(active("header")).toBe("Wide");
        expect(active("footer")).toBe("Original");
        expect(make({ namespace: "another" }).list()[0]?.active).toBe("Original");
    });

    it("beats what the annotation says was picked, and beats Original", () => {
        versions("header", "Original", "Stacked", "Wide");
        earlierVisit("header", "Wide");
        setAnnotations([offer("header", { status: "variant_chosen", chosen: "Stacked" })]);
        expect(make().list()[0]?.active).toBe("Wide");
    });

    it("is otherwise the version the linked annotation says was picked", () => {
        versions("header", "Original", "Stacked", "Wide");
        setAnnotations([offer("header", { status: "variant_chosen", chosen: "Stacked" })]);
        const v = make();
        expect(v.list()[0]?.active).toBe("Stacked");
        expect(styleText()).toContain(`:not([${NAME}="Stacked"])`);
    });

    it.each(["Original", "original", "ORIGINAL"])(
        "is otherwise the one named %s, wherever it is",
        (name) => {
            versions("header", "Stacked", name, "Wide");
            expect(make().list()[0]?.active).toBe(name);
        }
    );

    it("is otherwise the first", () => {
        versions("header", "Stacked", "Wide", "Compact");
        expect(make().list()[0]?.active).toBe("Stacked");
    });

    it("does not use a remembered or picked name that is no longer in the page", () => {
        const [, , gone] = versions("header", "Stacked", "Original", "Gone");
        earlierVisit("header", "Gone");
        gone.remove();
        setAnnotations([offer("header", { status: "variant_chosen", chosen: "AlsoGone" })]);
        expect(make().list()[0]?.active).toBe("Original");
    });

    it("ignores an annotation that was offered for another group", () => {
        versions("header", "Original", "Stacked");
        setAnnotations([offer("footer", { status: "variant_chosen", chosen: "Stacked" })]);
        expect(make().list()[0]).toMatchObject({
            active: "Original",
            annotationId: undefined,
            chosen: undefined,
        });
    });

    it("keeps what is shown when an update looks again", () => {
        versions("header", "Stacked", "Original");
        const v = make();
        v.select("header", "Original");
        v.update();
        expect(v.list()[0]?.active).toBe("Original");
    });
});

describe("a name that is padded or too long", () => {
    it("is written back as it is used, so the rule still matches and the shown version is not hidden", () => {
        document.body.innerHTML = `
      <div id="a" data-notato-variant="pad" data-notato-variant-name="  Original  "></div>
      <div id="b" data-notato-variant="pad" data-notato-variant-name="${"x".repeat(60)}"></div>`;
        const layer = document.createElement("div");
        document.body.append(layer);
        const v = createVariants({
            layer,
            windows: () => [window],
            annotations: () => [],
            namespace: "pad",
        });
        v.update();
        expect(document.getElementById("a")?.getAttribute("data-notato-variant-name")).toBe(
            "Original"
        );
        expect(document.getElementById("b")?.getAttribute("data-notato-variant-name")).toBe(
            "x".repeat(40)
        );
        const rule = styleText();
        expect(rule).toContain('[data-notato-variant-name="Original"]');
        expect(
            document
                .getElementById("a")
                ?.matches(`[data-notato-variant="pad"]:not([data-notato-variant-name="Original"])`)
        ).toBe(false);
        v.destroy();
    });
});
