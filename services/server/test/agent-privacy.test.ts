import { expect, it } from "bun:test";
import { annotationFixture, cleanupAfterEach, PNG, PNG_B } from "./helpers.ts";
import { bearer, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();

it("enforces People only in Postgres-backed agent reads, including shared object hashes", async () => {
    const s = await startServe(defer);
    await s.rt.backend.createProject("private");
    const agent = bearer(
        (await s.rt.auth.issueToken("private", "agent", { purpose: "agent", createdBy: "admin" }))
            .token
    );
    const person = bearer(
        (
            await s.rt.auth.issueToken("private", "human", {
                purpose: "app",
                ownership: "service",
                createdBy: "admin",
            })
        ).token
    );
    const reference = {
        id: "reference",
        mime: "image/png" as const,
        w: 1,
        h: 1,
        name: "Private design",
    };
    const note = annotationFixture({
        projectId: "private",
        screenshots: undefined,
        peopleOnly: true,
        comment: "PRIVATE BODY",
        references: [reference],
    });
    const { stored } = await s.rt.backend.ingest(note, new Map([[reference.id, PNG]]), {
        feedbackActorId: "admin",
    });
    await s.rt.backend.ingest(
        annotationFixture({
            projectId: "private",
            screenshots: undefined,
            comment: "PUBLIC BODY",
            references: [{ ...reference, id: "public" }],
        }),
        new Map([["public", PNG_B]]),
        { feedbackActorId: "admin" }
    );
    const asset = stored.annotation.references?.[0]?.id;
    if (!asset) throw new Error("Missing reference");
    expect(await s.rt.store.projectsWithAsset(asset)).toEqual(["private"]);
    expect(await s.rt.store.projectsWithAsset(asset, { peopleOnly: false })).toEqual([]);
    for (const path of [
        `/annotations/${note.id}`,
        `/annotations/${note.id}/markdown`,
        `/assets/${asset}`,
    ]) {
        expect((await s.call(path, { headers: agent })).status).toBe(404);
        expect((await s.call(path, { headers: person })).status).toBe(200);
    }
    for (const path of [
        "/annotations",
        "/projects/private/annotations",
        "/projects/private/markdown",
    ]) {
        const response = await s.call(path, { headers: agent });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("PUBLIC BODY");
        expect(text).not.toContain("PRIVATE BODY");
    }
    await s.rt.backend.createProject("other");
    await s.rt.backend.ingest(
        annotationFixture({ projectId: "other", screenshots: undefined, references: [reference] }),
        new Map([[reference.id, PNG]])
    );
    expect(await s.rt.store.projectsWithAsset(asset, { peopleOnly: false })).toEqual(["other"]);
    expect((await s.call(`/assets/${asset}`, { headers: agent })).status).toBe(404);
    await s.rt.backend.update(note.id, { peopleOnly: false }, { kind: "human" });
    expect((await s.call(`/assets/${asset}`, { headers: agent })).status).toBe(200);
});
