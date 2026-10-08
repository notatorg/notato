import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import schemaJson from "../schema.json";
import { Annotation, Bundle, sampleAnnotation, sampleBundle } from "../src/index.ts";

describe("zod schema", () => {
    it("round-trips an annotation through JSON", () => {
        const parsed = Annotation.parse(JSON.parse(JSON.stringify(sampleAnnotation)));
        expect(parsed).toEqual(sampleAnnotation);
    });

    it("round-trips a bundle through JSON", () => {
        const parsed = Bundle.parse(JSON.parse(JSON.stringify(sampleBundle)));
        expect(parsed).toEqual(sampleBundle);
    });

    it("rejects an unknown schemaVersion", () => {
        expect(Bundle.safeParse({ ...sampleBundle, schemaVersion: 2 }).success).toBe(false);
    });

    it("rejects a bad severity and a missing comment", () => {
        expect(Annotation.safeParse({ ...sampleAnnotation, severity: "huge" }).success).toBe(false);
        const { comment: _comment, ...noComment } = sampleAnnotation;
        expect(Annotation.safeParse(noComment).success).toBe(false);
    });
});

describe("what was added for intent, source and context", () => {
    const parse = (over: Record<string, unknown>) =>
        Annotation.safeParse({ ...sampleAnnotation, ...over });

    it("accepts the five intents and nothing else, and an annotation without one", () => {
        for (const intent of ["fix", "change", "question", "approve", "variants"])
            expect(parse({ intent }).success, intent).toBe(true);
        expect(parse({ intent: "shrug" }).success).toBe(false);
        expect(parse({ intent: undefined }).success).toBe(true);
    });

    it("accepts the seven statuses", () => {
        for (const status of [
            "open",
            "acknowledged",
            "variant_chosen",
            "resolved",
            "revert_requested",
            "reverted",
            "dismissed",
        ])
            expect(parse({ status }).success, status).toBe(true);
        expect(parse({ status: "pending" }).success).toBe(false);
    });

    it("does not need screenshots, because they can be switched off", () => {
        const { screenshots: _screenshots, ...without } = sampleAnnotation;
        expect(Annotation.safeParse(without).success).toBe(true);
    });

    it("carries source, component path, styles, ancestors and the hops to an element in a frame or a shadow root", () => {
        const first = sampleAnnotation.target.identity[0];
        if (!first) throw new Error("fixture has no identity");
        const identity = {
            ...first,
            source: { file: "src/Pay.tsx", line: 12, col: 5, nearest: true },
            component: { name: "PayButton", path: ["PayButton", "Checkout"] },
            styles: { color: "#fff" },
            ancestors: ["main", "form"],
            within: [
                { kind: "frame", selector: "iframe#a" },
                { kind: "shadow", selector: "my-widget" },
            ],
        };
        const parsed = parse({ target: { ...sampleAnnotation.target, identity: [identity] } });
        expect(parsed.success).toBe(true);
        expect(parsed.data?.target.identity[0]).toEqual(identity);
    });

    it("refuses a hop it does not know, and a source that is not a position", () => {
        const first = sampleAnnotation.target.identity[0];
        if (!first) throw new Error("fixture has no identity");
        const bad = (extra: Record<string, unknown>) =>
            parse({ target: { ...sampleAnnotation.target, identity: [{ ...first, ...extra }] } })
                .success;
        expect(bad({ within: [{ kind: "portal", selector: "x" }] })).toBe(false);
        expect(bad({ source: { file: "a.tsx", line: "12", col: 5 } })).toBe(false);
    });
});

describe("variants", () => {
    const offer = {
        group: "hero",
        options: [{ name: "Original" }, { name: "Stacked", summary: "Image above the text" }],
        offeredAt: "2026-10-05T10:00:00.000Z",
    };
    const parse = (variants: unknown) => Annotation.safeParse({ ...sampleAnnotation, variants });

    it("is an offer of at least two options, with the pick once made", () => {
        expect(parse(offer).success).toBe(true);
        expect(
            parse({ ...offer, chosen: "Stacked", chosenAt: "2026-10-05T10:05:00.000Z" }).success
        ).toBe(true);
        expect(parse({ ...offer, options: [{ name: "Original" }] }).success).toBe(false);
        expect(parse({ ...offer, options: [] }).success).toBe(false);
    });

    it("refuses a group name that cannot be written as an attribute value safely, and over-long names", () => {
        for (const group of ["", "has space", 'quote"', "-leading", "a".repeat(65)])
            expect(parse({ ...offer, group }).success, group).toBe(false);
        expect(
            parse({ ...offer, options: [{ name: "x".repeat(41) }, { name: "y" }] }).success
        ).toBe(false);
        expect(parse({ ...offer, options: [{ name: "" }, { name: "y" }] }).success).toBe(false);
    });

    it("is optional, and is in schema.json", () => {
        expect(Annotation.safeParse(sampleAnnotation).success).toBe(true);
        expect(Object.keys(schemaJson.definitions)).toContain("Variants");
    });
});

describe("generated schema.json", () => {
    const ajv = new Ajv({ strict: false });
    ajv.addSchema(schemaJson, "notato");

    const validate = (name: string, value: unknown) => {
        const fn = ajv.getSchema(`notato#/definitions/${name}`);
        if (!fn) throw new Error(`definition ${name} missing from schema.json`);
        const ok = fn(value) as boolean;
        return { ok, errors: fn.errors };
    };

    it("accepts an intent and refuses one that is not", () => {
        expect(validate("Annotation", { ...sampleAnnotation, intent: "question" }).ok).toBe(true);
        expect(validate("Annotation", { ...sampleAnnotation, intent: "shrug" }).ok).toBe(false);
    });

    it("validates the sample annotation and bundle", () => {
        expect(validate("Annotation", sampleAnnotation).ok).toBe(true);
        expect(validate("Bundle", sampleBundle).ok).toBe(true);
    });

    it("rejects what zod rejects", () => {
        expect(validate("Annotation", { ...sampleAnnotation, severity: "huge" }).ok).toBe(false);
        expect(validate("Bundle", { ...sampleBundle, schemaVersion: 2 }).ok).toBe(false);
    });
});
