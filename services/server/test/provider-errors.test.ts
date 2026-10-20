import { expect, it } from "bun:test";
import { refusal } from "../src/plugins/providers.ts";

it("says what a provider's refusal probably means and what to try", () => {
    expect(refusal(401)).toContain("did not accept that credential");
    expect(refusal(401)).toContain("copied in full");
    expect(refusal(403)).toContain("permissions");
    expect(refusal(404)).toContain("could not find");
    expect(refusal(429)).toBe("Provider rate limit reached.");
    expect(refusal(502)).toContain("Try again");
    expect(refusal(418)).toBe("The provider refused the request (418).");
});
