import type { Annotation } from "@notato/schema";
import { h } from "./dom.ts";

/** A review stays held until Send review; downloading a backup never sends or discards its drafts. */
export function createReviewDialog(layer: HTMLElement) {
    let el: HTMLElement | null = null;
    let shade: HTMLElement | null = null;
    let owner: HTMLElement | null = null;
    const close = () => {
        el?.remove();
        shade?.remove();
        el = shade = null;
        owner?.focus();
    };
    return {
        close,
        open(options: {
            instruction: string;
            notes: Annotation[];
            onSubmit(instruction: string): Promise<void>;
            onDiscard?(): Promise<void>;
            onExport?(instruction: string): Promise<void>;
        }) {
            close();
            owner =
                layer.getRootNode() instanceof ShadowRoot
                    ? ((layer.getRootNode() as ShadowRoot).activeElement as HTMLElement)
                    : null;
            let busy = false,
                armed = false;
            const instruction = h(
                "textarea",
                { rows: 3, maxlength: 8000, "aria-label": "Shared review instruction" },
                options.instruction
            );
            const status = h("p", { class: "status", role: "status" });
            const submit = h(
                "button",
                { class: "btn primary", type: "button" },
                options.notes.length ? `Send review (${options.notes.length})` : "Start review"
            );
            const cancel = h("button", { class: "btn", type: "button", onclick: close }, "Close");
            const discard = options.onDiscard
                ? h("button", { class: "btn", type: "button" }, "Discard review")
                : null;
            const download = options.onExport
                ? h("button", { class: "btn", type: "button" }, "Download review")
                : null;
            const setBusy = (on: boolean) => {
                busy = on;
                for (const control of [submit, cancel, discard, download, instruction])
                    if (control) control.disabled = on;
                if (on) el?.focus();
            };
            const perform = async (action: () => Promise<void>, dismiss: boolean) => {
                if (busy) return;
                setBusy(true);
                status.textContent = "";
                try {
                    await action();
                    if (dismiss) close();
                    else status.textContent = "Review downloaded. Your drafts are still here.";
                } catch (error) {
                    status.textContent =
                        error instanceof Error ? error.message : "Could not complete this action.";
                } finally {
                    setBusy(false);
                }
            };
            const text = () => {
                const value = instruction.value.trim();
                if (!value) {
                    status.textContent = "Write the shared instruction first.";
                    instruction.focus();
                }
                return value;
            };
            submit.addEventListener("click", () => {
                const value = text();
                if (value) void perform(() => options.onSubmit(value), true);
            });
            download?.addEventListener("click", () => {
                const value = text();
                if (value)
                    void perform(() => options.onExport?.(value) ?? Promise.resolve(), false);
            });
            discard?.addEventListener("click", () => {
                if (busy) return;
                if (!armed) {
                    armed = true;
                    discard.textContent = "Discard these drafts?";
                    return;
                }
                void perform(() => options.onDiscard?.() ?? Promise.resolve(), true);
            });
            shade = h("div", { class: "shade" });
            el = h(
                "div",
                {
                    class: "dialog review-dialog",
                    role: "dialog",
                    "aria-modal": "true",
                    "aria-label": "Grouped review",
                    tabindex: -1,
                },
                h("h2", {}, "Grouped review"),
                h(
                    "p",
                    { class: "hint" },
                    "Write one instruction, then annotate related targets across pages. Notes stay in this browser until you send the review. Up to 50 targets."
                ),
                h("label", { class: "field" }, "Apply this to every target", instruction),
                options.notes.length
                    ? h(
                          "ol",
                          { class: "review-targets" },
                          ...options.notes.map((a) =>
                              h("li", {}, h("b", {}, a.route), " · ", a.comment)
                          )
                      )
                    : null,
                status,
                h("div", { class: "actions" }, discard, download, cancel, submit)
            );
            el.addEventListener("keydown", (event) => {
                if (event.key === "Escape" && !busy) {
                    event.preventDefault();
                    close();
                }
                if (event.key !== "Tab" || !el) return;
                const controls = [
                    ...el.querySelectorAll<HTMLElement>(
                        "button:not(:disabled), textarea:not(:disabled)"
                    ),
                ];
                const active = (el.getRootNode() as ShadowRoot).activeElement;
                if (!controls.length) {
                    event.preventDefault();
                    el.focus();
                } else if (event.shiftKey && active === controls[0]) {
                    event.preventDefault();
                    controls.at(-1)?.focus();
                } else if (!event.shiftKey && active === controls.at(-1)) {
                    event.preventDefault();
                    controls[0]?.focus();
                }
            });
            layer.append(shade, el);
            instruction.focus();
        },
    };
}
