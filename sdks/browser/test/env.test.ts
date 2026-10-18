import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEnvironment, notatoEnvironment, parseSwitch, readEnvironment } from "../src/env.ts";

afterEach(() => vi.unstubAllEnvs());

it("replaces server, project and app key together and clears stale credentials when returning locally", () => {
    const base = { project: "old", server: "https://old.example", token: "old-secret" };
    const remote = {
        name: "Cloud",
        mode: "remote",
        server: "https://cloud.example",
        project: "team",
        context: { id: "ctx-1", name: "My checkout", branch: "feature/cart" },
        token: "app-secret",
    };
    const env = readEnvironment({
        VITE_NOTATO_SERVER: "https://wrong.example",
        VITE_NOTATO_CONNECTION: JSON.stringify(remote),
    });
    const props = applyEnvironment(base, env);
    expect(props.server).toBe(remote.server);
    expect(props.project).toBe("team");
    expect(props.token).toBe("app-secret");
    expect(props.connection?.context?.name).toBe("My checkout");
    const local = applyEnvironment(
        props,
        readEnvironment({
            VITE_NOTATO_CONNECTION: JSON.stringify({
                name: "Local",
                mode: "local",
                server: "http://127.0.0.1:4893",
                project: "my-app",
            }),
        })
    );
    expect(local.token).toBeUndefined();
    expect(local.project).toBe("my-app");
    expect(local.connection?.mode).toBe("local");
});
it("refuses malformed or credential-contaminated browser profiles without falling back to inline props", () => {
    for (const raw of [
        "",
        "{bad}",
        JSON.stringify({ mode: "remote", name: "Cloud", server: "https://cloud.example" }),
        JSON.stringify({
            mode: "local",
            name: "Local",
            server: "http://127.0.0.1:4893",
            agentToken: "never-in-browser",
        }),
    ])
        expect(() => readEnvironment({ VITE_NOTATO_CONNECTION: raw })).toThrow("Capture stopped");
});
it("reads a Next public profile using literal environment names", () => {
    vi.stubEnv("VITE_NOTATO_CONNECTION", undefined);
    vi.stubEnv(
        "NEXT_PUBLIC_NOTATO_CONNECTION",
        JSON.stringify({ name: "Local", mode: "local", server: "http://127.0.0.1:4895" })
    );
    expect(notatoEnvironment().connection?.server).toBe("http://127.0.0.1:4895");
});

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
