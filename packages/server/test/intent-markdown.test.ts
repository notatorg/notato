import { afterEach, describe, expect, it } from "bun:test";
import type { Annotation } from "@notato/schema";
import type { Backend } from "../src/index.ts";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    filesFor,
    ingest,
    makeApp,
    makeBackend,
    multipart,
} from "./helpers.ts";

// What a note asks for (its intent: fix, change, question, approve, variants), and notes as Markdown at each level of
// detail, over HTTP and through the MCP tools.

type Ctx = ReturnType<typeof makeApp>;
let ctx: Ctx | undefined;
afterEach(() => {
    ctx?.cleanup();
    ctx = undefined;
});
const defer = cleanupAfterEach();

const ids = async (res: Response) =>
    ((await res.json()) as { items: Array<{ annotation: Annotation }> }).items
        .map((i) => i.annotation.comment)
        .sort();

describe("intent over HTTP", () => {
    it("is kept as sent and read back", async () => {
        ctx = makeApp();
        const { body } = await ingest(ctx.call, { intent: "question" });
        expect(body.annotation.intent).toBe("question");
        const got = (await (await ctx.call(`/annotations/${body.annotation.id}`)).json()) as {
            annotation: Annotation;
        };
        expect(got.annotation.intent).toBe("question");
    });

    it("filters a project's list by one intent or several", async () => {
        ctx = makeApp();
        await ingest(ctx.call, { comment: "a fix", intent: "fix" });
        await ingest(ctx.call, { comment: "a question", intent: "question" });
        await ingest(ctx.call, { comment: "an approval", intent: "approve" });
        await ingest(ctx.call, { comment: "no intent" });
        const project = "checkout-web";
        expect(
            await ids(await ctx.call(`/projects/${project}/annotations?intent=question`))
        ).toEqual(["a question"]);
        expect(
            await ids(await ctx.call(`/projects/${project}/annotations?intent=fix,approve`))
        ).toEqual(["a fix", "an approval"]);
        expect(await ids(await ctx.call(`/annotations?intent=question`))).toEqual(["a question"]);
        expect(await ids(await ctx.call(`/projects/${project}/annotations`))).toHaveLength(4);
    });

    it("refuses an intent it does not know, rather than returning everything", async () => {
        ctx = makeApp();
        const res = await ctx.call("/projects/checkout-web/annotations?intent=shrug");
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain("invalid intent");
    });

    it("rejects an intent in the body that is not one", async () => {
        ctx = makeApp();
        const annotation = { ...annotationFixture(), intent: "shrug" };
        const res = await ctx.call(`/projects/${annotation.projectId}/annotations`, {
            method: "POST",
            body: multipart(annotation),
        });
        expect(res.status).toBe(400);
    });
});

describe("annotations as Markdown over HTTP", () => {
    it("one annotation, at standard detail unless asked otherwise", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call, {
            comment: "Button is hidden",
            intent: "change",
        });
        const res = await ctx.call(`/annotations/${annotation.id}/markdown`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/markdown");
        const text = await res.text();
        expect(text).toContain("Comment: Button is hidden");
        expect(text).toContain("Intent: change");
        expect(text).not.toContain("Identity (as captured)");
    });

    it("takes each of the four levels", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call, {
            context: {
                console: [{ level: "log", message: "boot-message" }],
                screenshot: { pin: 1 },
            },
        });
        const at = async (detail: string) =>
            (await ctx?.call(`/annotations/${annotation.id}/markdown?detail=${detail}`))?.text() ??
            "";
        expect((await at("compact")).split("\n")).toHaveLength(1);
        expect(await at("standard")).not.toContain("boot-message");
        expect(await at("detailed")).toContain("Environment:");
        const forensic = await at("forensic");
        expect(forensic).toContain("[log] boot-message");
        expect(forensic).toContain("Identity (as captured):");
    });

    it("says what is wrong with an unknown level or id", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        const bad = await ctx.call(`/annotations/${annotation.id}/markdown?detail=lots`);
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as { error: string }).error).toContain(
            "compact, standard, detailed, forensic"
        );
        expect((await ctx.call("/annotations/01NOPE/markdown")).status).toBe(404);
        expect((await ctx.call("/projects/..%2F..%2Fx/markdown")).status).toBe(400);
    });

    it("a project's list, filtered the same way the JSON list is, with a title", async () => {
        ctx = makeApp();
        await ingest(ctx.call, { comment: "one", intent: "fix" });
        await ingest(ctx.call, { comment: "two", intent: "question" });
        const res = await ctx.call(
            "/projects/checkout-web/markdown?intent=question&detail=compact"
        );
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text.startsWith("# Feedback for checkout-web — 1 annotation")).toBe(true);
        expect(text).toContain("two");
        expect(text).not.toContain("one");
    });

    it("an empty project is said to be empty, not an error", async () => {
        ctx = makeApp();
        const text = await (await ctx.call("/projects/nothing-here/markdown")).text();
        expect(text).toContain("Nothing to report.");
    });
});

const mcp = (backend: Backend) => connectMcp(backend, defer, { client: "test-client" });

describe("intent through the MCP tools", () => {
    it("tells the model what each intent means for what it does", async () => {
        const t = makeBackend();
        defer(t.cleanup);
        const { client } = await mcp(t.backend);
        const instructions = client.getInstructions() ?? "";
        expect(instructions).toContain("question means the person wants an answer, not an edit");
        expect(instructions).toContain("approve means it is right as it is");
        expect(instructions).toContain('detail: "detailed"');
    });

    it("notato_list_open shows the intent and filters by it", async () => {
        const t = makeBackend();
        defer(t.cleanup);
        await t.backend.ingest(
            annotationFixture({ comment: "Q one", intent: "question" }),
            filesFor()
        );
        await t.backend.ingest(annotationFixture({ comment: "F one", intent: "fix" }), filesFor());
        const { call, text } = await mcp(t.backend);
        const all = text(await call("notato_list_open"));
        expect(all).toContain("question");
        expect(all).toContain("Q one");
        expect(all).toContain("F one");
        const only = text(await call("notato_list_open", { intent: "question" }));
        expect(only).toContain("Q one");
        expect(only).not.toContain("F one");
    });

    it("notato_get honours the detail level, and notato_watch too", async () => {
        const t = makeBackend();
        defer(t.cleanup);
        const a = annotationFixture({
            context: { console: [{ level: "log", message: "boot-message" }] },
        });
        await t.backend.ingest(a, filesFor());
        const { call, text } = await mcp(t.backend);
        expect(text(await call("notato_get", { id: a.id }))).not.toContain("boot-message");
        expect(text(await call("notato_get", { id: a.id, detail: "forensic" }))).toContain(
            "[log] boot-message"
        );
        const watched = text(await call("notato_watch", { timeoutSeconds: 1, detail: "forensic" }));
        expect(watched).toContain("[log] boot-message");
    });

    it("notato_annotate passes the intent and a selector with >>> on to the page", async () => {
        const t = makeBackend();
        defer(t.cleanup);
        const seen: unknown[] = [];
        // Stands in for a connected page: records what the server asked it to annotate.
        const spy = Object.create(t.backend) as Backend;
        spy.requestAnnotation = async (_project, args) => {
            seen.push(args);
            return { ok: false, error: "no page in this test" };
        };
        const { call, text } = await mcp(spy);
        const result = await call("notato_annotate", {
            target: "iframe#preview >>> button.pay",
            comment: "Is this meant to be grey?",
            intent: "question",
        });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("no page in this test");
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            target: "iframe#preview >>> button.pay",
            intent: "question",
            comment: "Is this meant to be grey?",
        });
    });

    it("refuses an intent that is not one", async () => {
        const t = makeBackend();
        defer(t.cleanup);
        const { call } = await mcp(t.backend);
        const result = await call("notato_annotate", {
            target: "#x",
            comment: "c",
            intent: "shrug",
        });
        expect(result.isError).toBe(true);
    });
});
