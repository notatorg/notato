import { describe, expect, it } from "bun:test";
import { siteEnvironment } from "../site/environment.ts";

describe("website deployment environments", () => {
    it("keeps main indexable when the dashboard still has the old preview variable", () => {
        expect(siteEnvironment({ WORKERS_CI_BRANCH: "main", NOTATO_SITE_ENV: "preview" })).toBe(
            "production"
        );
    });

    it("keeps develop and feature branches out of production", () => {
        for (const branch of ["develop", "feature/feedback", "claude/0.3"])
            expect(
                siteEnvironment({ WORKERS_CI_BRANCH: branch, NOTATO_SITE_ENV: "production" })
            ).toBe("preview");
    });

    it("keeps local builds separate and allows explicit deployment checks", () => {
        expect(siteEnvironment({})).toBe("local");
        expect(siteEnvironment({ NOTATO_SITE_ENV: "preview" })).toBe("preview");
        expect(siteEnvironment({ NOTATO_SITE_ENV: "production" })).toBe("production");
    });

    it("rejects a misspelled local build environment", () => {
        expect(() => siteEnvironment({ NOTATO_SITE_ENV: "prodution" })).toThrow(
            "NOTATO_SITE_ENV must be production, preview or local"
        );
    });
});
