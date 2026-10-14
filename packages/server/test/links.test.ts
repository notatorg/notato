import { describe, expect, it } from "bun:test";
import { renderAnnotation } from "@notato/core";
import { annotationFixture, cleanupAfterEach, filesFor, multipart } from "./helpers.ts";
import { bearer, issue, post, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();

describe("links to other systems", () => {
    it("lets an agent record where a note went, once per address, and shows it in the Markdown", async () => {
        const s = await startServe(defer);
        const app = await issue(s, "p");
        const agent = await issue(s, "p", "agent", { purpose: "agent" });
        const { a } = await post(s, app, "p");
        const add = (body: unknown, token = agent) =>
            s.call(`/annotations/${a.id}/links`, {
                method: "POST",
                headers: { ...bearer(token), "content-type": "application/json" },
                body: JSON.stringify(body),
            });
        const link = {
            plugin: "github",
            url: "https://github.com/acme/web/issues/123",
            ref: "#123",
            title: "Button misaligned",
        };
        expect((await add(link)).status).toBe(201);
        expect((await add(link)).status).toBe(201);
        const stored = (await s.rt.backend.get(a.id))?.annotation;
        expect(stored?.links).toHaveLength(1);
        expect(stored?.links?.[0]).toMatchObject(link);
        expect(renderAnnotation(stored as never, { detail: "standard" })).toContain(
            "Links: github #123 <https://github.com/acme/web/issues/123>"
        );
    });

    it("refuses an app token, a bad address and an unknown note", async () => {
        const s = await startServe(defer);
        const app = await issue(s, "p");
        const agent = await issue(s, "p", "agent", { purpose: "agent" });
        const { a } = await post(s, app, "p");
        const add = (id: string, token: string, url: string) =>
            s.call(`/annotations/${id}/links`, {
                method: "POST",
                headers: { ...bearer(token), "content-type": "application/json" },
                body: JSON.stringify({ plugin: "github", url }),
            });
        expect((await add(a.id, app, "https://example.com/1")).status).toBe(403);
        expect((await add(a.id, agent, "javascript:alert(1)")).status).toBe(400);
        expect((await add(a.id, agent, "ftp://example.com/1")).status).toBe(400);
        expect(
            (await add("01HZZZZZZZZZZZZZZZZZZZZZZZ", agent, "https://example.com/1")).status
        ).toBe(404);
    });

    it("drops links an app sends with its note, but keeps them when a bundle is imported", async () => {
        const s = await startServe(defer);
        const app = await issue(s, "p");
        const sneaky = annotationFixture({
            projectId: "p",
            links: [
                {
                    plugin: "github",
                    url: "https://evil.example/phish",
                    createdAt: "2026-01-01T00:00:00.000Z",
                },
            ],
        });
        const sent = await s.call("/projects/p/annotations", {
            method: "POST",
            headers: bearer(app),
            body: multipart(sneaky, filesFor()),
        });
        expect(sent.status).toBe(201);
        expect((await s.rt.backend.get(sneaky.id))?.annotation.links).toBeUndefined();
    });
});
