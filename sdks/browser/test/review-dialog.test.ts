// @vitest-environment happy-dom
import { sampleAnnotation } from "@notato/schema";
import { expect, it, vi } from "vitest";
import { createReviewDialog } from "../src/ui/review-dialog.ts";

it("prevents sending, discarding or downloading twice while a review action is in progress", async () => {
    const layer = document.createElement("div");
    document.body.append(layer);
    const dialog = createReviewDialog(layer);
    let finish = () => {};
    const onSubmit = vi.fn(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve;
            })
    );
    const onDiscard = vi.fn(async () => {}),
        onExport = vi.fn(async () => {});
    dialog.open({
        instruction: "Same fix",
        notes: [sampleAnnotation],
        onSubmit,
        onDiscard,
        onExport,
    });
    const buttons = [...layer.querySelectorAll("button")];
    const send = buttons.find((b) => b.textContent?.startsWith("Send review"));
    send?.click();
    send?.click();
    expect(buttons.every((b) => b.disabled)).toBe(true);
    buttons.find((b) => b.textContent === "Discard review")?.click();
    buttons.find((b) => b.textContent === "Download review")?.click();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onExport).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(layer.querySelector(".review-dialog")).toBeNull();
    dialog.close();
    layer.remove();
});
