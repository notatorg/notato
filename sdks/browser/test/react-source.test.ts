// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
    componentName,
    firstAppFrame,
    formatFrame,
    normalisePath,
    reactSourceIdentityPlugin,
} from "../src/plugins/identity-react-source.ts";
import {
    clearSourceMapCache,
    decodeMappings,
    loadSourceMap,
    originalPosition,
    parseSourceMap,
    warmSourceMap,
} from "../src/plugins/sourcemap.ts";

afterEach(clearSourceMapCache);

/** Encodes one VLQ number, to build maps by hand. */
function vlq(n: number): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let v = n < 0 ? (-n << 1) | 1 : n << 1;
    let out = "";
    do {
        let digit = v & 31;
        v >>>= 5;
        if (v > 0) digit |= 32;
        out += chars[digit];
    } while (v > 0);
    return out;
}
const segment = (...fields: number[]) => fields.map(vlq).join("");

describe("source map decoding", () => {
    it("decodes relative VLQ segments across lines", () => {
        // line 0: genCol 0 -> src 0 line 0 col 0 ; genCol 5 -> line 0 col 8
        // line 1: genCol 2 -> src 0 line 3 col 4 (deltas are relative to the previous segment)
        const mappings = `${segment(0, 0, 0, 0)},${segment(5, 0, 0, 8)};${segment(2, 0, 3, -4)}`;
        const lines = decodeMappings(mappings);
        expect(lines[0]).toEqual([
            { col: 0, source: 0, line: 0, scol: 0 },
            { col: 5, source: 0, line: 0, scol: 8 },
        ]);
        expect(lines[1]).toEqual([{ col: 2, source: 0, line: 3, scol: 4 }]);
    });

    it("maps a 1-based generated position to the closest earlier segment", () => {
        const map = parseSourceMap(
            JSON.stringify({
                sources: ["/src/App.tsx"],
                mappings: `${segment(0, 0, 0, 0)},${segment(10, 0, 4, 6)}`,
            })
        );
        expect(map && originalPosition(map, 1, 11)).toEqual({
            source: "/src/App.tsx",
            line: 5,
            col: 7,
        });
        expect(map && originalPosition(map, 1, 3)).toEqual({
            source: "/src/App.tsx",
            line: 1,
            col: 1,
        });
        expect(map && originalPosition(map, 9, 1)).toBeNull();
    });

    it("ignores segments without a source", () => {
        expect(decodeMappings(segment(4))[0]).toEqual([]);
    });

    it("rejects malformed maps", () => {
        expect(parseSourceMap(JSON.stringify({ nope: true }))).toBeNull();
        expect(() => decodeMappings("!!!")).toThrow();
    });
});

describe("loading source maps", () => {
    const map = { version: 3, sources: ["/work/app/src/App.tsx"], mappings: segment(0, 0, 41, 2) };
    const inline = (json: object) =>
        `export const x = 1\n//# sourceMappingURL=data:application/json;base64,${btoa(JSON.stringify(json))}\n`;
    const respond = (body: string) => async () => new Response(body);

    it("reads an inline base64 map", async () => {
        const parsed = await loadSourceMap("http://x/a.js", respond(inline(map)));
        expect(parsed && originalPosition(parsed, 1, 1)?.line).toBe(42);
    });

    it("follows a sibling .map file", async () => {
        const seen: string[] = [];
        const fetcher = async (url: string) => {
            seen.push(url);
            return new Response(
                url.endsWith(".map") ? JSON.stringify(map) : "code\n//# sourceMappingURL=a.js.map"
            );
        };
        await loadSourceMap("http://x/src/a.js", fetcher);
        expect(seen).toEqual(["http://x/src/a.js", "http://x/src/a.js.map"]);
    });

    it("resolves null, never rejects, when the module has no map or the fetch fails", async () => {
        expect(await loadSourceMap("http://x/none.js", respond("no map here"))).toBeNull();
        clearSourceMapCache();
        const boom = async () => {
            throw new Error("offline");
        };
        expect(await loadSourceMap("http://x/boom.js", boom)).toBeNull();
    });

    it("fetches each module once", async () => {
        let calls = 0;
        const fetcher = async () => {
            calls += 1;
            return new Response(inline(map));
        };
        await Promise.all([
            loadSourceMap("http://x/b.js", fetcher),
            loadSourceMap("http://x/b.js", fetcher),
        ]);
        expect(calls).toBe(1);
    });

    it("formatFrame reports the original line once the map is warm, the served line before", async () => {
        const frame = { url: "http://localhost:5173/src/App.tsx?t=1", line: 1, col: 1 };
        const page = "http://localhost:5173";
        expect(formatFrame(frame, page)).toBe("src/App.tsx:1:1");
        await warmSourceMap(frame.url, respond(inline(map)));
        expect(formatFrame(frame, page)).toBe("src/App.tsx:42:3");
    });
});

describe("stack parsing", () => {
    const stack = [
        "Error: react-stack-top-frame",
        "    at jsxDEV_vfb3qa (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=abc:250:50)",
        "    at Checkout (http://localhost:5173/src/App.tsx?t=1760000000:229:88)",
        "    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js:1:1)",
    ].join("\n");

    it("skips React's own frames and returns the first app frame", () => {
        expect(firstAppFrame(stack)).toEqual({
            url: "http://localhost:5173/src/App.tsx?t=1760000000",
            line: 229,
            col: 88,
        });
    });

    it("returns undefined when only internal frames exist", () => {
        expect(firstAppFrame("at x (http://h/node_modules/react/index.js:1:1)")).toBeUndefined();
    });

    it("keeps the origin of a module served by another app, so a federated remote can be told apart", () => {
        const page = "http://localhost:5000";
        expect(normalisePath("http://localhost:5005/assets/Invite-Bs1.js?t=1", page)).toBe(
            "http://localhost:5005/assets/Invite-Bs1.js"
        );
        expect(normalisePath("http://localhost:5000/src/App.tsx", page)).toBe("src/App.tsx");
        expect(
            formatFrame(
                { url: "http://localhost:5005/assets/Invite-Bs1.js", line: 257, col: 28 },
                page
            )
        ).toBe("http://localhost:5005/assets/Invite-Bs1.js:257:28");
    });

    it("normalises urls to root-relative paths", () => {
        expect(normalisePath("http://localhost:5173/src/App.tsx?t=1#x")).toBe("src/App.tsx");
        expect(normalisePath("http://localhost:5173/@fs/Users/me/app/src/App.tsx")).toBe(
            "Users/me/app/src/App.tsx"
        );
    });
});

describe("component names", () => {
    it("handles function, memo, forwardRef and anonymous components", () => {
        function Card() {}
        expect(componentName(Card)).toBe("Card");
        expect(componentName({ type: Card })).toBe("Card");
        expect(componentName({ render: Card })).toBe("Card");
        expect(componentName({ displayName: "Named" })).toBe("Named");
        expect(componentName("div")).toBeUndefined();
        expect(componentName(null)).toBeUndefined();
    });
});

describe("reactSourceIdentityPlugin", () => {
    const plugin = reactSourceIdentityPlugin();
    const withFiber = (fiber: unknown) => {
        const el = document.createElement("button");
        (el as unknown as Record<string, unknown>).__reactFiber$abc = fiber;
        return el;
    };

    it("fails silently without a fiber", () => {
        expect(plugin.resolve(document.createElement("div"))).toEqual({});
    });

    it("reads React 18 _debugSource from the owner", () => {
        function PayButton() {}
        const owner = {
            type: PayButton,
            _debugSource: { fileName: "/app/src/Pay.tsx", lineNumber: 12, columnNumber: 5 },
        };
        const host = { type: "button", _debugOwner: owner, return: owner };
        expect(plugin.resolve(withFiber(host))).toEqual({
            component: { name: "PayButton", source: "/app/src/Pay.tsx:12:5" },
        });
    });

    it("falls back to the nearest ancestor component when there is no owner", () => {
        function Panel() {}
        const host = { type: "button", return: { type: "div", return: { type: Panel } } };
        expect(plugin.resolve(withFiber(host))).toEqual({ component: { name: "Panel" } });
    });

    it("never throws on a hostile fiber", () => {
        const evil = new Proxy(
            {},
            {
                get: () => {
                    throw new Error("boom");
                },
            }
        );
        expect(plugin.resolve(withFiber(evil))).toEqual({});
    });
});
