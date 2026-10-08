// @vitest-environment happy-dom
import {
    createEnvironmentInjector,
    type EnvironmentInjector,
    Injector,
    NgZone,
    PLATFORM_ID,
} from "@angular/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const destroy = vi.fn();
const createController = vi.fn(() => ({ destroy }));
vi.mock("@notato/browser", () => ({ createController }));

const { provideNotato } = await import("../src/index.ts");

/** An application's environment, as Angular makes it when it starts: its initializers run as it is created. */
const start = (
    platform: string,
    options: Parameters<typeof provideNotato>[0],
    zone?: { runOutsideAngular(fn: () => unknown): unknown }
) =>
    createEnvironmentInjector(
        [
            { provide: PLATFORM_ID, useValue: platform },
            ...(zone ? [{ provide: NgZone, useValue: zone }] : []),
            provideNotato(options),
        ],
        Injector.NULL as unknown as EnvironmentInjector
    );
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    createController.mockClear();
    destroy.mockClear();
    vi.restoreAllMocks();
});

describe("provideNotato", () => {
    it("starts the toolbar with the options when the app starts, and stops it with the app", async () => {
        const app = start("browser", { project: "shop", server: "http://localhost:4747" });
        await settle();
        expect(createController).toHaveBeenCalledWith({
            project: "shop",
            server: "http://localhost:4747",
        });
        app.destroy();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it("does nothing during server-side rendering", async () => {
        start("server", { project: "shop" });
        await settle();
        expect(createController).not.toHaveBeenCalled();
    });

    it("does nothing when turned off, and never starts if the app is gone before the toolbar loads", async () => {
        start("browser", { project: "shop", enabled: false });
        const gone = start("browser", { project: "shop" });
        gone.destroy();
        await settle();
        expect(createController).not.toHaveBeenCalled();
    });

    it("starts the toolbar outside Angular's zone, so what it does sets off no change detection", async () => {
        // A zone that holds on to what it is given: nothing may start until it runs it, outside Angular.
        let given: (() => unknown) | undefined;
        const zone = {
            runOutsideAngular: vi.fn((fn: () => unknown) => {
                given = fn;
            }),
        };
        start("browser", { project: "shop" }, zone);
        await settle();
        expect(zone.runOutsideAngular).toHaveBeenCalledOnce();
        expect(createController).not.toHaveBeenCalled();
        given?.();
        await settle();
        expect(createController).toHaveBeenCalledOnce();
    });

    it("says why when the toolbar cannot start, instead of failing silently", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        createController.mockImplementationOnce(() => {
            throw new Error("no document.body yet");
        });
        start("browser", { project: "shop" });
        await settle();
        expect(warn).toHaveBeenCalledWith(
            "[notato] the toolbar could not start",
            expect.objectContaining({ message: "no document.body yet" })
        );
    });
});
