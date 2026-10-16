// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as references from "../src/reference-image.ts";
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
    vi.restoreAllMocks();
});

describe("pasted reference images", () => {
    it("previews each image once and revokes its local URL on removal or close", async () => {
        const thumbnail = vi
            .spyOn(references, "referenceThumbnail")
            .mockResolvedValue(new Blob(["small"], { type: "image/webp" }));
        const url = vi
            .spyOn(URL, "createObjectURL")
            .mockReturnValueOnce("blob:first")
            .mockReturnValueOnce("blob:second");
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        paste(clipboard([image("first.png")]));
        await vi.waitFor(() =>
            expect(layer.querySelector(".reference-preview img")?.getAttribute("src")).toBe(
                "blob:first"
            )
        );
        paste(clipboard([image("second.png")]));
        await vi.waitFor(() => expect(url).toHaveBeenCalledTimes(2));
        expect(thumbnail).toHaveBeenCalledTimes(2);
        layer.querySelector<HTMLButtonElement>('[aria-label="Remove first.png"]')?.click();
        expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:first");
        popover.close();
        expect(revoke.mock.calls).toEqual([["blob:first"], ["blob:second"]]);
    });

    it("decodes one preview at a time and discards late results after removal or close", async () => {
        let finish: (blob: Blob) => void = () => {};
        const thumbnail = vi.spyOn(references, "referenceThumbnail").mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const url = vi.spyOn(URL, "createObjectURL");
        paste(clipboard([image("first.png"), image("second.png")]));
        await vi.waitFor(() => expect(thumbnail).toHaveBeenCalledOnce());
        layer.querySelector<HTMLButtonElement>('[aria-label="Remove first.png"]')?.click();
        finish(new Blob(["small"], { type: "image/webp" }));
        await vi.waitFor(() => expect(thumbnail).toHaveBeenCalledTimes(2));
        expect(url).not.toHaveBeenCalled();
        popover.close();
        finish(new Blob(["small"], { type: "image/webp" }));
        await Promise.resolve();
        expect(url).not.toHaveBeenCalled();
    });

    it("keeps a removable attachment when the browser cannot preview it", async () => {
        vi.spyOn(references, "referenceThumbnail").mockRejectedValue(new Error("Decode failed"));
        const file = image();
        paste(clipboard([file]));
        await vi.waitFor(() =>
            expect(layer.querySelector(".reference-preview")?.getAttribute("title")).toBe(
                "Preview unavailable"
            )
        );
        save();
        expect(saved()).toEqual([file]);
    });

    it("focuses the comment when the paste prompt is clicked so the next paste reaches the composer", () => {
        layer.querySelector<HTMLButtonElement>(".reference-choose")?.focus();
        layer.querySelector<HTMLElement>(".reference-paste")?.click();
        expect(document.activeElement).toBe(comment());
        paste(clipboard([image()]));
        save();
        expect(saved()).toHaveLength(1);
    });

    it("opens the file picker from Choose images and disables that action while saving", () => {
        const chooseButton = layer.querySelector<HTMLButtonElement>(
            ".reference-choose"
        ) as HTMLButtonElement;
        const click = vi.spyOn(input(), "click").mockImplementation(() => {});
        chooseButton.click();
        expect(click).toHaveBeenCalledOnce();
        save();
        expect(chooseButton.disabled).toBe(true);
        chooseButton.click();
        expect(click).toHaveBeenCalledOnce();
    });

    it("attaches an image once when the clipboard exposes it as both a file and an item", () => {
        const file = image();
        expect(paste(clipboard([file])).defaultPrevented).toBe(true);
        expect(attached()).toContain("image.png");
        expect(layer.querySelector(".reference-count")?.textContent).toBe("1 / 3");
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
