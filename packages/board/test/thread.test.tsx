import { describe, expect, it } from "bun:test";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { renderToStaticMarkup } from "react-dom/server";

// ui.tsx loads the theme, which marks the page's root element as soon as it loads: give it one to mark.
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { Thread } = await import("../src/Thread.tsx");

const html = (thread: Annotation["thread"], over: Partial<Annotation> = {}) =>
    renderToStaticMarkup(<Thread annotation={{ ...sampleAnnotation, ...over, thread }} />);

describe("a note's thread", () => {
    it("says who turned People only on, in one sentence", () => {
        const out = html([
            {
                id: "r1",
                author: { kind: "human", name: "Ada" },
                body: "Turned People only on.",
                createdAt: "2026-10-01T10:00:00.000Z",
                automatic: true,
                peopleOnly: true,
            },
        ]);
        expect(out).toContain('<li class="event">');
        expect(out).toContain("<strong>Ada </strong>turned People only on.");
    });

    it("draws an aside apart from what the agent is told", () => {
        const out = html([
            {
                id: "r1",
                author: { kind: "human", name: "Ada" },
                body: "Between us: this is the old logo.",
                createdAt: "2026-10-01T10:00:00.000Z",
                aside: true,
            },
            {
                id: "r2",
                author: { kind: "agent", name: "Claude" },
                body: "Fixed.",
                createdAt: "2026-10-01T11:00:00.000Z",
            },
        ]);
        expect(out).toContain('class="message aside"');
        expect(out).toContain('class="aside-tag"');
        expect(out).toContain('class="message agent"');
    });

    it("says whether the agent will answer when nobody has yet", () => {
        expect(html([])).toContain("The agent answers here");
        expect(html([], { peopleOnly: true })).toContain("This note is between people");
    });
});
