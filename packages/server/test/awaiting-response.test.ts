import { describe, expect, it } from "bun:test";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    filesFor,
    makeBackend,
} from "./helpers.ts";

const defer = cleanupAfterEach();
async function setup() {
    const ctx = makeBackend();
    defer(ctx.cleanup);
    const { stored } = await ctx.backend.ingest(annotationFixture(), filesFor());
    return { ...ctx, id: stored.annotation.id, ...(await connectMcp(ctx.backend, defer)) };
}

describe("agent questions", () => {
    it("waits for a person, excludes the agent queue and resumes exactly once on an answer", async () => {
        const t = await setup();
        expect(
            (await t.call("notato_ask_question", { id: t.id, question: "Which shade of blue?" }))
                .isError
        ).toBeUndefined();
        expect((await t.backend.get(t.id))?.annotation).toMatchObject({
            status: "awaiting_response",
            awaitingResponse: { resumeStatus: "acknowledged" },
            thread: [{ body: "Which shade of blue?", author: { kind: "agent" } }],
        });
        expect(t.text(await t.call("notato_list_open"))).not.toContain(t.id);
        await t.backend.reply(t.id, "Private aside", { kind: "human" }, { aside: true });
        await t.backend.reply(t.id, "Another thought", { kind: "agent" });
        expect((await t.backend.get(t.id))?.annotation.status).toBe("awaiting_response");
        await t.backend.reply(t.id, "Use #123456", { kind: "human" });
        expect((await t.backend.get(t.id))?.annotation.status).toBe("acknowledged");
        expect((await t.backend.get(t.id))?.annotation.awaitingResponse).toBeUndefined();
        const watch = { timeoutSeconds: 1, windowMs: 0, screenshots: "none" };
        expect(t.text(await t.call("notato_watch", watch))).toContain("Use #123456");
        expect(t.text(await t.call("notato_watch", watch))).toContain("No new annotations");
    });
    it("preserves revert work through repeated questions and never lets a human impersonate an agent question", async () => {
        const t = await setup();
        await t.backend.setStatus(t.id, "resolved");
        await t.backend.setStatus(t.id, "revert_requested");
        await t.call("notato_ask_question", { id: t.id, question: "Revert all of it?" });
        await t.call("notato_ask_question", { id: t.id, question: "Including the colours?" });
        await t.backend.reply(t.id, "Yes");
        expect((await t.backend.get(t.id))?.annotation.status).toBe("revert_requested");
        await expect(
            t.backend.setStatus(t.id, "awaiting_response", "Fake question")
        ).rejects.toThrow("only an agent");
        await expect(
            t.backend.setStatus(t.id, "awaiting_response", " ", { kind: "agent" })
        ).rejects.toThrow("question is required");
        await t.backend.setStatus(t.id, "resolved");
        expect(
            (await t.call("notato_ask_question", { id: t.id, question: "Too late?" })).isError
        ).toBe(true);
    });
    it("never resumes an agent on a private reply", async () => {
        const t = await setup();
        await t.call("notato_ask_question", { id: t.id, question: "Which layout?" });
        await t.backend.update(t.id, { peopleOnly: true });
        await t.backend.reply(t.id, "Keep this private");
        expect((await t.backend.get(t.id))?.annotation.status).toBe("awaiting_response");
    });
});

it("resumes a pending variant choice after the person answers", async () => {
    const t = await setup();
    await t.backend.offerVariants(t.id, {
        group: "header",
        options: [{ name: "Original" }, { name: "Rounded" }],
    });
    await t.backend.chooseVariant(t.id, "Rounded");
    await t.call("notato_ask_question", { id: t.id, question: "Apply it to the footer too?" });
    await t.backend.reply(t.id, "Yes");
    const a = (await t.backend.get(t.id))?.annotation;
    expect(a?.status).toBe("variant_chosen");
    expect(a?.variants?.chosen).toBe("Rounded");
});
