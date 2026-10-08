import { describe, expect, it, vi } from "vitest";
import { metroOrigin, parseComponentStack, symbolicate } from "../src/stack.ts";

const BUNDLE =
    "http://127.0.0.1:8081/index.ts.bundle//&platform=android&dev=true&hot=false&lazy=true&transform.engine=hermes";
// The start of the component stack React Native 0.86 reported for the same tap.
const STACK = `
    at RCTText (<anonymous>)
    at Text (${BUNDLE}:60993:18)
    at ProductCard (${BUNDLE}:93102:3)
    at ProductList (<anonymous>)
    at App (${BUNDLE}:93135:34)`;

describe("the component stack", () => {
    it("reads the frames that have a place in the bundle, innermost first", () => {
        expect(parseComponentStack(STACK)).toEqual([
            { name: "Text", url: BUNDLE, line: 60993, col: 18 },
            { name: "ProductCard", url: BUNDLE, line: 93102, col: 3 },
            { name: "App", url: BUNDLE, line: 93135, col: 34 },
        ]);
        expect(parseComponentStack(undefined)).toEqual([]);
        expect(metroOrigin(parseComponentStack(STACK))).toBe("http://127.0.0.1:8081");
    });

    it("asks Metro where each frame is in the source, as 1-based columns", async () => {
        const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
            const sent = JSON.parse(String(init?.body)) as { stack: Array<{ lineNumber: number }> };
            expect(sent.stack.map((f) => f.lineNumber)).toEqual([60993, 93102, 93135]);
            return new Response(
                JSON.stringify({
                    stack: [
                        {
                            file: "/r/node_modules/react-native/Libraries/Text/Text.js",
                            lineNumber: 47,
                            column: 5,
                        },
                        { file: "/r/App.tsx", lineNumber: 4, column: 0 },
                        { file: "/r/App.tsx", lineNumber: 25, column: 30 },
                    ],
                })
            );
        });
        const sources = await symbolicate(parseComponentStack(STACK), fetcher as typeof fetch);
        expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8081/symbolicate");
        expect(sources[1]).toEqual({ name: "ProductCard", file: "/r/App.tsx", line: 4, col: 1 });
    });

    it("gives up quietly when Metro is not there or too slow", async () => {
        const frames = parseComponentStack(STACK);
        expect(
            await symbolicate(frames, (async () =>
                Promise.reject(new Error("down"))) as typeof fetch)
        ).toEqual([]);
        const never = ((_: string, init?: RequestInit) =>
            new Promise((_resolve, reject) =>
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
            )) as typeof fetch;
        expect(await symbolicate(frames, never, 20)).toEqual([]);
        expect(await symbolicate([], fetch)).toEqual([]);
    });
});
