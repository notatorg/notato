import { describe, expect, it } from "bun:test";
import type { WebhookView } from "../src/api.ts";
import { draftOf, eventsSummary, formFor, formProblem, orderEvents } from "../src/webhook-form.ts";

const saved = (over: Partial<WebhookView> = {}): WebhookView => ({
    index: 0,
    fingerprint: "abc",
    name: "Team",
    url: "https://hooks.slack.com/services/••••",
    host: "hooks.slack.com",
    format: "json",
    events: ["annotation.created", "annotation.resolved"],
    project: "checkout-web",
    secret: { kind: "file" },
    screenshots: true,
    ...over,
});

describe("a new webhook", () => {
    it("starts as Slack, with every event chosen", () => {
        const form = formFor();
        expect(form).toMatchObject({
            format: "slack",
            allEvents: true,
            replaceUrl: true,
            secretAction: "set",
        });
    });

    it("needs a URL that is http or https", () => {
        const form = formFor();
        expect(formProblem(form)).toBe("Paste the webhook's URL.");
        expect(formProblem({ ...form, url: "hooks.slack.com/x" })).toBe("That is not a URL.");
        expect(formProblem({ ...form, url: "ftp://x.test" })).toBe(
            "The URL must start with https://."
        );
        expect(formProblem({ ...form, url: "https://x.test/h" })).toBeNull();
        expect(
            formProblem({ ...form, url: "https://x.test/h", allEvents: false, events: [] })
        ).toContain("event");
    });

    it("sends what was typed, with empty fields as none", () => {
        const form = {
            ...formFor(),
            url: " https://x.test/h ",
            name: "  ",
            project: "",
            format: "json" as const,
        };
        expect(draftOf({ ...form, secret: "env:S" })).toEqual({
            format: "json",
            name: null,
            project: null,
            events: null,
            url: "https://x.test/h",
            secret: "env:S",
            screenshots: true,
        });
    });

    it("sends the screenshot switch for the formats that can carry one", () => {
        const form = { ...formFor(), url: "https://x.test", screenshots: false };
        expect(draftOf({ ...form, format: "teams" }).screenshots).toBe(false);
        expect(draftOf({ ...form, format: "json" }).screenshots).toBe(false);
        expect(draftOf({ ...form, format: "slack" })).not.toHaveProperty("screenshots");
        expect(formFor(saved({ screenshots: false })).screenshots).toBe(false);
    });

    it("sends no secret for a chat service, which would ignore it", () => {
        expect(draftOf({ ...formFor(), url: "https://x.test", secret: "s" })).not.toHaveProperty(
            "secret"
        );
    });
});

describe("editing a saved webhook", () => {
    it("keeps the URL and secret it cannot see unless they are replaced or removed", () => {
        const form = formFor(saved());
        expect(formProblem(form, saved())).toBeNull();
        const draft = draftOf(form, saved());
        expect(draft).not.toHaveProperty("url");
        expect(draft).not.toHaveProperty("secret");
        expect(draft).toMatchObject({
            name: "Team",
            project: "checkout-web",
            events: ["annotation.created", "annotation.resolved"],
        });

        expect(draftOf({ ...form, replaceUrl: true, url: "https://new.test" }, saved()).url).toBe(
            "https://new.test"
        );
        expect(draftOf({ ...form, secretAction: "remove" }, saved()).secret).toBeNull();
        expect(draftOf({ ...form, secretAction: "set", secret: "new" }, saved()).secret).toBe(
            "new"
        );
    });

    it("shows a secret named by environment variable, since the name is not the secret", () => {
        const form = formFor(saved({ secret: { kind: "env", name: "HOOK", set: true } }));
        expect(form.secret).toBe("env:HOOK");
        expect(form.secretAction).toBe("keep");
    });
});

describe("describing events", () => {
    it("names a few, counts many, and says when it is all of them", () => {
        expect(eventsSummary(null)).toBe("Every event");
        expect(eventsSummary(["annotation.created", "annotation.resolved"])).toBe(
            "New note, Resolved"
        );
        expect(eventsSummary(["a", "b", "c", "d"])).toBe("4 events");
    });

    it("orders the server's events the way a person reads them, keeping ones it does not know", () => {
        expect(
            orderEvents(["annotation.deleted", "annotation.created", "annotation.future"])
        ).toEqual(["annotation.created", "annotation.deleted", "annotation.future"]);
    });
});
