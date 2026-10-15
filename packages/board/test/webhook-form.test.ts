import { afterEach, describe, expect, it } from "bun:test";
import { addWebhook, editWebhook, type WebhookView } from "../src/api.ts";
import {
    draftOf,
    eventsSummary,
    formFor,
    formProblem,
    orderEvents,
    saveProblem,
    secretGoesInFile,
    urlProblem,
} from "../src/webhook-form.ts";

const saved = (over: Partial<WebhookView> = {}): WebhookView => ({
    index: 0,
    fingerprint: "abc",
    name: "Team",
    url: "https://hooks.slack.com/••••",
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

describe("a URL read from the server's environment", () => {
    it("is written env:NAME, with a name the server can read", () => {
        const form = formFor();
        for (const url of ["env:SLACK_WEBHOOK_URL", " env:_hook2 "])
            expect(formProblem({ ...form, url }), url).toBeNull();
        for (const url of ["env:", "env:1HOOK", "env:MY-HOOK", "env:A B"])
            expect(urlProblem({ ...form, url }), url).toContain("After env:");
        // Only as the server writes it: anything else is a URL, and not an http one.
        expect(formProblem({ ...form, url: "ENV:HOOK" })).toBe("The URL must start with https://.");
        expect(draftOf({ ...form, url: " env:SLACK_WEBHOOK_URL " }).url).toBe(
            "env:SLACK_WEBHOOK_URL"
        );
    });
});

describe("a signing secret typed as it is", () => {
    const json = { ...formFor(), format: "json" as const, url: "https://x.test/h" };

    it("is not saved into the settings file unless that is ticked, and the form says to use env:NAME", () => {
        const typed = { ...json, secret: " s3cret " };
        expect(secretGoesInFile(typed)).toBe(true);
        expect(saveProblem(typed)).toBe(
            "Write the secret as env:NAME so it stays out of notato.config.json, or tick “Store this secret in notato.config.json”."
        );
        expect(saveProblem({ ...typed, secretInFile: true })).toBeNull();
        // A test writes nothing, so it can be sent either way.
        expect(formProblem(typed)).toBeNull();
    });

    it("is no question for env:NAME, no secret, a chat service, or a saved secret kept as it is", () => {
        expect(secretGoesInFile({ ...json, secret: "env:NOTATO_WEBHOOK_SECRET" })).toBe(false);
        expect(secretGoesInFile({ ...json, secret: "  " })).toBe(false);
        expect(secretGoesInFile({ ...json, format: "slack", secret: "s3cret" })).toBe(false);
        const kept = formFor(saved());
        expect(secretGoesInFile(kept)).toBe(false);
        expect(saveProblem(kept, saved())).toBeNull();
        expect(secretGoesInFile({ ...kept, secretAction: "remove" })).toBe(false);
        // Replacing it with one typed as it is asks again.
        expect(secretGoesInFile({ ...kept, secretAction: "set", secret: "new" })).toBe(true);
        expect(formFor().secretInFile).toBe(false);
    });
});

describe("saving, as the server is asked", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });
    const bodies = () => {
        const sent: unknown[] = [];
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            sent.push(JSON.parse(String(init?.body)));
            return Response.json({});
        }) as unknown as typeof fetch;
        return sent;
    };

    it("says to keep a secret typed as it is in the file only when asked to", async () => {
        const sent = bodies();
        const hook = { format: "json" as const, url: "https://x.test/h", secret: "s3cret" };
        await addWebhook(hook);
        await addWebhook(hook, { secretInFile: true });
        await editWebhook(saved(), hook, { secretInFile: true });
        await editWebhook(saved(), hook);
        expect(sent).toEqual([
            { hook },
            { hook, secretInFile: true },
            { fingerprint: "abc", hook, secretInFile: true },
            { fingerprint: "abc", hook },
        ]);
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
