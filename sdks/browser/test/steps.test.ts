// @vitest-environment happy-dom
import type { CapturePlugin, DraftAnnotation } from "@notato/core";
import type { AgentStep } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobFromBase64, ROOT_ATTR } from "../src/plugins/screenshot.ts";
import { stepsPlugin } from "../src/plugins/steps.ts";

const draft = (over: Partial<DraftAnnotation> = {}) => ({ ...over }) as DraftAnnotation;
let teardown: (() => void) | undefined;
let plugin: CapturePlugin;

const start = (options?: Parameters<typeof stepsPlugin>[0]) => {
    plugin = stepsPlugin(options);
    teardown = plugin.setup?.() as (() => void) | undefined;
};
const steps = async (d = draft()) => ((await plugin.capture(d))?.steps ?? []) as AgentStep[];

beforeEach(() => {
    document.body.innerHTML = `
    <button data-testid="pay">Pay</button>
    <input id="card" name="card" value="4242 4242 4242 4242">
    <input id="agree" type="checkbox">
    <select id="size"><option>S</option><option>M</option></select>
    <form id="f"><button type="submit" id="go">Go</button></form>`;
});
afterEach(() => {
    teardown?.();
    teardown = undefined;
});

const $ = (selector: string) => document.querySelector(selector) as HTMLElement;

describe("stepsPlugin", () => {
    it("records clicks, toggles, selects, inputs and submits with unique selectors, in order", async () => {
        start();
        $("[data-testid=pay]").click();
        $("#agree").dispatchEvent(new Event("change", { bubbles: true }));
        $("#size").dispatchEvent(new Event("change", { bubbles: true }));
        $("#card").dispatchEvent(new Event("change", { bubbles: true }));
        $("#f").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        const recorded = await steps();
        expect(recorded.map((s) => [s.action, s.target])).toEqual([
            ["click", '[data-testid="pay"]'],
            ["toggle", "#agree"],
            ["select", "#size"],
            ["input", "#card"],
            ["submit", "#f"],
        ]);
        expect(recorded.every((s) => !Number.isNaN(Date.parse(s.at)))).toBe(true);
    });

    it("never records what was typed or selected", async () => {
        start();
        ($("#card") as HTMLInputElement).value = "5555 5555 5555 4444";
        $("#card").dispatchEvent(new Event("change", { bubbles: true }));
        expect(JSON.stringify(await steps())).not.toContain("5555");
        expect(JSON.stringify(await steps())).not.toContain("4242");
        expect((await steps()).every((s) => s.value === undefined)).toBe(true);
    });

    it("records route changes, including pushState", async () => {
        start();
        window.history.pushState({}, "", "/orders");
        window.history.replaceState({}, "", "/orders?x=1");
        const recorded = await steps();
        expect(recorded.map((s) => s.action)).toEqual(["navigate", "navigate"]);
        expect(recorded[0]?.value).toBe("/orders");
    });

    it("covers only what happened since the last annotation", async () => {
        start();
        $("[data-testid=pay]").click();
        expect(await steps()).toHaveLength(1);
        expect(await steps()).toHaveLength(0);
        // Clicking a submit button is a click and then a submit, and both are steps.
        $("#go").click();
        expect((await steps()).map((s) => s.action)).toEqual(["click", "submit"]);
    });

    it("yields to steps the agent supplied, but still clears its buffer", async () => {
        start();
        $("[data-testid=pay]").click();
        expect(
            await plugin.capture(draft({ steps: [{ action: "click", at: "t" }] }))
        ).toBeUndefined();
        expect(await steps()).toHaveLength(0);
    });

    it("caps the buffer and drops the oldest", async () => {
        start({ limit: 3 });
        for (let i = 0; i < 5; i++) $("[data-testid=pay]").click();
        expect(await steps()).toHaveLength(3);
    });

    it("ignores Notato's own UI", async () => {
        start();
        const host = document.createElement("div");
        host.setAttribute(ROOT_ATTR, "");
        const inner = document.createElement("button");
        host.append(inner);
        document.body.append(host);
        inner.click();
        expect(await steps()).toHaveLength(0);
    });

    it("stops listening and restores history on teardown", async () => {
        const { pushState } = window.history;
        start();
        expect(window.history.pushState).not.toBe(pushState);
        teardown?.();
        teardown = undefined;
        expect(window.history.pushState).toBe(pushState);
        $("[data-testid=pay]").click();
        expect(await steps()).toHaveLength(0);
    });
});

describe("blobFromBase64", () => {
    const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
    const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0];
    const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

    it("types each format by its magic bytes", () => {
        expect(blobFromBase64(b64(PNG)).type).toBe("image/png");
        expect(blobFromBase64(b64(JPEG)).type).toBe("image/jpeg");
        expect(blobFromBase64(b64(WEBP)).type).toBe("image/webp");
    });

    it("accepts a data URL and tolerates whitespace", () => {
        const text = b64(PNG);
        expect(
            blobFromBase64(`data:image/png;base64,${text.slice(0, 6)}\n${text.slice(6)}`).type
        ).toBe("image/png");
    });

    it("preserves the bytes", async () => {
        const blob = blobFromBase64(b64(PNG));
        expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(PNG);
    });

    it("rejects anything that is not a supported image", () => {
        expect(() => blobFromBase64(btoa("<html>"))).toThrow(/PNG, WebP or JPEG/);
        expect(() => blobFromBase64("%%%not base64%%%")).toThrow();
    });
});
