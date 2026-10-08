// @vitest-environment happy-dom
import type { DraftAnnotation } from "@notato/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screenshotPlugin } from "../src/plugins/screenshot.ts";
import { createPolicy } from "../src/policy.ts";

const answer = (body: unknown, ok = true) =>
    vi.fn(async () => ({ ok, json: async () => body }) as Response);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("createPolicy", () => {
    it("allows screenshots until the server says otherwise", async () => {
        vi.stubGlobal("fetch", answer({ screenshots: true }));
        const policy = createPolicy({ baseUrl: "http://localhost:4747" });
        expect(policy.screenshotsNow()).toBe(true);
        expect(await policy.screenshots()).toBe(true);
    });

    it("asks the server, with the token, and does what it says", async () => {
        const fetchMock = answer({ screenshots: false });
        vi.stubGlobal("fetch", fetchMock);
        const policy = createPolicy({ baseUrl: "http://localhost:4747", token: "pft_x" });
        expect(await policy.screenshots()).toBe(false);
        expect(policy.screenshotsNow()).toBe(false);
        expect(fetchMock).toHaveBeenCalledWith("http://localhost:4747/config", {
            headers: { Authorization: "Bearer pft_x" },
        });
    });

    it("asks again before a capture once its answer is a few seconds old, so a change applies quickly", async () => {
        let allowed = true;
        const fetchMock = vi.fn(
            async () => ({ ok: true, json: async () => ({ screenshots: allowed }) }) as Response
        );
        vi.stubGlobal("fetch", fetchMock);
        const policy = createPolicy({ baseUrl: "http://localhost:4747" });
        expect(await policy.screenshots()).toBe(true);
        allowed = false;
        expect(await policy.screenshots()).toBe(true); // fresh enough: not asked again
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(6_000);
        expect(await policy.screenshots()).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps the last answer when the server cannot be reached or answers badly", async () => {
        vi.stubGlobal("fetch", answer({ screenshots: false }));
        const policy = createPolicy({ baseUrl: "http://localhost:4747" });
        expect(await policy.screenshots()).toBe(false);
        vi.advanceTimersByTime(6_000);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Promise.reject(new Error("down")))
        );
        expect(await policy.screenshots()).toBe(false);
        vi.advanceTimersByTime(6_000);
        vi.stubGlobal("fetch", answer({ screenshots: "maybe" }));
        expect(await policy.screenshots()).toBe(false);
        vi.advanceTimersByTime(6_000);
        vi.stubGlobal("fetch", answer({}, false));
        expect(await policy.screenshots()).toBe(false);
    });

    it("does not hold up an annotation for a slow server", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => new Promise<Response>(() => {}))
        );
        const policy = createPolicy({ baseUrl: "http://localhost:4747" });
        const pending = policy.screenshots();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await pending).toBe(true);
    });

    it("never calls out when there is no server", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const policy = createPolicy({ baseUrl: undefined });
        expect(await policy.screenshots()).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("asks once at a time", async () => {
        const fetchMock = answer({ screenshots: true });
        vi.stubGlobal("fetch", fetchMock);
        const policy = createPolicy({ baseUrl: "http://localhost:4747" });
        await Promise.all([policy.refresh(), policy.refresh(), policy.screenshots()]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe("screenshotPlugin with screenshots off", () => {
    const draft = (putAsset = vi.fn()) =>
        ({
            number: 3,
            mode: "dev",
            elements: [],
            rect: { x: 0, y: 0, w: 1, h: 1 },
            kind: "area",
            putAsset,
        }) as unknown as DraftAnnotation;

    it("makes no screenshot and stores no bytes, but keeps the pin number", async () => {
        const putAsset = vi.fn();
        const result = await screenshotPlugin({ enabled: () => false }).capture(draft(putAsset));
        expect(result?.screenshots).toBeUndefined();
        expect(result?.context).toEqual({ screenshot: { method: "off", pin: 3 } });
        expect(putAsset).not.toHaveBeenCalled();
    });

    it("asks each time, and an answer that arrives later still counts", async () => {
        const result = await screenshotPlugin({ enabled: async () => false }).capture(draft());
        expect(result?.screenshots).toBeUndefined();
    });

    it("does not use real pixels a driver supplied either", async () => {
        const withPixels = { ...draft(), screenshot: "iVBORw0KGgo=" } as unknown as DraftAnnotation;
        const result = await screenshotPlugin({ enabled: () => false }).capture(withPixels);
        expect(result?.screenshots).toBeUndefined();
    });
});
