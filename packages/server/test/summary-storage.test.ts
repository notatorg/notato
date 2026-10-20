import { expect, it } from "bun:test";
import { annotationFixture, cleanupAfterEach, makeApp, multipart } from "./helpers.ts";

const defer = cleanupAfterEach();
it("projects summary rows inside SQLite without changing the full diagnostic record", async () => {
    const app = makeApp();
    defer(app.cleanup);
    const note = annotationFixture({
        context: { screenshot: { pin: 7 }, console: "large diagnostic ".repeat(1000) },
    });
    const response = await app.call(`/projects/${note.projectId}/annotations`, {
        method: "POST",
        body: multipart(note),
    });
    expect(response.status).toBe(201);
    const full = await app.store.getAnnotation(note.id);
    const rows = await app.store.listAnnotations({ projectId: note.projectId, summary: true });
    expect(rows[0]?.annotation.context).toEqual({ screenshot: { pin: 7 } });
    expect(rows[0]?.annotation.steps).toBeUndefined();
    expect(JSON.stringify(rows).length).toBeLessThan(JSON.stringify(full).length / 2);
    expect((await app.store.getAnnotation(note.id))?.annotation.context).toEqual(note.context);
    const listed = await app.call(`/projects/${note.projectId}/annotations?fields=summary`);
    expect(((await listed.json()) as { items: typeof rows }).items[0]?.annotation.context).toEqual(
        rows[0]?.annotation.context
    );
});
