import { describe, expect, it } from "vitest";
import {
    type Candidate,
    indexOf,
    parseSelector,
    query,
    SelectorError,
    selectorToFind,
} from "../src/selectors.ts";

const el = (c: Partial<Candidate> & { tag: string }): Candidate => ({ path: [], ...c });

const screen: Candidate[] = [
    el({ tag: "Text", text: "Spud Shop", path: ["App", "Shop"] }),
    el({ tag: "Text", text: "Maris Piper", path: ["App", "ProductList", "ProductCard"] }),
    el({
        tag: "View",
        role: "button",
        testId: "add-to-basket",
        path: ["App", "ProductList", "ProductCard"],
    }),
    el({ tag: "Text", text: "Add to basket", path: ["App", "ProductList", "ProductCard"] }),
    el({ tag: "Text", text: "King Edward", path: ["App", "ProductList", "ProductCard"] }),
    el({
        tag: "View",
        role: "button",
        testId: "add-to-basket",
        label: "Add King Edward",
        path: ["App", "ProductList", "ProductCard"],
    }),
    el({ tag: "TextInput", role: "textbox", label: "Card number", path: ["App", "Checkout"] }),
];

describe("parseSelector", () => {
    it("reads every part the mobile SDKs write", () => {
        expect(
            parseSelector(
                'ProductCard > button#add-to-basket[label="Add \\"King\\""]:text("King"):nth(2)'
            )
        ).toEqual({
            ancestors: ["ProductCard"],
            type: "button",
            id: "add-to-basket",
            label: 'Add "King"',
            text: "King",
            nth: 2,
        });
        expect(parseSelector("*:text('basket')")).toEqual({ ancestors: [], text: "basket" });
        expect(parseSelector("#add-to-basket:nth(3)")).toEqual({
            ancestors: [],
            id: "add-to-basket",
            nth: 3,
        });
        expect(parseSelector("Checkout   TextInput")).toEqual({
            ancestors: ["Checkout"],
            type: "TextInput",
        });
    });

    it("says what it cannot read", () => {
        expect(() => parseSelector("")).toThrow(SelectorError);
        expect(() => parseSelector('Text:text("open')).toThrow(/unbalanced/);
        expect(() => parseSelector("Text:hover")).toThrow(/cannot read/);
    });
});

describe("query", () => {
    it("finds by type, role, test id, label and text", () => {
        expect(query(screen, "#add-to-basket")).toHaveLength(2);
        expect(query(screen, "button")).toHaveLength(2);
        expect(query(screen, '[label="Card number"]')[0]?.tag).toBe("TextInput");
        expect(query(screen, ':text("king")').map((c) => c.text ?? c.label)).toEqual([
            "King Edward",
            "Add King Edward",
        ]);
        expect(query(screen, "Text:nth(2)")[0]?.text).toBe("Maris Piper");
        expect(query(screen, "Text:nth(9)")).toEqual([]);
    });

    it("narrows by the components around it, and ignores a name that is only a screen's", () => {
        expect(query(screen, "Shop > Text")).toHaveLength(1);
        expect(query(screen, "ProductCard Text")).toHaveLength(3);
        // No component is called Basket: the name is a person's, not held against the match.
        expect(query(screen, "Basket > #add-to-basket")).toHaveLength(2);
    });

    it("cannot find a private element by its text, which it does not have", () => {
        const secret = [el({ tag: "Text", path: ["Account"] })];
        expect(query(secret, ':text("ada@example.com")')).toEqual([]);
        expect(query(secret, "Account > Text")).toHaveLength(1);
    });
});

describe("selectorToFind", () => {
    it("adds the text when there is no test id to tell alike elements apart", () => {
        expect(selectorToFind({ selector: "ProductCard > Text", text: "King Edward" })).toBe(
            'ProductCard > Text:text("King Edward")'
        );
        expect(
            selectorToFind({ selector: "ProductCard > View#add", testId: "add", text: "Add" })
        ).toBe("ProductCard > View#add");
        expect(
            query(screen, selectorToFind({ selector: "ProductCard > Text", text: "King Edward" }))
        ).toHaveLength(1);
    });
});

describe("indexOf", () => {
    it("finds the same elements, in the same order, as a look at every one", () => {
        const index = indexOf(screen);
        for (const selector of [
            "#add-to-basket",
            "button",
            "Text",
            "ProductCard",
            ":text('basket')",
            "ProductCard > button#add-to-basket:nth(2)",
            'View[label="Add King Edward"]',
            "textbox",
            "#nothing",
            "Image",
        ])
            expect(query(screen, selector, index)).toEqual(query(screen, selector));
    });
});
