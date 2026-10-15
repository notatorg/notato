import { expect, it } from "bun:test";
import { annotationFixture, cleanupAfterEach, makeApp, multipart } from "./helpers.ts";

const defer = cleanupAfterEach();
it("compact event streams omit diagnostics and steps while normal streams and stored notes retain them", async () => {
    const app = makeApp();
    defer(app.cleanup);
    const note = annotationFixture({
        screenshots: undefined,
        context: { screenshot: { pin: 3 }, console: "diagnostic ".repeat(2000) },
        steps: [{ action: "click", target: "#price", at: "2026-10-15T12:00:00Z" }],
    });
    const compact = await app.call(`/projects/${note.projectId}/events?fields=summary`);
    const original = await app.call(`/projects/${note.projectId}/events`);
    if (!compact.body || !original.body) throw new Error("missing stream");
    const shortReader = compact.body.getReader(),
        fullReader = original.body.getReader();
    defer(() => shortReader.cancel());
    defer(() => fullReader.cancel());
    await shortReader.read();
    await fullReader.read();
    const response = await app.call(`/projects/${note.projectId}/annotations`, {
        method: "POST",
        body: multipart(note),
    });
    expect(response.status).toBe(201);
    const short = new TextDecoder().decode((await shortReader.read()).value);
    const full = new TextDecoder().decode((await fullReader.read()).value);
    expect(short).toContain('"pin":3');
    expect(short).not.toContain("diagnostic");
    expect(short).not.toContain('"steps"');
    expect(full).toContain("diagnostic");
    expect(short.length).toBeLessThan(full.length / 5);
    expect((await app.store.getAnnotation(note.id))?.annotation.context).toEqual(note.context);
});
