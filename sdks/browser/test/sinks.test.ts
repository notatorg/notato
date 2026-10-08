// @vitest-environment happy-dom
import { buildBundle, readBundle } from "@notato/core";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnnotationForm, serverSink } from "../src/sinks/server.ts";
import { bundleFilename, bundleToZip, zipSink } from "../src/sinks/zip.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

function fixture(n = 1): { annotation: Annotation; assets: Map<string, Blob> } {
    const annotation: Annotation = {
        ...sampleAnnotation,
        id: `01TEST${n}`,
        screenshots: {
            full: { id: `full-${n}`, mime: "image/png", w: 1, h: 1 },
            crop: { id: `crop-${n}`, mime: "image/png", w: 1, h: 1 },
        },
    };
    return {
        annotation,
        assets: new Map([
            [`full-${n}`, new Blob([PNG as BlobPart], { type: "image/png" })],
            [`crop-${n}`, new Blob([PNG as BlobPart], { type: "image/png" })],
        ]),
    };
}

const respond = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("bundleFilename", () => {
    it("is sortable and filesystem-safe", () => {
        expect(bundleFilename("checkout-web", new Date(2026, 9, 5, 9, 7))).toBe(
            "notato-checkout-web-20261005-0907.zip"
        );
        expect(bundleFilename("a/b c:d", new Date(2026, 0, 1, 0, 0))).toBe(
            "notato-a_b_c_d-20260101-0000.zip"
        );
    });
});

describe("buildAnnotationForm", () => {
    it("carries the annotation JSON and one file per screenshot, named by asset id", async () => {
        const { annotation, assets } = fixture();
        const form = buildAnnotationForm(annotation, assets);
        expect(JSON.parse(form.get("annotation") as string).id).toBe(annotation.id);
        expect(form.get("asset:full-1")).toBeInstanceOf(Blob);
        expect(form.get("asset:crop-1")).toBeInstanceOf(Blob);
    });
});

describe("serverSink delivering annotations", () => {
    it("posts multipart to the project's endpoint", async () => {
        fetchMock.mockResolvedValue(respond(201));
        const sink = serverSink({ baseUrl: "http://localhost:4747/", project: "checkout web" });
        const { annotation, assets } = fixture();
        await sink.deliver(annotation, assets);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("http://localhost:4747/projects/checkout%20web/annotations");
        expect(init.method).toBe("POST");
        expect(init.body).toBeInstanceOf(FormData);
        expect(sink.pending()).toBe(0);
    });

    it("keeps an annotation when the server is down and sends it when it comes back", async () => {
        vi.useFakeTimers();
        fetchMock
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockRejectedValueOnce(new TypeError("fetch failed"));
        const pending = vi.fn();
        const sink = serverSink({
            baseUrl: "http://x",
            project: "p",
            retryMs: 1000,
            onPending: pending,
        });
        const teardown = sink.setup();
        const { annotation, assets } = fixture();

        await sink.deliver(annotation, assets);
        expect(sink.pending()).toBe(1);
        expect(pending).toHaveBeenLastCalledWith(1);

        await vi.advanceTimersByTimeAsync(1000); // first retry fails too
        expect(sink.pending()).toBe(1);
        fetchMock.mockResolvedValue(respond(201));
        await vi.advanceTimersByTimeAsync(2000); // backed off to 2s, now succeeds
        expect(sink.pending()).toBe(0);
        expect(pending).toHaveBeenLastCalledWith(0);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        teardown?.();
    });

    it("retries on a 5xx, but drops an annotation the server rejects outright", async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const sink = serverSink({ baseUrl: "http://x", project: "p", retryMs: 500 });
        const teardown = sink.setup();

        fetchMock.mockResolvedValueOnce(respond(503)).mockResolvedValue(respond(201));
        const a = fixture(1);
        await sink.deliver(a.annotation, a.assets);
        expect(sink.pending()).toBe(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(sink.pending()).toBe(0);

        fetchMock.mockReset();
        fetchMock.mockResolvedValue(respond(400, { error: "invalid annotation: severity" }));
        const b = fixture(2);
        await sink.deliver(b.annotation, b.assets);
        expect(sink.pending()).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid annotation: severity"));
        teardown?.();
    });

    it("flushes everything queued, in order, when asked", async () => {
        fetchMock.mockRejectedValueOnce(new TypeError("down")).mockResolvedValue(respond(201));
        const sink = serverSink({ baseUrl: "http://x", project: "p", retryMs: 60_000 });
        const one = fixture(1);
        const two = fixture(2);
        await sink.deliver(one.annotation, one.assets);
        fetchMock.mockRejectedValueOnce(new TypeError("down"));
        await sink.deliver(two.annotation, two.assets);
        expect(sink.pending()).toBe(2);
        await sink.flush();
        expect(sink.pending()).toBe(0);
        const posted = fetchMock.mock.calls
            .slice(-2)
            .map(
                ([, init]) =>
                    JSON.parse(((init as RequestInit).body as FormData).get("annotation") as string)
                        .id
            );
        expect(posted).toEqual(["01TEST1", "01TEST2"]);
    });
});

describe("serverSink and what the server says", () => {
    const posted = () =>
        fetchMock.mock.calls.map(
            ([, init]) =>
                JSON.parse(((init as RequestInit).body as FormData).get("annotation") as string).id
        );

    it.each([401, 403, 404, 408, 429, 500, 502, 503])(
        "keeps everything queued, in order, on a %i, and tries again later",
        async (status) => {
            fetchMock.mockResolvedValue(respond(status, { error: "not now" }));
            const sink = serverSink({ baseUrl: "http://x", project: "p", retryMs: 60_000 });
            const one = fixture(1);
            const two = fixture(2);
            await sink.deliver(one.annotation, one.assets);
            await sink.deliver(two.annotation, two.assets);
            expect(sink.pending()).toBe(2);
            expect(sink.refusal("01TEST1")).toBeUndefined();
            fetchMock.mockResolvedValue(respond(201));
            await sink.flush();
            expect(sink.pending()).toBe(0);
            expect(posted().slice(-2)).toEqual(["01TEST1", "01TEST2"]);
        }
    );

    it("says what a server without the project said, keeps the note, and sends it once the project is there", async () => {
        const said = 'project "p" does not exist on this server: create it first';
        fetchMock.mockResolvedValue(respond(404, { error: said }));
        const problems: Array<string | undefined> = [];
        const sink = serverSink({
            baseUrl: "http://x",
            project: "p",
            retryMs: 60_000,
            onProblem: (m) => problems.push(m),
        });
        const one = fixture(1);
        await sink.deliver(one.annotation, one.assets);
        expect(sink.pending()).toBe(1);
        expect(sink.problem()).toBe(said);
        fetchMock.mockResolvedValue(respond(201));
        await sink.flush();
        expect(sink.pending()).toBe(0);
        expect(sink.problem()).toBeUndefined();
        expect(problems).toEqual([said, undefined]);
    });

    it.each([400, 409, 413, 415, 422])(
        "on a %i marks that note refused, with what the server said, and sends the ones after it",
        async (status) => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            fetchMock.mockRejectedValue(new TypeError("down"));
            const refusedOnes: Array<[string, string]> = [];
            const sent: string[] = [];
            const sink = serverSink({
                baseUrl: "http://x",
                project: "p",
                retryMs: 60_000,
                onRefused: (id, m) => refusedOnes.push([id, m]),
                onSent: (id) => sent.push(id),
            });
            const one = fixture(1);
            const two = fixture(2);
            await sink.deliver(one.annotation, one.assets);
            await sink.deliver(two.annotation, two.assets);
            fetchMock.mockReset();
            fetchMock
                .mockResolvedValueOnce(respond(status, { error: "too big" }))
                .mockResolvedValue(respond(201));
            await sink.flush();
            expect(sink.pending()).toBe(0);
            expect(sink.refusal("01TEST1")).toBe("too big");
            expect(sink.unsent()).toEqual(["01TEST1"]);
            expect(refusedOnes).toEqual([["01TEST1", "too big"]]);
            expect(sent).toEqual(["01TEST2"]);
            // and it is never tried again
            await sink.flush();
            expect(posted()).toEqual(["01TEST1", "01TEST2"]);
        }
    );

    it("sends one made while a flush is under way in the same flush", async () => {
        let release: () => void = () => {};
        fetchMock
            .mockImplementationOnce(
                () => new Promise((resolve) => (release = () => resolve(respond(201))))
            )
            .mockResolvedValue(respond(201));
        const sink = serverSink({ baseUrl: "http://x", project: "p", retryMs: 60_000 });
        const one = fixture(1);
        const two = fixture(2);
        const first = sink.deliver(one.annotation, one.assets);
        const second = sink.deliver(two.annotation, two.assets);
        release();
        await Promise.all([first, second]);
        expect(sink.pending()).toBe(0);
        expect(posted()).toEqual(["01TEST1", "01TEST2"]);
    });

    it("never sends a note deleted while it waited, and says the server never had it", async () => {
        fetchMock.mockRejectedValue(new TypeError("down"));
        const sink = serverSink({ baseUrl: "http://x", project: "p", retryMs: 60_000 });
        const one = fixture(1);
        await sink.deliver(one.annotation, one.assets);
        expect(await sink.discard("01TEST1")).toBe(false);
        expect(sink.pending()).toBe(0);
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(respond(201));
        await sink.flush();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("waits for a note deleted on its way, and says the server may have it", async () => {
        let release: () => void = () => {};
        fetchMock.mockImplementationOnce(
            () => new Promise((resolve) => (release = () => resolve(respond(201))))
        );
        const sink = serverSink({ baseUrl: "http://x", project: "p", retryMs: 60_000 });
        const one = fixture(1);
        const delivered = sink.deliver(one.annotation, one.assets);
        await Promise.resolve();
        const discarded = sink.discard("01TEST1");
        release();
        expect(await discarded).toBe(true);
        await delivered;
        // one that went to the server earlier, or came from it, has to be deleted there too
        expect(await sink.discard("01OTHER")).toBe(true);
    });

    it("takes back what was not sent before a reload, and sends only the ones not refused", async () => {
        fetchMock.mockResolvedValue(respond(201));
        const sink = serverSink({ baseUrl: "http://x", project: "p", retryMs: 60_000 });
        const one = fixture(1);
        const two = fixture(2);
        sink.restore([{ ...one }, { ...two, refused: "too big" }]);
        expect(sink.pending()).toBe(1);
        expect(sink.refusal("01TEST2")).toBe("too big");
        expect(sink.queued().map((q) => q.annotation.id)).toEqual(["01TEST1"]);
        await sink.flush();
        expect(posted()).toEqual(["01TEST1"]);
        expect(sink.unsent()).toEqual(["01TEST2"]);
    });
});

describe("serverSink delivering bundles", () => {
    it("ignores single annotations, and uploads a bundle as a zip", async () => {
        fetchMock.mockResolvedValue(respond(201));
        const sink = serverSink({ baseUrl: "http://x", project: "p", delivers: "bundles" });
        const { annotation, assets } = fixture();
        await sink.deliver(annotation, assets);
        expect(fetchMock).not.toHaveBeenCalled();

        const { bundle } = buildBundle([{ annotation, assets }], { projectId: "p" });
        await sink.deliver(bundle, assets);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("http://x/projects/p/bundles");
        expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/zip");
        expect(readBundle(new Uint8Array(init.body as Uint8Array)).bundle.annotations).toHaveLength(
            1
        );
    });

    it("explains an unreachable server and a rejected bundle", async () => {
        const sink = serverSink({ baseUrl: "http://x", project: "p", delivers: "bundles" });
        const { annotation, assets } = fixture();
        const { bundle } = buildBundle([{ annotation, assets }], { projectId: "p" });
        fetchMock.mockRejectedValueOnce(new TypeError("down"));
        await expect(sink.deliver(bundle, assets)).rejects.toThrow(
            "could not reach the server at http://x"
        );
        fetchMock.mockResolvedValueOnce(respond(400, { error: "bundle is for project other" }));
        await expect(sink.deliver(bundle, assets)).rejects.toThrow(
            "the server rejected the bundle: bundle is for project other"
        );
    });

    it("in annotation mode never uploads a bundle", async () => {
        const sink = serverSink({ baseUrl: "http://x", project: "p" });
        const { annotation, assets } = fixture();
        const { bundle } = buildBundle([{ annotation, assets }], { projectId: "p" });
        await sink.deliver(bundle, assets);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("zip", () => {
    it("bundleToZip builds a bundle that reads back", async () => {
        const { annotation, assets } = fixture();
        const { bundle } = buildBundle([{ annotation, assets }], {
            projectId: "p",
            author: { name: "Tina" },
        });
        const read = readBundle(await bundleToZip(bundle, assets));
        expect(read.bundle.author.name).toBe("Tina");
        expect(read.files.size).toBe(2);
    });

    it("zipSink ignores single annotations and downloads a packaged bundle", async () => {
        const created: Blob[] = [];
        URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
            created.push(b as Blob);
            return "blob:test";
        });
        URL.revokeObjectURL = vi.fn();
        const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
            this: HTMLAnchorElement
        ) {
            expect(this.download).toMatch(/^notato-p-\d{8}-\d{4}\.zip$/);
        });

        const sink = zipSink();
        const { annotation, assets } = fixture();
        await sink.deliver(annotation, assets);
        expect(click).not.toHaveBeenCalled();

        const { bundle } = buildBundle([{ annotation, assets }], { projectId: "p" });
        await sink.deliver(bundle, assets);
        expect(click).toHaveBeenCalledTimes(1);
        expect(created[0]?.type).toBe("application/zip");
        expect(document.querySelector("a[download]")).toBeNull();
    });

    it("zipSink honours a custom filename", async () => {
        URL.createObjectURL = vi.fn(() => "blob:test");
        URL.revokeObjectURL = vi.fn();
        let name = "";
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
            this: HTMLAnchorElement
        ) {
            name = this.download;
        });
        const { annotation, assets } = fixture();
        const { bundle } = buildBundle([{ annotation, assets }], { projectId: "p" });
        await zipSink({ filename: () => "custom.zip" }).deliver(bundle, assets);
        expect(name).toBe("custom.zip");
    });
});
