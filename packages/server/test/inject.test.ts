import { afterEach, describe, expect, it } from "bun:test";
import {
    bookmarklet,
    bookmarkletPage,
    consoleSnippet,
    injectSource,
    scriptUrl,
} from "../src/index.ts";
import { makeApp } from "./helpers.ts";

let ctx: ReturnType<typeof makeApp> | undefined;
afterEach(() => {
    ctx?.cleanup();
    ctx = undefined;
});

describe("GET /inject.js", () => {
    it("is JavaScript that anyone can load, with no login, and is not cached", async () => {
        ctx = makeApp();
        const res = await ctx.call("/inject.js");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/javascript");
        expect(res.headers.get("cache-control")).toBe("no-cache");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        const body = await res.text();
        expect(body.length).toBeGreaterThan(20_000);
        // It is the page script: it mounts the controller, which exposes the page API.
        expect(body).toContain("__notato");
        expect(body).toContain("data-notato-variant");
    });

    it("is the same on every request, built once", async () => {
        const first = await injectSource();
        expect(first).toBeTruthy();
        expect(await injectSource()).toBe(first);
    });

    it("does not carry a server address in it: it takes the one it was loaded from", async () => {
        const body = (await injectSource()) ?? "";
        expect(body).not.toContain("localhost:4747");
    });
});

describe("the addresses it is loaded from", () => {
    it("scriptUrl adds only what was asked for", () => {
        expect(scriptUrl("http://localhost:4747")).toBe("http://localhost:4747/inject.js");
        expect(scriptUrl("http://localhost:4747/", { project: "shop", token: "notato_abc" })).toBe(
            "http://localhost:4747/inject.js?project=shop&token=notato_abc"
        );
    });

    it("the bookmark is plain JavaScript with single quotes and no percent escapes, which a browser would decode first", () => {
        const code = bookmarklet("http://localhost:4747", {
            project: "shop",
            author: "Ada Lovelace",
        });
        expect(code.startsWith("javascript:(function(){")).toBe(true);
        expect(code).toContain("http://localhost:4747/inject.js?project=shop&t='+Date.now()");
        expect(code).not.toContain('"');
        expect(code).not.toContain("%");
        expect(code).not.toContain("Lovelace"); // the name is set in the panel, not smuggled through an address
        expect(() => new Function(code.slice("javascript:".length))).not.toThrow();
    });

    it("the bookmark adds the time with ? when there is no query yet", () => {
        expect(bookmarklet("http://localhost:4747")).toContain("/inject.js?t='+Date.now()");
    });

    it("the console snippet is valid JavaScript that appends the script", () => {
        const code = consoleSnippet("http://localhost:4747", { project: "shop" });
        expect(code).toContain("http://localhost:4747/inject.js?project=shop");
        expect(() => new Function(code)).not.toThrow();
    });
});

describe("GET /bookmarklet", () => {
    it("is a page with the link to drag, for the address the server was reached at", async () => {
        ctx = makeApp();
        const res = await ctx.call("/bookmarklet?project=shop");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
        const html = await res.text();
        expect(html).toContain('class="bm"');
        expect(html).toContain("http://localhost:4747/inject.js?project=shop");
        expect(html).toContain("Notato (shop)");
        expect(html).toContain("--cors-origin");
    });

    it("does not let a project name or origin break out of the page", () => {
        const html = bookmarkletPage('http://x.test"><script>alert(1)</script>', {
            project: '"><img src=x onerror=alert(1)>',
        });
        expect(html).not.toContain("<script>alert(1)");
        expect(html).not.toContain("<img src=x");
        expect(html).not.toContain("x.test");
        expect(html).not.toContain("onerror=alert");
    });

    it("keeps a quote in the project or token out of the bookmark's script", () => {
        // %27 in the page's query string arrives as a quote, and a javascript: address is decoded before it runs.
        const html = bookmarkletPage("http://localhost:4747", {
            project: "x'+alert(document.domain)+'",
            token: "notato_a'+fetch('//evil.example')+'",
        });
        expect(html).not.toContain("alert(document.domain)");
        expect(html).not.toContain("evil.example");
        expect(html).toContain("http://localhost:4747/inject.js?t=");
    });
});
