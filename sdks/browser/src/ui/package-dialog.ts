import { plural } from "../text.ts";
import { h } from "./dom.ts";
import { LOGO } from "./logo.ts";

export interface PackageDialogInit {
    count: number;
    routes: number;
    /** The server the bundle is also sent to, if one is configured. */
    destination: string | null;
    name: string;
    /**
     * Whether to offer to remove the notes from this browser once they are downloaded. Not where they live on a server,
     * which would only send them back.
     */
    clearable?: boolean;
    /** Resolves with a message to show on success; rejects with the reason to show on failure. */
    onSubmit(value: { name: string; clear: boolean }): Promise<string>;
    onCancel(): void;
}

export interface PackageDialog {
    readonly isOpen: boolean;
    open(init: PackageDialogInit): void;
    close(): void;
}

export function createPackageDialog(layer: HTMLElement): PackageDialog {
    let el: HTMLElement | null = null;
    let shade: HTMLElement | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    const close = () => {
        if (closeTimer) clearTimeout(closeTimer);
        el?.remove();
        el = null;
        shade?.remove();
        shade = null;
    };

    return {
        get isOpen() {
            return el !== null;
        },
        close,
        open(init) {
            close();
            const name = h("input", {
                type: "text",
                value: init.name,
                placeholder: "Your name",
                autocomplete: "name",
                "aria-label": "Your name",
            });
            const clear = h("input", { type: "checkbox", id: "notato-clear" });
            const status = h("span", { class: "status" });
            const cancel = h(
                "button",
                { class: "btn", type: "button", onclick: () => init.onCancel() },
                "Cancel"
            );
            const submit = h("button", { class: "btn primary", type: "button" }, "Package");

            const run = async () => {
                // Enter and the button both come here: once it is under way (or done), a second press does nothing.
                if (submit.disabled) return;
                submit.disabled = true;
                status.className = "status";
                status.textContent = "Packaging…";
                try {
                    status.textContent = await init.onSubmit({
                        name: name.value.trim(),
                        clear: clear.checked,
                    });
                    cancel.textContent = "Close";
                    closeTimer = setTimeout(() => init.onCancel(), 2200);
                } catch (error) {
                    submit.disabled = false;
                    status.className = "status error";
                    status.textContent =
                        error instanceof Error ? error.message : "Could not package.";
                }
            };
            submit.addEventListener("click", () => void run());

            shade = h("div", { class: "shade", onclick: () => init.onCancel() });
            el = h(
                "div",
                { class: "dialog", role: "dialog", "aria-label": "Package feedback" },
                h(
                    "div",
                    { class: "dialog-head" },
                    h("img", { src: LOGO, alt: "", width: 34, height: 34 }),
                    h("h2", {}, "Package feedback")
                ),
                h(
                    "p",
                    { class: "hint" },
                    `${plural(init.count, "annotation")} on ${plural(init.routes, "page")}. A .zip with the screenshots and a feedback.md will download${init.destination ? ` and be sent to ${init.destination}` : ""}.`
                ),
                h("label", { class: "field" }, "Your name", name),
                init.clearable === false
                    ? null
                    : h(
                          "label",
                          { class: "check" },
                          clear,
                          "Remove these annotations from this browser afterwards"
                      ),
                h("div", { class: "actions" }, status, cancel, submit)
            );
            el.addEventListener("keydown", (ev) => {
                if (ev.key === "Escape") init.onCancel();
                else if (ev.key === "Enter" && (ev.target as HTMLElement).tagName === "INPUT")
                    void run();
            });
            layer.append(shade, el);
            name.focus({ preventScroll: true });
        },
    };
}
