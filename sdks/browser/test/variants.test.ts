// @vitest-environment happy-dom
import { type Annotation, type Status, sampleAnnotation } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsIn } from "../src/ui/sheet.ts";
import {
    createVariants,
    VARIANTS_STYLE_MARKER,
    type Variants,
    type VariantsOptions,
} from "../src/ui/variants.ts";

const GROUP = "data-notato-variant";
const NAME = "data-notato-variant-name";
const STYLE = "style[data-notato-variants-style]";

let layer: HTMLElement;
let page: HTMLElement;
let annotations: Annotation[];
let onChoose: ReturnType<typeof vi.fn<NonNullable<VariantsOptions["onChoose"]>>>;
let created: Variants[];

beforeEach(() => {
    vi.useFakeTimers();
    layer = document.createElement("div");
    page = document.createElement("main");
    document.body.append(page, layer);
    annotations = [];
    onChoose = vi.fn(async () => {});
    created = [];
    window.sessionStorage.clear();
});
afterEach(() => {
    for (const v of created) v.destroy();
    for (const style of document.querySelectorAll(STYLE)) style.remove();
    document.adoptedStyleSheets = [];
    layer.remove();
    page.remove();
    window.sessionStorage.clear();
    vi.useRealTimers();
});

/** Variants over the page, already looked at once. `onChoose` is passed unless the test says `onChoose: undefined`. */
const make = (options: Partial<VariantsOptions> = {}): Variants => {
    const v = createVariants({
        layer,
        windows: () => [window],
        annotations: () => annotations,
        namespace: "ns",
        onChoose,
        ...options,
    });
    created.push(v);
    v.update();
    return v;
};

/** One element of a version. `name` left out means the element has no name attribute at all. */
const version = (group: string, name?: string, parent: Element = page): HTMLElement => {
    const el = document.createElement("div");
    el.setAttribute(GROUP, group);
    if (name !== undefined) el.setAttribute(NAME, name);
    parent.append(el);
    return el;
};
const versions = <N extends string[]>(group: string, ...names: N) =>
    names.map((name) => version(group, name)) as { [K in keyof N]: HTMLElement };

const offer = (
    group: string,
    extra: { id?: string; status?: Status; chosen?: string; offeredAt?: string } = {}
): Annotation => ({
    ...sampleAnnotation,
    id: extra.id ?? "a1",
    status: extra.status ?? "acknowledged",
    thread: [],
    variants: {
        group,
        options: [
            { name: "Original", summary: "As it is today" },
            { name: "Stacked", summary: "Logo above the links" },
        ],
        offeredAt: extra.offeredAt ?? "2026-10-05T10:00:00.000Z",
        chosen: extra.chosen,
    },
});

const display = (el: Element) => getComputedStyle(el).display;
/** The rules that hide what is not shown, however the browser took them (a constructed sheet, or a style element). */
const styleTags = () => sheetsIn(document, VARIANTS_STYLE_MARKER);
const styleText = () => styleTags()[0] ?? "";
const pills = () => [...layer.querySelectorAll<HTMLElement>(".vpill")];
const pill = () => pills()[0] as HTMLElement;
const tabs = () => [...layer.querySelectorAll<HTMLButtonElement>(".vopt")];
const tabName = (tab: Element) => tab.firstChild?.textContent;
const tab = (name: string) => tabs().find((t) => tabName(t) === name) as HTMLButtonElement;
const selectedTabs = () =>
    tabs()
        .filter((t) => t.getAttribute("aria-selected") === "true")
        .map(tabName);
const button = (label: string) =>
    [...layer.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as
        | HTMLButtonElement
        | undefined;
const use = () => button("Use “");
const takeBack = () => button("Take back");
const state = () => layer.querySelector(".vstate")?.textContent;
const deferred = () => {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};
/** Lets promises settle and the frame the switcher redraws in go by. */
const frame = () => vi.advanceTimersByTimeAsync(20);

/** Pretends the browser laid `el` out here; elements in happy-dom have no size of their own. */
const lay = (el: Element, left: number, top: number, width: number, height: number) => {
    el.getBoundingClientRect = () =>
        ({
            left,
            top,
            width,
            height,
            right: left + width,
            bottom: top + height,
            x: left,
            y: top,
        }) as DOMRect;
};

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
            annotations = [offer("header")];
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
        annotations = [offer("header", { status: "variant_chosen", chosen: "Stacked" })];
        expect(make().list()[0]?.active).toBe("Wide");
    });

    it("is otherwise the version the linked annotation says was picked", () => {
        versions("header", "Original", "Stacked", "Wide");
        annotations = [offer("header", { status: "variant_chosen", chosen: "Stacked" })];
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
        annotations = [offer("header", { status: "variant_chosen", chosen: "AlsoGone" })];
        expect(make().list()[0]?.active).toBe("Original");
    });

    it("ignores an annotation that was offered for another group", () => {
        versions("header", "Original", "Stacked");
        annotations = [offer("footer", { status: "variant_chosen", chosen: "Stacked" })];
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

describe("select", () => {
    it("shows the version, hides the others and redraws the switcher at once", () => {
        const [a, b] = versions("header", "Original", "Stacked");
        const v = make();
        expect(selectedTabs()).toEqual(["Original"]);
        expect(v.select("header", "Stacked")).toBe(true);
        expect([a, b].map(display)).toEqual(["none", "block"]);
        expect(selectedTabs()).toEqual(["Stacked"]);
        expect(v.list()[0]?.active).toBe("Stacked");
    });

    it("remembers it for a later visit", () => {
        versions("header", "Original", "Stacked");
        make().select("header", "Stacked");
        expect(make().list()[0]?.active).toBe("Stacked");
    });

    it("returns false for a group or a version that is not there, and changes nothing", () => {
        versions("header", "Original", "Stacked");
        const v = make();
        const before = styleText();
        expect(v.select("nope", "Stacked")).toBe(false);
        expect(v.select("header", "Nope")).toBe(false);
        expect(v.select("header", "stacked")).toBe(false); // names are exact
        expect(styleText()).toBe(before);
        expect(v.list()[0]?.active).toBe("Original");
        expect(make().list()[0]?.active).toBe("Original"); // and nothing was remembered
    });
});

describe("list", () => {
    it("reports each group with its versions in page order and the one shown", () => {
        versions("header", "Original", "Wide", "Stacked");
        versions("footer", "Original", "Compact");
        expect(make().list()).toEqual([
            { group: "header", options: ["Original", "Wide", "Stacked"], active: "Original" },
            { group: "footer", options: ["Original", "Compact"], active: "Original" },
        ]);
    });

    it("adds the annotation it was offered for, and what was picked on it", () => {
        versions("header", "Original", "Stacked");
        annotations = [
            offer("header", { id: "01JANNOTATION", status: "variant_chosen", chosen: "Stacked" }),
        ];
        expect(make().list()).toEqual([
            {
                group: "header",
                options: ["Original", "Stacked"],
                active: "Stacked",
                annotationId: "01JANNOTATION",
                chosen: "Stacked",
            },
        ]);
    });

    it("links an annotation that was offered but not picked from yet, with nothing chosen", () => {
        versions("header", "Original", "Stacked");
        annotations = [offer("header", { id: "a9" })];
        expect(make().list()[0]).toMatchObject({ annotationId: "a9", chosen: undefined });
    });

    it("takes the newest offer when several annotations were offered for the same group", () => {
        versions("header", "Original", "Stacked");
        const older = offer("header", {
            id: "older",
            status: "variant_chosen",
            chosen: "Stacked",
            offeredAt: "2026-10-01T09:00:00.000Z",
        });
        const newer = offer("header", { id: "newer", offeredAt: "2026-10-04T09:00:00.000Z" });
        for (const order of [
            [older, newer],
            [newer, older],
        ]) {
            annotations = order;
            const v = make();
            expect(v.list()[0], order.map((a) => a.id).join()).toMatchObject({
                annotationId: "newer",
                chosen: undefined,
                active: "Original",
            });
            v.destroy();
        }
    });

    it("follows the annotations as they change", () => {
        versions("header", "Original", "Stacked");
        const v = make();
        expect(v.list()[0]?.annotationId).toBeUndefined();
        annotations = [offer("header", { id: "late" })];
        expect(v.list()[0]?.annotationId).toBe("late");
    });
});

describe("step", () => {
    it("goes to the next version and wraps round at the end", () => {
        versions("header", "Original", "A", "B");
        const v = make();
        expect(v.step(1)?.active).toBe("A");
        expect(v.step(1)?.active).toBe("B");
        expect(v.step(1)?.active).toBe("Original");
    });

    it("goes to the previous version and wraps round at the start", () => {
        versions("header", "Original", "A", "B");
        const v = make();
        expect(v.step(-1)?.active).toBe("B");
        expect(v.step(-1)?.active).toBe("A");
        expect(v.step(-1)?.active).toBe("Original");
    });

    it("shows what it steps to, and returns the group as it is now", () => {
        const [a, b] = versions("header", "Original", "A");
        const v = make();
        expect(v.step(1)).toEqual({ group: "header", options: ["Original", "A"], active: "A" });
        expect([a, b].map(display)).toEqual(["none", "block"]);
    });

    it("acts on the first group when none has been used", () => {
        versions("header", "Original", "A");
        versions("footer", "Original", "B");
        expect(make().step(1)?.group).toBe("header");
    });

    it("acts on the group last used, by select or by a click on its switcher", () => {
        versions("header", "Original", "A");
        versions("footer", "Original", "B", "C");
        const v = make();
        v.select("footer", "B");
        expect(v.step(1)).toMatchObject({ group: "footer", active: "C" });

        v.select("header", "A");
        expect(v.step(1)).toMatchObject({ group: "header", active: "Original" });

        const footerTab = layer
            .querySelectorAll(".vpill")[1]
            ?.querySelector(".vopt") as HTMLElement;
        footerTab.click(); // "Original" in the footer's switcher
        expect(v.step(1)).toMatchObject({ group: "footer", active: "B" });
    });

    it("acts on the group it is told to, and then that is the one last used", () => {
        versions("header", "Original", "A");
        versions("footer", "Original", "B");
        const v = make();
        expect(v.step(1, "footer")).toMatchObject({ group: "footer", active: "B" });
        expect(v.step(1)).toMatchObject({ group: "footer", active: "Original" });
    });

    it("returns null when there is nothing to step through", () => {
        version("header", "Original");
        expect(make().step(1)).toBeNull();
    });
});

describe("the switcher", () => {
    it("is one pill for each group, in the layer", () => {
        versions("header", "Original", "Stacked");
        versions("footer", "Original", "Wide");
        make();
        expect(pills().map((p) => p.parentElement)).toEqual([layer, layer]);
        expect(pills().map((p) => p.getAttribute("aria-label"))).toEqual([
            "Variants of header",
            "Variants of footer",
        ]);
    });

    it("has a tab for each version, with the shown one selected", () => {
        versions("header", "Original", "Stacked", "Wide");
        annotations = [offer("header", { status: "variant_chosen", chosen: "Stacked" })];
        make();
        expect(tabs().map(tabName)).toEqual(["Original", "Stacked", "Wide"]);
        expect(tabs().every((t) => t.getAttribute("role") === "tab")).toBe(true);
        expect(selectedTabs()).toEqual(["Stacked"]);
    });

    it("shows a version when its tab is clicked", () => {
        const [a, b, c] = versions("header", "Original", "Stacked", "Wide");
        const v = make();
        tab("Wide").click();
        expect(selectedTabs()).toEqual(["Wide"]);
        expect(v.list()[0]?.active).toBe("Wide");
        expect([a, b, c].map(display)).toEqual(["none", "none", "block"]);
        tab("Original").click();
        expect(selectedTabs()).toEqual(["Original"]);
        expect([a, b, c].map(display)).toEqual(["block", "none", "none"]);
    });

    it("titles a tab with what the agent said about the version, or else its name", () => {
        versions("header", "Original", "Stacked", "Wide");
        annotations = [offer("header")];
        make();
        expect(tab("Original").title).toBe("As it is today");
        expect(tab("Stacked").title).toBe("Logo above the links");
        expect(tab("Wide").title).toBe("Wide");
    });

    it("does not rebuild itself for an update that changes nothing it shows", () => {
        versions("header", "Original", "Stacked");
        annotations = [offer("header")];
        const v = make();
        const [stacked, useButton] = [tab("Stacked"), use()];
        v.update();
        expect(tab("Stacked")).toBe(stacked);
        expect(use()).toBe(useButton);
    });

    it("follows the annotation when the server changes it", () => {
        versions("header", "Original", "Stacked");
        annotations = [offer("header")];
        const v = make();
        expect(state()).toBeUndefined();
        annotations = [offer("header", { status: "variant_chosen", chosen: "Stacked" })];
        v.update();
        expect(state()).toBe("Picked “Stacked”.");
    });

    describe("Use", () => {
        it("is offered for the shown version once the agent has offered the versions", () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header")];
            make();
            expect(use()?.textContent).toBe("Use “Original”");
            tab("Stacked").click();
            expect(use()?.textContent).toBe("Use “Stacked”");
        });

        it("is offered while a pick is still up to the person, and after one has been made", () => {
            versions("header", "Original", "Stacked");
            for (const status of ["acknowledged", "variant_chosen"] as const) {
                annotations = [
                    offer("header", {
                        status,
                        chosen: status === "variant_chosen" ? "Stacked" : undefined,
                    }),
                ];
                const v = make();
                tab("Original").click(); // not the picked one, if there is one
                expect(use(), status).toBeDefined();
                v.destroy();
            }
        });

        it.each(["open", "resolved", "revert_requested", "reverted", "dismissed"] as const)(
            "is not offered when the annotation is %s",
            (status) => {
                versions("header", "Original", "Stacked");
                annotations = [offer("header", { status })];
                make();
                expect(use()).toBeUndefined();
                expect(takeBack()).toBeUndefined();
            }
        );

        it("is not offered when nothing can send the pick", () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header")];
            make({ onChoose: undefined });
            expect(use()).toBeUndefined();
            expect(tabs()).toHaveLength(2); // it still previews
        });

        it("is not offered for the version that is already the pick", () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header", { status: "variant_chosen", chosen: "Stacked" })];
            make();
            expect(selectedTabs()).toEqual(["Stacked"]);
            expect(use()).toBeUndefined();

            tab("Original").click();
            expect(use()?.textContent).toBe("Use “Original”");
            tab("Stacked").click();
            expect(use()).toBeUndefined();
        });

        it("shortens a long version name on the button", () => {
            versions("header", "Original", "A really long version name");
            annotations = [offer("header")];
            make();
            tab("A really long version name").click();
            expect(use()?.textContent).toBe("Use “A really long ver…”");
        });

        it("sends the annotation and the version, and is disabled until that is done", async () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header", { id: "a7" })];
            make();
            tab("Stacked").click();
            const pending = deferred();
            onChoose.mockReturnValueOnce(pending.promise);

            use()?.click();
            expect(onChoose).toHaveBeenCalledExactlyOnceWith("a7", "Stacked");
            expect(use()?.disabled).toBe(true);
            use()?.click();
            expect(onChoose).toHaveBeenCalledTimes(1);

            pending.resolve();
            await frame();
            expect(use()?.disabled).toBe(false);
            expect(layer.querySelector(".verr")).toBeNull();
        });

        it("shows why it failed, and takes the message away after five seconds", async () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header")];
            make();
            onChoose.mockRejectedValueOnce(new Error("Cannot reach the Notato server."));

            use()?.click();
            await frame();
            const error = layer.querySelector(".verr");
            expect(error?.textContent).toBe("Cannot reach the Notato server.");
            expect(error?.getAttribute("role")).toBe("alert");
            expect(use()?.disabled).toBe(false); // it can be tried again

            await vi.advanceTimersByTimeAsync(4800);
            expect(layer.querySelector(".verr")?.textContent).toBe(
                "Cannot reach the Notato server."
            );
            await vi.advanceTimersByTimeAsync(400);
            expect(layer.querySelector(".verr")).toBeNull();
        });

        it("shows a rejection that is not an Error as it is", async () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header")];
            make();
            onChoose.mockRejectedValueOnce("offline");
            use()?.click();
            await frame();
            expect(layer.querySelector(".verr")?.textContent).toBe("offline");
        });

        it("starts the five seconds again when a later attempt fails", async () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header")];
            make();
            onChoose
                .mockRejectedValueOnce(new Error("first"))
                .mockRejectedValueOnce(new Error("second"));
            use()?.click();
            await frame();
            await vi.advanceTimersByTimeAsync(3000);
            use()?.click();
            await frame();
            expect(layer.querySelector(".verr")?.textContent).toBe("second");
            await vi.advanceTimersByTimeAsync(3000); // past the first one's five seconds
            expect(layer.querySelector(".verr")?.textContent).toBe("second");
            await vi.advanceTimersByTimeAsync(2100);
            expect(layer.querySelector(".verr")).toBeNull();
        });
    });

    describe("after a pick", () => {
        it("says what was picked, and that the agent is applying it when that is the version shown", () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header", { status: "variant_chosen", chosen: "Stacked" })];
            make();
            expect(state()).toBe("Picked. The agent is applying “Stacked”.");
            tab("Original").click();
            expect(state()).toBe("Picked “Stacked”.");
        });

        it("offers Take back, which sends null for the annotation", async () => {
            versions("header", "Original", "Stacked");
            annotations = [
                offer("header", { id: "a3", status: "variant_chosen", chosen: "Stacked" }),
            ];
            make();
            const pending = deferred();
            onChoose.mockReturnValueOnce(pending.promise);

            takeBack()?.click();
            expect(onChoose).toHaveBeenCalledExactlyOnceWith("a3", null);
            expect(takeBack()?.disabled).toBe(true);
            pending.resolve();
            await frame();
            expect(takeBack()?.disabled).toBe(false);
        });

        it("shows why a Take back failed", async () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header", { status: "variant_chosen", chosen: "Stacked" })];
            make();
            onChoose.mockRejectedValueOnce(new Error("Already applied."));
            takeBack()?.click();
            await frame();
            expect(layer.querySelector(".verr")?.textContent).toBe("Already applied.");
        });

        it("still says it, with no Take back, when nothing can send it", () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header", { status: "variant_chosen", chosen: "Stacked" })];
            make({ onChoose: undefined });
            expect(state()).toBe("Picked. The agent is applying “Stacked”.");
            expect(takeBack()).toBeUndefined();
            expect(use()).toBeUndefined();
        });

        it("does not say it before there is a pick", () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header")];
            make();
            expect(state()).toBeUndefined();
            expect(takeBack()).toBeUndefined();
        });

        it("marks the version that was picked with a tick, and only that tab", () => {
            versions("header", "Original", "Stacked", "Wide");
            annotations = [offer("header", { status: "variant_chosen", chosen: "Stacked" })];
            make();
            const ticked = tabs().filter((t) => t.querySelector(".vmark"));
            expect(ticked.map(tabName)).toEqual(["Stacked"]);
            expect(ticked[0]?.querySelector(".vmark")?.textContent).toContain("✓");
            expect(ticked[0]?.querySelector(".vmark")?.getAttribute("aria-label")).toBe("picked");
        });

        it("marks no tab before a pick", () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header")];
            make();
            expect(layer.querySelector(".vmark")).toBeNull();
        });
    });

    describe("with no annotation for the group", () => {
        it("says Preview, and offers no way to pick", () => {
            versions("header", "Original", "Stacked");
            make();
            expect(state()).toBe("Preview");
            expect(use()).toBeUndefined();
            expect(takeBack()).toBeUndefined();
            expect(tabs()).toHaveLength(2);
        });

        it("says it for a group whose annotation was offered for another group", () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("footer")];
            make();
            expect(state()).toBe("Preview");
        });

        it("does not say it once there is an annotation", () => {
            versions("header", "Original", "Stacked");
            annotations = [offer("header")];
            make();
            expect(layer.textContent).not.toContain("Preview");
        });
    });
});

describe("where a version is on screen", () => {
    describe("anchor", () => {
        it("is the top-left corner of the area the shown version takes up", () => {
            const [a1, a2, b] = [
                version("header", "Original"),
                version("header", "Original"),
                version("header", "Stacked"),
            ];
            lay(a1, 100, 50, 200, 40);
            lay(a2, 80, 120, 300, 30);
            lay(b, 10, 15, 400, 100);
            const v = make();
            expect(v.anchor("header")).toEqual({ left: 80, top: 50 });
        });

        it("follows the version that is shown, not the hidden ones", () => {
            const [a, b] = versions("header", "Original", "Stacked");
            lay(a, 100, 50, 200, 40);
            lay(b, 10, 15, 400, 100);
            const v = make();
            v.select("header", "Stacked");
            expect(v.anchor("header")).toEqual({ left: 10, top: 15 });
        });

        it("uses the children of a wrapper with display: contents, which has no area of its own", () => {
            const wrapper = version("header", "Original");
            wrapper.style.display = "contents";
            lay(wrapper, 0, 0, 0, 0);
            const first = document.createElement("p");
            const second = document.createElement("p");
            wrapper.append(first, second);
            lay(first, 40, 200, 100, 20);
            lay(second, 60, 180, 50, 50);
            version("header", "Stacked");
            expect(make().anchor("header")).toEqual({ left: 40, top: 180 });
        });

        it("looks through wrappers inside wrappers", () => {
            const outer = version("header", "Original");
            const inner = document.createElement("div");
            const leaf = document.createElement("p");
            outer.append(inner);
            inner.append(leaf);
            lay(leaf, 25, 75, 100, 20);
            version("header", "Stacked");
            expect(make().anchor("header")).toEqual({ left: 25, top: 75 });
        });

        it("takes a wrapper's own area when it has one, whatever is inside", () => {
            const box = version("header", "Original");
            const child = document.createElement("p");
            box.append(child);
            lay(box, 100, 100, 300, 60);
            lay(child, 5, 5, 10, 10);
            version("header", "Stacked");
            expect(make().anchor("header")).toEqual({ left: 100, top: 100 });
        });

        it("is null when the shown version takes up no area, even if a hidden one does", () => {
            const [, b] = versions("header", "Original", "Stacked");
            lay(b, 10, 15, 400, 100);
            expect(make().anchor("header")).toBeNull();
        });

        it("is null for a group that is not there", () => {
            versions("header", "Original", "Stacked");
            expect(make().anchor("nope")).toBeNull();
        });
    });

    describe("placement of the switcher", () => {
        const view = { w: window.innerWidth, h: window.innerHeight };
        beforeEach(() => Object.assign(window, { innerWidth: 1000, innerHeight: 700 }));
        afterEach(() => Object.assign(window, { innerWidth: view.w, innerHeight: view.h }));

        const shownAt = (left: number, top: number, width: number, height: number) => {
            const [a] = versions("header", "Original", "Stacked");
            lay(a as HTMLElement, left, top, width, height);
            return make();
        };

        it("sits above the shown version, past where a pin would be", () => {
            shownAt(200, 100, 300, 50);
            expect(pill().style.display).toBe("flex");
            expect(pill().style.left).toBe("234px");
            expect(pill().style.top).toBe("60px");
        });

        it("sits over the top edge when there is no room above, so it stays reachable", () => {
            shownAt(200, 10, 300, 50);
            expect(pill().style.top).toBe("18px");
        });

        it("stays inside the right edge of the viewport", () => {
            shownAt(950, 100, 300, 50);
            expect(pill().style.left).toBe("732px"); // 1000 less the pill's 260 (happy-dom has no width) and a margin of 8
        });

        it.each([
            ["above the viewport", 100, -100, 300, 40],
            ["below it", 100, 800, 300, 40],
            ["left of it", -400, 100, 100, 40],
            ["right of it", 1200, 100, 300, 40],
        ])("is hidden when the shown version is entirely %s", (_, left, top, width, height) => {
            const v = shownAt(left, top, width, height);
            expect(pill().style.display).toBe("none");
            expect(v.anchor("header")).not.toBeNull(); // it has an area, just not one on screen
        });

        it("is shown when only part of the version is on screen", () => {
            shownAt(-200, -20, 300, 100);
            expect(pill().style.display).toBe("flex");
        });

        it("is hidden when the shown version takes up no area", () => {
            versions("header", "Original", "Stacked");
            make();
            expect(pill().style.display).toBe("none");
        });

        it("comes back at the next update once the version is on screen", () => {
            const [a] = versions("header", "Original", "Stacked");
            lay(a as HTMLElement, 100, 900, 300, 40);
            const v = make();
            expect(pill().style.display).toBe("none");
            lay(a as HTMLElement, 100, 300, 300, 40);
            v.update();
            expect(pill().style.display).toBe("flex");
            expect(pill().style.top).toBe("260px");
        });

        it("moves with the version that is shown", () => {
            const [a, b] = versions("header", "Original", "Stacked");
            lay(a as HTMLElement, 100, 300, 300, 40);
            lay(b as HTMLElement, 500, 500, 300, 40);
            const v = make();
            expect(pill().style.left).toBe("134px");
            v.select("header", "Stacked");
            expect(pill().style.left).toBe("534px");
            expect(pill().style.top).toBe("460px");
        });
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
