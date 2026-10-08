// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
    ancestorsOf,
    containerPath,
    domIdentityPlugin,
    uniqueSelector,
} from "../src/plugins/identity-dom.ts";

afterEach(() => {
    document.body.innerHTML = "";
});

/** A custom element with a shadow root holding `html`, appended to `into`. */
const widget = (tag: string, html: string, into: ParentNode = document.body) => {
    const host = document.createElement(tag);
    into.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = html;
    return { host, root };
};
const $in = (root: ParentNode, selector: string): Element => {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`test setup: ${selector} is not there`);
    return el;
};

describe("uniqueSelector inside a shadow root", () => {
    /** The selector, checked the way the identity is used: looked up from the root that holds the element. */
    const inRoot = (root: ShadowRoot, el: Element) => {
        const sel = uniqueSelector(el);
        expect(root.querySelectorAll(sel)).toHaveLength(1);
        expect(root.querySelector(sel)).toBe(el);
        return sel;
    };

    it("is relative to the shadow root: unique there, even if the document has more of the same", () => {
        document.body.innerHTML = "<button>Outside</button><button>Also outside</button>";
        const { root } = widget("pay-card", "<button>Pay</button>");
        expect(inRoot(root, $in(root, "button"))).toBe("button");
    });

    it("does not anchor on the document's <html>", () => {
        const { root } = widget("pay-card", '<div class="row"><span>a</span><span>b</span></div>');
        const sel = inRoot(root, root.querySelectorAll("span")[1] as Element);
        expect(sel).not.toContain("html");
        expect(sel).not.toContain("body");
    });

    it("uses a test id or a stable id found in the root", () => {
        const { root } = widget(
            "pay-card",
            '<div><b data-testid="total">1</b><b>2</b></div><i id="note"></i><i></i>'
        );
        expect(inRoot(root, $in(root, "[data-testid=total]"))).toBe('[data-testid="total"]');
        expect(inRoot(root, $in(root, "#note"))).toBe("#note");
    });

    it("tells apart same-tag siblings, nested or at the top of the root", () => {
        const { root } = widget(
            "pay-card",
            "<ul><li>A</li><li>B</li></ul><button>Pay</button><button>Cancel</button><button>Help</button>"
        );
        const sels = [...root.querySelectorAll("li, button")].map((el) => inRoot(root, el));
        expect(new Set(sels).size).toBe(sels.length);
    });

    it("never names an element by anything outside its own root", () => {
        const { root } = widget("pay-card", '<div class="panel"><p>a</p><p>b</p></div>');
        document.body.insertAdjacentHTML(
            "afterbegin",
            '<div class="panel" id="outer-panel"></div>'
        );
        const sel = inRoot(root, root.querySelectorAll("p")[1] as Element);
        expect(sel).not.toContain("outer-panel");
    });
});

describe("containerPath", () => {
    it("is empty for an element of the page itself", () => {
        document.body.innerHTML = "<main><button>Pay</button></main>";
        expect(containerPath($in(document, "button"))).toBeUndefined();
    });

    it("names the host of the shadow root an element is in", () => {
        const { root } = widget("pay-card", "<button>Pay</button>");
        expect(containerPath($in(root, "button"))).toEqual([
            { kind: "shadow", selector: "pay-card" },
        ]);
    });

    it("lists nested shadow roots outermost first, each host named from the root that holds it", () => {
        document.body.innerHTML = "<pay-card></pay-card>"; // another host of the same name outside, so names must stay scoped
        const outer = widget("app-shell", "<p>chrome</p>");
        const inner = widget("pay-card", "<button>Pay</button>", outer.root);
        const path = containerPath($in(inner.root, "button"));
        expect(path).toEqual([
            { kind: "shadow", selector: "app-shell" },
            { kind: "shadow", selector: "pay-card" },
        ]);
        // The inner host is looked up from the outer root, where `pay-card` is unique.
        expect(outer.root.querySelectorAll("pay-card")).toHaveLength(1);
    });

    it("names a host by its test id, with the attributes it is given", () => {
        const { host, root } = widget("pay-card", "<button>Pay</button>");
        host.setAttribute("data-qa", "card");
        document.body.append(document.createElement("pay-card"));
        expect(containerPath($in(root, "button"))).toEqual([
            { kind: "shadow", selector: '[data-qa="card"]' },
        ]);
        expect(containerPath($in(root, "button"), ["data-nothing"])).toEqual([
            { kind: "shadow", selector: "pay-card:nth-of-type(1)" },
        ]);
    });

    it("goes through the frame an element's document sits in", () => {
        const iframe = document.createElement("iframe");
        iframe.id = "preview";
        document.body.append(iframe);
        const doc = iframe.contentDocument as Document;
        doc.body.innerHTML = "<button>Pay</button>";
        // happy-dom has no `Window.frameElement`, which is how the path gets from a frame's window to the frame.
        Object.defineProperty(iframe.contentWindow, "frameElement", {
            configurable: true,
            get: () => iframe,
        });
        expect(containerPath($in(doc, "button"))).toEqual([
            { kind: "frame", selector: "#preview" },
        ]);

        const inShadow = widget("pay-card", "<b>x</b>", doc.body);
        expect(containerPath($in(inShadow.root, "b"))).toEqual([
            { kind: "frame", selector: "#preview" },
            { kind: "shadow", selector: "pay-card" },
        ]);
    });
});

describe("ancestorsOf", () => {
    it("lists the elements around one, outermost first, without <html>", () => {
        document.body.innerHTML =
            '<main id="app"><section class="panel"><form><button>Pay</button></form></section></main>';
        expect(ancestorsOf($in(document, "button"))).toEqual([
            "body",
            "main#app",
            "section.panel",
            "form",
        ]);
    });

    it("keeps the nearest six", () => {
        document.body.innerHTML =
            "<a1><a2><a3><a4><a5><a6><a7><a8><i></i></a8></a7></a6></a5></a4></a3></a2></a1>";
        expect(ancestorsOf($in(document, "i"))).toEqual(["a3", "a4", "a5", "a6", "a7", "a8"]);
        expect(ancestorsOf($in(document, "i"), 2)).toEqual(["a7", "a8"]);
    });

    it("names an element by its id, else by its first stable class, never by generated ones", () => {
        document.body.innerHTML = `
      <div id="a" class="x"><div class="css-1abc23 card wide"><div id=":r1:" class="inner"><i></i></div></div></div>`;
        expect(ancestorsOf($in(document, "i"))).toEqual(["body", "div#a", "div.card", "div.inner"]);
    });

    it("says nothing for an element with no ancestors to name", () => {
        expect(ancestorsOf(document.documentElement)).toBeUndefined();
        expect(ancestorsOf(document.createElement("div"))).toBeUndefined();
    });

    it("lists the ancestors an element has inside its shadow root", () => {
        const { root } = widget("pay-card", '<div class="panel"><button>Pay</button></div>');
        expect(ancestorsOf($in(root, "button"))).toContain("div.panel");
    });
});

describe("domIdentityPlugin", () => {
    it("records where the element is: its containers and what is around it", () => {
        const { root } = widget(
            "pay-card",
            '<div class="panel"><button class="primary">Pay</button></div>'
        );
        const identity = domIdentityPlugin().resolve($in(root, "button"));
        expect(identity).toMatchObject({
            selector: "button",
            within: [{ kind: "shadow", selector: "pay-card" }],
            ancestors: expect.arrayContaining(["div.panel"]),
        });
    });

    it("leaves `within` out for an element of the page itself", () => {
        document.body.innerHTML = "<main><button>Pay</button></main>";
        const identity = domIdentityPlugin().resolve($in(document, "button"));
        expect(identity?.within).toBeUndefined();
        expect(identity?.ancestors).toEqual(["body", "main"]);
    });
});
