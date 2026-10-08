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
        targets: ["button.pay"],
        anchor: { left: 100, top: 100, width: 80, height: 24 },
        onSave,
        onCancel: () => {},
        ...init,
    });

const intentChip = (intent: Intent) =>
    layer.querySelector(`[data-intent="${intent}"]`) as HTMLButtonElement;
const severityChip = (severity: Severity) =>
    layer.querySelector(`[data-severity="${severity}"]`) as HTMLButtonElement;
const intentChips = () => [...layer.querySelectorAll<HTMLButtonElement>("[data-intent]")];
const pressedIntents = () =>
    intentChips()
        .filter((c) => c.getAttribute("aria-pressed") === "true")
        .map((c) => c.dataset.intent);
const pressedSeverities = () =>
    [...layer.querySelectorAll<HTMLButtonElement>("[data-severity]")]
        .filter((c) => c.getAttribute("aria-pressed") === "true")
        .map((c) => c.dataset.severity);
const note = (text: string) => {
    const box = layer.querySelector("textarea") as HTMLTextAreaElement;
    box.value = text;
};
const save = () => {
    const button = [...layer.querySelectorAll("button")].find(
        (b) => b.textContent === "Save"
    ) as HTMLButtonElement;
    button.click();
};
const saved = () => onSave.mock.calls[0]?.[0];
const hintLine = () => layer.querySelector(".hint") as HTMLElement;

describe("intent chips", () => {
    it("offers fix, change, question and approve, none chosen to start with", () => {
        open();
        expect(intentChips().map((c) => c.dataset.intent)).toEqual([
            "fix",
            "change",
            "question",
            "approve",
        ]);
        expect(intentChips().map((c) => c.textContent)).toEqual([
            "Fix",
            "Change",
            "Question",
            "Approve",
        ]);
        expect(pressedIntents()).toEqual([]);
        expect(intentChips().every((c) => c.title.length > 0)).toBe(true);
    });

    it("marks the one that is clicked as pressed", () => {
        open();
        intentChip("question").click();
        expect(pressedIntents()).toEqual(["question"]);
    });

    it("lets only one be pressed at a time", () => {
        open();
        intentChip("fix").click();
        intentChip("approve").click();
        expect(pressedIntents()).toEqual(["approve"]);
    });

    it("clears the choice when the pressed one is clicked again", () => {
        open();
        intentChip("change").click();
        intentChip("change").click();
        expect(pressedIntents()).toEqual([]);
    });

    it("keeps intent and severity separate", () => {
        open();
        intentChip("fix").click();
        severityChip("blocker").click();
        expect(pressedIntents()).toEqual(["fix"]);
        expect(pressedSeverities()).toEqual(["blocker"]);
        intentChip("fix").click();
        expect(pressedSeverities()).toEqual(["blocker"]);
    });
});

describe("saving", () => {
    it("passes the chosen intent and severity with the comment", () => {
        open();
        intentChip("fix").click();
        severityChip("major").click();
        note("  The button is cut off  ");
        save();
        expect(onSave).toHaveBeenCalledOnce();
        expect(saved()).toEqual({
            comment: "The button is cut off",
            severity: "major",
            intent: "fix",
        });
    });

    it("passes no intent when none was chosen, or when it was cleared", () => {
        open();
        note("Looks off");
        save();
        expect(saved()?.intent).toBeUndefined();
        expect(saved()?.severity).toBeUndefined();

        onSave.mockClear();
        popover.close();
        open();
        intentChip("question").click();
        intentChip("question").click();
        note("Why is this blue?");
        save();
        expect(saved()?.intent).toBeUndefined();
    });

    it("passes the intent that is pressed when Save is clicked, whichever was clicked first", () => {
        open();
        intentChip("fix").click();
        intentChip("change").click();
        note("Make it wider");
        save();
        expect(saved()?.intent).toBe("change");
    });

    it("does not save a comment that is empty, intent or not", () => {
        open();
        intentChip("approve").click();
        save();
        expect(onSave).not.toHaveBeenCalled();
    });
});

describe("starting a new annotation", () => {
    it("starts with nothing chosen, even when the last popover was left with a choice and not closed", () => {
        open();
        intentChip("question").click();
        severityChip("nit").click();
        open(); // the next element picked, without the first having been saved or cancelled
        expect(pressedIntents()).toEqual([]);
        expect(pressedSeverities()).toEqual([]);
        note("Another one");
        save();
        expect(saved()?.intent).toBeUndefined();
        expect(saved()?.severity).toBeUndefined();
    });

    it("starts with nothing chosen after a close", () => {
        open();
        intentChip("approve").click();
        popover.close();
        expect(popover.isOpen).toBe(false);
        open();
        expect(pressedIntents()).toEqual([]);
        note("Fine");
        save();
        expect(saved()?.intent).toBeUndefined();
    });
});

describe("updating an open popover", () => {
    it("keeps the chosen intent and the typed comment while the targets change", () => {
        open();
        intentChip("change").click();
        note("Wider, please");
        popover.update({ title: "2 elements", targets: ["button.pay", "button.cancel"] });
        expect(layer.querySelector("h2")?.textContent).toBe("2 elements");
        expect(layer.querySelectorAll(".targets li")).toHaveLength(2);
        expect(pressedIntents()).toEqual(["change"]);
        save();
        expect(saved()).toMatchObject({ comment: "Wider, please", intent: "change" });
    });

    it("shows a hint it is given, and takes the line away when there is none", () => {
        open();
        expect(hintLine().style.display).toBe("none");
        expect(hintLine().textContent).toBe("");

        popover.update({ hint: "Hold Shift to add more elements" });
        expect(hintLine().textContent).toBe("Hold Shift to add more elements");
        expect(hintLine().style.display).not.toBe("none");

        popover.update({ hint: undefined });
        expect(hintLine().textContent).toBe("");
        expect(hintLine().style.display).toBe("none");
    });

    it("shows the hint the popover was opened with", () => {
        open({ hint: "Text selection" });
        expect(hintLine().textContent).toBe("Text selection");
        expect(hintLine().style.display).not.toBe("none");
    });

    it("leaves the hint as it is when the update does not mention one", () => {
        open({ hint: "Text selection" });
        popover.update({ title: "Selection" });
        expect(hintLine().textContent).toBe("Text selection");
    });

    it("does nothing once it is closed", () => {
        open();
        popover.close();
        expect(() => popover.update({ hint: "late" })).not.toThrow();
        expect(layer.querySelector(".popover")).toBeNull();
    });
});
