import { describe, expect, it } from "bun:test";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { renderToStaticMarkup } from "react-dom/server";

// ui.tsx loads the theme, which marks the page's root element as soon as it loads: give it one to mark.
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { pageLink, TargetFacts } = await import("../src/NoteFacts.tsx");

const html = (over: Partial<Annotation>) =>
    renderToStaticMarkup(<TargetFacts annotation={{ ...sampleAnnotation, ...over }} />);

describe("a note's page", () => {
    it("is a link labelled with where it goes, not with the route sent beside it", () => {
        const out = html({ url: "https://evil.example/login", route: "/checkout" });
        expect(out).toContain('href="https://evil.example/login"');
        expect(out).toContain("evil.example/login");
        expect(out).not.toContain("/checkout");
    });

    it("shows the host a link really goes to, however the address dresses it up", () => {
        const out = html({ url: "https://shop.example%2Fcheckout@evil.example/", route: "/" });
        expect(out).toContain(">evil.example/<");
        const lookalike = html({ url: "https://аpple.example/", route: "/" }); // a Cyrillic а
        expect(lookalike).toContain(">xn--pple-43d.example/<");
    });

    it("keeps the path and a hash route of the page", () => {
        expect(html({ url: "http://localhost:5173/#/orders/42", route: "/#/orders/42" })).toContain(
            "localhost:5173/#/orders/42"
        );
    });

    it("is only text for any other scheme, so nothing hands it to another program", () => {
        for (const url of [
            "react-native://shop/Checkout",
            "ms-settings:privacy",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "not a url",
        ]) {
            const out = html({ url, route: "/checkout" });
            expect(out, url).not.toContain("<a");
            expect(out, url).not.toContain("href=");
        }
        expect(html({ url: "react-native://shop/Checkout", route: "/Checkout" })).toContain(
            "react-native://shop/Checkout"
        );
    });

    it("the whole address under the details is linked only when it is http or https", () => {
        expect(pageLink("https://app.example/a?b=1")?.href).toBe("https://app.example/a?b=1");
        expect(pageLink("http://localhost:5173/")?.host).toBe("localhost:5173");
        for (const url of ["javascript:alert(1)", "data:text/html,hi", "vscode://x", "", "/a"])
            expect(pageLink(url), url).toBeNull();
    });
});
