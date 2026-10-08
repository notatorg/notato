// @vitest-environment happy-dom
import type { Intent, Severity } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPopover, type Popover, type PopoverInit } from "../src/ui/popover.ts";

let layer: HTMLElement;
let popover: Popover;
let onSave: ReturnType<typeof vi.fn<PopoverInit["onSave"]>>;

beforeEach(() => {
    layer = document.createElement("div");
    document.body.append(layer);
    popover = createPopover(layer);
    onSave = vi.fn(async () => {});
});
afterEach(() => {
    popover.destroy();
    layer.remove();
});

const open = (init: Partial<PopoverInit> = {}) =>
    popover.open({
        title: "1 element",
        targets: ["header.site"],
        anchor: { left: 100, top: 100, width: 80, height: 24 },
        onSave,
        onCancel: () => {},
        ...init,
    });

const intentChip = (intent: Intent) =>
    layer.querySelector(`[data-intent="${intent}"]`) as HTMLButtonElement;
const intentChips = () => [...layer.querySelectorAll<HTMLButtonElement>("[data-intent]")];
const pressedIntents = () =>
    intentChips()
        .filter((c) => c.getAttribute("aria-pressed") === "true")
        .map((c) => c.dataset.intent);
const severityChip = (severity: Severity) =>
    layer.querySelector(`[data-severity="${severity}"]`) as HTMLButtonElement;
const textarea = () => layer.querySelector("textarea") as HTMLTextAreaElement;
const note = (text: string) => {
    textarea().value = text;
};
const save = () => {
    const button = [...layer.querySelectorAll("button")].find(
        (b) => b.textContent === "Save"
    ) as HTMLButtonElement;
    button.click();
};
const saved = () => onSave.mock.calls[0]?.[0];

describe("the Variants chip", () => {
    it("is not offered unless the caller says a request for variants can be made", () => {
        open();
        expect(intentChip("variants")).toBeNull();
        popover.close();
        open({ variants: false });
        expect(intentChip("variants")).toBeNull();
        expect(intentChips().map((c) => c.dataset.intent)).toEqual([
            "fix",
            "change",
            "question",
            "approve",
        ]);
    });

    it("is offered after the others when it can be made, with a note on what it does", () => {
        open({ variants: true });
        expect(intentChips().map((c) => c.dataset.intent)).toEqual([
            "fix",
            "change",
            "question",
            "approve",
            "variants",
        ]);
        expect(intentChip("variants").textContent).toBe("Variants");
        expect(intentChip("variants").title).toContain("versions");
        expect(pressedIntents()).toEqual([]);
    });

    it("is offered only for the open that asked for it", () => {
        open({ variants: true });
        popover.close();
        open();
        expect(intentChip("variants")).toBeNull();

        open({ variants: true }); // the next element picked, without closing the first
        expect(intentChip("variants")).not.toBeNull();
        open();
        expect(intentChip("variants")).toBeNull();
    });

    it("is pressed when clicked, and alone", () => {
        open({ variants: true });
        intentChip("fix").click();
        intentChip("variants").click();
        expect(pressedIntents()).toEqual(["variants"]);
    });

    it("passes the intent variants to onSave with the comment", () => {
        open({ variants: true });
        intentChip("variants").click();
        note("  Three layouts for this header  ");
        save();
        expect(onSave).toHaveBeenCalledOnce();
        expect(saved()).toEqual({
            comment: "Three layouts for this header",
            severity: undefined,
            intent: "variants",
        });
    });

    it("passes it along with a severity", () => {
        open({ variants: true });
        intentChip("variants").click();
        severityChip("minor").click();
        note("Try a few");
        save();
        expect(saved()).toMatchObject({ intent: "variants", severity: "minor" });
    });

    it("passes no intent once it is clicked off again", () => {
        open({ variants: true });
        intentChip("variants").click();
        intentChip("variants").click();
        expect(pressedIntents()).toEqual([]);
        note("Never mind");
        save();
        expect(saved()?.intent).toBeUndefined();
    });

    it("does not save an empty note, variants or not", () => {
        open({ variants: true });
        intentChip("variants").click();
        save();
        expect(onSave).not.toHaveBeenCalled();
    });

    describe("the note's placeholder", () => {
        it("changes to ask what the versions should explore, and goes back when it is unchosen", () => {
            open({ variants: true });
            const usual = textarea().placeholder;
            expect(usual).not.toBe("");

            intentChip("variants").click();
            expect(textarea().placeholder).not.toBe(usual);
            expect(textarea().placeholder).toContain("versions");

            intentChip("variants").click();
            expect(textarea().placeholder).toBe(usual);
        });

        it("goes back when another chip is chosen instead", () => {
            open({ variants: true });
            const usual = textarea().placeholder;
            intentChip("variants").click();
            intentChip("question").click();
            expect(pressedIntents()).toEqual(["question"]);
            expect(textarea().placeholder).toBe(usual);
        });

        it("stays the usual one for the other chips", () => {
            open({ variants: true });
            const usual = textarea().placeholder;
            for (const intent of ["fix", "change", "question", "approve"] as const) {
                intentChip(intent).click();
                expect(textarea().placeholder, intent).toBe(usual);
            }
        });

        it("leaves what has been typed alone when it changes", () => {
            open({ variants: true });
            note("Something already written");
            intentChip("variants").click();
            expect(textarea().value).toBe("Something already written");
        });

        it("is the usual one in the next popover, even if the last was left on Variants", () => {
            open({ variants: true });
            const usual = textarea().placeholder;
            intentChip("variants").click();
            open({ variants: true });
            expect(textarea().placeholder).toBe(usual);
            expect(pressedIntents()).toEqual([]);
        });
    });

    describe("the other chips", () => {
        it("still work when it is offered", () => {
            open({ variants: true });
            intentChip("change").click();
            severityChip("major").click();
            note("Wider, please");
            save();
            expect(saved()).toEqual({
                comment: "Wider, please",
                severity: "major",
                intent: "change",
            });
        });

        it("each replace Variants as the chosen one", () => {
            for (const intent of ["fix", "change", "question", "approve"] as const) {
                popover.close();
                onSave.mockClear();
                open({ variants: true });
                intentChip("variants").click();
                intentChip(intent).click();
                expect(pressedIntents(), intent).toEqual([intent]);
                note("Hmm");
                save();
                expect(saved()?.intent, intent).toBe(intent);
            }
        });

        it("can be cleared and chosen again around it", () => {
            open({ variants: true });
            intentChip("fix").click();
            intentChip("fix").click();
            intentChip("variants").click();
            intentChip("variants").click();
            intentChip("approve").click();
            expect(pressedIntents()).toEqual(["approve"]);
        });
    });

    it("starts with nothing chosen in the next popover, so a request for variants is never sent by accident", () => {
        open({ variants: true });
        intentChip("variants").click();
        open({ variants: true });
        note("A different element");
        save();
        expect(saved()?.intent).toBeUndefined();
    });

    it("keeps the choice while the targets are updated", () => {
        open({ variants: true });
        intentChip("variants").click();
        popover.update({ title: "2 elements", targets: ["header.site", "nav.main"] });
        expect(pressedIntents()).toEqual(["variants"]);
        expect(textarea().placeholder).toContain("versions");
        note("Both together");
        save();
        expect(saved()?.intent).toBe("variants");
    });
});
