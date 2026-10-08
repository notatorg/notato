import { describe, expect, it } from "bun:test";
import { knownAgent } from "@notato/core";
import { renderToStaticMarkup } from "react-dom/server";

// ui.tsx loads the theme, which marks the page's root element as soon as it loads: give it one to mark.
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { Avatar } = await import("../src/ui.tsx");

const html = (author: { kind: string; name?: string }) =>
    renderToStaticMarkup(<Avatar author={author} size={30} />);

describe("avatars", () => {
    it("draws a known agent's own logo on its colours, with its name to hover", () => {
        const claude = knownAgent("Claude");
        const out = html({ kind: "agent", name: "Claude" });
        expect(out).toContain('class="avatar brand"');
        expect(out).toContain("background:#d97757");
        expect(out).toContain('title="Claude"');
        expect(out).toContain(`<path d="${claude?.paths[0]}"`);
        expect(out).toContain('width="18"');
    });

    it("leaves a black-and-white logo's colours to the theme", () => {
        const out = html({ kind: "agent", name: "Cursor" });
        expect(out).toContain('class="avatar brand ink"');
        expect(out).not.toContain("background:");
        expect(out).toContain("<svg");
    });

    it("gives an agent it doesn't know its initial in the accent colour", () => {
        const out = html({ kind: "agent", name: "Robo" });
        expect(out).toContain('class="avatar agent"');
        expect(out).toContain(">R</span>");
        expect(out).not.toContain("<svg");
    });

    it("never gives a person an agent's logo, even one called Claude", () => {
        const out = html({ kind: "human", name: "Claude" });
        expect(out).toContain('class="avatar"');
        expect(out).toContain(">C</span>");
        expect(out).not.toContain("<svg");
    });
});
