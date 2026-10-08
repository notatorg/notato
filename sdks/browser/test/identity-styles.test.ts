// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { computedStylesOf, stylesIdentityPlugin, toHex } from "../src/plugins/identity-styles.ts";

afterEach(() => {
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
});

/** An element with these inline styles, in the page. */
const styled = (css: string) => {
    const el = document.createElement("div");
    el.style.cssText = css;
    document.body.append(el);
    return el;
};

describe("toHex", () => {
    it("turns computed rgb colours into hex", () => {
        expect(toHex("rgb(255, 0, 0)")).toBe("#ff0000");
        expect(toHex("rgb(1, 2, 3)")).toBe("#010203");
        expect(toHex("rgb(0 128 255)")).toBe("#0080ff");
    });

    it("adds the alpha as a fourth pair when it is not opaque", () => {
        expect(toHex("rgba(0, 128, 255, 0.5)")).toBe("#0080ff80");
        expect(toHex("rgb(255 0 0 / 0.25)")).toBe("#ff000040");
        expect(toHex("rgba(0, 0, 0, 0)")).toBe("#00000000");
    });

    it("leaves out the alpha when it is opaque", () => {
        expect(toHex("rgba(10, 20, 30, 1)")).toBe("#0a141e");
    });

    it("leaves anything that is not rgb as it was", () => {
        for (const value of [
            "red",
            "transparent",
            "#abc",
            "oklch(0.7 0.1 200)",
            "linear-gradient(red, blue)",
            "",
        ])
            expect(toHex(value)).toBe(value);
    });
});

describe("computedStylesOf", () => {
    it("reports colours as hex", () => {
        const styles = computedStylesOf(
            styled("color: rgb(255, 0, 0); background-color: rgb(0, 0, 255)")
        );
        expect(styles).toMatchObject({ color: "#ff0000", "background-color": "#0000ff" });
    });

    it("reports type, size and layout as they are computed", () => {
        const styles = computedStylesOf(
            styled(
                "font-size: 18px; font-weight: 700; width: 120px; height: 40px; display: inline-block; opacity: 0.5"
            )
        );
        expect(styles).toMatchObject({
            "font-size": "18px",
            "font-weight": "700",
            width: "120px",
            height: "40px",
            display: "inline-block",
            opacity: "0.5",
        });
    });

    it("never includes the cursor", () => {
        const styles = computedStylesOf(styled("cursor: pointer; color: rgb(0, 0, 0)"));
        expect(styles).toBeDefined();
        expect(styles).not.toHaveProperty("cursor");
        expect(Object.values(styles ?? {})).not.toContain("pointer");
    });

    it("leaves out what is only the default", () => {
        const styles = computedStylesOf(
            styled(
                [
                    "background-color: rgba(0, 0, 0, 0)",
                    "position: static",
                    "opacity: 1",
                    "z-index: auto",
                    "margin: 0px",
                    "padding: 0px",
                    "border-radius: 0px",
                    "box-shadow: none",
                    "text-transform: none",
                    "overflow: visible",
                    "letter-spacing: normal",
                    "border: 0px none rgb(0, 0, 0)",
                ].join(";")
            )
        );
        for (const quiet of [
            "background-color",
            "position",
            "opacity",
            "z-index",
            "margin",
            "padding",
            "border-radius",
            "box-shadow",
            "text-transform",
            "overflow",
            "letter-spacing",
            "border",
        ])
            expect(styles).not.toHaveProperty(quiet);
    });

    // A browser computes "no background" as rgba(0, 0, 0, 0), which toHex turns into #00000000: it must still count as none.
    it("does not report a transparent background, however it is spelled", () => {
        for (const none of ["rgba(0, 0, 0, 0)", "transparent", "rgb(0 0 0 / 0)"])
            expect(computedStylesOf(styled(`background-color: ${none}`))).not.toHaveProperty(
                "background-color"
            );
        expect(computedStylesOf(styled("background-color: rgba(0, 0, 0, 0.5)"))).toHaveProperty(
            "background-color",
            "#00000080"
        );
    });

    it("keeps the same properties once they are set to something", () => {
        const styles = computedStylesOf(
            styled(
                "position: absolute; z-index: 10; border-radius: 8px; text-transform: uppercase; overflow: hidden; letter-spacing: 2px; box-shadow: 0 1px 2px rgb(0, 0, 0)"
            )
        );
        expect(styles).toMatchObject({
            position: "absolute",
            "z-index": "10",
            "border-radius": "8px",
            "text-transform": "uppercase",
            overflow: "hidden",
            "letter-spacing": "2px",
        });
        expect(styles?.["box-shadow"]).toContain("1px");
    });

    it("writes margin and padding as the shortest shorthand", () => {
        expect(computedStylesOf(styled("margin: 8px; padding: 4px 16px"))).toMatchObject({
            margin: "8px",
            padding: "4px 16px",
        });
        expect(computedStylesOf(styled("margin: 1px 2px 3px 4px"))).toMatchObject({
            margin: "1px 2px 3px 4px",
        });
        // top/bottom equal and left/right equal is the two-value form, even when all four differ from zero.
        expect(computedStylesOf(styled("padding: 0 12px"))).toMatchObject({ padding: "0px 12px" });
    });

    it("describes a border that is the same on every side in one phrase, with a hex colour", () => {
        expect(computedStylesOf(styled("border: 1px solid rgb(0, 128, 0)"))).toMatchObject({
            border: "1px solid #008000",
        });
    });

    it("names the sides of a border that is not the same everywhere, and skips sides without one", () => {
        const styles = computedStylesOf(
            styled("border-bottom: 2px solid rgb(255, 0, 0); border-top: 1px dashed rgb(0, 0, 0)")
        );
        expect(styles?.border).toBe("top 1px dashed #000000, bottom 2px solid #ff0000");
    });

    it("reads flex alignment only from flex and grid containers, and says nothing of the defaults", () => {
        const flex = computedStylesOf(
            styled(
                "display: flex; flex-direction: column; justify-content: space-between; align-items: center; gap: 12px"
            )
        );
        expect(flex).toMatchObject({
            display: "flex",
            "flex-direction": "column",
            "justify-content": "space-between",
            "align-items": "center",
            gap: "12px",
        });
        const row = computedStylesOf(styled("display: flex; flex-direction: row"));
        expect(row).not.toHaveProperty("flex-direction");
        expect(computedStylesOf(styled("display: grid; align-items: end"))).toMatchObject({
            "align-items": "end",
        });

        const block = computedStylesOf(
            styled("display: block; justify-content: center; align-items: center")
        );
        expect(block).not.toHaveProperty("justify-content");
        expect(block).not.toHaveProperty("align-items");
    });

    it("follows the cascade, not only inline styles", () => {
        document.head.innerHTML =
            "<style>.cta { color: rgb(255, 255, 255); background-color: rgb(17, 24, 39); padding: 8px }</style>";
        const el = styled("");
        el.className = "cta";
        expect(computedStylesOf(el)).toMatchObject({
            color: "#ffffff",
            "background-color": "#111827",
            padding: "8px",
        });
    });

    it("clips a long value to 120 characters", () => {
        const families = Array.from({ length: 30 }, (_, i) => `"Typeface Number ${i}"`).join(", ");
        const family = computedStylesOf(styled(`font-family: ${families}`))?.[
            "font-family"
        ] as string;
        expect(family).toHaveLength(120);
        expect(family.endsWith("…")).toBe(true);
    });

    it("is undefined for an element whose document has no window", () => {
        const orphan = document.implementation.createHTMLDocument("x").createElement("div");
        expect(computedStylesOf(orphan)).toBeUndefined();
    });
});

describe("stylesIdentityPlugin", () => {
    const plugin = stylesIdentityPlugin();

    it("puts the styles on the identity", () => {
        const identity = plugin.resolve(styled("color: rgb(255, 0, 0)"));
        expect(plugin.id).toBe("styles");
        expect(identity).toEqual({ styles: expect.objectContaining({ color: "#ff0000" }) });
    });

    it("adds nothing when there are no styles to read", () => {
        const orphan = document.implementation.createHTMLDocument("x").createElement("div");
        expect(plugin.resolve(orphan)).toEqual({});
    });

    it("adds nothing, and does not throw, when the browser refuses", () => {
        vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
            throw new Error("detached");
        });
        expect(plugin.resolve(styled("color: red"))).toEqual({});
    });
});
