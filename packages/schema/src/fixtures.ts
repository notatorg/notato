import type { Annotation, Bundle } from "./index.ts";

/** A fully populated annotation: for tests, and for the samples `notato doctor`, webhook tests and the docs send. */
export const sampleAnnotation: Annotation = {
    id: "01JA0000000000000000000001",
    projectId: "checkout-web",
    bundleId: null,
    author: { kind: "human", name: "Dom" },
    mode: "dev",
    createdAt: "2026-10-05T10:00:00.000Z",
    url: "http://localhost:5173/checkout?step=2",
    route: "/checkout",
    appName: "checkout-web",
    appVersion: "1.4.2",
    environment: {
        userAgent: "Mozilla/5.0 (test)",
        viewport: { w: 1280, h: 800 },
        dpr: 2,
        platform: "web",
    },
    target: {
        kind: "element",
        identity: [
            {
                selector: "#pay > button.primary",
                testId: "pay-button",
                role: "button",
                name: "Pay now",
                tag: "button",
                classes: ["primary"],
                text: "Pay now",
                component: { name: "PayButton", source: "src/PayButton.tsx:12:5" },
            },
        ],
        rect: { x: 120, y: 480, w: 160, h: 44 },
    },
    comment: "The pay button is hidden behind the cookie banner on small screens.",
    severity: "major",
    screenshots: {
        full: { id: "a".repeat(64), mime: "image/png", w: 2560, h: 1600 },
        crop: { id: "b".repeat(64), mime: "image/png", w: 208, h: 92 },
    },
    steps: [{ action: "click", target: "#pay > button.primary", at: "2026-10-05T09:59:58.000Z" }],
    context: { console: [{ level: "error", message: "boom" }] },
    status: "open",
    thread: [
        {
            id: "01JA0000000000000000000002",
            author: { kind: "agent", name: "Claude" },
            body: "Looking into it.",
            createdAt: "2026-10-05T10:01:00.000Z",
        },
    ],
};

/** A bundle of one test-mode annotation. */
export const sampleBundle: Bundle = {
    id: "01JA0000000000000000000003",
    projectId: "checkout-web",
    createdAt: "2026-10-05T10:05:00.000Z",
    author: { name: "Tester" },
    appName: "checkout-web",
    appVersion: "1.4.2",
    annotations: [{ ...sampleAnnotation, bundleId: "01JA0000000000000000000003", mode: "test" }],
    schemaVersion: 1,
};
