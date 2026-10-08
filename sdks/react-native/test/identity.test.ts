import { describe, expect, it } from "vitest";
import { identityOf, textOf } from "../src/identity.ts";
import { parseSelector } from "../src/selectors.ts";

// What React Native 0.86's inspector reported for a tap on a button's label in the example (Android, Expo Go).
const tapped = {
    names: ["withDevTools(App)", "App", "ProductList", "ProductCard", "Text", "RCTText"],
    props: { accessible: false, ellipsizeMode: "tail", children: "Add to basket" },
    frame: { left: 47.2, top: 143.6, width: 86.9, height: 19.4 },
    componentStack: "",
};

describe("identityOf", () => {
    it("names your component, the ones around it and the view, without React Native's own", () => {
        expect(identityOf(tapped)).toEqual({
            selector: "ProductCard > Text",
            tag: "Text",
            text: "Add to basket",
            component: { name: "ProductCard", path: ["App", "ProductList", "ProductCard"] },
            ancestors: ["App", "ProductList", "ProductCard"],
        });
    });

    it("adds where the component is written, from the first frame in the app's own files", () => {
        const identity = identityOf(tapped, [
            {
                name: "Text",
                file: "/repo/node_modules/react-native/Libraries/Text/Text.js",
                line: 47,
                col: 6,
            },
            { name: "ProductCard", file: "/repo/app/App.tsx", line: 4, col: 1 },
        ]);
        expect(identity.component?.source).toBe("/repo/app/App.tsx:4:1");
    });

    it("takes the test id, label, role and native id people give their views", () => {
        const identity = identityOf({
            ...tapped,
            names: ["App", "Checkout", "Pressable", "View", "RCTView"],
            props: {
                testID: "pay",
                accessibilityLabel: 'Pay "now"',
                accessibilityRole: "button",
                nativeID: "pay-button",
            },
        });
        expect(identity).toMatchObject({
            selector: 'Checkout > View#pay[label="Pay \\"now\\""]',
            tag: "View",
            testId: "pay",
            name: 'Pay "now"',
            role: "button",
            platformId: "pay-button",
            component: { name: "Checkout", path: ["App", "Checkout"] },
        });
    });

    it("still says what the view is when none of the components is yours", () => {
        const identity = identityOf({
            ...tapped,
            names: ["AppContainer", "View", "RCTView"],
            props: {},
        });
        expect(identity).toEqual({ selector: "View", tag: "View" });
    });

    it("says none of a private view's ids: an app may make them of what it shows", () => {
        const identity = identityOf(
            {
                ...tapped,
                names: ["App", "Account", "Text", "RCTText"],
                props: {
                    children: "alice@example.com",
                    testID: "alice@example.com",
                    nativeID: "alice@example.com",
                    accessibilityLabel: "Email",
                },
            },
            [],
            { private: true }
        );
        expect(identity).toEqual({
            selector: "Account > Text",
            tag: "Text",
            component: { name: "Account", path: ["App", "Account"] },
            ancestors: ["App", "Account"],
        });
    });

    it("takes only a test id a selector can name, and escapes a label so it reads back as it was", () => {
        const identity = identityOf({
            ...tapped,
            names: ["App", "Checkout", "View", "RCTView"],
            props: { testID: "pay now, please", accessibilityLabel: 'C:\\temp "x"' },
        });
        expect(identity.testId).toBeUndefined();
        expect(identity.selector).toBe('Checkout > View[label="C:\\\\temp \\"x\\""]');
        expect(parseSelector(identity.selector).label).toBe('C:\\temp "x"');
        expect(
            identityOf({ ...tapped, props: { testID: "x".repeat(101) } }).testId
        ).toBeUndefined();
    });

    it("reads a Text's text from its children, nested or not", () => {
        expect(textOf(["£", 1.2, ["0 each"]])).toBe("£1.20 each");
        expect(textOf("  spaced \n out ")).toBe("spaced out");
        expect(textOf({ type: "Image" })).toBeUndefined();
        expect(textOf("x".repeat(300))?.length).toBe(200);
    });
});
