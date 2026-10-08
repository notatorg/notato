// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { domIdentityPlugin } from "../src/plugins/identity-dom.ts";
import { querySelectorDeep, resolveIdentity } from "../src/resolve.ts";

afterEach(() => {
    document.body.innerHTML = "";
});

/** The element a test built, so that "finds it" cannot pass by both sides being null. */
const $in = (root: ParentNode, selector: string): Element => {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`test setup: ${selector} is not there`);
    return el;
};
/** A custom element with a shadow root holding `html`, appended to `into`. */
const widget = (
    tag: string,
    html: string,
    into: ParentNode = document.body,
    mode: "open" | "closed" = "open"
) => {
    const host = document.createElement(tag);
    into.append(host);
    const root = host.attachShadow({ mode });
    root.innerHTML = html;
    return { host, root };
};
const frame = (id: string, html: string, into: ParentNode = document.body) => {
    const el = document.createElement("iframe");
    el.id = id;
    into.append(el);
    const doc = el.contentDocument as Document;
    doc.body.innerHTML = html;
    return { el, doc };
};
/** What a browser does for a frame from another origin: its document cannot be read. */
const makeForeign = (el: HTMLIFrameElement) =>
    Object.defineProperty(el, "contentDocument", {
        configurable: true,
        get() {
            throw new DOMException(
                "Blocked a frame from accessing a cross-origin frame.",
                "SecurityError"
            );
        },
    });

describe("querySelectorDeep", () => {
    it("is an ordinary selector when there is no >>>", () => {
        document.body.innerHTML = '<main><button class="pay">Pay</button></main>';
        expect(querySelectorDeep("main > .pay")).toBe($in(document, ".pay"));
    });

    it("returns null when nothing matches", () => {
        document.body.innerHTML = "<p>hello</p>";
        expect(querySelectorDeep(".missing")).toBeNull();
        expect(querySelectorDeep(".missing >>> .inner")).toBeNull();
    });

    it("goes into a shadow root", () => {
        const { root } = widget("my-widget", '<span class="inner">x</span>');
        expect(querySelectorDeep("my-widget >>> .inner")).toBe($in(root, ".inner"));
    });

    it("does not reach into a shadow root without >>>", () => {
        widget("my-widget", '<span class="inner">x</span>');
        expect(querySelectorDeep(".inner")).toBeNull();
    });

    it("goes through shadow roots inside shadow roots", () => {
        const outer = widget("app-shell", "<p>chrome</p>");
        const inner = widget("pay-card", '<button class="pay">Pay</button>', outer.root);
        expect(querySelectorDeep("app-shell >>> pay-card >>> .pay")).toBe($in(inner.root, ".pay"));
    });

    it("goes into an iframe", () => {
        const { doc } = frame("preview", '<button class="pay">Pay</button>');
        expect(querySelectorDeep("iframe#preview >>> button.pay")).toBe($in(doc, ".pay"));
    });

    it("goes through an iframe and a shadow root in either order", () => {
        const inFrame = frame("preview", "");
        const w = widget("pay-card", '<button class="pay">Pay</button>', inFrame.doc.body);
        expect(querySelectorDeep("#preview >>> pay-card >>> .pay")).toBe($in(w.root, ".pay"));

        const host = widget("app-shell", "");
        const nested = frame("inner", '<i class="deep"></i>', host.root);
        expect(querySelectorDeep("app-shell >>> #inner >>> .deep")).toBe($in(nested.doc, ".deep"));
    });

    it("allows any amount of whitespace around >>>", () => {
        const { root } = widget("my-widget", '<span class="inner">x</span>');
        const inner = $in(root, ".inner");
        expect(querySelectorDeep("my-widget>>>.inner")).toBe(inner);
        expect(querySelectorDeep("  my-widget   >>>   .inner  ")).toBe(inner);
        expect(querySelectorDeep("my-widget\n>>>\n.inner")).toBe(inner);
    });

    it("returns null when a step has nothing to go into, or the target is not there", () => {
        document.body.innerHTML = '<div class="plain"><span class="inner"></span></div>';
        expect(querySelectorDeep(".plain >>> .inner")).toBeNull(); // a div is neither a frame nor a shadow host
        widget("my-widget", "<span></span>");
        expect(querySelectorDeep("my-widget >>> .missing")).toBeNull();
    });

    it("returns null for a closed shadow root, which the page cannot enter", () => {
        widget("secret-box", '<span class="inner"></span>', document.body, "closed");
        expect(querySelectorDeep("secret-box >>> .inner")).toBeNull();
    });

    it("returns null, and does not throw, for a frame from another origin", () => {
        const { el } = frame("ads", '<b class="inner"></b>');
        makeForeign(el);
        expect(querySelectorDeep("#ads >>> .inner")).toBeNull();
    });

    it("returns null for a selector that is not valid CSS", () => {
        expect(querySelectorDeep("div[")).toBeNull();
        expect(querySelectorDeep("div[ >>> span")).toBeNull();
    });

    it("starts from the document it is given", () => {
        const other = document.implementation.createHTMLDocument("other");
        other.body.innerHTML = '<p class="only-here"></p>';
        expect(querySelectorDeep(".only-here")).toBeNull();
        expect(querySelectorDeep(".only-here", other)).toBe($in(other, ".only-here"));
    });
});

describe("resolveIdentity", () => {
    it("finds an element of the page by its selector when it records no containers", () => {
        document.body.innerHTML = '<button id="pay">Pay</button>';
        expect(resolveIdentity({ selector: "#pay" })).toBe($in(document, "#pay"));
        expect(resolveIdentity({ selector: "#pay", within: [] })).toBe($in(document, "#pay"));
    });

    it("returns null when the selector matches nothing", () => {
        expect(resolveIdentity({ selector: "#gone" })).toBeNull();
    });

    it("looks for the selector inside each shadow root it records, outermost first", () => {
        const outer = widget("app-shell", "");
        const inner = widget("pay-card", '<button id="pay">Pay</button>', outer.root);
        const identity = {
            selector: "#pay",
            within: [
                { kind: "shadow" as const, selector: "app-shell" },
                { kind: "shadow" as const, selector: "pay-card" },
            ],
        };
        expect(resolveIdentity(identity)).toBe($in(inner.root, "#pay"));
        // The page's own document is not searched for it.
        expect(resolveIdentity({ selector: "#pay" })).toBeNull();
    });

    it("goes through an iframe it records", () => {
        const { doc } = frame("preview", '<button id="pay">Pay</button>');
        const identity = {
            selector: "#pay",
            within: [{ kind: "frame" as const, selector: "#preview" }],
        };
        expect(resolveIdentity(identity)).toBe($in(doc, "#pay"));
    });

    it("is null when a container is gone", () => {
        const identity = {
            selector: "#pay",
            within: [{ kind: "shadow" as const, selector: "pay-card" }],
        };
        expect(resolveIdentity(identity)).toBeNull(); // the component is not on the page
        widget("pay-card", '<button id="pay"></button>');
        expect(resolveIdentity(identity)).not.toBeNull();
    });

    it("is null when a container is no longer the kind it was", () => {
        document.body.innerHTML = '<div id="box"><button id="pay"></button></div>';
        expect(
            resolveIdentity({ selector: "#pay", within: [{ kind: "shadow", selector: "#box" }] })
        ).toBeNull();
        expect(
            resolveIdentity({ selector: "#pay", within: [{ kind: "frame", selector: "#box" }] })
        ).toBeNull();
    });

    it("is null for a closed shadow root and for a frame from another origin", () => {
        widget("secret-box", '<button id="pay"></button>', document.body, "closed");
        expect(
            resolveIdentity({
                selector: "#pay",
                within: [{ kind: "shadow", selector: "secret-box" }],
            })
        ).toBeNull();

        makeForeign(frame("ads", '<button id="pay"></button>').el);
        expect(
            resolveIdentity({ selector: "#pay", within: [{ kind: "frame", selector: "#ads" }] })
        ).toBeNull();
    });

    it("is null, and does not throw, for a selector that is not valid CSS", () => {
        expect(resolveIdentity({ selector: "div[" })).toBeNull();
        widget("pay-card", "<b></b>");
        expect(
            resolveIdentity({ selector: "b", within: [{ kind: "shadow", selector: "pay-card[" }] })
        ).toBeNull();
    });

    it("finds again what the DOM identity plugin described, through shadow roots", () => {
        document.body.innerHTML = "<main><p>before</p></main>";
        const outer = widget("app-shell", '<section class="panel"></section>');
        const inner = widget(
            "pay-card",
            '<button class="primary">Pay</button><button>Cancel</button>',
            outer.root
        );
        const target = $in(inner.root, ".primary");
        const identity = domIdentityPlugin().resolve(target) as Parameters<
            typeof resolveIdentity
        >[0];
        expect(identity.within).toEqual([
            { kind: "shadow", selector: "app-shell" },
            { kind: "shadow", selector: "pay-card" },
        ]);
        expect(resolveIdentity(identity)).toBe(target);
    });

    it("finds again an element in an iframe, and one in a shadow root inside it", () => {
        // happy-dom has no `Window.frameElement`, which the identity plugin follows from a frame's window to the frame.
        const inFrame = frame("preview", "<p>text</p>");
        const win = inFrame.el.contentWindow as Window;
        Object.defineProperty(win, "frameElement", { configurable: true, get: () => inFrame.el });
        const w = widget("pay-card", '<button class="primary">Pay</button>', inFrame.doc.body);
        const target = $in(w.root, ".primary");
        const identity = domIdentityPlugin().resolve(target) as Parameters<
            typeof resolveIdentity
        >[0];
        expect(identity.within).toEqual([
            { kind: "frame", selector: "#preview" },
            { kind: "shadow", selector: "pay-card" },
        ]);
        expect(resolveIdentity(identity)).toBe(target);
    });
});
