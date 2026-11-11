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
const intentChips = () => [...layer.querySelectorAll<HTMLButtonElement>(".chip[data-intent]")];
const mode = (m: "note" | "variants") =>
    layer.querySelector(`.composer-mode [data-mode="${m}"]`) as HTMLButtonElement;
const pressedMode = () =>
    [...layer.querySelectorAll<HTMLButtonElement>(".composer-mode [data-mode]")]
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.dataset.mode);
const intentsShown = () =>
    !(layer.querySelector('[aria-label="Feedback type"]') as HTMLElement).hidden;
const explainerShown = () => !(layer.querySelector(".variants-explainer") as HTMLElement).hidden;
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
const saveButton = () => layer.querySelector(".composer-footer .btn.primary") as HTMLButtonElement;
const save = () => saveButton().click();
const saved = () => onSave.mock.calls[0]?.[0];

describe("the Note / Variants switch", () => {
    it("is not offered unless the caller says a request for variants can be made", () => {
        open();
        expect(layer.querySelector(".composer-mode")).toBeNull();
        popover.close();
        open({ variants: false });
        expect(layer.querySelector(".composer-mode")).toBeNull();
        expect(intentChips().map((c) => c.dataset.intent)).toEqual([
            "fix",
            "change",
            "question",
            "approve",
        ]);
        expect(intentsShown()).toBe(true);
    });

    it("sits above the note and the kinds of note, on Note to begin with", () => {
        open({ variants: true });
        const order = [
            ...layer.querySelectorAll(".composer-mode, [aria-label='Feedback type'], textarea"),
        ];
        expect(order.map((e) => e.className || e.tagName)).toEqual([
            "composer-mode",
            "composer-options",
            "TEXTAREA",
        ]);
        expect(pressedMode()).toEqual(["note"]);
        expect(mode("variants").textContent).toBe("Variants");
        expect(mode("variants").title).toContain("versions");
        expect(intentsShown()).toBe(true);
        expect(explainerShown()).toBe(false);
    });

    it("is offered only for the open that asked for it", () => {
        open({ variants: true });
        popover.close();
        open();
        expect(layer.querySelector(".composer-mode")).toBeNull();

        open({ variants: true }); // the next element picked, without closing the first
        expect(layer.querySelector(".composer-mode")).not.toBeNull();
        open();
        expect(layer.querySelector(".composer-mode")).toBeNull();
    });

    it("swaps the kinds of note for a line on what Variants does, and back", () => {
        open({ variants: true });
        mode("variants").click();
        expect(pressedMode()).toEqual(["variants"]);
        expect(intentsShown()).toBe(false);
        expect(explainerShown()).toBe(true);
        expect(layer.querySelector(".variants-explainer")?.textContent).toContain("Use this");

        mode("note").click();
        expect(pressedMode()).toEqual(["note"]);
        expect(intentsShown()).toBe(true);
        expect(explainerShown()).toBe(false);
    });

    it("stays on Variants when Variants is clicked again", () => {
        open({ variants: true });
        mode("variants").click();
        mode("variants").click();
        expect(pressedMode()).toEqual(["variants"]);
    });

    it("moves the typing to the note when switched", () => {
        open({ variants: true });
        mode("variants").focus();
        mode("variants").click();
        expect(document.activeElement).toBe(textarea());
    });

    it("passes the intent variants to onSave with the comment", () => {
        open({ variants: true });
        mode("variants").click();
        note("  Three layouts for this header  ");
        save();
        expect(onSave).toHaveBeenCalledOnce();
        expect(saved()).toEqual({
            visibility: "personal",
            comment: "Three layouts for this header",
            severity: undefined,
            intent: "variants",
        });
    });

    it("passes it along with a severity", () => {
        open({ variants: true });
        mode("variants").click();
        severityChip("minor").click();
        note("Try a few");
        save();
        expect(saved()).toMatchObject({ intent: "variants", severity: "minor" });
    });

    it("asks for variants even if a kind of note was chosen before switching", () => {
        open({ variants: true });
        intentChip("fix").click();
        mode("variants").click();
        note("Try a few");
        save();
        expect(saved()?.intent).toBe("variants");
    });

    it("finds the kind of note chosen before, on going back to Note", () => {
        open({ variants: true });
        intentChip("question").click();
        mode("variants").click();
        mode("note").click();
        expect(pressedIntents()).toEqual(["question"]);
        note("Why is this grey?");
        save();
        expect(saved()?.intent).toBe("question");
    });

    it("passes no intent after going back to Note with nothing chosen", () => {
        open({ variants: true });
        mode("variants").click();
        mode("note").click();
        note("Never mind");
        save();
        expect(saved()?.intent).toBeUndefined();
    });

    it("does not save an empty note, variants or not", () => {
        open({ variants: true });
        mode("variants").click();
        save();
        expect(onSave).not.toHaveBeenCalled();
    });

    describe("the note's placeholder", () => {
        it("changes to ask what the versions should explore, and goes back on Note", () => {
            open({ variants: true });
            const usual = textarea().placeholder;
            expect(usual).not.toBe("");

            mode("variants").click();
            expect(textarea().placeholder).not.toBe(usual);
            expect(textarea().placeholder).toContain("versions");

            mode("note").click();
            expect(textarea().placeholder).toBe(usual);
        });

        it("stays the usual one for the kinds of note", () => {
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
            mode("variants").click();
            expect(textarea().value).toBe("Something already written");
        });

        it("is the usual one in the next popover, even if the last was left on Variants", () => {
            open({ variants: true });
            const usual = textarea().placeholder;
            mode("variants").click();
            open({ variants: true });
            expect(textarea().placeholder).toBe(usual);
            expect(pressedMode()).toEqual(["note"]);
        });
    });

    describe("the save button", () => {
        it("says Ask for variants on Variants, and Save note again on Note", () => {
            open({ variants: true });
            expect(saveButton().textContent).toBe("Save note");
            mode("variants").click();
            expect(saveButton().textContent).toBe("Ask for variants");
            mode("note").click();
            expect(saveButton().textContent).toBe("Save note");
        });

        it("says Save note in the next popover", () => {
            open({ variants: true });
            mode("variants").click();
            open({ variants: true });
            expect(saveButton().textContent).toBe("Save note");
        });

        it("keeps Add to review in a review", () => {
            open({ variants: true, reviewInstruction: "Check the spacing" });
            mode("variants").click();
            expect(saveButton().textContent).toBe("Add to review");
        });
    });

    describe("the kinds of note", () => {
        it("still work when Variants is offered", () => {
            open({ variants: true });
            intentChip("change").click();
            severityChip("major").click();
            note("Wider, please");
            save();
            expect(saved()).toEqual({
                visibility: "personal",
                comment: "Wider, please",
                severity: "major",
                intent: "change",
            });
        });

        it("are one at a time, and can be cleared", () => {
            open({ variants: true });
            intentChip("fix").click();
            intentChip("approve").click();
            expect(pressedIntents()).toEqual(["approve"]);
            intentChip("approve").click();
            expect(pressedIntents()).toEqual([]);
        });
    });

    it("starts on Note in the next popover, so a request for variants is never sent by accident", () => {
        open({ variants: true });
        mode("variants").click();
        open({ variants: true });
        note("A different element");
        save();
        expect(saved()?.intent).toBeUndefined();
    });

    it("keeps the choice while the targets are updated", () => {
        open({ variants: true });
        mode("variants").click();
        popover.update({ title: "2 elements", targets: ["header.site", "nav.main"] });
        expect(pressedMode()).toEqual(["variants"]);
        expect(textarea().placeholder).toContain("versions");
        note("Both together");
        save();
        expect(saved()?.intent).toBe("variants");
    });
});
