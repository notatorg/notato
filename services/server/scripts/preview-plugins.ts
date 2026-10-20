// Synthetic providers for the local preview only. Never reaches a real provider or creates an external record.
import type { CloudRuntime } from "../src/index.ts";
import type { Destination } from "../src/plugins/model.ts";
import { Providers } from "../src/plugins/providers.ts";
import { pluginsFor } from "../src/routes/plugins.ts";
import { annotationFixture } from "../test/helpers.ts";

const team = "11111111-1111-4111-8111-111111111111";
export const previewPlugins = {
    key: Buffer.alloc(32, 8),
    providers: new Providers(async (value, init) => {
        const url = new URL(value);
        const method = init?.method ?? "GET";
        if (url.hostname === "api.github.com") {
            if (/\/pulls\/42$/.test(url.pathname))
                return Response.json({
                    number: 42,
                    title: "Make checkout errors clear and accessible",
                    state: "open",
                    merged: false,
                    head: { sha: "a".repeat(40) },
                    base: { sha: "b".repeat(40), repo: { full_name: "notato-preview/app" } },
                });
            if (url.pathname.endsWith("/reviews"))
                return Response.json(method === "POST" ? { id: 1 } : []);
            if (url.pathname === "/user/repos")
                return Response.json([{ full_name: "notato-preview/app" }]);
            if (url.pathname.endsWith("/issues") && method === "POST")
                return Response.json(
                    { html_url: "https://github.com/notato-preview/app/issues/1", number: 1 },
                    { status: 201 }
                );
            if (/\/issues\/\d+$/.test(url.pathname))
                return Response.json({
                    html_url: "https://github.com/notato-preview/app/issues/1",
                    number: 1,
                });
            return Response.json({ id: 1, name: "Preview user" });
        }
        if (url.hostname === "slack.com")
            return Response.json({
                ok: true,
                ts: "1.2",
                channels: [{ id: "C123456789", name: "feedback", is_member: true }],
            });
        if (url.hostname === "api.linear.app")
            return Response.json({
                data: {
                    viewer: { id: team },
                    teams: { nodes: [{ id: team, name: "Product" }] },
                    issueCreate: {
                        success: true,
                        issue: {
                            id: team,
                            identifier: "APP-1",
                            url: "https://linear.app/notato-preview/issue/APP-1/feedback",
                        },
                    },
                },
            });
        if (url.hostname === "gitlab.com")
            return Response.json(
                method === "POST"
                    ? { iid: 1, web_url: "https://gitlab.com/notato-preview/app/-/issues/1" }
                    : url.pathname === "/api/v4/projects"
                      ? [{ id: 1, name_with_namespace: "Preview / App" }]
                      : { id: 1 }
            );
        if (url.hostname === "dev.azure.com")
            return Response.json(
                method === "POST"
                    ? {
                          id: 1,
                          _links: {
                              html: {
                                  href: "https://dev.azure.com/notato-preview/App/_workitems/edit/1",
                              },
                          },
                      }
                    : { value: [{ name: "Bug" }, { name: "Task" }] }
            );
        return new Response(null, { status: 204 });
    }),
};
export async function seedPreviewPlugins(
    rt: CloudRuntime,
    workspace: string,
    actor: string,
    origin: string
) {
    const project = (await rt.store.listProjects(workspace))[0];
    if (!project) return;
    const service = pluginsFor(rt.backend, origin, previewPlugins);
    const destinations: Destination[] = [
        { provider: "github", repository: "notato-preview/app", labels: ["feedback"] },
        { provider: "azure", organization: "notato-preview", project: "App", workItemType: "Bug" },
        { provider: "teams" },
        { provider: "slack", channel: "C123456789" },
        { provider: "webhook" },
        { provider: "linear", team, labels: [] },
        { provider: "gitlab", project: "1", labels: [] },
    ];
    const actions: Record<string, string> = {};
    for (const destination of destinations) {
        const connectionId = await service.connect(
            workspace,
            {
                name: `Preview ${destination.provider}`,
                provider: destination.provider,
                credential:
                    destination.provider === "teams"
                        ? "https://preview.environment.api.powerplatform.com/feedback"
                        : destination.provider === "webhook"
                          ? "https://hooks.example.com/feedback"
                          : "preview-only-not-a-real-token",
                ...(destination.provider === "webhook"
                    ? { signingSecret: "preview-signing-secret-at-least-32-characters" }
                    : {}),
            },
            actor
        );
        const id = crypto.randomUUID();
        actions[destination.provider] = id;
        await service.saveAction({
            id,
            name: `${destination.provider === "slack" || destination.provider === "teams" ? "Notify" : "Send to"} ${destination.provider}`,
            connectionId,
            projectId: project.id,
            destination,
            creator: actor,
            workspaceId: workspace,
            updatedAt: new Date().toISOString(),
        });
    }
    for (const [provider, trigger] of [
        ["github", "created"],
        ["slack", "daily_digest"],
        ["teams", "unanswered"],
    ] as const) {
        const actionId = actions[provider];
        if (actionId)
            await service.saveWorkflow({
                id: crypto.randomUUID(),
                name:
                    provider === "github"
                        ? "Route major fixes to GitHub"
                        : provider === "slack"
                          ? "Daily Slack review"
                          : "Remind us about unanswered questions",
                actionId,
                trigger,
                enabled: true,
                hourUtc: 9,
                delayHours: 24,
                workspaceId: workspace,
                creator: actor,
                createdAt: new Date().toISOString(),
                ...(provider === "github"
                    ? { severity: "major" as const, intent: "fix" as const }
                    : {}),
            });
    }
    for (const [comment, peopleOnly] of [
        ["The pay button is disabled after entering a valid card.", false],
        ["Please align the order total with the amount above.", false],
        ["Private discussion: keep this out of automatic workflows.", true],
    ] as const)
        await rt.store.insertAnnotation(
            annotationFixture({
                id: crypto.randomUUID(),
                projectId: project.id,
                createdAt: new Date().toISOString(),
                comment,
                peopleOnly,
                intent: "fix",
                severity: "major",
                route: "/checkout",
                screenshots: undefined,
                context: {},
            })
        );
}
