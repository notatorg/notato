import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Annotation } from "@notato/schema";
import {
    type Backend,
    createMcpServer,
    eventFor,
    type LocalBackend,
    type NotatoEvent,
    startWebhooks,
    type Webhook,
} from "../src/index.ts";
import { annotationFixture, filesFor, ingest, makeApp, makeBackend } from "./helpers.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
});

const OFFER = {
    group: "hero",
    options: [
        { name: "Original" },
        { name: "Stacked", summary: "Image above the text" },
        { name: "Compact", summary: "Tighter spacing" },
    ],
};

async function setup() {
    const ctx = makeBackend();
    cleanups.push(ctx.cleanup);
    const add = async (over: Partial<Annotation> = {}) =>
        (await ctx.backend.ingest(annotationFixture({ intent: "variants", ...over }), filesFor()))
            .stored;
    return { ...ctx, add };
}

describe("offering variants", () => {
    it("records them on the annotation, acknowledges it, and says so in the thread", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        const updated = await backend.offerVariants(annotation.id, OFFER);
        expect(updated?.annotation.status).toBe("acknowledged");
        expect(updated?.annotation.variants).toMatchObject({
            group: "hero",
            options: OFFER.options,
        });
        expect(updated?.annotation.variants?.offeredAt).toBeTruthy();
        expect(updated?.annotation.variants?.chosen).toBeUndefined();
        const last = updated?.annotation.thread.at(-1);
        // Without an MCP client to name it, the agent is just "Agent".
        expect(last?.author).toEqual({ kind: "agent", name: "Agent" });
        expect(last?.body).toContain("Original, Stacked, Compact");
    });

    it("uses the agent's own note when it gives one", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        const updated = await backend.offerVariants(annotation.id, {
            ...OFFER,
            note: "Three takes on the header.",
        });
        expect(updated?.annotation.thread.at(-1)?.body).toBe("Three takes on the header.");
    });

    it("refuses what cannot be offered, and says what is wrong", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        const refusal = async (offer: unknown, expected: string) => {
            const error = await backend
                .offerVariants(annotation.id, offer as never)
                .catch((e: Error) => e);
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain(expected);
        };
        await refusal({ ...OFFER, options: [{ name: "Only one" }] }, "invalid variants");
        await refusal({ ...OFFER, group: "has space" }, "invalid variants");
        await refusal({ ...OFFER, options: [{ name: "A" }, { name: "A" }] }, "appears twice");
        expect((await backend.get(annotation.id))?.annotation.variants).toBeUndefined();
    });

    it("only for an annotation that is still being worked on", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        await backend.setStatus(annotation.id, "resolved", "done");
        const error = await backend
            .offerVariants(annotation.id, OFFER)
            .catch((e: Error & { status?: number }) => e);
        expect((error as Error).message).toContain("open or acknowledged (this one is resolved)");
        expect((error as { status?: number }).status).toBe(409);
    });

    it("an unknown annotation is null, not an error", async () => {
        const { backend } = await setup();
        expect(await backend.offerVariants("01NOPE", OFFER)).toBeNull();
    });

    it("offering again replaces the offer and clears an earlier pick", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        await backend.offerVariants(annotation.id, OFFER);
        await backend.chooseVariant(annotation.id, "Stacked");
        const again = await backend.offerVariants(annotation.id, {
            group: "hero",
            options: [{ name: "Original" }, { name: "Bolder" }],
        });
        expect(again?.annotation.status).toBe("acknowledged");
        expect(again?.annotation.variants?.options.map((o) => o.name)).toEqual([
            "Original",
            "Bolder",
        ]);
        expect(again?.annotation.variants?.chosen).toBeUndefined();
    });
});

describe("choosing a variant", () => {
    it("records the pick as the person's, and moves the annotation to variant_chosen", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        await backend.offerVariants(annotation.id, OFFER);
        const picked = await backend.chooseVariant(annotation.id, "Stacked", "I like the spacing");
        expect(picked?.annotation.status).toBe("variant_chosen");
        expect(picked?.annotation.variants?.chosen).toBe("Stacked");
        expect(picked?.annotation.variants?.chosenAt).toBeTruthy();
        const last = picked?.annotation.thread.at(-1);
        expect(last?.author.kind).toBe("human");
        expect(last?.body).toBe("Picked “Stacked”.\nI like the spacing");
    });

    it("must be one of the options offered", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        await backend.offerVariants(annotation.id, OFFER);
        const error = await backend.chooseVariant(annotation.id, "Wild").catch((e: Error) => e);
        expect((error as Error).message).toContain(
            '"Wild" is not one of the variants offered: Original, Stacked, Compact'
        );
        expect((await backend.get(annotation.id))?.annotation.status).toBe("acknowledged");
    });

    it("needs an offer first", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        const error = await backend.chooseVariant(annotation.id, "Stacked").catch((e: Error) => e);
        expect((error as Error).message).toContain("no variants have been offered");
    });

    it("can be changed before the agent has acted, and taken back", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        await backend.offerVariants(annotation.id, OFFER);
        await backend.chooseVariant(annotation.id, "Stacked");
        const changed = await backend.chooseVariant(annotation.id, "Compact");
        expect(changed?.annotation.variants?.chosen).toBe("Compact");
        const back = await backend.chooseVariant(annotation.id, null);
        expect(back?.annotation.status).toBe("acknowledged");
        expect(back?.annotation.variants?.chosen).toBeUndefined();
        expect(back?.annotation.variants?.chosenAt).toBeUndefined();
        expect(back?.annotation.variants?.options).toHaveLength(3);
        expect(back?.annotation.thread.at(-1)?.body).toBe("Took back the pick (“Compact”).");
    });

    it("taking back when nothing is picked changes nothing", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        const offered = await backend.offerVariants(annotation.id, OFFER);
        const same = await backend.chooseVariant(annotation.id, null);
        expect(same?.annotation.thread).toHaveLength(offered?.annotation.thread.length ?? -1);
    });

    it("not once it is resolved", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        await backend.offerVariants(annotation.id, OFFER);
        await backend.setStatus(annotation.id, "resolved", "applied");
        const error = await backend.chooseVariant(annotation.id, "Stacked").catch((e: Error) => e);
        expect((error as Error).message).toContain(
            "while the annotation is acknowledged (this one is resolved)"
        );
    });

    it("is the only way to reach variant_chosen: setting the status directly is refused", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        const error = await backend
            .setStatus(annotation.id, "variant_chosen")
            .catch((e: Error) => e);
        expect((error as Error).message).toContain("variants/choose");
    });

    it("resolving after a pick works, and a revert can then be asked for as with any change", async () => {
        const { backend, add } = await setup();
        const { annotation } = await add();
        await backend.offerVariants(annotation.id, OFFER);
        await backend.chooseVariant(annotation.id, "Stacked");
        const resolved = await backend.setStatus(
            annotation.id,
            "resolved",
            "Resolved: applied Stacked"
        );
        expect(resolved?.annotation.status).toBe("resolved");
        expect(resolved?.annotation.variants?.chosen).toBe("Stacked"); // kept as the record of what was picked
        const asked = await backend.setStatus(annotation.id, "revert_requested", "undo");
        expect(asked?.annotation.status).toBe("revert_requested");
    });
});

describe("filtering by who wrote it", () => {
    it("lists one person's notes, over HTTP and through the query helpers", async () => {
        const ctx = makeApp();
        cleanups.push(ctx.cleanup);
        await ingest(ctx.call, { comment: "from dom", author: { kind: "human", name: "Dom" } });
        await ingest(ctx.call, { comment: "from ana", author: { kind: "human", name: "Ana" } });
        await ingest(ctx.call, { comment: "from an agent", author: { kind: "agent" } });
        const by = async (name: string) =>
            (
                (await (
                    await ctx.call(
                        `/projects/checkout-web/annotations?by=${encodeURIComponent(name)}`
                    )
                ).json()) as {
                    items: Array<{ annotation: Annotation }>;
                }
            ).items.map((i) => i.annotation.comment);
        expect(await by("Dom")).toEqual(["from dom"]);
        expect(await by("Ana")).toEqual(["from ana"]);
        expect(await by("Nobody")).toEqual([]);
        expect(
            await (await ctx.call("/projects/checkout-web/markdown?by=Ana&detail=compact")).text()
        ).toContain("from ana");
    });
});

describe("variants over HTTP", () => {
    let ctx: ReturnType<typeof makeApp> | undefined;
    afterEach(() => {
        ctx?.cleanup();
        ctx = undefined;
    });
    const put = (id: string, body: unknown) =>
        ctx?.call(`/annotations/${id}/variants`, {
            method: "PUT",
            body: JSON.stringify(body),
        }) as Promise<Response>;
    const choose = (id: string, body: unknown) =>
        ctx?.call(`/annotations/${id}/variants/choose`, {
            method: "POST",
            body: JSON.stringify(body),
        }) as Promise<Response>;

    it("PUT offers, POST chooses, and both return the annotation", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call, { intent: "variants" });
        const offered = await put(annotation.id, OFFER);
        expect(offered.status).toBe(200);
        expect(
            ((await offered.json()) as { annotation: Annotation }).annotation.variants?.group
        ).toBe("hero");
        const picked = await choose(annotation.id, {
            name: "Compact",
            author: { kind: "human", name: "Dom" },
        });
        const body = (await picked.json()) as { annotation: Annotation };
        expect(body.annotation.status).toBe("variant_chosen");
        expect(body.annotation.thread.at(-1)?.author).toEqual({ kind: "human", name: "Dom" });
        const taken = await choose(annotation.id, { name: null });
        expect(((await taken.json()) as { annotation: Annotation }).annotation.status).toBe(
            "acknowledged"
        );
    });

    it("says what is wrong, with the right status", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        expect((await choose(annotation.id, { name: "Stacked" })).status).toBe(409);
        expect((await put(annotation.id, { ...OFFER, options: [{ name: "One" }] })).status).toBe(
            400
        );
        expect((await put(annotation.id, { ...OFFER, extra: 1 })).status).toBe(400);
        await put(annotation.id, OFFER);
        const unknown = await choose(annotation.id, { name: "Wild" });
        expect(unknown.status).toBe(400);
        expect(((await unknown.json()) as { error: string }).error).toContain(
            "not one of the variants offered"
        );
        expect((await put("01NOPE", OFFER)).status).toBe(404);
        expect((await choose("01NOPE", { name: "x" })).status).toBe(404);
    });

    it("PATCH cannot set variant_chosen", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        const res = await ctx.call(`/annotations/${annotation.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "variant_chosen" }),
        });
        expect(res.status).toBe(409);
    });

    it("variant_chosen is filterable like any status, and counts as needing attention", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        await put(annotation.id, OFFER);
        await choose(annotation.id, { name: "Compact" });
        const listed = (await (
            await ctx.call("/projects/checkout-web/annotations?status=variant_chosen")
        ).json()) as {
            items: unknown[];
        };
        expect(listed.items).toHaveLength(1);
        const projects = (await (await ctx.call("/projects")).json()) as {
            items: Array<{ id: string; open: number }>;
        };
        expect(projects.items.find((p) => p.id === "checkout-web")?.open).toBe(1);
    });
});

async function mcp(backend: Backend) {
    const server = createMcpServer({ backend, version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })) as unknown as {
            content: Array<{ type: string; text?: string }>;
            isError?: boolean;
        };
    const text = (r: Awaited<ReturnType<typeof call>>) =>
        r.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
    return { client, call, text };
}

const watch = { timeoutSeconds: 3, windowMs: 0, screenshots: "none" };

describe("notato_variants_ready", () => {
    it("offers the versions, tells the agent how the page finds them, and shows in the annotation", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        const { call, text } = await mcp(t.backend);
        const result = await call("notato_variants_ready", { id: annotation.id, ...OFFER });
        expect(result.isError).toBeUndefined();
        expect(text(result)).toContain("Original, Stacked, Compact");
        expect(text(result)).toContain('data-notato-variant="hero"');
        expect((await t.backend.get(annotation.id))?.annotation.variants?.group).toBe("hero");
        expect(
            text(await call("notato_get", { id: annotation.id, screenshots: "none" }))
        ).toContain("Variants: group `hero`");
    });

    it("reports problems as errors the agent can act on", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        const { call, text } = await mcp(t.backend);
        const dup = await call("notato_variants_ready", {
            id: annotation.id,
            group: "hero",
            options: [{ name: "A" }, { name: "A" }],
        });
        expect(dup.isError).toBe(true);
        expect(text(dup)).toContain("appears twice");
        expect((await call("notato_variants_ready", { id: "01NOPE", ...OFFER })).isError).toBe(
            true
        );
        const tooFew = await call("notato_variants_ready", {
            id: annotation.id,
            group: "hero",
            options: [{ name: "A" }],
        });
        expect(tooFew.isError).toBe(true);
    });

    it("is refused for a revert request, which has to be undone first", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        await t.backend.setStatus(annotation.id, "resolved", "done");
        await t.backend.setStatus(annotation.id, "revert_requested", "undo");
        const { call, text } = await mcp(t.backend);
        const result = await call("notato_variants_ready", { id: annotation.id, ...OFFER });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("notato_reverted");
    });
});

describe("a pick reaches notato_watch", () => {
    async function picked(name = "Stacked") {
        const t = await setup();
        const { annotation } = await t.add({ comment: "three versions of the hero" });
        const m = await mcp(t.backend);
        // The agent has seen the annotation as new, offered, and is now waiting.
        await m.call("notato_watch", watch);
        await m.call("notato_variants_ready", { id: annotation.id, ...OFFER });
        await t.backend.chooseVariant(annotation.id, name);
        return { ...t, ...m, id: annotation.id };
    }

    it("with what it must do: keep that version, remove the rest and every marker, then resolve", async () => {
        const { call, text } = await picked();
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("1 variant pick.");
        expect(out).toContain("VARIANT CHOSEN: “Stacked”");
        expect(out).toContain("“Original”, “Compact”");
        expect(out).toContain(
            "remove every wrapper element and both data-notato-variant attributes"
        );
        expect(out).toContain("notato_resolve");
        expect(out).toContain("Variants: group `hero`");
    });

    it("once per pick, and again when the person picks something else", async () => {
        const { call, text, backend, id } = await picked();
        expect(text(await call("notato_watch", watch))).toContain("VARIANT CHOSEN: “Stacked”");
        expect(text(await call("notato_watch", { ...watch, timeoutSeconds: 1 }))).toContain(
            "No new annotations"
        );
        await new Promise((r) => setTimeout(r, 5));
        await backend.chooseVariant(id, "Compact");
        expect(text(await call("notato_watch", watch))).toContain("VARIANT CHOSEN: “Compact”");
    });

    it("wakes a watch that is already waiting", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        const { call, text } = await mcp(t.backend);
        await call("notato_watch", watch);
        await call("notato_variants_ready", { id: annotation.id, ...OFFER });
        const waiting = call("notato_watch", {
            timeoutSeconds: 10,
            windowMs: 0,
            screenshots: "none",
        });
        await new Promise((r) => setTimeout(r, 150));
        await t.backend.chooseVariant(annotation.id, "Compact");
        expect(text(await waiting)).toContain("VARIANT CHOSEN: “Compact”");
    });

    it("is in notato_list_open", async () => {
        const { call, text } = await picked();
        expect(text(await call("notato_list_open"))).toContain("variant_chosen");
    });

    it("cannot be wiped by acknowledging, and resolves normally", async () => {
        const { call, text, backend, id } = await picked();
        const ack = text(await call("notato_acknowledge", { id, note: "on it" }));
        expect(ack).toContain("has a variant picked");
        expect((await backend.get(id))?.annotation.status).toBe("variant_chosen");
        expect(
            text(await call("notato_resolve", { id, summary: "applied Stacked", commit: "abc123" }))
        ).toContain("Resolved");
        expect((await backend.get(id))?.annotation.status).toBe("resolved");
    });

    it("a pick that is taken back is not delivered", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        const { call, text } = await mcp(t.backend);
        await call("notato_watch", watch);
        await call("notato_variants_ready", { id: annotation.id, ...OFFER });
        await t.backend.chooseVariant(annotation.id, "Stacked");
        await t.backend.chooseVariant(annotation.id, null);
        expect(text(await call("notato_watch", { ...watch, timeoutSeconds: 1 }))).toContain(
            "No new annotations"
        );
    });
});

describe("replies from the person reach notato_watch", () => {
    it("delivers a reply to a thread the agent is working on, once, marked FOLLOW-UP", async () => {
        const t = await setup();
        const { annotation } = await t.add({ intent: "change", comment: "make the header nicer" });
        const { call, text } = await mcp(t.backend);
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
        const { call, text } = await mcp(t.backend);
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
        const { call, text } = await mcp(t.backend);
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
        const { call, text } = await mcp(t.backend);
        expect(text(await call("notato_watch", watch))).toContain("Any news?");
    });

    it("a reopened annotation, with the person's note, is delivered", async () => {
        const t = await setup();
        const { annotation } = await t.add();
        const { call, text } = await mcp(t.backend);
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
        const { call, text } = await mcp(t.backend);
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
        const { call, text } = await mcp(t.backend);
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
        const { call, text } = await mcp(t.backend);
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
        const { call, text } = await mcp(t.backend);
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
});

describe("webhooks for variants", () => {
    const event = (annotation: Annotation, type: NotatoEvent["type"] = "updated"): NotatoEvent => ({
        type,
        projectId: annotation.projectId,
        id: annotation.id,
        seq: 1,
        annotation,
    });
    const base = annotationFixture({ intent: "variants" });
    const offered = (at: string): Annotation => ({
        ...base,
        status: "acknowledged",
        variants: { ...OFFER, offeredAt: at },
    });

    it("an offer is variants_ready, whether or not the status changed, and a repeat is not", () => {
        expect(eventFor(event(offered("t1")), "open", undefined)).toBe("annotation.variants_ready");
        expect(eventFor(event(offered("t2")), "acknowledged", "t1")).toBe(
            "annotation.variants_ready"
        );
        expect(eventFor(event(offered("t1")), "acknowledged", "t1")).toBe("annotation.updated");
    });

    it("a pick is variant_chosen, and taking it back is acknowledged", () => {
        const chosen: Annotation = {
            ...offered("t1"),
            status: "variant_chosen",
            variants: { ...OFFER, offeredAt: "t1", chosen: "Stacked", chosenAt: "t2" },
        };
        expect(eventFor(event(chosen), "acknowledged", "t1")).toBe("annotation.variant_chosen");
        expect(eventFor(event(offered("t1")), "variant_chosen", "t1")).toBe(
            "annotation.acknowledged"
        );
    });

    it("reach a real receiver, in order, with the pick named in a chat line", async () => {
        const got: Array<{ event: string; body: string }> = [];
        const receiver = Bun.serve({
            port: 0,
            async fetch(req) {
                got.push({
                    event: req.headers.get("x-notato-event") ?? "",
                    body: await req.text(),
                });
                return new Response("ok");
            },
        });
        cleanups.push(() => receiver.stop(true));
        const t = await setup();
        const hooks: Webhook[] = [{ url: `http://127.0.0.1:${receiver.port}/in`, format: "slack" }];
        const dispatcher = startWebhooks({
            bus: (t.backend as LocalBackend).bus,
            config: () => ({
                screenshots: true,
                mcp: true,
                source: { screenshots: "default", mcp: "default" },
                webhooks: hooks,
            }),
            retryDelaysMs: [5],
        });
        cleanups.push(() => dispatcher.stop());
        const { annotation } = await t.add();
        await t.backend.offerVariants(annotation.id, OFFER);
        await t.backend.chooseVariant(annotation.id, "Stacked");
        await dispatcher.flush();
        expect(got.map((g) => g.event)).toEqual([
            "annotation.created",
            "annotation.variants_ready",
            "annotation.variant_chosen",
        ]);
        expect(got[2]?.body).toContain("picked “Stacked”");
    });
});
