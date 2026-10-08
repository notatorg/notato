// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createController, type NotatoController } from "../src/controller.ts";
import { addSheet, setStyleNonce, sheetsIn } from "../src/ui/sheet.ts";

const MARK = "data-notato-test";
const RULE = "p { color: red; }";

/** A browser without constructed stylesheets (Safari before 16.4): documents and shadow roots have no `adoptedStyleSheets`. */
function withoutConstructedSheets() {
    const host = document.createElement("div");
    const removed: Array<[object, PropertyDescriptor]> = [];
    for (const start of [document, host.attachShadow({ mode: "open" })]) {
        for (
            let proto = Object.getPrototypeOf(start);
            proto;
            proto = Object.getPrototypeOf(proto)
        ) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, "adoptedStyleSheets");
            if (!descriptor) continue;
            removed.push([proto, descriptor]);
            Reflect.deleteProperty(proto, "adoptedStyleSheets");
        }
    }
    return () => {
        for (const [proto, descriptor] of removed)
            Object.defineProperty(proto, "adoptedStyleSheets", descriptor);
    };
}

let undo: (() => void) | undefined;
let controller: NotatoController | undefined;
afterEach(() => {
    controller?.destroy();
    controller = undefined;
    undo?.();
    undo = undefined;
    setStyleNonce(undefined);
    document.adoptedStyleSheets = [];
    document.body.innerHTML = "";
    document.head.innerHTML = "";
});

describe("Notato's style rules", () => {
    it("are a constructed sheet where the browser takes one: no style element, which a strict policy would block", () => {
        const sheet = addSheet(document, RULE, MARK);
        expect(document.adoptedStyleSheets).toHaveLength(1);
        expect(document.querySelector("style")).toBeNull();
        expect(sheetsIn(document, MARK)).toEqual([RULE]);
        sheet.remove();
        expect(document.adoptedStyleSheets).toHaveLength(0);
    });

    it("come back when the page replaces its sheets", () => {
        const sheet = addSheet(document, RULE, MARK);
        document.adoptedStyleSheets = []; // an app that assigns its own list
        sheet.set(RULE);
        expect(sheetsIn(document, MARK)).toEqual([RULE]);
    });

    it("are a style element carrying the page's nonce where the browser has no constructed sheets", () => {
        undo = withoutConstructedSheets();
        setStyleNonce("r4nd0m");
        const sheet = addSheet(document, RULE, MARK);
        const style = document.head.querySelector(`style[${MARK}]`);
        expect(style?.getAttribute("nonce")).toBe("r4nd0m");
        expect(style?.textContent).toBe(RULE);
        sheet.disabled = true;
        expect(sheet.disabled).toBe(true);
        sheet.set("p { color: blue; }");
        expect(sheetsIn(document, MARK)).toEqual(["p { color: blue; }"]);
        sheet.remove();
        expect(document.head.querySelector("style")).toBeNull();
    });

    it("carry no nonce when the page gave none", () => {
        undo = withoutConstructedSheets();
        addSheet(document, RULE, MARK);
        expect(document.head.querySelector("style")?.hasAttribute("nonce")).toBe(false);
    });
});

describe("the toolbar's own styles", () => {
    const shadow = () =>
        (document.querySelector("[data-notato-root]") as HTMLElement).shadowRoot as ShadowRoot;

    it("are adopted by its shadow root", () => {
        controller = createController({ project: "shop", screenshots: false, persist: false });
        expect(shadow().adoptedStyleSheets).toHaveLength(1);
        expect(shadow().querySelector("style")).toBeNull();
    });

    it("are a style element with the nonce from the options, in an older browser", () => {
        undo = withoutConstructedSheets();
        controller = createController({
            project: "shop",
            screenshots: false,
            persist: false,
            nonce: "abc123",
        });
        expect(shadow().querySelector("style")?.getAttribute("nonce")).toBe("abc123");
    });
});
