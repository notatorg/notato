import { afterEach, describe, expect, it } from "bun:test";
import { type Backend, type DevRuntime, RelayError, RelayHub, runDev } from "../src/index.ts";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    filesFor,
    makeApp,
    multipart,
    waitFor,
} from "./helpers.ts";

const defer = cleanupAfterEach();

let ctx: ReturnType<typeof makeApp>;
const runtimes: DevRuntime[] = [];
afterEach(async () => {
    ctx?.cleanup();
    for (const r of runtimes.splice(0)) await r.close();
});

const args = { target: "#pay", comment: "Pay button hidden" };

describe("RelayHub", () => {
    it("hands a request to the page and resolves with what the page reports", async () => {
        const hub = new RelayHub();
        const seen: string[] = [];
        hub.register("p", (r) => {
            seen.push(r.args.target);
            hub.complete(r.requestId, { ok: true, annotationId: "A1" });
        });
        expect(await hub.request("p", args, 1000)).toEqual({ ok: true, annotationId: "A1" });
        expect(seen).toEqual(["#pay"]);
    });

    it("uses the most recently connected page, and falls back when it disconnects", async () => {
        const hub = new RelayHub();
        const who: string[] = [];
        const reply = (name: string) => (r: { requestId: string }) => {
            who.push(name);
            hub.complete(r.requestId, { ok: true, annotationId: name });
        };
        hub.register("p", reply("old"));
        const unregisterNew = hub.register("p", reply("new"));
        await hub.request("p", args, 1000);
        unregisterNew();
        await hub.request("p", args, 1000);
        expect(who).toEqual(["new", "old"]);
    });

    it("picks the only open project, and asks for projectId when there are several", async () => {
        const hub = new RelayHub();
        const respond = (r: { requestId: string }) =>
            hub.complete(r.requestId, { ok: true, annotationId: "x" });
        hub.register("only", respond);
        expect(await hub.request(undefined, args, 1000)).toMatchObject({ ok: true });
        hub.register("other", respond);
        await expect(hub.request(undefined, args, 1000)).rejects.toThrow(
            /Several projects.*only, other.*projectId/
        );
    });

    it("rejects with guidance when no page is connected", async () => {
        const hub = new RelayHub();
        const error = (await hub.request("p", args, 1000).catch((e) => e)) as RelayError;
        expect(error).toBeInstanceOf(RelayError);
        expect(error.status).toBe(409);
        expect(error.message).toContain('mode="agent"');
        expect(hub.has("p")).toBe(false);
    });

    it("times out when the page never answers, and ignores a late answer", async () => {
        const hub = new RelayHub();
        let late = "";
        hub.register("p", (r) => {
            late = r.requestId;
        });
        const error = (await hub.request("p", args, 30).catch((e) => e)) as RelayError;
        expect(error.status).toBe(504);
        expect(hub.complete(late, { ok: true, annotationId: "A" })).toBe(false);
        expect(hub.complete("unknown", { ok: false, error: "x" })).toBe(false);
    });

    it("carries a page-side failure through", async () => {
        const hub = new RelayHub();
        hub.register("p", (r) =>
            hub.complete(r.requestId, { ok: false, error: 'no element matches "#nope"' })
        );
        expect(await hub.request("p", args, 1000)).toEqual({
            ok: false,
            error: 'no element matches "#nope"',
        });
    });
});

/** A stand-in for a browser tab in agent mode: reads the event stream and answers annotate requests. */
async function fakePage(call: ReturnType<typeof makeApp>["call"], projectId = "checkout-web") {
    const controller = new AbortController();
    const res = await call(`/projects/${projectId}/events?agent=1`, { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const requests: Array<{
        requestId: string;
        args: { target: string; comment: string; author?: string };
    }> = [];
    let buffer = "";
    const loop = (async () => {
        for (;;) {
            const { value, done } = await reader
                .read()
                .catch(() => ({ value: undefined, done: true }));
            if (done) return;
            buffer += decoder.decode(value);
            for (;;) {
                const end = buffer.indexOf("\n\n");
                if (end < 0) break;
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (!frame.startsWith("event: annotate-request")) continue;
                const request = JSON.parse(/data: (.*)/.exec(frame)?.[1] ?? "{}");
                requests.push(request);
                // What the SDK does: create the annotation (posting it to the server), then report the outcome.
                const annotation = annotationFixture({
                    projectId,
                    comment: request.args.comment,
                    mode: "agent",
                    author: { kind: "agent", name: request.args.author },
                });
                await call(`/projects/${projectId}/annotations`, {
                    method: "POST",
                    body: multipart(annotation, filesFor()),
                });
                await call(`/relay/${request.requestId}/result`, {
                    method: "POST",
                    body: JSON.stringify({ ok: true, annotationId: annotation.id }),
                });
            }
        }
    })();
    return {
        requests,
        async close() {
            controller.abort();
            await reader.cancel().catch(() => {});
            await loop;
        },
    };
}

describe("relay over HTTP", () => {
    it("delivers annotate-request events only to agent pages, and registers on connect", async () => {
        ctx = makeApp();
        const plain = await ctx.call("/projects/checkout-web/events");
        expect(ctx.backend.relay.has("checkout-web")).toBe(false);
        const page = await fakePage(ctx.call);
        expect(await waitFor(() => ctx.backend.relay.has("checkout-web"))).toBe(true);
        await page.close();
        expect(await waitFor(() => !ctx.backend.relay.has("checkout-web"))).toBe(true);
        await plain.body?.cancel();
    });

    it("POST /relay/annotate runs the page round trip and returns the annotation id", async () => {
        ctx = makeApp();
        const page = await fakePage(ctx.call);
        await waitFor(() => ctx.backend.relay.has("checkout-web"));
        const res = await ctx.call("/relay/annotate", {
            method: "POST",
            body: JSON.stringify({ ...args, author: "Claude" }),
        });
        const body = (await res.json()) as { ok: boolean; annotationId: string };
        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(page.requests[0]?.args).toMatchObject({ target: "#pay", author: "Claude" });
        expect((await ctx.backend.get(body.annotationId))?.annotation).toMatchObject({
            comment: "Pay button hidden",
            mode: "agent",
        });
        await page.close();
    });

    it("answers 409 with guidance when no page is connected, and 504 when the page is silent", async () => {
        ctx = makeApp();
        const none = await ctx.call("/relay/annotate", {
            method: "POST",
            body: JSON.stringify(args),
        });
        expect(none.status).toBe(409);
        expect(((await none.json()) as { error: string }).error).toContain('mode="agent"');

        const silent = await ctx.call("/projects/checkout-web/events?agent=1");
        await waitFor(() => ctx.backend.relay.has("checkout-web"));
        const slow = await ctx.call("/relay/annotate", {
            method: "POST",
            body: JSON.stringify({ ...args, timeoutMs: 1000 }),
        });
        expect(slow.status).toBe(504);
        await silent.body?.cancel();
    });

    it("validates relay bodies and results", async () => {
        ctx = makeApp();
        expect(
            (
                await ctx.call("/relay/annotate", {
                    method: "POST",
                    body: JSON.stringify({ comment: "no target" }),
                })
            ).status
        ).toBe(400);
        expect(
            (
                await ctx.call("/relay/annotate", {
                    method: "POST",
                    body: JSON.stringify({ ...args, timeoutMs: 5 }),
                })
            ).status
        ).toBe(400);
        expect(
            (
                await ctx.call("/relay/nope/result", {
                    method: "POST",
                    body: JSON.stringify({ ok: true, annotationId: "a" }),
                })
            ).status
        ).toBe(404);
        expect(
            (
                await ctx.call("/relay/nope/result", {
                    method: "POST",
                    body: JSON.stringify({ ok: "maybe" }),
                })
            ).status
        ).toBe(400);
    });
});

describe("notato_annotate", () => {
    const connect = (backend: Backend) =>
        connectMcp(backend, defer, { client: "codex-mcp-client" });

    it("files an annotation through the page and returns it with screenshots", async () => {
        ctx = makeApp();
        const page = await fakePage(ctx.call);
        await waitFor(() => ctx.backend.relay.has("checkout-web"));
        const { call } = await connect(ctx.backend);
        const result = await call("notato_annotate", {
            target: "#pay",
            comment: "Pay button hidden behind banner",
            severity: "major",
            timeoutSeconds: 5,
        });
        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toBe("Filed.");
        expect(
            result.content.some((c) => c.text?.includes("Pay button hidden behind banner"))
        ).toBe(true);
        expect(result.content.filter((c) => c.type === "image")).toHaveLength(2);
        // The agent is named as the author, so the thread shows who filed it.
        // Signed with the agent the MCP client says it is.
        expect(page.requests[0]?.args.author).toBe("Codex");
        await page.close();
    });

    it("explains what to do when no page is connected", async () => {
        ctx = makeApp();
        const { call } = await connect(ctx.backend);
        const result = await call("notato_annotate", { target: "#pay", comment: "x" });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('<Notato mode="agent"');
    });

    it("reports a page-side failure, and works through an attached notato dev process", async () => {
        const first = await runDev({
            port: 0,
            dir: `${ctx?.dir ?? "/tmp"}-a-${Date.now()}`,
            version: "t",
            stdio: false,
            log: () => {},
        });
        runtimes.push(first);
        const second = await runDev({
            port: first.port,
            dir: `${ctx?.dir ?? "/tmp"}-b-${Date.now()}`,
            version: "t",
            stdio: false,
            log: () => {},
        });
        runtimes.push(second);
        expect(second.role).toBe("client");

        const controller = new AbortController();
        const res = await fetch(
            `http://127.0.0.1:${first.port}/projects/checkout-web/events?agent=1`,
            {
                signal: controller.signal,
            }
        );
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        // A page that cannot find the element.
        void (async () => {
            let buffer = "";
            for (;;) {
                const { value, done } = await reader
                    .read()
                    .catch(() => ({ value: undefined, done: true }));
                if (done) return;
                buffer += new TextDecoder().decode(value);
                const id = /"requestId":"([^"]+)"/.exec(buffer)?.[1];
                if (!id) continue;
                buffer = "";
                await fetch(`http://127.0.0.1:${first.port}/relay/${id}/result`, {
                    method: "POST",
                    body: JSON.stringify({ ok: false, error: 'no element matches "#nope"' }),
                });
            }
        })();
        await waitFor(() => first.local?.relay.has("checkout-web") === true);

        const { call } = await connect(second.backend);
        const result = await call("notato_annotate", {
            target: "#nope",
            comment: "x",
            timeoutSeconds: 5,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain(
            'The page could not annotate: no element matches "#nope"'
        );
        controller.abort();
    });
});
