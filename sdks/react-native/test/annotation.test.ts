import { Annotation } from "@notato/schema";
import { describe, expect, it } from "vitest";
import { appUrl, buildAnnotation } from "../src/annotation.ts";
import { ulid } from "../src/ids.ts";
import { SDK } from "../src/version.ts";

const shot = (id: string, w: number, h: number) => ({
    bytes: new Uint8Array([1]),
    ref: { id, mime: "image/png" as const, w, h },
});

describe("buildAnnotation", () => {
    it("makes a note the server's own schema takes", () => {
        const note = buildAnnotation({
            project: "shop",
            appName: "Spud Shop",
            appVersion: "1.2.0",
            route: "Checkout",
            author: "Ada",
            identity: { selector: "ProductCard > Text", tag: "Text", text: "Add to basket" },
            rect: { x: 47.238, y: 143.619, w: 86.857, h: 19.428 },
            comment: "  The label should say the price  ",
            intent: "change",
            severity: "minor",
            pin: 3,
            screenshots: {
                full: shot("01ABC-full", 1080, 2400),
                crop: shot("01ABC-crop", 260, 58),
            },
            device: {
                os: "android",
                osVersion: "36",
                reactNative: "0.86.3",
                viewport: { w: 411.43, h: 914.29 },
                dpr: 2.625,
            },
        });
        const parsed = Annotation.safeParse(note);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        expect(note).toMatchObject({
            projectId: "shop",
            mode: "dev",
            url: "react-native://spud-shop/Checkout",
            comment: "The label should say the price",
            environment: { platform: "react-native", sdk: SDK, dpr: 2.625 },
            target: { kind: "element", rect: { x: 47.24, y: 143.62, w: 86.86, h: 19.43 } },
            screenshots: {
                full: { id: "01ABC-full", w: 1080, h: 2400 },
                crop: { id: "01ABC-crop" },
            },
            context: { screenshot: { method: "native", pin: 3 } },
            status: "open",
            bundleId: null,
        });
        expect(note.environment.userAgent).toBe("Spud Shop/1.2.0 (android 36) React Native/0.86.3");
    });

    it("is still a valid note with no screenshots and nothing optional", () => {
        const note = buildAnnotation({
            project: "shop",
            appName: "Shop",
            route: "/",
            identity: { selector: "View", tag: "View" },
            rect: { x: 0, y: 0, w: 10, h: 10 },
            comment: "Too tight",
            pin: 1,
            device: { os: "ios", osVersion: "26.3", viewport: { w: 402, h: 874 }, dpr: 3 },
        });
        expect(Annotation.safeParse(note).success).toBe(true);
        expect(note.screenshots).toBeUndefined();
        expect(appUrl("Shop", "/")).toBe("react-native://shop/");
    });
});

describe("an agent's note, People only and context", () => {
    const base = {
        project: "shop",
        appName: "Shop",
        route: "/",
        identity: { selector: "View", tag: "View" },
        rect: { x: 0, y: 0, w: 10, h: 10 },
        comment: "x",
        pin: 1,
        device: { os: "ios", osVersion: "26.3", viewport: { w: 402, h: 874 }, dpr: 3 },
    };

    it("is the agent's when an agent makes it, and never kept from the agent", () => {
        const note = buildAnnotation({
            ...base,
            mode: "agent",
            agentName: "Claude",
            peopleOnly: true,
            steps: [{ action: "tap", target: "#pay", at: "2026-10-07T10:00:00Z" }],
        });
        expect(note).toMatchObject({
            mode: "agent",
            author: { kind: "agent", name: "Claude" },
            steps: [{ action: "tap" }],
        });
        expect(note.peopleOnly).toBeUndefined();
        expect(Annotation.safeParse(note).success).toBe(true);
    });

    it("carries People only, the app's warnings and its requests", () => {
        const note = buildAnnotation({
            ...base,
            peopleOnly: true,
            console: [{ level: "error", message: "boom", at: "2026-10-07T10:00:00Z" }],
            network: [
                {
                    method: "GET",
                    url: "https://api.example.com/basket",
                    status: 500,
                    durationMs: 120,
                    at: "2026-10-07T10:00:00Z",
                },
            ],
        });
        expect(note.peopleOnly).toBe(true);
        expect(note.context).toMatchObject({
            console: [{ message: "boom" }],
            network: [{ status: 500 }],
        });
        expect(Annotation.safeParse(note).success).toBe(true);
    });
});

describe("ulid", () => {
    it("is 26 Crockford characters that sort by time", () => {
        const a = ulid(1_700_000_000_000);
        const b = ulid(1_700_000_000_001);
        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(a < b).toBe(true);
    });
});
