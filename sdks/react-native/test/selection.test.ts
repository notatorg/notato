import { describe, expect, it } from "vitest";
import type { Picked } from "../src/inspect.ts";
import type { TreeElement } from "../src/tree.ts";
import { type RawShots, selectionFor, shotsToSend } from "../src/ui/selection.ts";
import { PNG } from "./controller/harness.ts";

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const element = {
    tag: "Text",
    text: "£1.45",
    path: ["App", "ProductCard"],
    private: false,
    input: false,
    shown: false,
} as unknown as TreeElement;

const picked = {
    names: ["ProductCard", "Text"],
    props: {},
    frame: { left: 30, top: 140, width: 60, height: 20 },
    componentStack: "",
    element,
    view: {},
} as Picked;

describe("selectionFor", () => {
    it("opens the composer before the screenshots are taken, and Send waits for them", async () => {
        let finish: (shots: RawShots) => void = () => undefined;
        const taking = new Promise<RawShots>((resolve) => {
            finish = resolve;
        });
        const selection = selectionFor(picked, null, {
            origin: { x: 0, y: 40 },
            nextPin: () => 3,
            newId: () => "n1",
            shoot: () => taking,
        });
        // The selection is there at once, with what the composer shows.
        expect(selection).toMatchObject({
            pin: 3,
            id: "n1",
            rect: { x: 30, y: 100, w: 60, h: 20 },
            title: "ProductCard › Text",
            subtitle: "“£1.45” · App",
        });
        let sent = false;
        const sending = shotsToSend(selection).then((shots) => {
            sent = true;
            return shots;
        });
        await Promise.resolve();
        expect(sent).toBe(false);
        finish({ full: { id: "n1-full", data: base64(PNG) } });
        const shots = await sending;
        expect(shots.full?.ref).toEqual({ id: "n1-full", mime: "image/png", w: 4, h: 2 });
        expect(shots.crop).toBeUndefined();
    });

    it("keeps the pin and id of the note being written when another element is picked", () => {
        const first = selectionFor(picked, null, {
            origin: { x: 0, y: 0 },
            nextPin: () => 1,
            newId: () => "a",
            shoot: async () => ({}),
        });
        const second = selectionFor(picked, first, {
            origin: { x: 0, y: 0 },
            nextPin: () => 2,
            newId: () => "b",
            shoot: async () => ({}),
        });
        expect([second.pin, second.id]).toEqual([1, "a"]);
    });

    it("sends without screenshots when they could not be taken", async () => {
        const failing = selectionFor(picked, null, {
            origin: { x: 0, y: 0 },
            nextPin: () => 1,
            newId: () => "a",
            shoot: () => Promise.reject(new Error("view-shot")),
        });
        expect(await shotsToSend(failing)).toEqual({});
        const throwing = selectionFor(picked, null, {
            origin: { x: 0, y: 0 },
            nextPin: () => 1,
            newId: () => "a",
            shoot: () => {
                throw new Error("no view");
            },
        });
        expect(await shotsToSend(throwing)).toEqual({});
        // Not a PNG: left out, and so is the crop.
        const garbled = selectionFor(picked, null, {
            origin: { x: 0, y: 0 },
            nextPin: () => 1,
            newId: () => "a",
            shoot: async () => ({
                full: { id: "a-full", data: "AAAA" },
                crop: { id: "a-crop", data: base64(PNG) },
            }),
        });
        expect(await shotsToSend(garbled)).toEqual({});
    });
});
