import type { Annotation, Status } from "@notato/schema";
import { describe, expect, it } from "vitest";
import { annotationStatusLabel, canRequestRevert } from "../src/annotation-state.ts";

describe("completed feedback", () => {
    it("keeps the two completion outcomes named Resolved and Dismissed", () => {
        expect(annotationStatusLabel("resolved")).toBe("Resolved");
        expect(annotationStatusLabel("dismissed")).toBe("Dismissed");
    });

    it("offers reverting only for a resolved change", () => {
        const statuses: Status[] = [
            "open",
            "acknowledged",
            "awaiting_response",
            "variant_chosen",
            "resolved",
            "dismissed",
            "revert_requested",
            "reverted",
        ];
        const intents: Annotation["intent"][] = [undefined, "fix", "change", "question", "approve"];
        for (const status of statuses)
            for (const intent of intents) {
                expect(canRequestRevert({ status, intent }), `${status}, ${intent}`).toBe(
                    status === "resolved" && intent !== "question" && intent !== "approve"
                );
            }
    });
});
