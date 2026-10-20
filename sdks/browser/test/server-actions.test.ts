import { afterEach, expect, it, vi } from "vitest";
import { setTransport } from "../src/net.ts";
import { createServerActions } from "../src/server-actions.ts";
import type { ServerSync } from "../src/sync.ts";

afterEach(() => setTransport());

const sync: ServerSync = {
    start() {},
    stop() {},
    refresh: async () => {},
    mark: () => 0,
    apply: () => true,
};

it("scopes status to the app's project for CORS, with credentials only in headers", async () => {
    const fetch = vi.fn(async () =>
        Response.json({
            version: "0.3.0",
            mode: "serve",
            pages: 2,
            config: { screenshots: "on" },
            agents: { connected: true, watching: true, names: ["Example agent"] },
        })
    );
    setTransport({ fetch });
    const actions = createServerActions({
        server: "https://notes.example.com",
        project: "web@example.com & mobile",
        token: "notato_app_test",
        sync,
        author: () => "Tester",
    });
    expect(await actions.status()).toEqual({
        version: "0.3.0",
        mode: "serve",
        pages: 2,
        screenshots: "on",
        agent: { connected: true, watching: true, names: ["Example agent"] },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
        "https://notes.example.com/status?project=web%40example.com%20%26%20mobile",
        { headers: { Authorization: "Bearer notato_app_test" } }
    );
});

it("does not request private server status under a capture-only credential", async () => {
    const fetch = vi.fn();
    setTransport({ fetch });
    const actions = createServerActions({
        server: "https://notes.example.com",
        project: "web",
        sync,
        author: () => undefined,
        captureOnly: () => true,
    });
    expect(await actions.status()).toEqual({
        mode: "capture",
        agent: { connected: false, watching: false },
    });
    expect(fetch).not.toHaveBeenCalled();
});
