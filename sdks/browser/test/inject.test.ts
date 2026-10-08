// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const created = vi.fn();
vi.mock("../src/controller.ts", () => ({ createController: created }));

afterEach(() => {
    window.__NOTATO_CONFIG__ = undefined;
    vi.resetModules();
    created.mockReset();
});

describe("the injected script", () => {
    it("loaded in the <head>, waits for the body before putting Notato on the page", async () => {
        const body = document.body;
        body.remove(); // what a script in the <head> sees: no body yet
        window.__NOTATO_CONFIG__ = { server: "http://localhost:4801/", project: "shop" };
        await import("../src/inject.ts");
        expect(created).not.toHaveBeenCalled();
        document.documentElement.append(body);
        document.dispatchEvent(new Event("DOMContentLoaded"));
        expect(created).toHaveBeenCalledTimes(1);
        expect(created.mock.calls[0]?.[0]).toMatchObject({
            server: "http://localhost:4801",
            project: "shop",
            mode: "dev",
        });
    });

    it("starts at once when there is a body already", async () => {
        window.__NOTATO_CONFIG__ = { server: "http://localhost:4801" };
        await import("../src/inject.ts");
        expect(created).toHaveBeenCalledTimes(1);
    });

    it("gives Notato's styles the nonce the page let the script in with", async () => {
        const script = document.createElement("script");
        script.nonce = "s3cr3t";
        Object.defineProperty(document, "currentScript", { configurable: true, value: script });
        window.__NOTATO_CONFIG__ = { server: "http://localhost:4801" };
        await import("../src/inject.ts");
        Reflect.deleteProperty(document, "currentScript");
        expect(created.mock.calls[0]?.[0]).toMatchObject({ nonce: "s3cr3t" });
    });
});
