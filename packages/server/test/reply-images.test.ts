import { describe, expect, it } from "bun:test";
import { assetsFor, readBundle } from "@notato/core";
import type { Annotation } from "@notato/schema";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    hex,
    makeBackend,
    multipart,
    PNG,
    PNG_B,
} from "./helpers.ts";
import { bearer, issue, startServe } from "./serve-helpers.ts";

// A person can send images with a reply (issue #18). They are stored and checked like design references, reach the
// agent with the reply, travel with the note, and go when it does. An aside's images stay as private as its words.

const defer = cleanupAfterEach();

async function setup() {
    const ctx = makeBackend();
    defer(ctx.cleanup);
    const { stored } = await ctx.backend.ingest(
        // No screenshots: the fixture's are the same bytes as the images sent here.
        annotationFixture({
            intent: "change",
            comment: "make the header nicer",
            screenshots: undefined,
        }),
        new Map()
    );
    return { ...ctx, note: stored.annotation as Annotation };
}

const watch = { timeoutSeconds: 3, windowMs: 0, screenshots: "none" };

describe("images sent with a reply", () => {
    it("are stored like references, may come without words, and go with the note", async () => {
        const t = await setup();
        const stored = await t.backend.reply(t.note.id, "", undefined, {
            images: [{ name: "after.png\nsecond line", bytes: PNG }],
        });
        const reply = stored?.annotation.thread.at(-1);
        const id = await hex(PNG);
        expect(reply?.body).toBe("");
        expect(reply?.images).toEqual([
            { id, mime: "image/png", w: 1, h: 1, name: "after.png second line" },
        ]);
        expect(await t.backend.projectsWithAsset(id)).toEqual([t.note.projectId]);
        expect(await t.backend.asset(id)).not.toBeNull();
        await t.backend.remove(t.note.id);
        expect(await t.backend.asset(id)).toBeNull();
    });

    it("refuses a reply with nothing in it, too many images or ones that are not PNG or WebP, and keeps nothing", async () => {
        const t = await setup();
        await expect(t.backend.reply(t.note.id, "  ")).rejects.toThrow("words or an image");
        const image = { name: "a.png", bytes: PNG };
        await expect(
            t.backend.reply(t.note.id, "four", undefined, {
                images: [image, image, image, image],
            })
        ).rejects.toThrow("at most 3");
        await expect(
            t.backend.reply(t.note.id, "svg", undefined, {
                images: [
                    { name: "b.png", bytes: PNG_B },
                    { name: "x.svg", bytes: new TextEncoder().encode("<svg/>") },
                ],
            })
        ).rejects.toThrow("PNG or WebP");
        expect(await t.backend.asset(await hex(PNG_B))).toBeNull();
        // A note that is not there keeps none of the images either.
        expect(
            await t.backend.reply("01NOSUCHNOTE00000000000000", "hi", undefined, {
                images: [{ name: "b.png", bytes: PNG_B }],
            })
        ).toBeNull();
        expect(await t.backend.asset(await hex(PNG_B))).toBeNull();
        expect((await t.backend.get(t.note.id))?.annotation.thread).toEqual([]);
    });

    it("travel in an exported bundle", async () => {
        const t = await setup();
        await t.backend.reply(t.note.id, "Like this", undefined, {
            images: [{ name: "wanted.png", bytes: PNG_B }],
        });
        const result = await t.backend.exportBundle({ projectId: t.note.projectId });
        if (!result) throw new Error("Missing export");
        const bundled = readBundle(new Uint8Array(await new Response(result.zip).arrayBuffer()));
        const note = bundled.bundle.annotations[0] as Annotation;
        const image = note.thread[0]?.images?.[0];
        expect(image?.path).toBe("shots/01-reply-1-1.png");
        expect(assetsFor(note, bundled.files).get(await hex(PNG_B))).toEqual(PNG_B);
        expect(bundled.files.get("feedback.md") ?? "").toBeDefined();
    });

    it("reach the agent with the reply, and through notato_get, but never an aside's", async () => {
        const t = await setup();
        const { call, text } = await connectMcp(t.backend, defer);
        await call("notato_watch", watch);
        await call("notato_acknowledge", { id: t.note.id });
        await t.backend.reply(t.note.id, "Private", undefined, {
            aside: true,
            images: [{ name: "secret.png", bytes: PNG_B }],
        });
        await t.backend.reply(t.note.id, "More like this", undefined, {
            images: [{ name: "wanted.png", bytes: PNG }],
        });
        const delivered = await call("notato_watch", watch);
        const out = text(delivered);
        expect(out).toContain("FOLLOW-UP");
        expect(out).toContain("More like this [image attached: wanted.png");
        expect(out).toContain("Image sent with the human's reply: wanted.png");
        expect(out).not.toContain("secret.png");
        const images = delivered.content.filter((c) => c.type === "image");
        expect(images).toHaveLength(1);
        expect(images[0]?.data).toBe(Buffer.from(PNG).toString("base64"));

        const got = await call("notato_get", { id: t.note.id, screenshots: "none" });
        expect(got.content.filter((c) => c.type === "image")).toHaveLength(1);
        expect(text(got)).not.toContain("secret.png");
        const textOnly = await call("notato_get", {
            id: t.note.id,
            screenshots: "none",
            references: false,
        });
        expect(textOnly.content.filter((c) => c.type === "image")).toHaveLength(0);
    });
});

describe("POST /annotations/:id/replies with images", () => {
    it("takes a multipart reply, and an agent's token reads its images but not an aside's", async () => {
        const t = await startServe(defer);
        const app = await issue(t, "p", "app", { purpose: "app" });
        const agent = await issue(t, "p", "agent", { purpose: "agent" });
        const a = annotationFixture({
            projectId: "p",
            visibility: "shared",
            screenshots: undefined,
        });
        expect(
            (
                await t.call("/projects/p/annotations", {
                    method: "POST",
                    headers: bearer(app),
                    body: multipart(a, new Map()),
                })
            ).status
        ).toBe(201);
        const send = (reply: Record<string, unknown>, images: Array<[string, Uint8Array]>) => {
            const form = new FormData();
            form.set("reply", JSON.stringify(reply));
            for (const [name, bytes] of images)
                form.append("image", new File([bytes as BlobPart], name, { type: "image/png" }));
            return t.call(`/annotations/${a.id}/replies`, {
                method: "POST",
                headers: bearer(app),
                body: form,
            });
        };
        const res = await send({ body: "See this" }, [["shot.png", PNG]]);
        expect(res.status).toBe(201);
        const stored = (await res.json()) as { annotation: Annotation };
        const image = stored.annotation.thread.at(-1)?.images?.[0];
        expect(image?.name).toBe("shot.png");
        const aside = await send({ body: "Between us", aside: true }, [["aside.png", PNG_B]]);
        expect(aside.status).toBe(201);
        expect((await send({ body: "" }, [])).status).toBe(400);

        const shown = await t.call(`/assets/${image?.id}?scope=all`, { headers: bearer(agent) });
        expect(shown.status).toBe(200);
        const hidden = await t.call(`/assets/${await hex(PNG_B)}?scope=all`, {
            headers: bearer(agent),
        });
        expect(hidden.status).toBe(404);
        // JSON replies are unchanged.
        const plain = await t.call(`/annotations/${a.id}/replies`, {
            method: "POST",
            headers: { ...bearer(app), "content-type": "application/json" },
            body: JSON.stringify({ body: "Words only" }),
        });
        expect(plain.status).toBe(201);
    });
});
