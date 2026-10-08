// @vitest-environment happy-dom
import type { CapturePlugin, DraftAnnotation } from "@notato/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consolePlugin } from "../src/plugins/console.ts";
import { networkPlugin, safeUrl } from "../src/plugins/network.ts";
import { routePlugin, routeString } from "../src/plugins/route.ts";
import {
    cropBox,
    MASK_ATTR,
    maskClone,
    planCapture,
    shiftFixed,
    shouldMask,
} from "../src/plugins/screenshot.ts";

const draft = {} as DraftAnnotation;
const teardowns: Array<() => void> = [];
afterEach(() => {
    for (const t of teardowns.splice(0)) t();
});
const contextOf = async <T>(plugin: CapturePlugin, key: string): Promise<T> => {
    const context = (await plugin.capture(draft))?.context ?? {};
    return context[key] as T;
};
const setup = (plugin: { setup?: () => undefined | (() => void) }) => {
    const teardown = plugin.setup?.();
    if (teardown) teardowns.push(teardown);
};

describe("planCapture", () => {
    it("keeps the device pixel ratio when the long edge fits", () => {
        expect(planCapture(1000, 600, 2, 2000)).toEqual({ scale: 2, width: 2000, height: 1200 });
    });
    it("caps the long edge at maxEdge", () => {
        const plan = planCapture(1920, 1080, 2, 2000);
        expect(plan.width).toBe(2000);
        expect(plan.scale).toBeCloseTo(2000 / 1920);
    });
    it("never upscales beyond the DPR", () => {
        expect(planCapture(800, 600, 1, 2000).scale).toBe(1);
    });
});

describe("cropBox", () => {
    it("pads by 24px", () => {
        expect(cropBox({ x: 100, y: 100, w: 50, h: 20 }, 24, 1000, 800)).toEqual({
            x: 76,
            y: 76,
            w: 98,
            h: 68,
        });
    });
    it("clamps to the viewport", () => {
        expect(cropBox({ x: 5, y: 5, w: 50, h: 20 }, 24, 60, 40)).toEqual({
            x: 0,
            y: 0,
            w: 60,
            h: 40,
        });
    });
    it("never returns an empty box", () => {
        expect(cropBox({ x: 500, y: 500, w: 0, h: 0 }, 0, 100, 100).w).toBeGreaterThanOrEqual(1);
    });
});

describe("maskClone", () => {
    const el = (html: string) => {
        const wrap = document.createElement("div");
        wrap.innerHTML = html;
        return wrap.firstElementChild as HTMLElement;
    };

    it("blanks value fields when masking is on", () => {
        const input = el('<input value="4242" placeholder="Card" checked>') as HTMLInputElement;
        maskClone(input, true);
        expect(input.getAttribute("value")).toBeNull();
        expect(input.getAttribute("placeholder")).toBeNull();
        expect(input.value).toBe("");
        expect(input.style.getPropertyValue("background")).toContain("#9ca3af");
    });

    it("empties textareas and selects", () => {
        const ta = el("<textarea>secret</textarea>");
        maskClone(ta, true);
        expect(ta.textContent).toBe("");
        const sel = el("<select><option>private</option></select>");
        maskClone(sel, true);
        expect(sel.children).toHaveLength(0);
    });

    it("leaves value fields alone when masking is off, but always masks marked elements", () => {
        const input = el('<input value="visible">') as HTMLInputElement;
        maskClone(input, false);
        expect(input.getAttribute("value")).toBe("visible");
        const marked = el(`<div ${MASK_ATTR}>account <b>123</b></div>`);
        maskClone(marked, false);
        expect(marked.textContent).toBe("");
    });

    it("always covers password fields, even when masking is off", () => {
        const password = el('<input type="password" value="hunter2">') as HTMLInputElement;
        maskClone(password, false);
        expect(password.getAttribute("value")).toBeNull();
    });

    it("lets a field opt out with data-notato-mask=false, except a password", () => {
        const search = el(`<input ${MASK_ATTR}="false" value="smoke detector">`);
        maskClone(search, true);
        expect(search.getAttribute("value")).toBe("smoke detector");
        expect(shouldMask(el(`<input type="password" ${MASK_ATTR}="false">`), true)).toBe(true);
        expect(shouldMask(el(`<div ${MASK_ATTR}="true">x</div>`), false)).toBe(true);
        expect(shouldMask(el(`<div ${MASK_ATTR}="false">x</div>`), true)).toBe(false);
    });

    it("does not mask buttons or hidden inputs", () => {
        for (const type of ["submit", "button", "reset", "hidden", "image"]) {
            const input = el(`<input type="${type}" value="Go">`);
            maskClone(input, true);
            expect(input.getAttribute("value")).toBe("Go");
        }
    });

    it("ignores text nodes", () => {
        expect(() => maskClone(document.createTextNode("x"), true)).not.toThrow();
    });
});

describe("shiftFixed", () => {
    it("offsets fixed elements by the scroll position and keeps their own transform", () => {
        const fixed = document.createElement("div");
        fixed.style.position = "fixed";
        fixed.style.transform = "scale(2)";
        shiftFixed(fixed, 10, 300);
        expect(fixed.style.transform).toBe("translate(10px, 300px) scale(2)");
    });
    it("leaves other elements and unscrolled pages alone", () => {
        const flow = document.createElement("div");
        shiftFixed(flow, 10, 300);
        expect(flow.style.transform).toBe("");
        const fixed = document.createElement("div");
        fixed.style.position = "fixed";
        shiftFixed(fixed, 0, 0);
        expect(fixed.style.transform).toBe("");
    });
});

describe("routePlugin", () => {
    it("builds routes with and without the hash", () => {
        expect(routeString({ pathname: "/a", hash: "#/b" }, false)).toBe("/a");
        expect(routeString({ pathname: "/a", hash: "#/b" }, true)).toBe("/a#/b");
        expect(routeString({ pathname: "/a", hash: "" }, true)).toBe("/a");
    });
    it("blanks out a secret in a hash route, as in a URL, and keeps the rest", () => {
        expect(routeString({ pathname: "/", hash: "#/reset?token=XYZ123&step=2" }, true)).toBe(
            "/#/reset?token=redacted&step=2"
        );
        expect(routeString({ pathname: "/", hash: "#access_token=ya29.abc" }, true)).toBe(
            "/#access_token=redacted"
        );
        expect(routeString({ pathname: "/app", hash: "#/orders/42?tab=items" }, true)).toBe(
            "/app#/orders/42?tab=items"
        );
    });
    it("captures the current location", async () => {
        window.history.pushState({}, "", "/orders");
        expect(await routePlugin().capture(draft)).toEqual({ route: "/orders" });
    });
});

describe("consolePlugin", () => {
    it("records messages and restores console on teardown", async () => {
        const original = console.warn;
        const plugin = consolePlugin({ limit: 2 });
        const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
        setup(plugin);
        console.log("one");
        console.log("two", { a: 1 });
        console.log("three");
        const entries = await contextOf<Array<{ message: string; level: string }>>(
            plugin,
            "console"
        );
        expect(entries.map((e) => e.message)).toEqual(['two {"a":1}', "three"]);
        teardowns.pop()?.();
        expect(console.warn).toBe(original);
        quiet.mockRestore();
    });

    it("keeps uncaught errors and unhandled rejections", async () => {
        const plugin = consolePlugin();
        setup(plugin);
        window.dispatchEvent(new ErrorEvent("error", { message: "kaboom" }));
        const entries = await contextOf<Array<{ level: string }>>(plugin, "console");
        expect(entries.some((e) => e.level === "uncaught")).toBe(true);
    });
});

describe("networkPlugin", () => {
    it("strips query strings and never records bodies or headers", () => {
        expect(safeUrl("/api/orders?token=secret#x", "http://localhost:5173/")).toBe(
            "http://localhost:5173/api/orders"
        );
    });

    it("records fetch method, path, status and duration, even on failure", async () => {
        const realFetch = window.fetch;
        window.fetch = (async (input: RequestInfo | URL) =>
            String(input).includes("fail")
                ? Promise.reject(new Error("net"))
                : new Response("ok", { status: 201 })) as unknown as typeof fetch;
        const plugin = networkPlugin();
        setup(plugin);
        await window.fetch("http://localhost/api/a?secret=1", { method: "post", body: "private" });
        await window.fetch("http://localhost/fail").catch(() => {});
        const entries = await contextOf<Array<Record<string, unknown>>>(plugin, "network");
        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({
            method: "POST",
            url: "http://localhost/api/a",
            status: 201,
        });
        expect(entries[1]).toMatchObject({ status: 0 });
        expect(JSON.stringify(entries)).not.toContain("secret");
        expect(JSON.stringify(entries)).not.toContain("private");
        teardowns.pop()?.();
        window.fetch = realFetch;
    });

    it("restores fetch on teardown and honours ignore prefixes", async () => {
        const realFetch = window.fetch;
        window.fetch = (async () => new Response("ok")) as unknown as typeof fetch;
        const base = window.fetch;
        const plugin = networkPlugin({ ignore: ["http://localhost:4747"] });
        setup(plugin);
        await window.fetch("http://localhost:4747/health");
        expect(await contextOf<unknown[]>(plugin, "network")).toHaveLength(0);
        teardowns.pop()?.();
        expect(window.fetch).toBe(base);
        window.fetch = realFetch;
    });
});
