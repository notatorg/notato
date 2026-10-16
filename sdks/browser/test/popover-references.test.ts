// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPopover, type Popover, type PopoverInit } from "../src/ui/popover.ts";
import { useReducedMotion } from "./support/motion.ts";

useReducedMotion();
let layer: HTMLElement;
let popover: Popover;
let onSave: ReturnType<typeof vi.fn<PopoverInit["onSave"]>>;
const image = (name = "image.png", type = "image/png") => new File(["image"], name, { type });
const comment = () => layer.querySelector("textarea") as HTMLTextAreaElement;
const input = () => layer.querySelector('input[type="file"]') as HTMLInputElement;
const save = () => (layer.querySelector(".btn.primary") as HTMLButtonElement).click();
const attached = () => layer.querySelector(".reference-files")?.textContent;
const saved = () => onSave.mock.calls.at(-1)?.[0].references;

function clipboard(files: File[], text?: string): DataTransfer {
    const data = new DataTransfer();
    for (const file of files) data.items.add(file);
    if (text) data.setData("text/plain", text);
    return data;
}
function paste(data: DataTransfer, target: EventTarget = comment()) {
    const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
    });
    target.dispatchEvent(event);
    return event;
}
function choose(files: File[]) {
    Object.defineProperty(input(), "files", { configurable: true, value: clipboard(files).files });
    input().dispatchEvent(new Event("change"));
}

beforeEach(() => {
    layer = document.createElement("div");
    document.body.append(layer);
    popover = createPopover(layer);
    onSave = vi.fn(async () => {});
    popover.open({
        title: "1 element",
        targets: ["button.pay"],
        anchor: { left: 100, top: 100, width: 80, height: 24 },
        references: true,
        onSave,
        onCancel: () => {},
    });
    comment().value = "Use this reference";
});
afterEach(() => {
    popover.destroy();
    layer.remove();
});

describe("pasted reference images", () => {
    it("attaches an image once when the clipboard exposes it as both a file and an item", () => {
        const file = image();
        expect(paste(clipboard([file])).defaultPrevented).toBe(true);
        expect(attached()).toContain("image.png");
        save();
        expect(saved()).toEqual([file]);
    });

    it("accepts clipboard images exposed only through items", () => {
        const file = image("Reference.webp", "image/webp");
        const data = clipboard([file]);
        Object.defineProperty(data, "files", { value: [] });
        paste(data);
        save();
        expect(saved()).toEqual([file]);
    });

    it("counts pasted and selected images together, keeps existing attachments on refusal and allows removal", () => {
        const selected = [image("first.png"), image("second.png")];
        const third = image("third.jpg", "image/jpeg");
        choose(selected);
        paste(clipboard([third]));
        paste(clipboard([image("fourth.png")]));
        expect(layer.querySelector(".status.error")?.textContent).toContain("at most three");
        expect(attached()).not.toContain("fourth.png");
        layer.querySelector<HTMLButtonElement>('[aria-label="Remove second.png"]')?.click();
        const replacement = image("replacement.png");
        paste(clipboard([replacement]));
        expect(layer.querySelector(".status.error")).toBeNull();
        save();
        expect(saved()).toEqual([selected[0], third, replacement]);
    });

    it("refuses an excessive batch without partially adding it", () => {
        paste(clipboard([image("first.png")]));
        paste(clipboard([image("a.png"), image("b.png"), image("c.png")]));
        save();
        expect(saved()?.map((file) => file.name)).toEqual(["first.png"]);
    });

    it.each(["paste", "choose"])(
        "validates unsupported formats and input size for %s",
        (source) => {
            const add = source === "paste" ? (files: File[]) => paste(clipboard(files)) : choose;
            add([image("unsupported.gif", "image/gif")]);
            expect(layer.querySelector(".status.error")?.textContent).toContain(
                "PNG, JPEG or WebP"
            );
            const large = image("large.png");
            Object.defineProperty(large, "size", { value: 16 * 1024 * 1024 + 1 });
            add([large]);
            expect(layer.querySelector(".status.error")?.textContent).toContain("16 MB");
            expect(attached()).toBe("");
            save();
            expect(saved()).toBeUndefined();
        }
    );

    it("leaves ordinary text paste and mixed text/image text insertion to the browser", () => {
        expect(paste(clipboard([], "Some feedback")).defaultPrevented).toBe(false);
        expect(paste(clipboard([image()], "More feedback")).defaultPrevented).toBe(false);
        save();
        expect(saved()).toHaveLength(1);
    });

    it("does not intercept a paste outside the composer", () => {
        expect(paste(clipboard([image()]), document.body).defaultPrevented).toBe(false);
        save();
        expect(saved()).toBeUndefined();
    });

    it("does not attach images when the destination does not allow references", () => {
        popover.update({ references: false });
        expect(paste(clipboard([image()])).defaultPrevented).toBe(false);
        choose([image("selected.png")]);
        save();
        expect(saved()).toBeUndefined();
    });

    it("keeps attachments fixed while saving and restores the controls after failure", async () => {
        let reject: (error: Error) => void = () => {};
        onSave.mockImplementationOnce(
            () =>
                new Promise((_, fail) => {
                    reject = fail;
                })
        );
        paste(clipboard([image("first.png")]));
        save();
        expect(input().disabled).toBe(true);
        paste(clipboard([image("while-saving.png")]));
        reject(new Error("Try again"));
        await vi.waitFor(() => expect(input().disabled).toBe(false));
        expect(attached()).not.toContain("while-saving.png");
        save();
        expect(saved()?.map((file) => file.name)).toEqual(["first.png"]);
    });

    it("clears pasted attachments when the composer closes", () => {
        paste(clipboard([image()]));
        popover.close();
        popover.open({
            title: "Area",
            targets: [],
            anchor: { left: 0, top: 0, width: 1, height: 1 },
            references: true,
            onSave,
            onCancel: () => {},
        });
        comment().value = "A different note";
        save();
        expect(saved()).toBeUndefined();
    });

    it("does not apply an old save failure to a newly opened composer", async () => {
        let reject: (error: Error) => void = () => {};
        onSave.mockImplementationOnce(
            () =>
                new Promise((_, fail) => {
                    reject = fail;
                })
        );
        paste(clipboard([image()]));
        save();
        popover.close();
        popover.open({
            title: "Area",
            targets: [],
            anchor: { left: 0, top: 0, width: 1, height: 1 },
            references: true,
            onSave,
            onCancel: () => {},
        });
        reject(new Error("Old attachment failed"));
        await Promise.resolve();
        expect(layer.querySelector(".status.error")).toBeNull();
        expect(input().disabled).toBe(false);
    });
});
