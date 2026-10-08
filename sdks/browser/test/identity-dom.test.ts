// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
    accessibleName,
    cssEscape,
    domIdentityPlugin,
    looksGenerated,
    roleOf,
    safeText,
    stableClasses,
    uniqueSelector,
    visibleText,
} from "../src/plugins/identity-dom.ts";

const mount = (html: string) => {
    document.body.innerHTML = html;
};
const $ = (selector: string) => document.querySelector(selector) as Element;

describe("looksGenerated", () => {
    it.each([
        ":r1:",
        "«r2»",
        "_r_3_",
        "12345",
        "a8f3e2c1-9b7d-4e8a",
        "css-1x2y3z",
        "Button_primary__x7Fq2",
    ])("flags %s", (token) => expect(looksGenerated(token)).toBe(true));
    it.each(["pay", "btn_primary", "checkout-form", "nav-orders", "primary"])("keeps %s", (token) =>
        expect(looksGenerated(token)).toBe(false)
    );
});

describe("uniqueSelector", () => {
    beforeEach(() =>
        mount(`
      <main>
        <ul><li class="item">A</li><li class="item">B</li><li class="item">C</li></ul>
        <section id="checkout"><button class="primary">Pay</button><button class="secondary">Cancel</button></section>
        <div data-testid="card"><span>x</span><span>y</span></div>
        <input id=":r1:" name="generated">
        <p>only</p>
      </main>`)
    );

    const unique = (el: Element) => {
        const sel = uniqueSelector(el);
        expect(document.querySelectorAll(sel)).toHaveLength(1);
        expect(document.querySelector(sel)).toBe(el);
        return sel;
    };

    it("prefers a test id", () =>
        expect(unique($("[data-testid=card]"))).toBe('[data-testid="card"]'));
    it("uses a stable id", () => expect(unique($("#checkout"))).toBe("#checkout"));
    it("uses the bare tag when that is unique", () => expect(unique($("p"))).toBe("p"));
    it("uses stable classes to disambiguate siblings", () =>
        expect(unique($(".primary"))).toBe("button.primary"));
    it("falls back to nth-of-type among identical siblings", () => {
        const sel = unique($("li:nth-child(2)"));
        expect(sel).toContain("nth-of-type(2)");
    });
    it("ignores generated ids", () => expect(unique($("input"))).not.toContain(":r1:"));
    it("anchors on an ancestor test id when the path alone is ambiguous", () => {
        mount(
            '<div><span>a</span><span>b</span></div><div data-testid="card"><span>x</span><span>y</span></div>'
        );
        const sel = unique($("[data-testid=card] span:last-child"));
        expect(sel).toBe('[data-testid="card"] > span:nth-of-type(2)');
    });
    it("honours configured test id attributes", () => {
        mount('<div><b data-qa="x">1</b><b>2</b></div>');
        const sel = uniqueSelector($("b"), ["data-qa"]);
        expect(sel).toBe('[data-qa="x"]');
    });
});

describe("role and accessible name", () => {
    it("derives implicit roles", () => {
        mount(
            '<a href="/x">l</a><a>n</a><button>b</button><input type="checkbox"><img alt="logo"><img alt=""><h2>h</h2>'
        );
        expect([...document.body.children].map(roleOf)).toEqual([
            "link",
            undefined,
            "button",
            "checkbox",
            "img",
            "presentation",
            "heading",
        ]);
    });

    it("prefers an explicit role", () => {
        mount('<div role="tab button">x</div>');
        expect(roleOf($("div"))).toBe("tab");
    });

    it("names by aria-labelledby, aria-label, label, then content", () => {
        mount(`
      <span id="l1">First</span><span id="l2">Second</span>
      <div id="a" role="button" aria-labelledby="l1 l2">ignored</div>
      <div id="b" role="button" aria-label="Close">x</div>
      <label for="in">Email</label><input id="in">
      <button id="c">Pay <b>now</b></button>`);
        expect(accessibleName($("#a"))).toBe("First Second");
        expect(accessibleName($("#b"))).toBe("Close");
        expect(accessibleName($("#in"))).toBe("Email");
        expect(accessibleName($("#c"))).toBe("Pay now");
    });

    it("never lets a wrapping label leak the textarea's content", () => {
        mount(
            "<label>Delivery notes<textarea>Leave with the neighbour at number 9.</textarea></label>"
        );
        const name = accessibleName($("textarea"));
        expect(name).toBe("Delivery notes");
        expect(name).not.toContain("neighbour");
    });

    it("never uses a text input's value as its name", () => {
        mount('<input id="card" value="4242 4242 4242 4242" placeholder="Card number">');
        expect(accessibleName($("#card"))).toBe("Card number");
    });
});

describe("visible text", () => {
    it("collapses whitespace and clips to 200 characters", () => {
        mount(`<p>${"word ".repeat(100)}</p>`);
        const text = visibleText($("p")) as string;
        expect(text.length).toBe(200);
        expect(text.endsWith("…")).toBe(true);
    });

    it("omits field contents and masked subtrees from ancestors", () => {
        mount(`
      <form>
        Name
        <textarea>secret notes</textarea>
        <select><option>private choice</option></select>
        <span data-notato-mask>4242 4242</span>
        Done
      </form>`);
        const text = visibleText($("form")) as string;
        expect(text).toContain("Name");
        expect(text).toContain("Done");
        for (const leaked of ["secret", "private", "4242"]) expect(text).not.toContain(leaked);
    });

    it("returns nothing for fields and masked elements", () => {
        mount('<input value="x"><textarea>y</textarea><div data-notato-mask>z</div>');
        for (const el of document.body.children) expect(visibleText(el)).toBeUndefined();
    });

    it("records nothing for an element inside a private one, not even its name", () => {
        mount(
            `<section data-notato-mask><h2 aria-label="Ada's account">Ada Lovelace</h2><b>£1,204</b></section><p>Visit</p>`
        );
        expect(visibleText($("h2"))).toBeUndefined();
        expect(accessibleName($("h2"))).toBeUndefined();
        expect(visibleText($("b"))).toBeUndefined();
        expect(visibleText($("p"))).toBe("Visit");
    });

    it("treats data-notato-mask=false as an opt-out, not as private", () => {
        mount(
            `<div data-notato-mask="false"><label>Search <input value="smoke"></label> results</div>`
        );
        const text = visibleText($("div")) as string;
        expect(text).toContain("results");
        // A field's contents are never recorded as text, opted out or not.
        expect(text).not.toContain("smoke");
    });

    it("safeText of an omitted root is empty", () => {
        mount("<textarea>abc</textarea>");
        expect(safeText($("textarea"))).toBe("");
    });
});

describe("domIdentityPlugin", () => {
    it("fills every field it can", () => {
        mount(
            '<button data-testid="pay" class="primary Button_x__a1b2c3" type="button">Pay now</button>'
        );
        const identity = domIdentityPlugin().resolve($("button"));
        expect(identity).toMatchObject({
            selector: '[data-testid="pay"]',
            testId: "pay",
            role: "button",
            name: "Pay now",
            tag: "button",
            classes: ["primary"],
            text: "Pay now",
        });
    });

    it("exposes classes only when stable", () => {
        mount('<div class="css-1abc23 sc-xyz999"></div>');
        expect(stableClasses($("div"), 8)).toEqual([]);
    });
});

describe("cssEscape", () => {
    it("escapes characters that are not valid in identifiers", () => {
        expect(cssEscape("a:b")).toContain("\\");
        expect(cssEscape("plain-id_1")).toBe("plain-id_1");
    });
});
