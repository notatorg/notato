import { expect, it } from "bun:test";
import type { UiAssets } from "../src/http.ts";
import { cleanupAfterEach, makeApp } from "./helpers.ts";
import { adminCookie, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
const ui: UiAssets = {
    async lookup(path) {
        if (path === "404.html")
            return { body: "<!doctype html><title>Page not found</title>", type: "text/html" };
        if (path === "index.html")
            return { body: "<!doctype html><title>Notato</title>", type: "text/html" };
        return null;
    },
};
const navigation = { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" };

it("serves a true, uncached HTML 404 for browser navigation without reflecting the requested URL", async () => {
    const app = makeApp({ ui });
    defer(app.cleanup);
    const response = await app.call("/missing/path?secret=never-echo", { headers: navigation });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).not.toContain("never-echo");
    expect((await app.call("/", { headers: navigation })).status).toBe(200);
});

it("preserves JSON errors for API requests, missing assets and excluded HTML representations", async () => {
    const app = makeApp({ ui });
    defer(app.cleanup);
    for (const [path, headers] of [
        ["/missing", {}],
        ["/missing", { accept: "application/json" }],
        ["/missing", { accept: "text/html;q=0,application/json" }],
        ["/ui/missing.js", navigation],
        ["/annotations/missing", navigation],
    ] as const) {
        const response = await app.call(path, { headers });
        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("application/json");
    }
    const post = await app.call("/missing", { method: "POST", headers: navigation });
    expect(post.status).toBe(404);
    expect(post.headers.get("content-type")).toContain("application/json");
    const direct = await app.call("/ui/404.html");
    expect(direct.status).toBe(404);
    expect(direct.headers.get("cache-control")).toBe("no-store");
});

it("shows only a static error page before sign-in and keeps unauthenticated API access denied", async () => {
    const server = await startServe(defer, { ui });
    const response = await server.call("/missing", { headers: navigation });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    for (const path of ["/projects", "/annotations/missing", "/missing"]) {
        const api = await server.call(path, { headers: { accept: "application/json" } });
        expect(api.status).toBe(401);
        expect(api.headers.get("www-authenticate")).toBe("Bearer");
    }
    const cookie = await adminCookie(server);
    expect((await server.call("/missing", { headers: { ...navigation, cookie } })).status).toBe(
        404
    );
    expect(
        (await server.call("/projects", { headers: { cookie, accept: "application/json" } })).status
    ).toBe(200);
});

it("keeps JSON fallback when an older or headless build has no 404 asset", async () => {
    const app = makeApp({ ui: { lookup: async () => null } });
    defer(app.cleanup);
    const response = await app.call("/missing", { headers: navigation });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
});
