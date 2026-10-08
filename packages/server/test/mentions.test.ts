import { describe, expect, it } from "bun:test";
import { mentionsIn } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { buildDelivery, type Mention, MentionRegistry } from "../src/index.ts";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    filesFor,
    makeApp,
    makeBackend,
    waitFor,
} from "./helpers.ts";

// `@name` in a note or a reply: the mention plugins a server can have (none built in), and what an @name means for
// the agent, which is nothing special.

const defer = cleanupAfterEach();

async function setup() {
    const ctx = makeBackend();
    defer(ctx.cleanup);
    const add = async (over: Partial<Annotation> = {}) =>
        (await ctx.backend.ingest(annotationFixture(over), filesFor())).stored;
    return { ...ctx, add };
}

const watch = { timeoutSeconds: 2, windowMs: 0, screenshots: "none" };

describe("mention plugins", () => {
    it("finds every @name once, lowercased", () => {
        expect(mentionsIn("@Design and @jira, then @design again (@qa-team)")).toEqual([
            "design",
            "jira",
            "qa-team",
        ]);
        expect(mentionsIn("mail me@jira.dev")).toEqual([]);
    });

    it("offers what is registered, says when that changes, and only then", () => {
        let open = false;
        let tell = () => {};
        const registry = new MentionRegistry([]);
        const lists: string[][] = [];
        registry.subscribe((list) =>
            lists.push(list.filter((m) => m.available).map((m) => m.name))
        );
        registry.register({ name: "design", description: "Ask the design team" });
        registry.register({
            name: "jira",
            description: "File it in Jira",
            available: () => open,
            watch: (changed) => {
                tell = changed;
                return () => {};
            },
        });
        expect(registry.list()).toEqual([
            { name: "design", description: "Ask the design team", available: true },
            { name: "jira", description: "File it in Jira", available: false },
        ]);
        tell();
        expect(lists).toHaveLength(2);
        open = true;
        tell();
        expect(lists.at(-1)).toEqual(["design", "jira"]);
        expect(registry.mentioned("@design and @nobody")).toEqual(["design"]);
        expect(() => registry.register({ name: "no spaces", description: "" })).toThrow();
    });

    it("calls a plugin for a note or a reply that mentions it, never for an automatic reply, and survives one that fails", async () => {
        const t = await setup();
        const heard: Mention[] = [];
        const logs: string[] = [];
        const registry = t.backend.mentions;
        registry.register({
            name: "design",
            description: "Ask the design team",
            onMention: (m) => void heard.push(m),
        });
        registry.register({
            name: "broken",
            description: "Always fails",
            onMention: () => {
                throw new Error("boom");
            },
        });
        (registry as unknown as { log: (m: string) => void }).log = (m) => logs.push(m);
        const { annotation } = await t.add({ comment: "@design is this the right shade? @broken" });
        await t.backend.reply(annotation.id, "@Design also the hover state");
        await t.backend.setStatus(annotation.id, "resolved", "Done. @design was asked.", {
            kind: "agent",
            name: "Claude",
        });
        await waitFor(() => heard.length === 2 && logs.length === 1);
        expect(heard.map((m) => [m.name, m.reply ? "reply" : "note", m.text])).toEqual([
            ["design", "note", "@design is this the right shade? @broken"],
            ["design", "reply", "@Design also the hover state"],
        ]);
        expect(logs).toEqual(["@broken failed: boom"]);
    });

    it("offers no plugin of its own, and tells pages when one is registered", async () => {
        const ctx = makeApp();
        defer(ctx.cleanup);
        expect((await (await ctx.call("/config")).json()).mentions).toEqual([]);
        const ac = new AbortController();
        defer(() => ac.abort());
        const reader = (
            (await ctx.call("/projects/demo/events", { signal: ac.signal }))
                .body as ReadableStream<Uint8Array>
        ).getReader();
        const decoder = new TextDecoder();
        let received = "";
        const until = async (needle: string) => {
            while (!received.includes(needle))
                received += decoder.decode((await reader.read()).value);
        };
        await until("event: hello");
        const unregister = ctx.backend.mentions.register({
            name: "jira",
            description: "File it in Jira",
        });
        await until("event: mentions");
        expect(received.slice(received.indexOf("event: mentions"))).toContain('"name":"jira"');
        unregister();
    });

    it("puts the @names someone just wrote in a webhook's payload", () => {
        const hook = { url: "https://example.com/hook", format: "json" as const };
        const note = annotationFixture({ comment: "@jira why is this here? cc @design" });
        expect(JSON.parse(buildDelivery(hook, "annotation.created", note).body).mentions).toEqual([
            "jira",
            "design",
        ]);
        const replied = {
            ...note,
            thread: [
                {
                    id: "r1",
                    author: { kind: "human" as const, name: "Dom" },
                    body: "@qa can you check",
                    createdAt: note.createdAt,
                },
            ],
        };
        expect(
            JSON.parse(buildDelivery(hook, "annotation.replied", replied).body).mentions
        ).toEqual(["qa"]);
        expect(
            JSON.parse(buildDelivery(hook, "annotation.resolved", replied).body).mentions
        ).toEqual([]);
    });
});

describe("an @name nobody registered", () => {
    it("delivers a note that says @agent like any other, in order, with nothing special about it", async () => {
        const t = await setup();
        await t.add({ id: "01TEST0000000000000000AAA1", comment: "The button is misaligned" });
        await t.add({
            id: "01TEST0000000000000000AAA2",
            comment: "@agent what does this page do when offline?",
        });
        const { call, text } = await connectMcp(t.backend, defer, { client: "test-client" });
        const out = text(await call("notato_watch", watch));
        expect(out).toContain("2 new annotations.");
        expect(out.indexOf("The button is misaligned")).toBeLessThan(
            out.indexOf("what does this page do")
        );
        expect(out).not.toContain("ADDRESSED TO YOU");
        expect(text(await call("notato_list_open"))).not.toContain("✉");
    });
});
