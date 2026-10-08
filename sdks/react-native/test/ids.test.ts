import { describe, expect, it } from "vitest";
import { ulid } from "../src/ids.ts";

describe("ulid", () => {
    it("is 26 Crockford characters that sort by time", () => {
        const a = ulid(1_700_000_000_000);
        const b = ulid(1_700_000_000_001);
        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(a < b).toBe(true);
    });
});
