import { describe, expect, it } from "bun:test";
import type { Annotation } from "@notato/schema";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    filesFor,
    makeBackend,
} from "./helpers.ts";

// What the person writes in a thread reaches the agent's `notato_watch` as a FOLLOW-UP: once, whatever the note's
// status, and never twice with what it is already being handed (a new note, a pick).

const defer = cleanupAfterEach();

const OFFER = {
    group: "hero",
    options: [
        { name: "Original" },
        { name: "Stacked", summary: "Image above the text" },
        { name: "Compact", summary: "Tighter spacing" },
    ],
};

/** A store whose notes ask for variants unless a test says otherwise, so any of them can be offered versions. */
async function setup() {
    const ctx = makeBackend();
    defer(ctx.cleanup);
    const add = async (over: Partial<Annotation> = {}) =>
        (await ctx.backend.ingest(annotationFixture({ intent: "variants", ...over }), filesFor()))
            .stored;
    return { ...ctx, add };
}

const watch = { timeoutSeconds: 3, windowMs: 0, screenshots: "none" };

describe("replies from the person reach notato_watch", () => {
    it("delivers a reply to a thread the agent is working on, once, marked FOLLOW-UP", async () => {
        const t = await setup();
        const { annotation } = await t.add({ intent: "change", comment: "make the header nicer" });
        const { call, text } = await connectMcp(t.backend, defer);
        await call("notato_watch", watch);
        await call("notato_acknowledge", { id: annotation.id });
        await call("notato_reply", {
            id: annotation.id,
            body: "Do you mean the colours or the layout?",
        });
        // The agent has asked; nothing is waiting for it yet.
        expect(text(await call("notato_watch", { ...watch, timeoutSeconds: 1 }))).toContain(
            "No new annotations"
        );
        await t.backend.reply(annotation.id, "The layout, please");
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("1 reply from the person.");
        expect(out).toContain("FOLLOW-UP");
        expect(out).toContain("The layout, please");
        expect(text(await call("notato_watch", { ...watch, timeoutSeconds: 1 }))).toContain(
            "No new annotations"
        );
        // A second reply is a second delivery.
        await t.backend.reply(annotation.id, "And keep the logo");
        expect(text(await call("notato_watch", watch))).toContain("And keep the logo");
    });

    it("wakes a watch that is waiting, within a few seconds", async () => {
        const t = await setup();
        const { annotation } = await t.add({ intent: "question" });
        const { call, text } = await connectMcp(t.backend, defer);
        await call("notato_watch", watch);
        await call("notato_acknowledge", { id: annotation.id });
        const waiting = call("notato_watch", {
            timeoutSeconds: 10,
            windowMs: 0,
            screenshots: "none",
        });
        await new Promise((r) => setTimeout(r, 100));
        await t.backend.reply(annotation.id, "Which breakpoint?");
        const started = Date.now();
        expect(text(await waiting)).toContain("Which breakpoint?");
        expect(Date.now() - started).toBeLessThan(4500);
    });

    it("is not delivered twice with a new annotation, and a new annotation is not a follow-up", async () => {
        const t = await setup();
        const { annotation } = await t.add({ comment: "brand new" });
        await t.backend.reply(annotation.id, "one more detail");
        const { call, text } = await connectMcp(t.backend, defer);
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("1 new annotation.");
        expect(out).not.toContain("reply from the person");
        expect(out).not.toContain("FOLLOW-UP");
    });

    it("an acknowledged annotation with the person's last word is delivered to a session that starts later", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        await t.backend.setStatus(annotation.id, "acknowledged", "On it", {
            kind: "agent",
            name: "Claude",
        });
        await t.backend.reply(annotation.id, "Any news?");
        const { call, text } = await connectMcp(t.backend, defer);
        expect(text(await call("notato_watch", watch))).toContain("Any news?");
    });

    it("a reopened annotation, with the person's note, is delivered", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        const { call, text } = await connectMcp(t.backend, defer);
        await call("notato_watch", watch);
        await call("notato_resolve", { id: annotation.id, summary: "fixed" });
        await t.backend.setStatus(annotation.id, "open", "Still broken on mobile");
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("Still broken on mobile");
        expect(out).toContain("FOLLOW-UP");
    });

    it("taking a pick back with a note says something, so it is delivered; without one it is not", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        const { call, text } = await connectMcp(t.backend, defer);
        await call("notato_watch", watch);
        await call("notato_variants_ready", { id: annotation.id, ...OFFER });
        await t.backend.chooseVariant(annotation.id, "Stacked");
        await t.backend.chooseVariant(annotation.id, null, "None of these, make it bolder");
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("None of these, make it bolder");
        expect(out).toContain("FOLLOW-UP");
        const thread = (await t.backend.get(annotation.id))?.annotation.thread ?? [];
        // The pick is something the person did; taking it back with a note is something they said.
        expect(thread.filter((r) => r.automatic)).toHaveLength(1);
        expect(thread.at(-1)?.automatic).toBeUndefined();
    });

    it("a request for different versions after a pick is delivered, once, and the pick's own note is not", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        const { call, text } = await connectMcp(t.backend, defer);
        await call("notato_watch", watch);
        await call("notato_variants_ready", { id: annotation.id, ...OFFER });
        await t.backend.chooseVariant(annotation.id, "Stacked", "I like this one");
        const picked = text(await call("notato_watch", watch));
        expect(picked).toContain("1 variant pick.");
        expect(picked).not.toContain("reply from the person");
        expect(text(await call("notato_watch", { ...watch, timeoutSeconds: 1 }))).toContain(
            "No new annotations"
        );
        await t.backend.reply(annotation.id, "Make Stacked bolder and add a fourth");
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("1 reply from the person.");
        expect(out).toContain("Make Stacked bolder and add a fourth");
        expect(out).toContain("FOLLOW-UP");
        // The agent then offers a new set, which clears the pick.
        await call("notato_variants_ready", {
            id: annotation.id,
            group: "hero",
            options: [{ name: "Original" }, { name: "Bolder" }, { name: "Right" }],
        });
        expect((await t.backend.get(annotation.id))?.annotation.status).toBe("acknowledged");
        expect(text(await call("notato_watch", { ...watch, timeoutSeconds: 1 }))).toContain(
            "No new annotations"
        );
    });

    it("a pick the person has since written about is delivered as their message, not as a pick, and does not make the next watch spin", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        await t.backend.offerVariants(annotation.id, OFFER);
        await t.backend.chooseVariant(annotation.id, "Stacked");
        await t.backend.reply(annotation.id, "Actually, make Stacked bolder");
        // A session that starts after both: the message is what to act on.
        const { call, text } = await connectMcp(t.backend, defer);
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("1 reply from the person.");
        expect(out).toContain("make Stacked bolder");
        expect(out).not.toContain("VARIANT CHOSEN");
        const started = Date.now();
        expect(text(await call("notato_watch", { ...watch, timeoutSeconds: 1 }))).toContain(
            "No new annotations"
        );
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
        // A fresh pick after that is a pick again.
        await t.backend.chooseVariant(annotation.id, "Compact");
        expect(text(await call("notato_watch", watch))).toContain("VARIANT CHOSEN: “Compact”");
    });

    it("a pick's own note is not also a follow-up, and a resolved annotation's reply is one, still resolved", async () => {
        const t = await setup();
        const a = await t.add();
        const b = await t.add();
        const { call, text } = await connectMcp(t.backend, defer);
        await call("notato_watch", watch);
        await call("notato_variants_ready", { id: a.annotation.id, ...OFFER });
        await t.backend.chooseVariant(a.annotation.id, "Stacked", "love it");
        await t.backend.setStatus(b.annotation.id, "resolved", "done", { kind: "agent" });
        await t.backend.reply(b.annotation.id, "thanks");
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("1 variant pick and 1 reply from the person.");
        expect(out).toContain("thanks");
        expect(out).toContain("A plain acknowledgement (thanks, looks good) needs nothing");
        expect((await t.backend.get(b.annotation.id))?.annotation.status).toBe("resolved");
    });

    it("delivers any reply on a resolved annotation, and leaves it resolved for the agent to reopen", async () => {
        const t = await setup();
        const resolved = await t.add({ id: "01TEST0000000000000000BBB1", comment: "Make it blue" });
        await t.backend.setStatus(resolved.annotation.id, "resolved", "Made it blue.", {
            kind: "agent",
            name: "Claude",
        });
        const { call, text } = await connectMcp(t.backend, defer, { client: "test-client" });
        text(await call("notato_watch", watch)); // the backlog

        await t.backend.reply(resolved.annotation.id, "can you make the border blue too?");
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("1 reply from the person.");
        expect(out).toContain("↩ FOLLOW-UP.");
        expect(out).toContain("reopen it with notato_acknowledge");
        expect(out).toContain("border blue too");
        expect((await t.backend.get(resolved.annotation.id))?.annotation.status).toBe("resolved");
        expect(text(await call("notato_watch", { ...watch, timeoutSeconds: 1 }))).toContain(
            "No new annotations"
        );

        // Reopening is the agent's call: acknowledge does it.
        await call("notato_acknowledge", { id: resolved.annotation.id });
        expect((await t.backend.get(resolved.annotation.id))?.annotation.status).toBe(
            "acknowledged"
        );
    });
});
