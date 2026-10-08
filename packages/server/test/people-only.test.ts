import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { awaitsAgent, lastWord, renderAnnotation } from "@notato/core";
import type { Annotation, Reply } from "@notato/schema";
import { type Backend, createMcpServer } from "../src/index.ts";
import { annotationFixture, filesFor, makeApp, makeBackend } from "./helpers.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
});

const AGENT = { kind: "agent" as const, name: "Claude" };
const DOM = { kind: "human" as const, name: "Dom" };
const SAM = { kind: "human" as const, name: "Sam" };

async function setup() {
    const ctx = makeBackend();
    cleanups.push(ctx.cleanup);
    const add = async (over: Partial<Annotation> = {}) =>
        (await ctx.backend.ingest(annotationFixture(over), filesFor())).stored.annotation;
    return { ...ctx, add };
}

async function mcp(backend: Backend) {
    const server = createMcpServer({ backend, version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as unknown as {
            isError?: boolean;
            content: Array<{ type: string; text?: string }>;
        };
        return {
            isError: Boolean(r.isError),
            text: r.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n"),
        };
    };
    return call;
}

const watch = { timeoutSeconds: 2, windowMs: 0, screenshots: "none" };
const quiet = { ...watch, timeoutSeconds: 1 };

const reply = (body: string, over: Partial<Reply> = {}): Reply => ({
    id: `r${Math.random().toString(36).slice(2)}`,
    author: DOM,
    body,
    createdAt: "2026-10-07T09:00:00.000Z",
    ...over,
});

describe("the latest word, as the agent sees it", () => {
    const note = (thread: Reply[]) => annotationFixture({ thread });

    it("skips asides, and counts People only being turned off as handing the note back", () => {
        expect(awaitsAgent(note([reply("make it blue")]))).toBe(true);
        expect(awaitsAgent(note([reply("make it blue", { author: AGENT })]))).toBe(false);
        expect(
            awaitsAgent(note([reply("done", { author: AGENT }), reply("lol", { aside: true })]))
        ).toBe(false);
        const behind = note([reply("make it blue"), reply("Sam, agree?", { aside: true })]);
        expect(lastWord(behind)?.body).toBe("make it blue");
        expect(awaitsAgent(behind)).toBe(true);
        expect(awaitsAgent(note([reply("Picked “A”.", { automatic: true })]))).toBe(false);
        expect(
            awaitsAgent(
                note([reply("Shared this with the agent.", { automatic: true, peopleOnly: false })])
            )
        ).toBe(true);
    });

    it("is the same in the database as in memory", async () => {
        const t = await setup();
        const cases: Array<[Reply[], boolean]> = [
            [[reply("make it blue")], true],
            [[reply("done", { author: AGENT }), reply("lol", { aside: true })], false],
            [[reply("make it blue"), reply("Sam, agree?", { aside: true })], true],
            [[reply("Picked “A”.", { automatic: true })], false],
            [[reply("Shared.", { automatic: true, peopleOnly: false })], true],
            [[], false],
        ];
        const ids: string[] = [];
        // A new note starts with no thread, so each is written in after.
        for (const [thread] of cases) {
            const { id } = await t.add();
            await t.backend.store.updateAnnotation(id, (a) => ({ ...a, thread }));
            ids.push(id);
        }
        const found = new Set(
            (await t.backend.list({ lastReplyBy: "human" })).map((s) => s.annotation.id)
        );
        cases.forEach(([thread, expected], i) => {
            expect(found.has(ids[i] as string), JSON.stringify(thread.map((r) => r.body))).toBe(
                expected
            );
        });
    });
});

describe("People only", () => {
    it("never reaches notato_watch or notato_list_open, and is labelled when asked for by id", async () => {
        const t = await setup();
        const kept = await t.add({
            comment: "between us: is this the right green?",
            peopleOnly: true,
        });
        const open = await t.add({ comment: "the header overlaps" });
        const call = await mcp(t.backend);

        const out = (await call("notato_watch", watch)).text;
        expect(out).toContain("1 new annotation.");
        expect(out).toContain("the header overlaps");
        expect(out).not.toContain("right green");
        expect((await call("notato_list_open")).text).not.toContain(kept.id);
        expect((await call("notato_list_open")).text).toContain(open.id);

        // A reply on it is between people too.
        await t.backend.reply(kept.id, "I think it's fine", SAM);
        expect((await call("notato_watch", quiet)).text).toContain("No new annotations");

        const got = (await call("notato_get", { id: kept.id })).text;
        expect(got).toContain("right green");
        expect(got).toContain("People only");
        expect(got).toContain("⊘ PEOPLE ONLY");
    });

    it("refuses the agent's tools on it", async () => {
        const t = await setup();
        const kept = await t.add({ comment: "between us", peopleOnly: true });
        const call = await mcp(t.backend);
        for (const [tool, args] of [
            ["notato_acknowledge", {}],
            ["notato_reply", { body: "hello" }],
            ["notato_resolve", { summary: "done" }],
            ["notato_dismiss", { reason: "no" }],
        ] as const) {
            const r = await call(tool, { id: kept.id, ...args });
            expect(r.isError, tool).toBe(true);
            expect(r.text).toContain("People only");
        }
        const after = await t.backend.get(kept.id);
        expect(after?.annotation.status).toBe("open");
        expect(after?.annotation.thread).toHaveLength(0);
    });

    it("is recorded in the thread each time someone turns it on or off, and only a person can", async () => {
        const ctx = makeApp();
        cleanups.push(ctx.cleanup);
        const a = annotationFixture({ projectId: "web" });
        await ctx.backend.ingest(a, filesFor());
        const patch = (body: object) =>
            ctx.call(`/annotations/${a.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });

        expect((await patch({ peopleOnly: true, author: DOM })).status).toBe(200);
        // The same value again changes nothing and records nothing.
        expect((await patch({ peopleOnly: true, author: SAM })).status).toBe(200);
        expect((await patch({ peopleOnly: false, author: SAM })).status).toBe(200);
        const refused = await patch({ peopleOnly: true, author: AGENT });
        expect(refused.status).toBe(403);

        const stored = (await ctx.backend.get(a.id))?.annotation;
        expect(stored?.peopleOnly).toBeUndefined();
        expect(
            stored?.thread.map((r) => [r.author.name, r.automatic, r.peopleOnly, r.body])
        ).toEqual([
            ["Dom", true, true, "Made this people only: the agent won't see it."],
            ["Sam", true, false, "Shared this with the agent."],
        ]);
    });

    it("hands the note back when it is turned off, thread and all, marked SHARED WITH YOU", async () => {
        const t = await setup();
        const call = await mcp(t.backend);
        // Made People only from the start, so the agent's cursor passes it by.
        const kept = await t.add({ comment: "should this be a modal?", peopleOnly: true });
        await t.add({ comment: "a later note" });
        expect((await call("notato_watch", watch)).text).toContain("1 new annotation.");

        await t.backend.reply(kept.id, "Let's make it a drawer", SAM);
        await t.backend.update(kept.id, { peopleOnly: false }, DOM);
        const out = (await call("notato_watch", watch)).text;
        expect(out).toContain("1 annotation shared with you again.");
        expect(out).toContain("⇢ SHARED WITH YOU");
        expect(out).toContain("Let's make it a drawer");
        expect((await call("notato_watch", quiet)).text).toContain("No new annotations");
    });

    it("an agent working on a note stops hearing of it once people take it over", async () => {
        const t = await setup();
        const call = await mcp(t.backend);
        const a = await t.add({ comment: "make it bigger" });
        await call("notato_watch", watch);
        await call("notato_acknowledge", { id: a.id });
        await t.backend.update(a.id, { peopleOnly: true }, DOM);
        await t.backend.reply(a.id, "actually, let's talk first", SAM);
        expect((await call("notato_watch", quiet)).text).toContain("No new annotations");
        expect((await call("notato_list_open")).text).not.toContain(a.id);
    });

    it("keeps who turned it on before the note was sent, and nothing else a page puts in the thread", async () => {
        const t = await setup();
        const on = {
            id: "r-on",
            author: DOM,
            body: "Made this people only: the agent won't see it.",
            createdAt: "2026-10-07T09:00:00.000Z",
            automatic: true,
            peopleOnly: true,
        };
        const forged = [
            { id: "r-agent", author: AGENT, body: "Resolved.", createdAt: on.createdAt },
            { id: "r-said", author: DOM, body: "hello", createdAt: on.createdAt },
            { ...on, id: "r-agent-toggle", author: AGENT },
        ];
        const a = await t.add({ peopleOnly: true, status: "resolved", thread: [...forged, on] });
        expect(a.status).toBe("open");
        expect(a.thread.map((r) => r.id)).toEqual(["r-on"]);
    });

    it("still goes to webhooks, which are for people", async () => {
        const t = await setup();
        const seen: string[] = [];
        t.backend.bus.subscribe(
            (e) => void seen.push(`${e.type}:${e.annotation.peopleOnly ?? false}`)
        );
        await t.add({ comment: "between us", peopleOnly: true });
        expect(seen).toEqual(["created:true"]);
    });
});

describe("an aside", () => {
    it("is not a follow-up, and is left out of what the agent is shown", async () => {
        const t = await setup();
        const call = await mcp(t.backend);
        const a = await t.add({ comment: "the spacing is off" });
        await call("notato_watch", watch);
        await call("notato_acknowledge", { id: a.id, note: "On it." });

        await t.backend.reply(a.id, "Sam, ignore the agent for a sec", DOM, { aside: true });
        expect((await call("notato_watch", quiet)).text).toContain("No new annotations");

        await t.backend.reply(a.id, "Use 16px, not 12", DOM);
        await t.backend.reply(a.id, "(told it 16, matches the grid)", DOM, { aside: true });
        const out = (await call("notato_watch", watch)).text;
        expect(out).toContain("1 reply from the person.");
        expect(out).toContain("Use 16px, not 12");
        expect(out).not.toContain("ignore the agent");
        expect(out).not.toContain("matches the grid");
        expect((await call("notato_get", { id: a.id })).text).not.toContain("ignore the agent");
        // People see it, marked.
        const forPeople = renderAnnotation((await t.backend.get(a.id))?.annotation as Annotation);
        expect(forPeople).toContain("Dom (aside): Sam, ignore the agent for a sec");
    });

    it("is a person's to send, over HTTP too", async () => {
        const t = await setup();
        const a = await t.add();
        expect(() => t.backend.reply(a.id, "psst", AGENT, { aside: true })).toThrow();

        const ctx = makeApp();
        cleanups.push(ctx.cleanup);
        const b = annotationFixture({ projectId: "web" });
        await ctx.backend.ingest(b, filesFor());
        const res = await ctx.call(`/annotations/${b.id}/replies`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body: "just for Sam", aside: true, author: DOM }),
        });
        expect(res.status).toBe(201);
        expect((await ctx.backend.get(b.id))?.annotation.thread[0]).toMatchObject({
            body: "just for Sam",
            aside: true,
        });
    });
});
