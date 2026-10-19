import { afterEach, describe, expect, it, vi } from "vitest";
import { notatoEnvironment, parseSwitch, readEnvironment } from "../src/env.ts";

afterEach(() => vi.unstubAllEnvs());

describe("the environment's switch", () => {
    it("is on for true, 1, yes and on, and off for false, 0, no and off, in any case and with spaces", () => {
        for (const on of ["true", "1", "yes", "on", "TRUE", " True "])
            expect(parseSwitch(on), on).toBe(true);
        for (const off of ["false", "0", "no", "off", "FALSE", " Off "])
            expect(parseSwitch(off), off).toBe(false);
    });

    it("is not set by anything else, so the app's own props decide", () => {
        for (const other of ["", " ", "maybe", "2", undefined, null, 1])
            expect(parseSwitch(other)).toBeUndefined();
    });

    it("takes a boolean as it is, for a bundler that defines one", () => {
        expect(parseSwitch(true)).toBe(true);
        expect(parseSwitch(false)).toBe(false);
    });
});

describe("readEnvironment", () => {
    it("reads VITE_NOTATO and VITE_NOTATO_SERVER", () => {
        expect(
            readEnvironment({ VITE_NOTATO: "true", VITE_NOTATO_SERVER: " http://localhost:4800 " })
        ).toEqual({ enabled: true, server: "http://localhost:4800" });
    });

    it("sets nothing for an empty server, or where there is no import.meta.env", () => {
        expect(readEnvironment({ VITE_NOTATO_SERVER: "  " })).toEqual({
            enabled: undefined,
            server: undefined,
        });
        expect(readEnvironment(undefined)).toEqual({ enabled: undefined, server: undefined });
    });
});

describe("notatoEnvironment", () => {
    it("reads what the bundler put in import.meta.env", () => {
        vi.stubEnv("VITE_NOTATO", "false");
        vi.stubEnv("VITE_NOTATO_SERVER", "http://localhost:4801");
        expect(notatoEnvironment()).toEqual({ enabled: false, server: "http://localhost:4801" });
    });

    it("says nothing when neither is set", () => {
        vi.stubEnv("VITE_NOTATO", undefined);
        vi.stubEnv("VITE_NOTATO_SERVER", undefined);
        expect(notatoEnvironment()).toEqual({ enabled: undefined, server: undefined });
    });
});
