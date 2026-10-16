import { expect, it } from "bun:test";
import { buildBundle, readBundle, writeBundle } from "@notato/core";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    hex,
    makeBackend,
    PNG,
    PNG_B,
    toolText,
} from "./helpers.ts";
import { bearer, issue, sse, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
const reference = {
    id: "private-reference",
    mime: "image/png" as const,
    w: 1,
    h: 1,
    name: "Private design",
};

it("refuses direct MCP reads of private text, screenshots and references, until a person shares the note", async () => {
    const t = makeBackend();
    defer(t.cleanup);
    const a = annotationFixture({
        peopleOnly: true,
        comment: "PRIVATE TEXT",
        screenshots: undefined,
        references: [reference],
    });
    await t.backend.ingest(a, new Map([[reference.id, PNG]]));
    const { call } = await connectMcp(t.backend, defer);
    const result = await call("notato_get", { id: a.id, references: true, screenshots: "both" });
    expect(result.isError).toBe(true);
    expect(toolText(result)).not.toContain("PRIVATE TEXT");
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(0);
    await t.backend.update(a.id, { peopleOnly: false }, { kind: "human" });
    const shared = await call("notato_get", { id: a.id });
    expect(shared.isError).not.toBe(true);
    expect(toolText(shared)).toContain("PRIVATE TEXT");
    expect(shared.content.filter((c) => c.type === "image")).toHaveLength(1);
});

it("keeps private notes and their assets out of every agent-token read, export and event path", async () => {
    const s = await startServe(defer);
    const app = bearer(await issue(s, "p", "human", { purpose: "app" }));
    const agent = bearer(await issue(s, "p", "agent", { purpose: "agent" }));
    const bundleId = "privacy-bundle";
    const hidden = annotationFixture({
        projectId: "p",
        bundleId,
        peopleOnly: true,
        comment: "PRIVATE TEXT",
        screenshots: undefined,
        references: [reference],
    });
    const visible = annotationFixture({
        projectId: "p",
        bundleId,
        comment: "PUBLIC TEXT",
        screenshots: undefined,
        references: [{ ...reference, id: "public-reference" }],
    });
    const { bundle } = buildBundle(
        [hidden, visible].map((annotation) => ({ annotation, assets: new Map() })),
        { projectId: "p", id: bundleId }
    );
    await s.rt.backend.importBundle(
        await writeBundle(bundle, async (ref) => (ref.id === reference.id ? PNG : PNG_B))
    );
    for (const path of [
        "/annotations",
        "/projects/p/annotations",
        "/projects/p/markdown",
        `/bundles/${bundleId}`,
    ]) {
        const response = await s.call(path, { headers: agent });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("PUBLIC TEXT");
        expect(text).not.toContain("PRIVATE TEXT");
    }
    const assetPath = `/assets/${await hex(PNG)}`;
    for (const path of [
        `/annotations/${hidden.id}`,
        `/annotations/${hidden.id}/markdown`,
        `/annotations/${hidden.id}/screenshot?view=crop`,
        assetPath,
    ])
        expect((await s.call(path, { headers: agent })).status).toBe(404);
    expect((await s.call(assetPath, { headers: app })).status).toBe(200);
    // Sharing identical pixels in another project cannot unlock the private image in this project.
    await s.rt.backend.createProject("other");
    await s.rt.backend.ingest(
        annotationFixture({ projectId: "other", screenshots: undefined, references: [reference] }),
        new Map([[reference.id, PNG]])
    );
    expect((await s.call(assetPath, { headers: agent })).status).toBe(404);
    for (const path of ["/projects/p/export", `/bundles/${bundleId}/export`]) {
        const response = await s.call(path, { headers: agent });
        expect(response.status).toBe(200);
        const exported = readBundle(new Uint8Array(await response.arrayBuffer()));
        expect(exported.bundle.annotations.map((a) => a.comment)).toEqual(["PUBLIC TEXT"]);
        expect(
            [...exported.files.values()].some((bytes) =>
                Buffer.from(bytes).equals(Buffer.from(PNG))
            )
        ).toBe(false);
    }
    const update = (id: string, headers: Record<string, string>, body: unknown) =>
        s.call(`/annotations/${id}`, {
            method: "PATCH",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    expect((await update(hidden.id, agent, { peopleOnly: false })).status).toBe(404);
    expect((await update(visible.id, agent, { peopleOnly: true })).status).toBe(403);
    const abort = new AbortController();
    defer(() => abort.abort());
    const next = sse(await s.call("/projects/p/events", { headers: agent, signal: abort.signal }));
    await next("hello");
    expect(
        (await update(visible.id, app, { peopleOnly: true, comment: "NEW PRIVATE TEXT" })).status
    ).toBe(200);
    const removed = await next("deleted");
    expect(removed).toMatchObject({ id: visible.id, projectId: "p" });
    expect(JSON.stringify(removed)).not.toContain("PRIVATE TEXT");
    expect(removed).not.toHaveProperty("annotation");
    expect((await update(hidden.id, app, { peopleOnly: false })).status).toBe(200);
    expect((await s.call(assetPath, { headers: agent })).status).toBe(200);
});
