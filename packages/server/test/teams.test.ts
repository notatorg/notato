import { describe, expect, it } from "bun:test";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { buildDelivery, parseWebhooks } from "../src/webhooks.ts";

const hook = {
    url: "https://x.environment.api.powerplatform.com/workflows/abc",
    format: "teams" as const,
};

/** What a Teams workflow is sent, parsed back. */
function sent(event: string, over: Partial<Annotation> = {}) {
    const body = JSON.parse(buildDelivery(hook, event, { ...sampleAnnotation, ...over }).body);
    const card = body.attachments[0].content;
    const text = JSON.stringify(card.body);
    return { body, card, text };
}

describe("the teams format", () => {
    it("is a format a webhook can have", () => {
        expect(parseWebhooks([hook]).webhooks).toEqual([hook]);
    });

    it("sends a message carrying one Adaptive Card, the shape a Teams workflow posts", () => {
        const { body, card } = sent("annotation.created");
        expect(body.type).toBe("message");
        expect(body.attachments).toHaveLength(1);
        expect(body.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
        expect(card).toMatchObject({ type: "AdaptiveCard", version: "1.4" });
        // Nothing of Notato's own JSON at the top, which the template would try to post as a card.
        expect(Object.keys(body).sort()).toEqual(["attachments", "type"]);
    });

    it("says what happened and shows the note with the facts that matter", () => {
        const { text, card } = sent("annotation.created");
        expect(text).toContain("Notato · checkout-web");
        expect(text).toContain("New note from Dom");
        expect(text).toContain(sampleAnnotation.comment);
        const facts = card.body.find((b: { type: string }) => b.type === "FactSet").facts;
        expect(facts).toContainEqual({ title: "Page", value: "/checkout" });
        expect(facts).toContainEqual({ title: "Severity", value: "major" });
        expect(facts).toContainEqual({ title: "Element", value: "button “Pay now”" });
    });

    it("says nothing about who when the note has no name on it", () => {
        const { text } = sent("annotation.created", { author: { kind: "human" } });
        expect(text).toContain('"New note"');
        expect(text).not.toContain("Someone");
        expect(text).not.toContain('"From"');
    });

    it("shows the latest reply on a reply or a status change, and who wrote it", () => {
        const thread = [
            ...sampleAnnotation.thread,
            {
                id: "r2",
                author: { kind: "agent" as const, name: "Claude" },
                body: "Resolved: moved the banner.",
                createdAt: "2026-10-05T11:00:00.000Z",
            },
        ];
        expect(sent("annotation.replied", { thread }).text).toContain("Claude replied");
        const resolved = sent("annotation.resolved", { thread, status: "resolved" });
        expect(resolved.text).toContain("Resolved");
        expect(resolved.text).toContain("Resolved: moved the banner.");
        expect(sent("annotation.created", { thread }).text).not.toContain("moved the banner");
    });

    it("links to the page only when it is a web address, since anything else makes Teams reject the card", () => {
        expect(sent("annotation.created").card.actions).toEqual([
            {
                type: "Action.OpenUrl",
                title: "Open the page",
                url: "http://localhost:5173/checkout?step=2",
            },
        ]);
        expect(
            sent("annotation.created", { url: "app://field/LoginPage" }).card.actions
        ).toBeUndefined();
    });

    it("keeps a long note short enough for a card", () => {
        const { card } = sent("annotation.created", { comment: "x".repeat(5000) });
        expect(card.body[2].text.length).toBe(1000);
    });
});
