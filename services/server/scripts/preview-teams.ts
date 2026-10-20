import { type DevelopmentContext, TeamCoordinator, type WorkRecord } from "@notato/server";
import type { CloudRuntime } from "../src/index.ts";
import { annotationFixture } from "../test/helpers.ts";
export async function seedPreviewTeams(rt: CloudRuntime, workspace: string, owner: string) {
    const project = (await rt.store.listProjects(workspace)).find((p) => p.name === "Checkout web");
    if (!project) return;
    await rt.store.selectWorkspacePlan(workspace, owner, "team", 0);
    const teams = new TeamCoordinator(rt.store),
        contexts: DevelopmentContext[] = [];
    for (const [name, branch] of [
        ["Dominic", "feature/checkout"],
        ["Sam", "feature/search"],
        ["Priya", "fix/mobile-nav"],
        ["Alex", "feature/account"],
    ] as const) {
        const actor = name === "Dominic" ? owner : `preview-${name.toLowerCase()}`;
        if (actor !== owner) {
            await rt.store.upsertUser({
                username: actor,
                passwordHash: "synthetic-preview-only",
                createdAt: new Date().toISOString(),
                displayName: name,
            });
            await rt.store.setMembership({
                workspaceId: workspace,
                username: actor,
                role: "member",
                createdAt: new Date().toISOString(),
            });
        }
        contexts.push(await teams.create(project.id, actor, `${name}'s laptop`, branch));
    }
    const connection = (await rt.store.plugins!.connections(workspace)).find(
        (c) => c.provider === "github" && !c.revoked
    );
    if (!connection) return;
    const id = "pr_preview_checkout_42",
        at = new Date().toISOString();
    await teams.records.change<WorkRecord>(id, project.id, "work", () => ({
        id,
        projectId: project.id,
        contextId: contexts[0]!.id,
        version: 0,
        createdAt: at,
        updatedAt: at,
        pullRequest: {
            connectionId: connection.id,
            repository: "notato-preview/app",
            number: 42,
            title: "Make checkout errors clear and accessible",
            url: "https://github.com/notato-preview/app/pull/42",
            headSha: "a".repeat(40),
            latestHeadSha: "a".repeat(40),
            baseSha: "b".repeat(40),
            previewUrl: "https://checkout.preview.example.com",
            state: "open",
            merged: false,
            checkedAt: at,
            creator: owner,
        },
    }));
    const notes = [
        {
            comment: "The error message disappears before I can read it.",
            status: "open" as const,
            severity: "major" as const,
        },
        {
            comment: "Move focus to the card number when validation fails.",
            status: "acknowledged" as const,
            severity: "major" as const,
        },
        {
            comment: "The order total and pay button now line up correctly.",
            status: "resolved" as const,
            severity: "minor" as const,
        },
    ];
    for (const [i, n] of notes.entries())
        await rt.store.insertAnnotation(
            annotationFixture({
                id: `preview-pr-${i}`,
                projectId: project.id,
                workId: id,
                comment: n.comment,
                status: n.status,
                severity: n.severity,
                createdAt: at,
                route: "/checkout",
                author: { kind: "human", name: "Jamie · QA" },
                screenshots: undefined,
                context: {},
                thread: [],
            })
        );
    for (const [i, c] of contexts.entries()) {
        const a = annotationFixture({
            id: `preview-personal-${i}`,
            projectId: project.id,
            createdAt: at,
            comment: [
                "Keep the payment form stable while loading.",
                "Search results need a clearer empty state.",
                "The mobile menu closes while scrolling.",
                "Account settings should retain unsaved edits.",
            ][i]!,
            route: ["/checkout", "/search", "/", "/account"][i]!,
            author: { kind: "human", name: c.name.split("'")[0] },
            screenshots: undefined,
            context: {},
            thread: [],
        });
        await teams.route(a, c.id);
        await rt.store.insertAnnotation(a);
    }
    return project.id;
}
