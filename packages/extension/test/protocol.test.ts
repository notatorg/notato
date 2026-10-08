import { describe, expect, it } from "bun:test";
import {
    allowedRequest,
    createSseParser,
    decodeInit,
    decodeResponse,
    encodeInit,
    encodeResponse,
    fromBase64,
    projectFor,
    projectOf,
    type SiteConfig,
    serverMethod,
    toBase64,
} from "../src/protocol.ts";

describe("base64", () => {
    it("round-trips every byte value, and a large buffer without overflowing the stack", () => {
        const all = Uint8Array.from({ length: 256 }, (_, i) => i);
        expect([...fromBase64(toBase64(all))]).toEqual([...all]);
        const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 256);
        expect(fromBase64(toBase64(big))).toEqual(big);
        expect(toBase64(new Uint8Array(0))).toBe("");
    });
});

describe("a request's options as data", () => {
    it("keeps the method, the headers and a text body", async () => {
        const wire = await encodeInit({
            method: "PATCH",
            headers: { "Content-Type": "application/json", "X-A": "1" },
            body: '{"a":1}',
        });
        expect(wire.method).toBe("PATCH");
        expect(Object.fromEntries(wire.headers ?? [])).toEqual({
            "content-type": "application/json",
            "x-a": "1",
        });
        const back = decodeInit(wire);
        expect(back.method).toBe("PATCH");
        expect(back.body).toBe('{"a":1}');
    });

    it("nothing at all is nothing", async () => {
        expect(await encodeInit(undefined)).toEqual({});
        expect(await encodeInit({ method: "GET" })).toEqual({ method: "GET" });
        expect(decodeInit({})).toEqual({});
    });

    it("carries bytes: a zip as a Blob, an ArrayBuffer, and a view into a bigger buffer", async () => {
        const bytes = Uint8Array.from([80, 75, 3, 4, 0, 255, 128]);
        const viaBlob = decodeInit(
            await encodeInit({ body: new Blob([bytes], { type: "application/zip" }) })
        ).body as Blob;
        expect(viaBlob.type).toBe("application/zip");
        expect(new Uint8Array(await viaBlob.arrayBuffer())).toEqual(bytes);
        const viaBuffer = decodeInit(
            await encodeInit({ body: bytes.buffer.slice(0) as ArrayBuffer })
        ).body as Blob;
        expect(new Uint8Array(await viaBuffer.arrayBuffer())).toEqual(bytes);
        const bigger = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
        const slice = bigger.subarray(2, 5);
        const viaView = decodeInit(await encodeInit({ body: slice })).body as Blob;
        expect(new Uint8Array(await viaView.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]));
    });

    it("carries a form with a screenshot: the fields, and the file's bytes, type and name", async () => {
        const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]);
        const form = new FormData();
        form.set("annotation", JSON.stringify({ id: "a1" }));
        form.set("asset:abc", new File([png], "abc.png", { type: "image/png" }));
        const wire = await encodeInit({
            method: "POST",
            headers: {
                Authorization: "Bearer t",
                "Content-Type": "multipart/form-data; boundary=zzz",
            },
            body: form,
        });
        const back = decodeInit(wire);
        const rebuilt = back.body as FormData;
        expect(rebuilt.get("annotation")).toBe('{"id":"a1"}');
        const file = rebuilt.get("asset:abc") as File;
        expect(file.name).toBe("abc.png");
        expect(file.type).toBe("image/png");
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
        // The multipart boundary is the browser's to write, so the old Content-Type is not carried over.
        const headers = Object.fromEntries(back.headers as Array<[string, string]>);
        expect(headers.authorization).toBe("Bearer t");
        expect(headers["content-type"]).toBeUndefined();
    });

    it("URLSearchParams is text", async () => {
        expect(decodeInit(await encodeInit({ body: new URLSearchParams({ a: "1 2" }) })).body).toBe(
            "a=1+2"
        );
    });

    it("refuses a body it cannot carry, rather than losing it", async () => {
        await expect(encodeInit({ body: new ReadableStream() as never })).rejects.toThrow(
            "cannot be sent"
        );
    });
});

describe("a response as data", () => {
    it("keeps status, headers and a binary body", async () => {
        const png = Uint8Array.from([137, 80, 78, 71, 0, 255]);
        const res = new Response(png, {
            status: 200,
            headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
        });
        const back = decodeResponse(await encodeResponse(res));
        expect(back.status).toBe(200);
        expect(back.headers.get("content-type")).toBe("image/png");
        expect(new Uint8Array(await back.arrayBuffer())).toEqual(png);
    });

    it("json, and an empty body, and the statuses that cannot have one", async () => {
        const json = decodeResponse(
            await encodeResponse(Response.json({ ok: true }, { status: 201 }))
        );
        expect(json.status).toBe(201);
        expect(await json.json()).toEqual({ ok: true });
        for (const status of [204, 304]) {
            const none = decodeResponse(await encodeResponse(new Response(null, { status })));
            expect(none.status).toBe(status);
            expect(await none.text()).toBe("");
        }
        const empty = decodeResponse(await encodeResponse(new Response("", { status: 200 })));
        expect(await empty.text()).toBe("");
    });

    it("a status no response can have throws, in every runtime, as a browser's Response does", () => {
        for (const status of [0, 101, 199, 600, Number.NaN])
            expect(
                () => decodeResponse({ status, statusText: "", headers: [] }),
                String(status)
            ).toThrow(RangeError);
    });

    it("an error status is still a response, with its message", async () => {
        const res = decodeResponse(
            await encodeResponse(Response.json({ error: "nope" }, { status: 403 }))
        );
        expect(res.ok).toBe(false);
        expect(((await res.json()) as { error: string }).error).toBe("nope");
    });
});

describe("what the extension will fetch for a page", () => {
    const server = "http://localhost:4747";
    const ORIGIN = "https://app.example.com";
    const site: SiteConfig = { enabled: true, server, project: "shop" };
    const may = (method: string, path: string, over: Partial<SiteConfig> = {}) =>
        allowedRequest({ ...site, ...over }, ORIGIN, `${server}${path}`, method);

    it("what the toolbar asks for, for the site's own project", () => {
        for (const [method, path] of [
            ["GET", "/health"],
            ["GET", "/config"],
            ["GET", "/status"],
            ["GET", "/auth/me"],
            ["GET", "/projects/shop/annotations?limit=500"],
            ["POST", "/projects/shop/annotations"],
            ["GET", "/projects/shop/events?agent=1"],
            ["POST", "/projects/shop/bundles"],
            ["GET", "/projects/shop/markdown"],
            ["GET", "/projects/shop/export"],
            ["GET", "/annotations/01ABC"],
            ["PATCH", "/annotations/01ABC"],
            ["DELETE", "/annotations/01ABC"],
            ["POST", "/annotations/01ABC/replies"],
            ["PUT", "/annotations/01ABC/variants"],
            ["GET", "/annotations/01ABC/variants"],
            ["POST", "/annotations/01ABC/variants/choose"],
            ["GET", "/annotations/01ABC/markdown"],
            ["GET", `/assets/${"a".repeat(64)}`],
        ] as const)
            expect(may(method, path), `${method} ${path}`).toBe(true);
    });

    it("nothing else on that server: settings, webhooks, accounts, the relay, other lists", () => {
        for (const [method, path] of [
            ["GET", "/"],
            ["GET", "/settings"],
            ["PUT", "/settings"],
            ["GET", "/settings/config"],
            ["GET", "/webhooks"],
            ["POST", "/webhooks/test"],
            ["GET", "/admin/tokens"],
            ["POST", "/admin/tokens"],
            ["POST", "/auth/login"],
            ["POST", "/auth/logout"],
            ["GET", "/projects"],
            ["POST", "/projects"],
            ["GET", "/projects/shop"],
            ["DELETE", "/projects/shop"],
            ["GET", "/annotations"],
            ["GET", "/annotations/wait"],
            ["GET", "/bundles/x"],
            ["GET", "/bundles/x/export"],
            ["POST", "/relay/r1/result"],
            ["POST", "/relay/annotate"],
            ["POST", "/mcp"],
            ["GET", "/inject.js"],
            ["GET", "/bookmarklet"],
            ["GET", "/../etc/passwd"],
            ["GET", "/health/"],
            ["GET", "/projects/shop/annotations/"],
        ] as const)
            expect(may(method, path), `${method} ${path}`).toBe(false);
    });

    it("not with another method than the toolbar's", () => {
        for (const [method, path] of [
            ["DELETE", "/projects/shop/annotations"],
            ["PUT", "/projects/shop/annotations"],
            ["GET", "/webhooks/test"],
            ["POST", "/health"],
            ["DELETE", "/status"],
            ["POST", "/projects/shop/events"],
            ["GET", "/projects/shop/bundles"],
            ["POST", "/annotations/01ABC"],
            ["PUT", "/annotations/01ABC"],
            ["DELETE", "/annotations/01ABC/replies"],
            ["DELETE", "/annotations/01ABC/variants"],
            ["GET", "/annotations/01ABC/variants/choose"],
            ["DELETE", `/assets/${"a".repeat(64)}`],
            ["HEAD", "/health"],
            ["OPTIONS", "/projects/shop/annotations"],
        ] as const)
            expect(may(method, path), `${method} ${path}`).toBe(false);
    });

    it("never another project, however its name is written", () => {
        for (const [method, path] of [
            ["GET", "/projects/other/annotations"],
            ["POST", "/projects/other/annotations"],
            ["GET", "/projects/other/events"],
            ["POST", "/projects/other/bundles"],
            ["GET", "/projects/other/export"],
            ["GET", "/projects/shop%2F..%2Fother/annotations"],
            ["GET", "/projects/shop%2f..%2fother/annotations"],
            ["GET", "/projects/shop/..%2Fother/annotations"],
            ["GET", "/projects/shop/../other/annotations"],
            ["GET", "/projects/shop/%2e%2e/other/annotations"],
            ["GET", "/projects/%73hop%2Fx/annotations"],
            ["GET", "/projects/%2573hop/annotations"],
            ["GET", "/projects/sho%/annotations"],
            ["GET", "/projects/Shop/annotations"],
            ["GET", "/projects//annotations"],
            ["GET", "/projects/shop/annotations/../../other/annotations"],
        ] as const)
            expect(may(method, path), `${method} ${path}`).toBe(false);
        // The same name, encoded, is the same project, as the server reads it.
        expect(may("GET", "/projects/%73hop/annotations")).toBe(true);
        expect(may("GET", "/projects/my%20shop/annotations", { project: "my shop" })).toBe(true);
    });

    it("a site with no project set works in the one named after its host, as the page does", () => {
        expect(may("GET", "/projects/app.example.com/annotations", { project: "" })).toBe(true);
        expect(may("GET", "/projects/shop/annotations", { project: "" })).toBe(false);
        expect(
            allowedRequest(
                { ...site, project: "" },
                "http://localhost:5173",
                `${server}/projects/localhost-5173/events`,
                "GET"
            )
        ).toBe(true);
    });

    it("ids are ids: no encoding, no dots, nothing too long", () => {
        for (const path of [
            "/annotations/a%2Fb",
            "/annotations/..",
            "/annotations/a.b",
            "/annotations/a b",
            `/annotations/${"a".repeat(129)}`,
            "/assets/a%2e%2e",
            "/assets/",
        ])
            expect(may("GET", path), path).toBe(false);
        expect(may("GET", `/annotations/${"a".repeat(128)}`)).toBe(true);
    });

    it("no other server, port, scheme or trick of the address", () => {
        for (const url of [
            "http://localhost:4748/config",
            "https://localhost:4747/config",
            "http://127.0.0.1:4747/config",
            "http://evil.example/config",
            "http://localhost:4747@evil.example/config",
            "http://localhost:4747.evil.example/config",
            "//evil.example/config",
            "file:///etc/passwd",
            "not a url",
            "",
        ])
            expect(allowedRequest(site, ORIGIN, url, "GET"), url).toBe(false);
    });

    it("a server behind a path keeps to it", () => {
        const behind = (server: string, url: string) =>
            allowedRequest({ ...site, server }, ORIGIN, url, "GET");
        expect(behind("https://tools.example/notato", "https://tools.example/notato/config")).toBe(
            true
        );
        expect(behind("https://tools.example/notato", "https://tools.example/config")).toBe(false);
        expect(behind("https://tools.example/notato", "https://tools.example/notatox/config")).toBe(
            false
        );
        expect(
            behind("https://tools.example/notato/", "https://tools.example/notato/annotations/1")
        ).toBe(true);
        expect(
            behind(
                "https://tools.example/notato",
                "https://tools.example/notato/projects/shop/annotations"
            )
        ).toBe(true);
    });

    it("a server address that is not one allows nothing", () => {
        expect(
            allowedRequest(
                { ...site, server: "nope" },
                ORIGIN,
                "http://localhost:4747/config",
                "GET"
            )
        ).toBe(false);
    });
});

describe("the method the server acts on", () => {
    it("is the one sent, in capitals, except a POST that says it means PATCH", () => {
        expect(serverMethod(undefined)).toBe("GET");
        expect(serverMethod("patch")).toBe("PATCH");
        expect(serverMethod("POST", [["X-HTTP-Method-Override", "patch"]])).toBe("PATCH");
        expect(serverMethod("post", { "x-http-method-override": "PATCH" })).toBe("PATCH");
        // Only a POST, and only to PATCH, as the server reads it.
        expect(serverMethod("POST", { "x-http-method-override": "DELETE" })).toBe("POST");
        expect(serverMethod("DELETE", { "x-http-method-override": "PATCH" })).toBe("DELETE");
    });
});

describe("server-sent events", () => {
    const frames = (...chunks: string[]) => {
        const parser = createSseParser();
        return chunks.flatMap((c) => parser.push(c));
    };

    it("reads named frames, with the data as sent", () => {
        expect(frames('event: created\ndata: {"a":1}\n\n')).toEqual([
            { type: "created", data: '{"a":1}' },
        ]);
    });

    it("a frame split across chunks, anywhere, is the same frame", () => {
        const text = 'event: updated\nid: 7\ndata: {"x":"y"}\n\n';
        for (let cut = 1; cut < text.length; cut++)
            expect(frames(text.slice(0, cut), text.slice(cut)), `cut at ${cut}`).toEqual([
                { type: "updated", data: '{"x":"y"}', lastEventId: "7" },
            ]);
    });

    it("several frames in one chunk, in order", () => {
        expect(frames("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n").map((f) => f.type)).toEqual([
            "a",
            "b",
        ]);
    });

    it("multi-line data is joined with newlines, CRLF is accepted, and the default name is message", () => {
        expect(frames("data: one\r\ndata: two\r\n\r\n")).toEqual([
            { type: "message", data: "one\ntwo" },
        ]);
    });

    it("comments (keep-alives) and frames with no data are not frames", () => {
        expect(frames(": ping\n\nevent: hello\n\n:x\n\n")).toEqual([]);
        expect(frames(": ping\n\nevent: hello\ndata: {}\n\n")).toEqual([
            { type: "hello", data: "{}" },
        ]);
    });

    it("a value keeps its inner spaces, losing only the one after the colon", () => {
        expect(frames("data:  two spaces\n\n")).toEqual([{ type: "message", data: " two spaces" }]);
        expect(frames("data:tight\n\n")).toEqual([{ type: "message", data: "tight" }]);
    });

    it("an unfinished frame waits for the rest and is never emitted early", () => {
        const parser = createSseParser();
        expect(parser.push("event: a\ndata: 1")).toEqual([]);
        expect(parser.push("\n\n")).toEqual([{ type: "a", data: "1" }]);
    });
});

describe("projectOf", () => {
    it("is the project set for the site, or else the one named after the page's host", () => {
        expect(projectOf({ project: "shop" }, "https://app.example.com")).toBe("shop");
        expect(projectOf({ project: "" }, "http://localhost:5173")).toBe("localhost-5173");
        expect(projectOf({ project: "" }, "not an origin")).toBe("page");
    });
});

describe("projectFor", () => {
    it("makes a valid project id from where a page is served", () => {
        expect(projectFor("localhost:5173")).toBe("localhost-5173");
        expect(projectFor("app.example.com")).toBe("app.example.com");
        expect(projectFor("")).toBe("page");
        expect(projectFor("a b/c?d")).toMatch(/^[\w.@-]+$/);
        expect(projectFor("x".repeat(300)).length).toBe(100);
    });
});
