// @vitest-environment happy-dom
import { Annotation, sampleAnnotation } from "@notato/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
    parseSource,
    SOURCE_ATTRIBUTE,
    sourceAttributeIdentityPlugin,
} from "../src/plugins/identity-source.ts";

afterEach(() => {
    document.body.replaceChildren();
});
const plugin = sourceAttributeIdentityPlugin();
const html = (markup: string) => {
    document.body.innerHTML = markup;
    return document.body;
};

describe("parseSource", () => {
    it("splits path, line and column", () => {
        expect(parseSource("public/src/features/Invite.tsx:558:9")).toEqual({
            file: "public/src/features/Invite.tsx",
            line: 558,
            col: 9,
        });
    });
    it("keeps colons that are part of the path", () => {
        expect(parseSource("C:/work/app/src/A.tsx:3:1")).toEqual({
            file: "C:/work/app/src/A.tsx",
            line: 3,
            col: 1,
        });
    });
    it("rejects anything else", () => {
        for (const bad of [
            null,
            undefined,
            "",
            "src/A.tsx",
            "src/A.tsx:3",
            "src/A.tsx:x:1",
            "src/A.tsx:0:1",
            "src/A.tsx:1:0",
        ])
            expect(parseSource(bad), String(bad)).toBeUndefined();
    });
});

describe("sourceAttributeIdentityPlugin", () => {
    it("reads the position the Vite plugin wrote on the element itself", () => {
        const body = html(`<h1 ${SOURCE_ATTRIBUTE}="public/src/Invite.tsx:12:5">Title</h1>`);
        expect(plugin.resolve(body.querySelector("h1") as Element)).toEqual({
            source: { file: "public/src/Invite.tsx", line: 12, col: 5 },
        });
    });

    it("takes the nearest tagged element around one that is not tagged, and says so", () => {
        const body = html(
            `<section ${SOURCE_ATTRIBUTE}="app/src/Panel.tsx:4:3"><div><span class="from-a-library">x</span></div></section>`
        );
        expect(plugin.resolve(body.querySelector("span") as Element)).toEqual({
            source: { file: "app/src/Panel.tsx", line: 4, col: 3, nearest: true },
        });
    });

    it("prefers the element's own position over a parent's", () => {
        const body = html(
            `<div ${SOURCE_ATTRIBUTE}="a.tsx:1:1"><p ${SOURCE_ATTRIBUTE}="a.tsx:2:3">t</p></div>`
        );
        expect(plugin.resolve(body.querySelector("p") as Element)).toEqual({
            source: { file: "a.tsx", line: 2, col: 3 },
        });
    });

    it("says nothing when the page was not built with the plugin, or the attribute is malformed", () => {
        const body = html(`<div><p>plain</p></div><b ${SOURCE_ATTRIBUTE}="garbage">x</b>`);
        expect(plugin.resolve(body.querySelector("p") as Element)).toEqual({});
        expect(plugin.resolve(body.querySelector("b") as Element)).toEqual({});
    });

    it("is an identity the schema keeps, so it reaches the server and Claude", () => {
        const parsed = Annotation.safeParse({
            ...sampleAnnotation,
            target: {
                ...sampleAnnotation.target,
                identity: [
                    {
                        selector: "#a",
                        tag: "h1",
                        source: { file: "public/src/Invite.tsx", line: 12, col: 5 },
                    },
                    {
                        selector: "#b",
                        tag: "span",
                        source: { file: "x.tsx", line: 1, col: 1, nearest: true },
                    },
                ],
            },
        });
        expect(parsed.success).toBe(true);
        const identity = parsed.success ? parsed.data.target.identity : [];
        expect(identity[0]?.source).toEqual({ file: "public/src/Invite.tsx", line: 12, col: 5 });
        expect(identity[1]?.source?.nearest).toBe(true);
    });

    it("is refused when it is not a real position", () => {
        const bad = Annotation.safeParse({
            ...sampleAnnotation,
            target: {
                ...sampleAnnotation.target,
                identity: [{ selector: "#a", tag: "h1", source: { file: "x", line: 0, col: 1 } }],
            },
        });
        expect(bad.success).toBe(false);
    });
});
