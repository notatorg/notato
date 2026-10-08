import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Annotation } from "@notato/schema";
import { createConfigSource } from "../src/config.ts";
import { SAMPLE_COMMENT, type TestResult } from "../src/settings.ts";
import { SHARE_KEY_FILE, ShareLinks } from "../src/share.ts";
import { createTunnelGate } from "../src/tunnel.ts";
import { buildDelivery } from "../src/webhooks.ts";
import { ingest, makeApp } from "./helpers.ts";

const TUNNEL = "https://abc-4747.uks1.devtunnels.ms";
const TOKEN = "device-token-for-the-tests-0123456789";

let dir: string;
let publicUrl: string | undefined;
let ctx: ReturnType<typeof makeApp>;
let receiver: ReturnType<typeof Bun.serve> | undefined;
let received: string[];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notato-share-"));
    publicUrl = TUNNEL;
    ctx = makeApp(
        {
            share: new ShareLinks(dir, () => publicUrl),
            // As `notato dev --tunnel` runs: anything through the tunnel needs the device token.
            authorize: createTunnelGate(TOKEN).authorize,
            allowedHosts: [new URL(TUNNEL).hostname],
        },
        createConfigSource({ file: join(dir, "notato.config.json"), env: {} })
    );
    received = [];
});
afterEach(() => {
    ctx.cleanup();
    receiver?.stop(true);
    receiver = undefined;
    rmSync(dir, { recursive: true, force: true });
});

/** A note with real screenshots, as the server stored it. */
async function note(over: Partial<Annotation> = {}) {
    const { body } = await ingest(ctx.call, over);
    return body.annotation;
}

const board = (path: string, body: unknown) =>
    ctx.call(path, {
        method: "POST",
        headers: { origin: "http://localhost:4747", "content-type": "application/json" },
        body: JSON.stringify(body),
    });

/** A request as it arrives through the dev tunnel: sent to the tunnel's host name. */
const outside = (path: string, headers: Record<string, string> = {}) =>
    ctx.app(
        new Request(`${TUNNEL}${path}`, { headers: { host: new URL(TUNNEL).host, ...headers } })
    );

function listen() {
    receiver = Bun.serve({
        port: 0,
        async fetch(req) {
            received.push(await req.text());
            return new Response("1", { status: 202 });
        },
    });
    return `http://127.0.0.1:${receiver.port}/workflows/x`;
}

describe("signed screenshot links", () => {
    it("open one screenshot from outside without the device token, and nothing else", async () => {
        const a = await note();
        const links = new ShareLinks(dir, () => TUNNEL).linksFor(a);
        expect(links?.full).toStartWith(`${TUNNEL}/shared/${a.screenshots?.full.id}.png?sig=`);
        const path = (links?.full ?? "").slice(TUNNEL.length);

        const res = await outside(path);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(new Uint8Array(await res.arrayBuffer()).slice(0, 4)).toEqual(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47])
        );

        // The rest of the server still needs the token through the tunnel.
        expect((await outside(`/assets/${a.screenshots?.full.id}`)).status).toBe(401);
        expect((await outside("/projects")).status).toBe(401);
    });

    it("refuse a wrong signature, another image's signature, and a server that never made a link", async () => {
        const a = await note();
        const share = new ShareLinks(dir, () => TUNNEL);
        const sig = new URL(
            share.urlFor(a.screenshots?.full ?? ({} as never)) ?? ""
        ).searchParams.get("sig");
        expect((await outside(`/shared/${a.screenshots?.full.id}.png?sig=nope`)).status).toBe(404);
        // The close-up is a different image, so the page's signature is not good for it.
        expect((await outside(`/shared/${a.screenshots?.crop?.id}.png?sig=${sig}`)).status).toBe(
            404
        );
        expect((await outside(`/shared/${a.screenshots?.full.id}.png`)).status).toBe(404);

        const fresh = mkdtempSync(join(tmpdir(), "notato-nokey-"));
        try {
            expect(
                new ShareLinks(fresh, () => TUNNEL).verify(a.screenshots?.full.id ?? "", sig ?? "")
            ).toBe(false);
            // Checking a signature does not make a key; only making a link does.
            expect(existsSync(join(fresh, SHARE_KEY_FILE))).toBe(false);
        } finally {
            rmSync(fresh, { recursive: true, force: true });
        }
    });

    it("keep their key in a private file, so links in messages already sent keep working after a restart", async () => {
        const a = await note();
        const first = new ShareLinks(dir, () => TUNNEL).linksFor(a);
        expect(statSync(join(dir, SHARE_KEY_FILE)).mode & 0o777).toBe(0o600);
        expect(new ShareLinks(dir, () => TUNNEL).linksFor(a)).toEqual(first as never);
    });

    it("are not made without an address the outside world can reach", async () => {
        const a = await note();
        expect(new ShareLinks(dir, () => undefined).linksFor(a)).toBeUndefined();
    });
});

describe("screenshots in messages", () => {
    it("put the screenshot in a Teams card, a tap away from full size, and link it from JSON", async () => {
        const a = await note();
        const links = new ShareLinks(dir, () => TUNNEL).linksFor(a);
        const teams = JSON.parse(
            buildDelivery(
                { url: "https://x.test", format: "teams" },
                "annotation.created",
                a,
                undefined,
                undefined,
                links
            ).body
        );
        const image = teams.attachments[0].content.body.find(
            (b: { type: string }) => b.type === "Image"
        );
        expect(image).toMatchObject({
            url: links?.full,
            selectAction: { type: "Action.OpenUrl", url: links?.full },
        });

        const json = JSON.parse(
            buildDelivery(
                { url: "https://x.test", format: "json" },
                "annotation.created",
                a,
                undefined,
                undefined,
                links
            ).body
        );
        expect(json.screenshotUrls).toEqual(links);
    });

    it("leave the card without an image when there is no link to give", async () => {
        const a = await note();
        const teams = JSON.parse(
            buildDelivery({ url: "https://x.test", format: "teams" }, "annotation.created", a).body
        );
        expect(JSON.stringify(teams)).not.toContain('"Image"');
    });
});

describe("previewing a test", () => {
    it("shows exactly what would be sent for a real note and event, with the image where the board can show it", async () => {
        const a = await note({ comment: "The save button is cut off" });
        const res = await board("/settings/webhooks/preview", {
            hook: {
                url: "https://x.environment.api.powerplatform.com/workflows/abc?sig=SECRET",
                format: "teams",
            },
            annotationId: a.id,
            event: "annotation.resolved",
        });
        expect(res.status).toBe(200);
        const preview = (await res.json()) as {
            body: {
                attachments: Array<{ content: { body: Array<{ type: string; url?: string }> } }>;
            };
            images: Record<string, string>;
            notes: string[];
            url: string;
            event: string;
        };
        expect(preview.event).toBe("annotation.resolved");
        expect(preview.url).not.toContain("SECRET");
        const card = preview.body.attachments[0]?.content;
        const image = card?.body.find((b) => b.type === "Image");
        expect(image?.url).toStartWith(`${TUNNEL}/shared/`);
        expect(preview.images[image?.url ?? ""]).toBe(`/assets/${a.screenshots?.full.id}`);
        expect(JSON.stringify(card)).toContain("The save button is cut off");
        expect(preview.notes).toEqual([]);
        // A preview sends nothing.
        expect(received).toEqual([]);
    });

    it("says why a screenshot is missing", async () => {
        const a = await note();
        const why = async (hook: Record<string, unknown>, annotationId?: string) =>
            (
                (await (
                    await board("/settings/webhooks/preview", { hook, annotationId })
                ).json()) as {
                    notes: string[];
                }
            ).notes;
        const teams = { url: "https://x.test/h", format: "teams" };
        expect((await why(teams))[0]).toContain("made-up note");
        expect((await why({ ...teams, screenshots: false }, a.id))[0]).toContain("turned off");
        expect((await why({ url: "https://x.test/h", format: "slack" }, a.id))[0]).toContain(
            "one line of text"
        );
        publicUrl = undefined;
        expect((await why(teams, a.id))[0]).toContain("--tunnel");
    });

    it("says when the webhook would not normally get that note or event", async () => {
        const a = await note({ projectId: "other" });
        const { notes } = (await (
            await board("/settings/webhooks/preview", {
                hook: {
                    url: "https://x.test/h",
                    format: "teams",
                    events: ["annotation.created"],
                    project: "mine",
                },
                annotationId: a.id,
                event: "annotation.replied",
            })
        ).json()) as { notes: string[] };
        expect(notes).toEqual([
            "This webhook is not sent this event; the test sends it anyway.",
            "This note is from other; the webhook only gets mine.",
        ]);
    });

    it("refuses a note that does not exist", async () => {
        const res = await board("/settings/webhooks/preview", {
            hook: { url: "https://x.test/h", format: "teams" },
            annotationId: "01NOPE",
        });
        expect(res.status).toBe(404);
    });
});

describe("sending a test", () => {
    it("sends the previewed message: the real note, the event, the screenshot link", async () => {
        const url = listen();
        const a = await note({ comment: "Totals overlap on large text" });
        const result = (await (
            await board("/settings/webhooks/test", {
                hook: { url, format: "teams" },
                annotationId: a.id,
                event: "annotation.created",
            })
        ).json()) as TestResult;
        expect(result).toMatchObject({ ok: true, status: 202 });
        const sent = JSON.parse(received[0] ?? "{}");
        const card = sent.attachments[0].content;
        expect(JSON.stringify(card)).toContain("Totals overlap on large text");
        expect(card.body.find((b: { type: string }) => b.type === "Image").url).toStartWith(
            `${TUNNEL}/shared/`
        );
    });

    it("sends the made-up note when none is chosen", async () => {
        const url = listen();
        await board("/settings/webhooks/test", { hook: { url, format: "json" } });
        expect(JSON.parse(received[0] ?? "{}").annotation.comment).toBe(SAMPLE_COMMENT);
    });
});

describe("the screenshots switch", () => {
    it("is saved only when off", async () => {
        const file = join(dir, "notato.config.json");
        writeFileSync(file, "{}");
        await board("/settings/webhooks", {
            hook: { url: "https://x.test/a", format: "teams", screenshots: false },
        });
        await board("/settings/webhooks", {
            hook: { url: "https://x.test/b", format: "teams", screenshots: true },
        });
        expect(ctx.backend.config().webhooks).toEqual([
            { url: "https://x.test/a", format: "teams", screenshots: false },
            { url: "https://x.test/b", format: "teams" },
        ]);
    });
});
