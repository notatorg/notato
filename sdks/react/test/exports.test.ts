import * as browser from "@notato/browser";
import { describe, expect, it } from "vitest";
import * as react from "../src/index.ts";

describe("@notato/react", () => {
    it("is everything @notato/browser offers, plus the component", () => {
        expect(Object.keys(react).sort()).toEqual([...Object.keys(browser), "Notato"].sort());
        expect(react.createController).toBe(browser.createController);
        expect(typeof react.Notato).toBe("function");
    });
});
