// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
    display,
    layer,
    make,
    offer,
    selectedTabs,
    setAnnotations,
    styleText,
    useVariantsPage,
    version,
    versions,
} from "./support/variants.ts";

useVariantsPage();

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
        setAnnotations([
            offer("header", { id: "01JANNOTATION", status: "variant_chosen", chosen: "Stacked" }),
        ]);
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
        setAnnotations([offer("header", { id: "a9" })]);
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
            setAnnotations(order);
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
        setAnnotations([offer("header", { id: "late" })]);
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
