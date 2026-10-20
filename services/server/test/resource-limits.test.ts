import { expect, it } from "bun:test";
import { resourceLimitsFromEnv } from "../src/resource-limits.ts";

it("leaves self-hosting unrestricted unless the operator sets capacity", () => {
    expect(resourceLimitsFromEnv({})).toBeUndefined();
    const limits = resourceLimitsFromEnv({ NOTATO_RESOURCE_LIMITS: '{"bytes":1000,"projects":0}' });
    expect(limits?.bytes).toBe(1000);
    expect(limits?.projects).toBe(0);
    expect(limits?.members).toBe(Number.MAX_SAFE_INTEGER);
    expect(limits?.notesPerMonth).toBeUndefined();
});
it("rejects invalid capacity configuration without echoing its contents", () => {
    for (const value of [
        '{"bytes":-1}',
        '{"notes":1.5}',
        '{"private":"secret"}',
        "[]",
        "null",
        "{",
    ]) {
        expect(() => resourceLimitsFromEnv({ NOTATO_RESOURCE_LIMITS: value })).toThrow(
            "JSON object"
        );
    }
});
