import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { createApp, FileBlobStore, LocalBackend, SqliteStore } from "@notato/server";
import { exportMarkdown } from "../src/commands/export.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const c of cleanups.splice(0)) c();
});

/** A real server app, reached through its own handler so nothing is mocked but the network hop. */
async function serverWith(...comments: Array<Partial<Annotation>>) {
    const dir = mkdtempSync(join(tmpdir(), "notato-export-"));
    const store = new SqliteStore(":memory:");
    const backend = new LocalBackend(store, new FileBlobStore(join(dir, "assets")));
    const app = createApp({ backend, mode: "dev", version: "test" });
    cleanups.push(() => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });
    /** Requests as Bun.serve would deliver them, with a Host header. */
    const call = (request: Request) => {
        request.headers.set("host", "localhost:4747");
        return app(request);
    };
    let n = 0;
    for (const over of comments) {
        n += 1;
        const annotation: Annotation = {
            ...sampleAnnotation,
            id: `01EXPORT${String(n).padStart(18, "0")}`,
            bundleId: null,
            status: "open",
            thread: [],
            screenshots: undefined,
            context: {},
            ...over,
        };
        const form = new FormData();
        form.set("annotation", JSON.stringify(annotation));
        const res = await call(
            new Request(`http://localhost:4747/projects/${annotation.projectId}/annotations`, {
                method: "POST",
                body: form,
            })
        );
        expect(res.status).toBe(201);
    }
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
        call(new Request(input as string, init))) as typeof fetch;
    return { fetch: fetcher, server: "http://localhost:4747", backend };
}

describe("notato export", () => {
    it("prints the project's annotations as Markdown, picking the project when there is only one", async () => {
        const s = await serverWith(
            { comment: "Button is hidden" },
            { comment: "Title is cut off", intent: "change" }
        );
        const md = await exportMarkdown(s);
        expect(md).toContain("2 annotations");
        expect(md).toContain("Comment: Button is hidden");
        expect(md).toContain("Intent: change");
    });

    it("takes the level of detail, and compact is a line each", async () => {
        const s = await serverWith(
            { comment: "Button is hidden" },
            { comment: "Title is cut off" }
        );
        const compact = await exportMarkdown({ ...s, detail: "compact" });
        expect(compact).toContain("- ");
        expect(compact).not.toContain("## Annotation");
        const forensic = await exportMarkdown({ ...s, detail: "forensic" });
        expect(forensic).toContain("Identity (as captured):");
    });

    it("filters by status and intent", async () => {
        const s = await serverWith(
            { comment: "one", intent: "fix" },
            { comment: "two", intent: "question" },
            { comment: "three" }
        );
        // A new annotation is always open; this one is resolved the way an agent would.
        await s.backend.setStatus("01EXPORT000000000000000003", "resolved", "done");
        const md = await exportMarkdown({ ...s, intent: "question" });
        expect(md).toContain("1 annotation");
        expect(md).toContain("Comment: two");
        const open = await exportMarkdown({ ...s, status: "open" });
        expect(open).not.toContain("Comment: three");
        expect(open).toContain("2 annotations");
        expect(await exportMarkdown({ ...s, status: "resolved" })).toContain("Comment: three");
    });

    it("asks which project when there are several, and says so rather than guessing", async () => {
        const s = await serverWith({ projectId: "alpha" }, { projectId: "beta" });
        await expect(exportMarkdown(s)).rejects.toThrow("alpha, beta");
        expect(await exportMarkdown({ ...s, project: "beta" })).toContain("Feedback for beta");
    });

    it("explains a bad level, an empty server and an unreachable one", async () => {
        const s = await serverWith({ comment: "x" });
        await expect(exportMarkdown({ ...s, detail: "lots" })).rejects.toThrow(
            "--detail must be one of"
        );
        const empty = await serverWith();
        await expect(exportMarkdown(empty)).rejects.toThrow("no annotations yet");
        await expect(
            exportMarkdown({
                server: "http://127.0.0.1:1",
                fetch: (() => Promise.reject(new Error("refused"))) as unknown as typeof fetch,
            })
        ).rejects.toThrow("cannot reach a Notato server");
    });
});
