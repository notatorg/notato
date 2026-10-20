import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSummary } from "../src/api.ts";

const originalDocument = globalThis.document;
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { ProjectSettings } = await import("../src/ProjectSettings.tsx");
globalThis.document = originalDocument;

it("uses the friendly project name and keeps the connection ID behind a closed disclosure", () => {
    const project = "project_internal_connection_id";
    const html = renderToStaticMarkup(
        <ProjectSettings
            me={{ mode: "serve", authenticated: true, authRequired: false }}
            project={project}
            summary={{ id: project, name: "Checkout web" } as ProjectSummary}
            projects={[]}
            menu={null}
            onRenamed={() => {}}
            onDeleted={() => {}}
        />
    );
    const header = html.match(/<header[^>]*>(.*?)<\/header>/s)?.[1];
    expect(header).toContain("Checkout web");
    expect(header).not.toContain(project);
    expect(html).toContain("Choose a name your team will recognise.");
    expect(html).toContain("<details><summary>Project ID for app and agent connections</summary>");
    expect(html).toContain(`<code>${project}</code>`);
    expect(html).toContain("Copy project ID");
    expect(html).not.toContain("<details open");
});
