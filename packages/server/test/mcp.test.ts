import { describe, expect, it } from "bun:test";
import { type Backend, createMcpServer, type LocalBackend } from "../src/index.ts";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    filesFor,
    makeBackend,
    PNG,
    type ToolResult,
    toolText as textOf,
} from "./helpers.ts";

// The MCP tools an agent works from: reading notes, waiting for them, changing their status and undoing a change.

const defer = cleanupAfterEach();

const connect = (backend: Backend) => connectMcp(backend, defer);

async function setup() {
    const ctx = makeBackend();
    defer(ctx.cleanup);
    return { ...ctx, ...(await connect(ctx.backend)) };
}

const add = async (backend: LocalBackend, over: Parameters<typeof annotationFixture>[0] = {}) => {
    const annotation = annotationFixture(over);
    return (await backend.ingest(annotation, filesFor())).stored;
};
const images = (r: ToolResult) => r.content.filter((c) => c.type === "image");

describe("which agent", () => {
    it("signs replies and status changes with the agent the client says it is, and tells the caller", async () => {
        const ctx = makeBackend();
        defer(ctx.cleanup);
        const told: Array<string | undefined> = [];
        const server = createMcpServer({
            backend: ctx.backend,
            version: "test",
            onClient: (name) => told.push(name),
        });
        const { call } = await connectMcp(server, defer, { client: "codex-mcp-client" });
        const stored = await add(ctx.backend);
        await call("notato_reply", { id: stored.annotation.id, body: "Which one?" });
        const after = await ctx.backend.get(stored.annotation.id);
        expect(after?.annotation.thread.at(-1)?.author).toEqual({ kind: "agent", name: "Codex" });
        expect(told).toEqual(["Codex"]);
    });
});

describe("tool surface", () => {
    it("exposes its tools and tells the model how to use them", async () => {
        const { client } = await setup();
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(
            [
                "notato_acknowledge",
                "notato_annotate",
                "notato_dismiss",
                "notato_get",
                "notato_import_bundle",
                "notato_list_open",
                "notato_reply",
                "notato_resolve",
                "notato_reverted",
                "notato_variants_ready",
                "notato_watch",
            ].sort()
        );
        expect(client.getInstructions()).toContain("notato_watch");
    });
});

describe("notato_list_open and notato_get", () => {
    it("lists open and acknowledged annotations, text only, with filters", async () => {
        const { backend, call } = await setup();
        expect(textOf(await call("notato_list_open"))).toBe("No open annotations.");
        const a = await add(backend, {
            route: "/checkout",
            comment: "button hidden",
            severity: "major",
        });
        await add(backend, { route: "/orders", comment: "typo" });
        const resolved = await add(backend, { route: "/checkout", comment: "old" });
        await backend.setStatus(resolved.annotation.id, "resolved");

        const all = await call("notato_list_open");
        expect(images(all)).toHaveLength(0);
        expect(textOf(all)).toContain("button hidden");
        expect(textOf(all)).toContain("in <PayButton>");
        expect(textOf(all)).toContain("typo");
        expect(textOf(all)).not.toContain("old");
        const filtered = textOf(
            await call("notato_list_open", { route: "/checkout", severity: "major" })
        );
        expect(filtered).toContain(a.annotation.id);
        expect(filtered).not.toContain("typo");
    });

    it("returns screenshots as real MCP image content the model can see", async () => {
        const { backend, call } = await setup();
        const { annotation } = await add(backend, { comment: "pay button hidden behind banner" });
        const result = await call("notato_get", { id: annotation.id });
        expect(result.isError).toBeUndefined();
        expect(images(result)).toHaveLength(2);
        const first = images(result)[0];
        expect(first?.mimeType).toBe("image/png");
        expect(Array.from(Buffer.from(first?.data ?? "", "base64"))).toEqual(Array.from(PNG));
        const text = textOf(result);
        expect(text).toContain("pay button hidden behind banner");
        expect(text).toContain("#pay > button.primary");
        expect(text).toContain("pay-button");
        expect(text).toContain("PayButton (src/PayButton.tsx:12:5)");
        expect(text).toContain("Screenshots follow");
    });

    it("honours the screenshots option and reports unknown ids as errors", async () => {
        const { backend, call } = await setup();
        const { annotation } = await add(backend);
        expect(
            images(await call("notato_get", { id: annotation.id, screenshots: "crop" }))
        ).toHaveLength(1);
        expect(
            images(await call("notato_get", { id: annotation.id, screenshots: "full" }))
        ).toHaveLength(1);
        const none = await call("notato_get", { id: annotation.id, screenshots: "none" });
        expect(images(none)).toHaveLength(0);
        expect(textOf(none)).not.toContain("Screenshots follow");
        const missing = await call("notato_get", { id: "nope" });
        expect(missing.isError).toBe(true);
    });

    it("summarises console errors and failed requests so the model need not ask", async () => {
        const { backend, call } = await setup();
        const { annotation } = await add(backend, {
            context: {
                screenshot: { method: "dom", pin: 7 },
                console: [{ level: "error", message: "TypeError: x is undefined", at: "t" }],
                network: [
                    {
                        method: "POST",
                        url: "http://localhost/api/pay",
                        status: 500,
                        durationMs: 40,
                        at: "t",
                    },
                ],
            },
        });
        const text = textOf(await call("notato_get", { id: annotation.id, screenshots: "none" }));
        expect(text).toContain("## Annotation #7");
        expect(text).toContain("TypeError: x is undefined");
        expect(text).toContain("POST http://localhost/api/pay → 500");
    });
});

describe("status tools", () => {
    it("acknowledge, reply, resolve and dismiss change status and attribute the thread to the agent", async () => {
        const { backend, call } = await setup();
        const { annotation } = await add(backend);
        const status = async () => (await backend.get(annotation.id))?.annotation;

        await call("notato_acknowledge", { id: annotation.id, note: "On it" });
        expect(await status()).toMatchObject({ status: "acknowledged" });
        await call("notato_reply", { id: annotation.id, body: "Which breakpoint?" });
        expect((await status())?.status).toBe("acknowledged");
        await call("notato_resolve", { id: annotation.id, summary: "Moved the banner" });
        const resolved = await status();
        expect(resolved?.status).toBe("resolved");
        expect(resolved?.thread.map((r) => r.body)).toEqual([
            "On it",
            "Which breakpoint?",
            "Resolved: Moved the banner",
        ]);
        expect(
            resolved?.thread.every((r) => r.author.kind === "agent" && r.author.name === "Claude")
        ).toBe(true);

        const other = await add(backend);
        await call("notato_dismiss", { id: other.annotation.id, reason: "works as intended" });
        expect((await backend.get(other.annotation.id))?.annotation).toMatchObject({
            status: "dismissed",
            thread: [{ body: "Dismissed: works as intended" }],
        });
    });

    it("reports unknown ids as errors", async () => {
        const { call } = await setup();
        for (const [tool, args] of [
            ["notato_acknowledge", { id: "x" }],
            ["notato_reply", { id: "x", body: "b" }],
            ["notato_resolve", { id: "x", summary: "s" }],
            ["notato_dismiss", { id: "x", reason: "r" }],
            ["notato_reverted", { id: "x", summary: "s" }],
        ] as const) {
            expect((await call(tool, args)).isError).toBe(true);
        }
    });
});

describe("notato_watch", () => {
    it("delivers an existing backlog immediately, with screenshots", async () => {
        const { backend, call } = await setup();
        await add(backend, { comment: "already waiting" });
        const result = await call("notato_watch", { timeoutSeconds: 5, windowMs: 0 });
        expect(textOf(result)).toContain("1 new annotation.");
        expect(textOf(result)).toContain("already waiting");
        expect(images(result)).toHaveLength(2);
    });

    it("delivers each annotation once per session, then waits and times out quietly", async () => {
        const { backend, call } = await setup();
        await add(backend);
        await call("notato_watch", { timeoutSeconds: 5, windowMs: 0 });
        const started = Date.now();
        const again = await call("notato_watch", { timeoutSeconds: 1, windowMs: 0 });
        expect(textOf(again)).toContain("No new annotations");
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });

    it("blocks until an annotation arrives, then returns it", async () => {
        const { backend, call } = await setup();
        const waiting = call("notato_watch", { timeoutSeconds: 10, windowMs: 0 });
        await new Promise((r) => setTimeout(r, 100));
        await add(backend, { comment: "arrived while watching" });
        const result = await waiting;
        expect(textOf(result)).toContain("arrived while watching");
    });

    it("groups a burst arriving inside the collection window into one batch", async () => {
        const { backend, call } = await setup();
        const waiting = call("notato_watch", {
            timeoutSeconds: 10,
            windowMs: 400,
            screenshots: "none",
        });
        await new Promise((r) => setTimeout(r, 50));
        await add(backend, { comment: "first of burst" });
        await new Promise((r) => setTimeout(r, 150));
        await add(backend, { comment: "second of burst" });
        const text = textOf(await waiting);
        expect(text).toContain("2 new annotations.");
        expect(text).toContain("first of burst");
        expect(text).toContain("second of burst");
    });

    it("only returns open annotations: acknowledged ones are someone else's work", async () => {
        const { backend, call } = await setup();
        const taken = await add(backend, { comment: "taken" });
        await backend.setStatus(taken.annotation.id, "acknowledged");
        await add(backend, { comment: "free" });
        const text = textOf(
            await call("notato_watch", { timeoutSeconds: 5, windowMs: 0, screenshots: "none" })
        );
        expect(text).toContain("free");
        expect(text).not.toContain("taken");
    });

    it("caps images per call and lists the rest as text", async () => {
        const { backend, call } = await setup();
        for (const n of [1, 2, 3]) await add(backend, { comment: `item ${n}` });
        const result = await call("notato_watch", {
            timeoutSeconds: 5,
            windowMs: 0,
            maxAnnotations: 1,
            screenshots: "full",
        });
        expect(images(result)).toHaveLength(1);
        expect(textOf(result)).toContain("2 more, text only");
        expect(textOf(result)).toContain("item 3");
    });

    it("filters by project, and each session keeps its own cursor", async () => {
        const { backend, call } = await setup();
        await add(backend, { projectId: "mine", comment: "for me" });
        await add(backend, { projectId: "theirs", comment: "for them" });
        const mine = textOf(
            await call("notato_watch", {
                projectId: "mine",
                timeoutSeconds: 5,
                windowMs: 0,
                screenshots: "none",
            })
        );
        expect(mine).toContain("for me");
        expect(mine).not.toContain("for them");

        const second = await connect(backend);
        const backlog = textOf(
            await second.call("notato_watch", {
                timeoutSeconds: 5,
                windowMs: 0,
                screenshots: "none",
            })
        );
        expect(backlog).toContain("for me");
        expect(backlog).toContain("for them");
    });

    it("stops waiting when the client cancels", async () => {
        const { client } = await setup();
        const controller = new AbortController();
        const started = Date.now();
        const pending = client
            .callTool({ name: "notato_watch", arguments: { timeoutSeconds: 30 } }, undefined, {
                signal: controller.signal,
            })
            .catch((e: Error) => e);
        setTimeout(() => controller.abort(), 100);
        expect(await pending).toBeInstanceOf(Error);
        expect(Date.now() - started).toBeLessThan(2000);
    });
});

describe("asking for a resolved change to be undone", () => {
    const HUMAN = { kind: "human", name: "Dom" } as const;

    /** An annotation Claude has resolved, the way a real session leaves it. */
    async function resolvedChange(over: Parameters<typeof annotationFixture>[0] = {}) {
        const ctx = await setup();
        const { annotation } = await add(ctx.backend, over);
        await ctx.call("notato_resolve", {
            id: annotation.id,
            summary: "Moved the banner",
            files: ["src/Banner.tsx", "src/Banner.css"],
            commit: "abc1234",
        });
        return {
            ...ctx,
            id: annotation.id,
            status: async () => (await ctx.backend.get(annotation.id))?.annotation,
        };
    }

    it("records the files and commit with the resolution, so the change can be found later", async () => {
        const { status } = await resolvedChange();
        const thread = (await status())?.thread;
        expect(thread?.[0]?.body).toBe(
            "Resolved: Moved the banner\nFiles: src/Banner.tsx, src/Banner.css\nCommit: abc1234"
        );
    });

    it("only a resolved annotation can have a revert requested", async () => {
        const { backend } = await setup();
        const open = await add(backend);
        await expect(
            backend.setStatus(open.annotation.id, "revert_requested", "undo", HUMAN)
        ).rejects.toMatchObject({
            status: 409,
        });
        expect((await backend.get(open.annotation.id))?.annotation.status).toBe("open");
    });

    it("a request reaches notato_watch with the instruction, the thread and the screenshots", async () => {
        const { backend, call, id } = await resolvedChange({
            comment: "banner covers the pay button",
        });
        await backend.setStatus(id, "revert_requested", "That broke the mobile layout", HUMAN);
        const result = await call("notato_watch", { timeoutSeconds: 5, windowMs: 0 });
        const text = textOf(result);
        expect(text).toContain("1 revert request.");
        expect(text).toContain("REVERT REQUESTED");
        expect(text).toContain("notato_reverted");
        expect(text).toContain("Commit: abc1234");
        expect(text).toContain("That broke the mobile layout");
        expect(images(result)).toHaveLength(2);
    });

    it("wakes a watch that is already waiting, and hands the request over once", async () => {
        const { backend, call, id } = await resolvedChange();
        const waiting = call("notato_watch", {
            timeoutSeconds: 10,
            windowMs: 0,
            screenshots: "none",
        });
        await new Promise((r) => setTimeout(r, 100));
        await backend.setStatus(id, "revert_requested", "Undo it please", HUMAN);
        expect(textOf(await waiting)).toContain("Undo it please");

        const again = await call("notato_watch", {
            timeoutSeconds: 1,
            windowMs: 0,
            screenshots: "none",
        });
        expect(textOf(again)).toContain("No new annotations");
    });

    it("delivers a request that was made before the session started", async () => {
        const { backend, id } = await resolvedChange();
        await backend.setStatus(id, "revert_requested", "Undo it", HUMAN);
        const fresh = await connect(backend);
        const text = textOf(
            await fresh.call("notato_watch", {
                timeoutSeconds: 5,
                windowMs: 0,
                screenshots: "none",
            })
        );
        expect(text).toContain("1 revert request");
    });

    it("delivers it again when the person cancels and asks a second time", async () => {
        const { backend, call, id } = await resolvedChange();
        await backend.setStatus(id, "revert_requested", "First ask", HUMAN);
        expect(
            textOf(
                await call("notato_watch", { timeoutSeconds: 5, windowMs: 0, screenshots: "none" })
            )
        ).toContain("First ask");
        await backend.setStatus(id, "resolved", "Revert request cancelled.", HUMAN);
        await backend.setStatus(id, "revert_requested", "Second ask", HUMAN);
        expect(
            textOf(
                await call("notato_watch", { timeoutSeconds: 5, windowMs: 0, screenshots: "none" })
            )
        ).toContain("Second ask");
    });

    it("hands a request over once, even when a watch for another project comes in between", async () => {
        const { backend, call, id } = await resolvedChange();
        await backend.setStatus(id, "revert_requested", "Undo it", HUMAN);
        const quiet = { timeoutSeconds: 1, windowMs: 0, screenshots: "none" };
        expect(
            textOf(await call("notato_watch", { ...quiet, projectId: "checkout-web" }))
        ).toContain("Undo it");
        await call("notato_watch", { ...quiet, projectId: "another-app" });
        expect(
            textOf(await call("notato_watch", { ...quiet, projectId: "checkout-web" }))
        ).toContain("No new annotations");
    });

    it("puts requests ahead of new annotations in a mixed batch", async () => {
        const { backend, call, id } = await resolvedChange();
        await backend.setStatus(id, "revert_requested", "Undo", HUMAN);
        await add(backend, { comment: "a brand new one" });
        const text = textOf(
            await call("notato_watch", { timeoutSeconds: 5, windowMs: 0, screenshots: "none" })
        );
        expect(text).toContain("1 new annotation and 1 revert request.");
        expect(text.indexOf("REVERT REQUESTED")).toBeLessThan(text.indexOf("a brand new one"));
    });

    it("lists it in notato_list_open, marked as waiting for an undo", async () => {
        const { backend, call, id } = await resolvedChange();
        expect(textOf(await call("notato_list_open"))).toBe("No open annotations.");
        await backend.setStatus(id, "revert_requested", "Undo", HUMAN);
        expect(textOf(await call("notato_list_open"))).toContain("revert_requested");
    });

    it("notato_reverted closes the request, attributed to the agent", async () => {
        const { backend, call, id, status } = await resolvedChange();
        await backend.setStatus(id, "revert_requested", "Undo", HUMAN);
        const result = await call("notato_reverted", { id, summary: "git revert abc1234" });
        expect(result.isError).toBeUndefined();
        const after = await status();
        expect(after?.status).toBe("reverted");
        expect(after?.thread.at(-1)).toMatchObject({
            body: "Reverted: git revert abc1234",
            author: { kind: "agent" },
        });
        expect(textOf(await call("notato_list_open"))).toBe("No open annotations.");
    });

    it("notato_reverted refuses when nothing was requested", async () => {
        const { call, id, status } = await resolvedChange();
        const result = await call("notato_reverted", { id, summary: "s" });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("No revert was requested");
        expect((await status())?.status).toBe("resolved");
    });

    it("acknowledging, resolving or dismissing a request cannot wipe it out", async () => {
        const { backend, call, id, status } = await resolvedChange();
        await backend.setStatus(id, "revert_requested", "Undo", HUMAN);

        const ack = await call("notato_acknowledge", { id, note: "On it" });
        expect(ack.isError).toBeUndefined();
        expect(textOf(ack)).toContain("notato_reverted");
        expect((await call("notato_resolve", { id, summary: "s" })).isError).toBe(true);
        expect((await call("notato_dismiss", { id, reason: "r" })).isError).toBe(true);

        const after = await status();
        expect(after?.status).toBe("revert_requested");
        expect(after?.thread.map((r) => r.body)).toContain("On it");
    });
});

describe("the watcher's filter", () => {
    it("excludeIds leaves out what was already handed over, in memory and in the query string", async () => {
        const { matchesFilter, filterFromQuery, filterToQuery } = await import("../src/index.ts");
        const { backend } = await setup();
        const a = await add(backend);
        const b = await add(backend);
        expect(matchesFilter(a, { excludeIds: [a.annotation.id] })).toBe(false);
        expect(matchesFilter(b, { excludeIds: [a.annotation.id] })).toBe(true);
        const query = filterToQuery({
            status: "revert_requested",
            excludeIds: [a.annotation.id, b.annotation.id],
        });
        expect(filterFromQuery(query).excludeIds).toEqual([a.annotation.id, b.annotation.id]);
        expect(
            (await backend.list({ excludeIds: [a.annotation.id] })).map((s) => s.annotation.id)
        ).toEqual([b.annotation.id]);
    });

    it("waitForNew wakes on a status change, not only on a new annotation", async () => {
        const { backend } = await setup();
        const { annotation } = await add(backend);
        await backend.setStatus(annotation.id, "resolved");
        const waiting = backend.waitForNew({ status: "revert_requested" }, 5000);
        await new Promise((r) => setTimeout(r, 50));
        await backend.setStatus(annotation.id, "revert_requested", "Undo");
        expect(await waiting).toBe(true);
    });

    it("waitForNew does not wake for an annotation it was told to ignore", async () => {
        const { backend } = await setup();
        const { annotation } = await add(backend);
        await backend.setStatus(annotation.id, "resolved");
        const waiting = backend.waitForNew(
            { status: "revert_requested", excludeIds: [annotation.id] },
            300
        );
        await backend.setStatus(annotation.id, "revert_requested", "Undo");
        expect(await waiting).toBe(false);
    });
});

describe("where an element is written", () => {
    const withSource = (source: { file: string; line: number; col: number; nearest?: boolean }) => {
        const base = annotationFixture();
        return annotationFixture({
            target: {
                ...base.target,
                identity: [{ ...(base.target.identity[0] as object), source }],
            } as never,
        });
    };

    it("is in what Claude reads: the exact file, line and column", async () => {
        const { backend, call } = await setup();
        const a = withSource({ file: "public/src/features/Invite.tsx", line: 558, col: 9 });
        await backend.ingest(a, filesFor());
        const text = textOf(await call("notato_get", { id: a.id }));
        expect(text).toContain("written at public/src/features/Invite.tsx:558:9");
        expect(text).not.toContain("inside the element");
    });

    it("says so when it is only the nearest tagged element", async () => {
        const { backend, call } = await setup();
        const a = withSource({ file: "app/src/Panel.tsx", line: 4, col: 3, nearest: true });
        await backend.ingest(a, filesFor());
        expect(textOf(await call("notato_get", { id: a.id }))).toContain(
            "inside the element written at app/src/Panel.tsx:4:3"
        );
    });

    it("shows in the compact list too, but only when it is exact", async () => {
        const { backend, call } = await setup();
        await backend.ingest(withSource({ file: "app/src/A.tsx", line: 7, col: 2 }), filesFor());
        await backend.ingest(
            withSource({ file: "app/src/B.tsx", line: 9, col: 2, nearest: true }),
            filesFor()
        );
        const list = textOf(await call("notato_list_open"));
        expect(list).toContain("at app/src/A.tsx:7");
        expect(list).not.toContain("B.tsx");
    });
});

describe("notato_watch on a long-running project", () => {
    const many = async (backend: LocalBackend, n: number, status: "resolved" | "open") => {
        const out = [];
        for (let i = 0; i < n; i += 1) {
            const stored = (
                await backend.ingest(annotationFixture({ screenshots: undefined }), new Map())
            ).stored;
            if (status === "resolved")
                await backend.setStatus(stored.annotation.id, "resolved", "Done.", {
                    kind: "agent",
                });
            out.push(stored);
        }
        return out;
    };

    it("hears a reply on the newest of more than a hundred finished notes", async () => {
        const { backend, call } = await setup();
        const notes = await many(backend, 101, "resolved");
        const newest = notes.at(-1)?.annotation.id as string;
        await backend.reply(newest, "make it blue too");
        const result = await call("notato_watch", {
            timeoutSeconds: 2,
            windowMs: 0,
            screenshots: "none",
        });
        expect(textOf(result)).toContain("make it blue too");
    });

    it("does not wake again for revert requests it was already handed, however many there are", async () => {
        const { backend, call } = await setup();
        const notes = await many(backend, 51, "resolved");
        for (const n of notes) await backend.setStatus(n.annotation.id, "revert_requested");
        const first = await call("notato_watch", {
            timeoutSeconds: 2,
            windowMs: 0,
            screenshots: "none",
            maxAnnotations: 1,
        });
        expect(textOf(first)).toContain("51 revert requests");
        const started = Date.now();
        const again = await call("notato_watch", { timeoutSeconds: 1, windowMs: 0 });
        expect(textOf(again)).toContain("No new annotations");
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });

    it("delivers a new note once, even when the person already replied to it", async () => {
        const { backend, call } = await setup();
        const stored = await add(backend, { comment: "first thought" });
        await backend.reply(stored.annotation.id, "and one more thing");
        const first = await call("notato_watch", { timeoutSeconds: 2, windowMs: 0 });
        expect(textOf(first)).toContain("1 new annotation.");
        const again = await call("notato_watch", { timeoutSeconds: 1, windowMs: 0 });
        expect(textOf(again)).toContain("No new annotations");
    });

    it("lists open notes a page at a time", async () => {
        const { backend, call } = await setup();
        await many(backend, 7, "open");
        const first = textOf(await call("notato_list_open", { limit: 5 }));
        const after = Number(/after: (\d+)/.exec(first)?.[1]);
        expect(after).toBeGreaterThan(0);
        const second = textOf(await call("notato_list_open", { limit: 5, after }));
        expect(second).not.toContain("There are more");
    });

    it("hands a reply over once, not again to the next session; and twenty at a time", async () => {
        const { backend, call } = await setup();
        const notes = await many(backend, 30, "resolved");
        for (const n of notes)
            await backend.reply(n.annotation.id, `thanks for ${n.annotation.id}`);
        const first = await call("notato_watch", {
            timeoutSeconds: 2,
            windowMs: 0,
            screenshots: "none",
            maxAnnotations: 1,
        });
        expect(textOf(first)).toContain("20 replies from the person");
        expect(textOf(first)).toContain("10 more replies from the person waiting");
        const second = await call("notato_watch", {
            timeoutSeconds: 2,
            windowMs: 0,
            screenshots: "none",
        });
        expect(textOf(second)).toContain("10 replies from the person");
        // A new session (another agent, or this one restarted) is not handed them again.
        const fresh = await connect(backend);
        const again = await fresh.call("notato_watch", { timeoutSeconds: 1, windowMs: 0 });
        expect(textOf(again)).toContain("No new annotations");
        // A new word from the person is.
        await backend.reply(notes[3]?.annotation.id as string, "actually, it is still wrong");
        const later = await fresh.call("notato_watch", { timeoutSeconds: 3, windowMs: 0 });
        expect(textOf(later)).toContain("actually, it is still wrong");
    });

    it("hears of a note the person reopened without writing anything", async () => {
        const { backend, call } = await setup();
        const stored = await add(backend, { comment: "the header overlaps" });
        await call("notato_watch", { timeoutSeconds: 2, windowMs: 0 });
        await backend.setStatus(stored.annotation.id, "resolved", "Fixed.", { kind: "agent" });
        await backend.setStatus(stored.annotation.id, "open");
        const result = await call("notato_watch", { timeoutSeconds: 4, windowMs: 0 });
        expect(textOf(result)).toContain("Reopened.");
        expect(textOf(result)).toContain("the header overlaps");
    });
});

describe("notato_watch and notato doctor", () => {
    it("is not woken by doctor's test note", async () => {
        const { backend, call } = await setup();
        const started = Date.now();
        const waiting = call("notato_watch", { timeoutSeconds: 1, windowMs: 0 });
        await new Promise((r) => setTimeout(r, 100));
        await add(backend, { context: { notatoDiagnostic: true } });
        const result = await waiting;
        expect(textOf(result)).toContain("No new annotations");
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });
});
