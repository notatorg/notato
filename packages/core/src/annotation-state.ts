import type { Annotation, Status } from "@notato/schema";

/** Consistent state names across the SDK's cards. */
export function annotationStatusLabel(status: Status): string {
    return {
        open: "Open",
        acknowledged: "Acknowledged",
        awaiting_response: "Needs your answer",
        variant_chosen: "Variant chosen",
        revert_requested: "Revert requested",
        reverted: "Reverted",
        resolved: "Resolved",
        dismissed: "Dismissed",
    }[status];
}

/** Only a completed change can be undone; questions, approvals and declined work have no fix to revert. */
export const canRequestRevert = (a: Pick<Annotation, "status" | "intent">): boolean =>
    a.status === "resolved" && a.intent !== "question" && a.intent !== "approve";
