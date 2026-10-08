import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Annotation } from "@notato/schema";
import { type ConfigSource, createMcpServer } from "../src/index.ts";
import {
    annotationFixture,
    filesFor,
    hex,
    makeApp,
    makeBundleZip,
    multipart,
    PNG,
} from "./helpers.ts";

const settings =
    (screenshots: boolean): ConfigSource =>
    () => ({
        screenshots,
        mcp: true,
        source: { screenshots: "file", mcp: "default" },
        webhooks: [],
        file: "/work/notato.config.json",
    });

let ctx: ReturnType<typeof makeApp>;
afterEach(() => ctx?.cleanup());

const post = (annotation: Annotation, files = filesFor()) =>
    ctx.call(`/projects/${annotation.projectId}/annotations`, {
        method: "POST",
        body: multipart(annotation, files),
    });
const hasBlob = async (bytes: Uint8Array) => Boolean(await ctx.backend.blobs.get(await hex(bytes)));

describe("with screenshots off, the server stores none", () => {
    it("drops the screenshot a page sends, and the bytes with it", async () => {
        ctx = makeApp({}, settings(false));
        const res = await post(annotationFixture());
        expect(res.status).toBe(201);
        const body = (await res.json()) as { annotation: Annotation };
        expect(body.annotation.screenshots).toBeUndefined();
        expect(await hasBlob(PNG)).toBe(false);
        expect((await ctx.backend.list())[0]?.annotation.screenshots).toBeUndefined();
    });

    it("is the control: the same upload is kept when they are on", async () => {
        ctx = makeApp({}, settings(true));
        const body = (await (await post(annotationFixture())).json()) as { annotation: Annotation };
        expect(body.annotation.screenshots?.full.id).toMatch(/^[0-9a-f]{64}$/);
        expect(await hasBlob(PNG)).toBe(true);
    });

    it("accepts an annotation that has no screenshot to begin with (a page that has them off)", async () => {
        ctx = makeApp({}, settings(true));
        const { screenshots: _dropped, ...bare } = annotationFixture();
        const res = await post(bare as Annotation, new Map());
        expect(res.status).toBe(201);
        expect(
            ((await res.json()) as { annotation: Annotation }).annotation.screenshots
        ).toBeUndefined();
    });

    it("applies a change at once, to the next annotation, without restarting", async () => {
        let on = true;
        ctx = makeApp({}, () => ({
            screenshots: on,
            mcp: true,
            source: { screenshots: "file", mcp: "default" },
            webhooks: [],
        }));
        const first = (await (await post(annotationFixture())).json()) as {
            annotation: Annotation;
        };
        expect(first.annotation.screenshots).toBeDefined();
        on = false;
        const second = (await (await post(annotationFixture())).json()) as {
            annotation: Annotation;
        };
        expect(second.annotation.screenshots).toBeUndefined();
    });

    it("drops them from an imported bundle too, since a tester's zip is the same data", async () => {
        ctx = makeApp({}, settings(false));
        const { zip } = await makeBundleZip(2);
        const res = await ctx.call("/projects/checkout-web/bundles", {
            method: "POST",
            body: zip as BodyInit,
            headers: { "content-type": "application/zip" },
        });
        expect(res.status).toBe(201);
        const stored = await ctx.backend.list();
        expect(stored).toHaveLength(2);
        expect(stored.every((s) => s.annotation.screenshots === undefined)).toBe(true);
        expect(await hasBlob(PNG)).toBe(false);
    });
});

describe("what a page can ask", () => {
    it("GET /config says whether screenshots are allowed", async () => {
        ctx = makeApp({}, settings(false));
        expect(await (await ctx.call("/config")).json()).toMatchObject({ screenshots: false });
        ctx.cleanup();
        ctx = makeApp({}, settings(true));
        expect(await (await ctx.call("/config")).json()).toMatchObject({ screenshots: true });
    });

    it("GET /status reports the setting, where it came from, and a broken file", async () => {
        ctx = makeApp({}, () => ({
            screenshots: false,
            mcp: false,
            source: { screenshots: "file", mcp: "file" },
            webhooks: [],
            file: "/work/notato.config.json",
            error: 'unknown setting "screenshot"',
        }));
        const status = (await (await ctx.call("/status")).json()) as {
            config: Record<string, unknown>;
        };
        expect(status.config).toEqual({
            screenshots: "off",
            source: "file",
            mcp: "off",
            mcpSource: "file",
            webhooks: 0,
            file: "/work/notato.config.json",
            error: 'unknown setting "screenshot"',
        });
    });

    it("defaults to on with nothing configured", async () => {
        ctx = makeApp();
        expect(await (await ctx.call("/config")).json()).toMatchObject({ screenshots: true });
        const status = (await (await ctx.call("/status")).json()) as {
            config: { screenshots: string; source: string };
        };
        expect(status.config).toMatchObject({ screenshots: "on", source: "default" });
    });
});

describe("how Claude sees an annotation without a screenshot", () => {
    async function connect() {
        const server = createMcpServer({ backend: ctx.backend, version: "test" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test", version: "0" });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        return {
            client,
            call: async (name: string, args: Record<string, unknown> = {}) =>
                (await client.callTool({ name, arguments: args })) as unknown as {
                    content: Array<{ type: string; text?: string }>;
                    isError?: boolean;
                },
        };
    }

    it("is plain text that says there is none, so Claude works from the target instead", async () => {
        ctx = makeApp({}, settings(false));
        const { annotation } = (await (
            await post(annotationFixture({ comment: "button hidden" }))
        ).json()) as {
            annotation: Annotation;
        };
        const { call, client } = await connect();
        const got = await call("notato_get", { id: annotation.id });
        expect(got.isError).toBeUndefined();
        expect(got.content.filter((c) => c.type === "image")).toHaveLength(0);
        const text = got.content.map((c) => c.text ?? "").join("\n");
        expect(text).toContain("button hidden");
        expect(text).toContain("No screenshot was taken");
        expect(text).not.toContain("Screenshots follow");

        const watched = await call("notato_watch", { timeoutSeconds: 5, windowMs: 0 });
        expect(watched.content.filter((c) => c.type === "image")).toHaveLength(0);
        expect(watched.content.map((c) => c.text ?? "").join("\n")).toContain("button hidden");
        await client.close();
    });
});
