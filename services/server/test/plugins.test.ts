import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { FileBlobStore } from "@notato/server";
import { CloudBackend } from "../src/backend.ts";
import { StripeBilling } from "../src/billing.ts";
import { planLimits } from "../src/plans.ts";
import { workflowConditions } from "../src/plugins/conditions.ts";
import {
    type Destination,
    decrypt,
    encrypt,
    hasWorkflowTag,
    notePayload,
    type Payload,
    type Workflow,
    WorkflowEditInput,
} from "../src/plugins/model.ts";
import { githubInstallUrl, oauthAuthorize, oauthToken } from "../src/plugins/oauth.ts";
import { ProviderError, Providers } from "../src/plugins/providers.ts";
import { PluginService } from "../src/plugins/service.ts";
import { outboundUrl, publicAddress } from "../src/plugins/transport.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import { HOSTED_LIMITS } from "../src/storage.ts";
import { annotationFixture, cleanupAfterEach, tempDir } from "./helpers.ts";
import { embeddedPostgres } from "./postgres.ts";

const defer = cleanupAfterEach();
const key = Buffer.alloc(32, 7);
const at = () => new Date().toISOString();
const payload: Payload = {
    title: "Button is broken",
    text: "Please fix it.\nView feedback: https://notato.example/#/p/p/a/a",
    url: "https://notato.example/#/p/p/a/a",
    noteIds: ["a"],
};
it("matches Shared OR tagged feedback differently from Shared AND tagged feedback, in capture and SQL", async () => {
    for (const match of ["all", "any"] as const) {
        const w = await setup();
        await w.workflow();
        const original = (await w.store.plugins.workflows("personal"))[0];
        if (!original) throw new Error("missing workflow");
        const configured: Workflow = {
            ...original,
            includePersonal: true,
            conditions: {
                match,
                rules: [
                    { field: "visibility", value: "shared" },
                    { field: "tag", value: "xyz" },
                ],
            },
        };
        await w.service.saveWorkflow(configured);
        await w.insert({ comment: "Shared without a tag", visibility: "shared" });
        await w.insert({ comment: "Shared #XYZ", visibility: "shared" });
        const personal = await w.insert({
            comment: "Mine #xyz",
            visibility: "personal",
            createdBy: "owner",
        });
        await w.insert({ comment: "Untagged private", visibility: "personal", createdBy: "owner" });
        await w.insert({
            comment: "Someone else #xyz",
            visibility: "personal",
            createdBy: "other",
        });
        await w.insert({ comment: "Hidden #xyz", peopleOnly: true, visibility: "shared" });
        const expected = match === "any" ? 3 : 1;
        expect(await w.store.plugins.history("personal")).toHaveLength(expected);
        expect(await w.store.plugins.digest("p", configured)).toHaveLength(expected);
        await w.service.run();
        expect(w.writes()).toHaveLength(expected);
        expect((await w.store.getAnnotation(personal.id))?.annotation.visibility).toBe("personal");
    }
});
it("supports OR across tags, severity and type while keeping personal and project boundaries outside the group", async () => {
    const w = await setup();
    await w.workflow();
    const original = (await w.store.plugins.workflows("personal"))[0];
    if (!original) throw new Error("missing workflow");
    const configured: Workflow = {
        ...original,
        includePersonal: true,
        conditions: {
            match: "any",
            rules: [
                { field: "severity", value: "blocker" },
                { field: "intent", value: "question" },
                { field: "tag", value: "xyz" },
            ],
        },
    };
    await w.service.saveWorkflow(configured);
    await w.insert({
        comment: "A shared question",
        intent: "question",
        severity: "minor",
        visibility: "shared",
    });
    await w.insert({
        comment: "Mine #xyz",
        intent: "fix",
        severity: "minor",
        visibility: "personal",
        createdBy: "owner",
    });
    await w.insert({
        comment: "Private blocker without a tag",
        severity: "blocker",
        visibility: "personal",
        createdBy: "owner",
    });
    await w.insert({
        comment: "Other person #xyz",
        severity: "blocker",
        visibility: "personal",
        createdBy: "other",
    });
    await w.insert({
        comment: "Unmatched shared feedback",
        severity: "minor",
        intent: "fix",
        visibility: "shared",
    });
    await w.store.createProject({
        id: "other-project",
        name: "Other",
        workspaceId: "personal",
        createdAt: at(),
    });
    await w.insert({
        comment: "Other project #xyz",
        severity: "blocker",
        projectId: "other-project",
        visibility: "shared",
    });
    expect(await w.store.plugins.history("personal")).toHaveLength(2);
    expect(await w.store.plugins.digest("p", configured)).toHaveLength(2);
    await w.service.run();
    expect(w.writes()).toHaveLength(2);
});
it("requires all configured tags in an AND group and queues newly matching rule groups only once", async () => {
    const w = await setup();
    await w.workflow();
    const original = (await w.store.plugins.workflows("personal"))[0];
    if (!original) throw new Error("missing workflow");
    const configured: Workflow = {
        ...original,
        includePersonal: true,
        conditions: {
            match: "all",
            rules: [
                { field: "tag", value: "xyz" },
                { field: "tag", value: "mobile" },
                { field: "severity", value: "blocker" },
            ],
        },
    };
    await w.service.saveWorkflow(configured);
    const n = await w.insert({
        comment: "#xyz #mobile",
        severity: "minor",
        visibility: "personal",
        createdBy: "owner",
    });
    await w.insert({ comment: "Only #xyz", severity: "blocker", visibility: "shared" });
    expect(await w.store.plugins.history("personal")).toHaveLength(0);
    await w.store.updateAnnotation(n.id, (note) => ({ ...note, severity: "blocker" }));
    await w.store.updateAnnotation(n.id, (note) => ({
        ...note,
        comment: "More detail #xyz #mobile",
    }));
    expect(await w.store.plugins.history("personal")).toHaveLength(1);
    expect(await w.store.plugins.digest("p", configured)).toHaveLength(1);
    await w.store.updateAnnotation(n.id, (note) => ({
        ...note,
        comment: "Removed one required tag #xyz",
    }));
    await w.service.run();
    expect(w.writes()).toHaveLength(0);
});
it("uses the same OR conditions for digests and unanswered reminders", async () => {
    for (const trigger of ["daily_digest", "unanswered"] as const) {
        const w = await setup();
        const { tag: _tag, ...original } = await notificationWorkflow(w, trigger);
        const configured: Workflow = {
            ...original,
            conditions: {
                match: "any",
                rules: [
                    { field: "visibility", value: "shared" },
                    { field: "tag", value: "xyz" },
                ],
            },
        };
        await w.service.saveWorkflow(configured);
        const awaiting =
            trigger === "unanswered"
                ? {
                      status: "awaiting_response" as const,
                      awaitingResponse: { resumeStatus: "acknowledged" as const },
                  }
                : {};
        await w.insert({ ...awaiting, comment: "Shared without tag", visibility: "shared" });
        await w.insert({
            ...awaiting,
            comment: "Private #xyz",
            visibility: "personal",
            createdBy: "owner",
        });
        await w.insert({
            ...awaiting,
            comment: "Other private #xyz",
            visibility: "personal",
            createdBy: "other",
        });
        await w.insert({
            ...awaiting,
            comment: "Unmatched private",
            visibility: "personal",
            createdBy: "owner",
        });
        if (trigger === "unanswered")
            await w.store.plugins.db.query(
                "UPDATE notato.annotations SET activity_received_at=$1",
                [new Date(Date.now() - 25 * 3600_000).toISOString()]
            );
        await w.store.plugins.scheduled(new Date());
        expect(await w.store.plugins.history("personal")).toHaveLength(
            trigger === "daily_digest" ? 1 : 2
        );
        await w.service.run();
        const writes = w.calls.filter(
            (r) => r.method === "POST" && r.url === "https://hooks.example.com/feedback"
        );
        expect(writes).toHaveLength(trigger === "daily_digest" ? 1 : 2);
        const text = (await Promise.all(writes.map((r) => r.text()))).join("\n");
        expect(text).toContain("Shared without tag");
        expect(text).toContain("Private #xyz");
        expect(text).not.toContain("Other private");
        expect(text).not.toContain("Unmatched private");
    }
});
it("bounds and normalizes rules, preserves legacy AND semantics, and rejects untagged personal opt-in", async () => {
    const input = { name: "Rules", actionId: crypto.randomUUID(), trigger: "created" };
    expect(
        WorkflowEditInput.safeParse({ ...input, conditions: { match: "all", rules: [] } }).success
    ).toBe(false);
    expect(
        WorkflowEditInput.safeParse({
            ...input,
            conditions: {
                match: "any",
                rules: Array.from({ length: 9 }, () => ({ field: "tag", value: "xyz" })),
            },
        }).success
    ).toBe(false);
    expect(
        WorkflowEditInput.safeParse({
            ...input,
            conditions: { match: "all", rules: [{ field: "sql", value: "TRUE" }] },
        }).success
    ).toBe(false);
    const parsed = WorkflowEditInput.parse({
        ...input,
        conditions: { match: "any", rules: [{ field: "tag", value: "#XYZ" }] },
    });
    expect(parsed.conditions?.rules[0]?.value).toBe("xyz");
    expect(workflowConditions({ tag: "xyz", severity: "blocker", includePersonal: true })).toEqual({
        match: "all",
        rules: [
            { field: "tag", value: "xyz" },
            { field: "severity", value: "blocker" },
        ],
    });
    const w = await setup();
    await w.workflow();
    const original = (await w.store.plugins.workflows("personal"))[0];
    if (!original) throw new Error("missing workflow");
    await expect(
        w.service.saveWorkflow({
            ...original,
            includePersonal: true,
            conditions: { match: "any", rules: [{ field: "visibility", value: "personal" }] },
        })
    ).rejects.toThrow("tag");
    const configured: Workflow = {
        ...original,
        conditions: { match: "all", rules: [{ field: "visibility", value: "shared" }] },
    };
    await w.service.saveWorkflow(configured);
    await expect(w.service.saveWorkflow(original)).rejects.toThrow("Refresh");
    await expect(w.service.saveWorkflow({ ...configured, tag: "xyz" })).rejects.toThrow("legacy");
});
it("constructs only a registered GitHub App installation path", () => {
    expect(githubInstallUrl("notato-test-app")).toBe(
        "https://github.com/apps/notato-test-app/installations/new"
    );
    expect(githubInstallUrl("https://foreign.example/path")).toBeNull();
    expect(githubInstallUrl("../other")).toBeNull();
});
async function setup(plan: "free" | "plus" | "pro" = "plus") {
    const { store } = await embeddedPostgres();
    defer(() => store.close());
    store.setHostedLimits(HOSTED_LIMITS);
    store.setTestPlans(true);
    await store.upsertUser({ username: "owner", passwordHash: "synthetic", createdAt: at() });
    await store.createWorkspace({ id: "personal", name: "Personal", createdAt: at() }, "owner", {
        id: plan,
        extraSeats: 0,
    });
    await store.createProject({
        id: "p",
        name: "Project",
        workspaceId: "personal",
        createdAt: at(),
    });
    const calls: Request[] = [];
    let response = 201;
    let uncertain = false;
    const providers = new Providers(async (input, init) => {
        const req = new Request(input, init);
        calls.push(req);
        if (req.method === "POST" && new URL(req.url).pathname.endsWith("/issues")) {
            if (uncertain) throw new Error("secret provider message");
            return Response.json(
                { html_url: "https://github.com/example/repo/issues/1", number: 1 },
                { status: response }
            );
        }
        if (/\/issues\/\d+$/.test(new URL(req.url).pathname))
            return Response.json({
                html_url: "https://github.com/example/repo/issues/1",
                number: 1,
            });
        return Response.json({ id: 1 });
    });
    const backend = new CloudBackend(store, new FileBlobStore(tempDir(defer)));
    const service = new PluginService(backend, "https://notato.example", key, providers);
    const connectionId = await service.connect(
        "personal",
        {
            name: "GitHub",
            provider: "github",
            credential: "test-credential-never-disclosed",
        },
        "owner"
    );
    const actionId = crypto.randomUUID();
    await service.saveAction({
        id: actionId,
        name: "Create issue",
        workspaceId: "personal",
        creator: "owner",
        updatedAt: at(),
        connectionId,
        projectId: "p",
        destination: { provider: "github", repository: "example/repo", labels: [] },
    });
    const workflow = async (trigger: "created" | "resolved" = "created", creator = "owner") => {
        const id = crypto.randomUUID();
        await service.saveWorkflow({
            id,
            name: "Route bugs",
            workspaceId: "personal",
            creator,
            createdAt: at(),
            actionId,
            trigger,
            enabled: true,
            hourUtc: 9,
            delayHours: 24,
        });
        return id;
    };
    const insert = async (extra: Partial<ReturnType<typeof annotationFixture>> = {}) => {
        const n = annotationFixture({
            id: crypto.randomUUID(),
            projectId: "p",
            screenshots: undefined,
            ...extra,
        });
        await store.insertAnnotation(n);
        return n;
    };
    return {
        store,
        service,
        calls,
        connectionId,
        actionId,
        workflow,
        insert,
        fail(status: number) {
            response = status;
        },
        uncertain() {
            uncertain = true;
        },
        writes: () =>
            calls.filter((r) => r.method === "POST" && new URL(r.url).pathname.endsWith("/issues")),
    };
}
async function taggedSetup(plan: "plus" | "pro" = "plus") {
    const w = await setup(plan);
    await w.workflow();
    const workflow = (await w.store.plugins.workflows("personal"))[0];
    if (!workflow) throw new Error("missing workflow");
    await w.service.saveWorkflow({ ...workflow, tag: "triage", includePersonal: true });
    return w;
}
async function notificationWorkflow(
    w: Awaited<ReturnType<typeof setup>>,
    trigger: "daily_digest" | "unanswered"
) {
    const connectionId = await w.service.connect(
        "personal",
        {
            name: "Webhook",
            provider: "webhook",
            credential: "https://hooks.example.com/feedback",
            signingSecret: "synthetic-signing-secret-at-least-32-characters",
        },
        "owner"
    );
    const actionId = crypto.randomUUID();
    await w.service.saveAction({
        id: actionId,
        name: "Tagged notifications",
        creator: "owner",
        workspaceId: "personal",
        updatedAt: at(),
        connectionId,
        projectId: "p",
        destination: { provider: "webhook" },
    });
    const workflow: Workflow = {
        id: crypto.randomUUID(),
        name: "Tagged personal notifications",
        creator: "owner",
        workspaceId: "personal",
        createdAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
        actionId,
        enabled: true,
        trigger,
        hourUtc: 0,
        delayHours: 24,
        tag: "triage",
        includePersonal: true,
    };
    await w.service.saveWorkflow(workflow);
    return workflow;
}

it("normalizes reusable tags and matches complete hashtags only in the annotation comment", () => {
    const input = WorkflowEditInput.parse({
        name: "Triage",
        actionId: crypto.randomUUID(),
        trigger: "created",
        tag: " #TrIaGe ",
    });
    expect(input.tag).toBe("triage");
    for (const comment of [
        "#triage Fix this",
        "Fix this #TRIAGE.",
        "Fix (#triage)",
        "Fix\n#triage",
    ]) {
        expect(hasWorkflowTag(annotationFixture({ comment }), "triage")).toBe(true);
    }
    for (const comment of [
        "https://example.com/#triage",
        "#triage-more",
        "#triaged",
        "email#triage",
        "No tag",
    ]) {
        expect(hasWorkflowTag(annotationFixture({ comment }), "triage")).toBe(false);
    }
});
it("requires explicit consent and a tag for personal automation, without changing existing workflows", async () => {
    const w = await setup();
    await w.workflow();
    const workflow = (await w.store.plugins.workflows("personal"))[0];
    if (!workflow) throw new Error("missing workflow");
    await expect(w.service.saveWorkflow({ ...workflow, includePersonal: true })).rejects.toThrow(
        "tag"
    );
    await w.service.saveWorkflow({ ...workflow, tag: "triage" });
    await w.insert({ comment: "#triage Personal", visibility: "personal", createdBy: "owner" });
    await w.insert({ comment: "No tag", visibility: "shared" });
    await w.insert({ comment: "#triage Shared", visibility: "shared" });
    expect(await w.store.plugins.history("personal")).toHaveLength(1);
    await w.service.run();
    expect(w.writes()).toHaveLength(1);
});
it("preserves arrival-only behavior for existing workflows without tag filters", async () => {
    const w = await setup();
    await w.workflow();
    const workflow = (await w.store.plugins.workflows("personal"))[0];
    if (!workflow) throw new Error("missing workflow");
    await w.service.saveWorkflow({ ...workflow, severity: "blocker" });
    const note = await w.insert({ severity: "minor" });
    await w.store.updateAnnotation(note.id, (n) => ({ ...n, severity: "blocker" }));
    expect(await w.store.plugins.history("personal")).toHaveLength(0);
    await w.insert({ severity: "blocker" });
    expect(await w.store.plugins.history("personal")).toHaveLength(1);
});
it("routes only the creator’s tagged personal annotations and keeps delivery history private after deletion", async () => {
    const w = await taggedSetup("pro");
    await w.store.upsertUser({ username: "admin", passwordHash: "synthetic", createdAt: at() });
    await w.store.setMembership({
        workspaceId: "personal",
        username: "admin",
        role: "admin",
        createdAt: at(),
    });
    await w.insert({ comment: "#triage Other person", visibility: "personal", createdBy: "admin" });
    await w.insert({ comment: "#triage Missing owner", visibility: "personal" });
    await w.insert({
        comment: "#triage Hidden",
        visibility: "personal",
        createdBy: "owner",
        peopleOnly: true,
    });
    await w.insert({
        comment: "#triage Agent",
        visibility: "personal",
        createdBy: "owner",
        author: { kind: "agent", name: "agent" },
    });
    const note = await w.insert({
        comment: "#TRIAGE My feedback",
        visibility: "personal",
        createdBy: "owner",
    });
    const jobs = await w.store.plugins.history("personal", "owner");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.personalActor).toBe("owner");
    expect(await w.store.plugins.history("personal", "admin")).toHaveLength(0);
    const job = jobs[0];
    if (!job) throw new Error("missing job");
    expect(await w.store.plugins.job("personal", job.id, "admin")).toBeNull();
    expect(await w.store.plugins.cancel("personal", job.id, "admin")).toBe(false);
    await w.service.run();
    expect(w.writes()).toHaveLength(1);
    expect((await w.store.getAnnotation(note.id))?.annotation.visibility).toBe("personal");
    expect((await w.store.plugins.history("personal", "owner"))[0]?.status).toBe("succeeded");
    await w.store.deleteAnnotation(note.id);
    expect(await w.store.plugins.history("personal", "admin")).toHaveLength(0);
    expect((await w.store.plugins.history("personal", "owner"))[0]?.personalActor).toBe("owner");
});
it("queues newly tagged existing personal annotations once and stops sends after the tag is removed", async () => {
    const w = await taggedSetup();
    const n = await w.insert({
        comment: "Personal feedback",
        visibility: "personal",
        createdBy: "owner",
    });
    expect(await w.store.plugins.history("personal")).toHaveLength(0);
    await w.store.updateAnnotation(n.id, (note) => ({
        ...note,
        comment: `${note.comment} #triage`,
    }));
    await w.store.updateAnnotation(n.id, (note) => ({
        ...note,
        comment: `${note.comment} More detail`,
    }));
    expect(await w.store.plugins.history("personal")).toHaveLength(1);
    await w.store.updateAnnotation(n.id, (note) => ({
        ...note,
        comment: "Removed the routing tag",
    }));
    await w.service.run();
    expect(w.writes()).toHaveLength(0);
    expect((await w.store.plugins.history("personal"))[0]?.status).toBe("failed");
    await w.store.updateAnnotation(n.id, (note) => ({ ...note, comment: "#triage Added again" }));
    expect(await w.store.plugins.history("personal")).toHaveLength(1);
});
it("prevents another admin taking over personal routing while allowing them to pause it", async () => {
    const w = await taggedSetup("pro");
    await w.store.upsertUser({ username: "admin", passwordHash: "synthetic", createdAt: at() });
    await w.store.setMembership({
        workspaceId: "personal",
        username: "admin",
        role: "admin",
        createdAt: at(),
    });
    const workflow = (await w.store.plugins.workflows("personal"))[0];
    if (!workflow) throw new Error("missing workflow");
    await expect(
        w.service.saveWorkflow({ ...workflow, creator: "admin", tag: "steal" }, undefined, "admin")
    ).rejects.toThrow("creator");
    await w.service.saveWorkflow({ ...workflow, enabled: false }, workflow.updatedAt, "admin");
    const paused = (await w.store.plugins.workflows("personal"))[0];
    if (!paused) throw new Error("missing workflow");
    expect(paused.creator).toBe("owner");
    await expect(
        w.service.saveWorkflow({ ...paused, enabled: true }, paused.updatedAt, "admin")
    ).rejects.toThrow("creator");
});
it("revokes personal opt-in when action destinations or connection credentials are changed", async () => {
    const w = await taggedSetup();
    await w.insert({ comment: "#triage Personal", visibility: "personal", createdBy: "owner" });
    const action = await w.store.plugins.action("personal", w.actionId);
    if (!action) throw new Error("missing action");
    await w.service.editAction(
        "personal",
        w.actionId,
        {
            name: action.name,
            projectId: "p",
            connectionId: w.connectionId,
            destination: { provider: "github", repository: "example/other", labels: [] },
        },
        "owner"
    );
    const workflow = (await w.store.plugins.workflows("personal"))[0];
    if (!workflow) throw new Error("missing workflow");
    expect(workflow.includePersonal).toBe(false);
    expect((await w.store.plugins.history("personal"))[0]?.status).toBe("canceled");
    await w.service.saveWorkflow({ ...workflow, includePersonal: true }, workflow.updatedAt);
    const c = await w.store.plugins.connection("personal", w.connectionId);
    if (!c) throw new Error("missing connection");
    await w.service.connect(
        "personal",
        { name: c.name, provider: "github", credential: "replacement-synthetic-token" },
        "owner",
        { id: c.id, revision: c.revision }
    );
    expect((await w.store.plugins.workflows("personal"))[0]?.includePersonal).toBe(false);
    await w.service.run();
    expect(w.writes()).toHaveLength(0);
});
it("rechecks a personal annotation’s routing tag after credential lookup", async () => {
    const w = await taggedSetup();
    const note = await w.insert({
        comment: "#triage Personal",
        visibility: "personal",
        createdBy: "owner",
    });
    const secret = w.service.secret.bind(w.service);
    w.service.secret = async (c) => {
        await w.store.updateAnnotation(note.id, (n) => ({ ...n, comment: "Routing tag removed" }));
        return secret(c);
    };
    await w.service.run();
    expect(w.writes()).toHaveLength(0);
});
it("filters digests by tag and includes only explicitly opted-in personal feedback", async () => {
    const w = await setup();
    const workflow = await notificationWorkflow(w, "daily_digest");
    await w.insert({ comment: "#TRIAGE Shared digest item", visibility: "shared" });
    await w.insert({
        comment: "#triage My private digest item",
        visibility: "personal",
        createdBy: "owner",
    });
    await w.insert({
        comment: "#triage Foreign private digest item",
        visibility: "personal",
        createdBy: "someone-else",
    });
    await w.insert({
        comment: "https://example.com/#triage Wrong digest item",
        visibility: "shared",
    });
    await w.insert({ comment: "#triage-more Wrong prefix item", visibility: "shared" });
    expect(await w.store.plugins.digest("p", workflow)).toHaveLength(2);
    await w.store.plugins.scheduled(new Date());
    await w.service.run();
    const sent = w.calls.find(
        (r) => r.method === "POST" && r.url === "https://hooks.example.com/feedback"
    );
    const body = await sent?.text();
    expect(body).toContain("My private digest item");
    expect(body).toContain("Shared digest item");
    expect(body).not.toContain("Foreign private");
    expect(body).not.toContain("Wrong");
    expect(body).not.toContain("personalActor");
    expect((await w.store.plugins.history("personal", "owner"))[0]?.status).toBe("succeeded");
    expect(await w.store.plugins.history("personal", "someone-else")).toHaveLength(0);
});
it("filters unanswered reminders by tag and preserves personal ownership", async () => {
    const w = await setup();
    await notificationWorkflow(w, "unanswered");
    for (const [comment, createdBy] of [
        ["#triage My question", "owner"],
        ["#triage Foreign question", "other"],
        ["#triage-more Wrong tag", "owner"],
    ])
        await w.insert({
            comment,
            visibility: "personal",
            createdBy,
            status: "awaiting_response",
            awaitingResponse: { resumeStatus: "acknowledged" },
        });
    await w.store.plugins.db.query("UPDATE notato.annotations SET activity_received_at=$1", [
        new Date(Date.now() - 25 * 3600_000).toISOString(),
    ]);
    await w.store.plugins.scheduled(new Date());
    expect(await w.store.plugins.history("personal", "owner")).toHaveLength(1);
    await w.service.run();
    expect((await w.store.plugins.history("personal", "owner"))[0]?.status).toBe("succeeded");
    expect(await w.store.plugins.history("personal", "other")).toHaveLength(0);
});
it("keeps Plus individual, raises its allowance, and supports a base-only Stripe price", async () => {
    expect(planLimits({ id: "plus", extraSeats: 0 })).toMatchObject({
        projects: 5,
        notesPerMonth: 500,
        bytes: 1024 ** 3,
        tokens: 20,
        members: 1,
    });
    expect(() => planLimits({ id: "plus", extraSeats: 1 })).toThrow();
    const fetched: string[] = [];
    const b = new StripeBilling({
        key: "sk_test_fake",
        webhookSecret: "whsec_fake",
        origin: "https://notato.example",
        workspacePlans: true,
        plans: [{ id: "plus", priceId: "price_plus" }],
        fetcher: (async (url: URL | RequestInfo) => {
            fetched.push(String(url));
            return Response.json({
                active: true,
                livemode: false,
                billing_scheme: "per_unit",
                currency: "gbp",
                unit_amount: 300,
                recurring: { usage_type: "licensed", interval: "month", interval_count: 1 },
            });
        }) as typeof fetch,
    });
    expect((await b.pricing()).plus).toMatchObject({
        baseAmount: 300,
        seatAmount: 0,
        currency: "gbp",
    });
    expect(fetched).toHaveLength(1);
});
it("encrypts each credential with authenticated workspace and record scope", () => {
    const a = encrypt("secret", key, "workspace-a:record");
    expect(a).not.toContain("secret");
    expect(decrypt(a, key, "workspace-a:record")).toBe("secret");
    expect(() => decrypt(a, key, "workspace-b:record")).toThrow();
    expect(() => decrypt(a, Buffer.alloc(32, 8), "workspace-a:record")).toThrow();
    expect(encrypt("secret", key, "workspace-a:record")).not.toBe(a);
});
it("exports only explicit feedback fields and a protected backlink", () => {
    const n = annotationFixture({
        comment: "Fix this",
        context: { network: "private-diagnostics" },
        thread: [
            {
                id: "reply",
                createdAt: at(),
                author: { kind: "human", name: "Person" },
                body: "private-reply",
                peopleOnly: true,
            },
        ],
    });
    const p = JSON.stringify(notePayload(n, "https://notato.example"));
    expect(p).toContain("Fix this");
    for (const hidden of ["private-diagnostics", "private-reply", "screenshots", "references"])
        expect(p).not.toContain(hidden);
});
it("rejects private and special-use outbound addresses, IP URLs and credential-bearing URLs", () => {
    for (const ip of [
        "127.0.0.1",
        "10.1.2.3",
        "169.254.169.254",
        "100.64.0.1",
        "192.168.1.1",
        "::1",
        "::ffff:127.0.0.1",
        "fc00::1",
        "2001:db8::1",
        "2002:7f00:1::",
        "3fff::1",
    ])
        expect(publicAddress(ip)).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
    for (const url of [
        "http://example.com",
        "https://127.0.0.1",
        "https://user:pass@example.com",
        "https://example.com:8443",
    ])
        expect(() => outboundUrl(url)).toThrow();
});
describe("durable actions and workflows", () => {
    it("runs manually on Free, requires a current preview and deduplicates repeated submissions", async () => {
        const w = await setup("free");
        const n = await w.insert();
        const preview = await w.service.preview("personal", w.actionId, n.id);
        const requestId = crypto.randomUUID();
        const first = await w.service.enqueue(
            "personal",
            "owner",
            w.actionId,
            n.id,
            preview.hash,
            requestId
        );
        expect(
            await w.service.enqueue("personal", "owner", w.actionId, n.id, preview.hash, requestId)
        ).toBe(first);
        await expect(
            w.service.enqueue(
                "personal",
                "owner",
                w.actionId,
                n.id,
                "0".repeat(64),
                crypto.randomUUID()
            )
        ).rejects.toThrow("Preview");
        await w.service.run();
        await w.service.run();
        expect(w.writes()).toHaveLength(1);
        expect((await w.store.plugins.history("personal"))[0]?.status).toBe("succeeded");
        expect((await w.store.getAnnotation(n.id))?.annotation.links?.[0]?.url).toBe(
            "https://github.com/example/repo/issues/1"
        );
        expect(await w.store.plugins.usage("personal", at().slice(0, 7))).toBe(0);
    });
    it("does not send changed feedback after its manual preview was confirmed", async () => {
        const w = await setup("free");
        const n = await w.insert();
        const preview = await w.service.preview("personal", w.actionId, n.id);
        await w.service.enqueue(
            "personal",
            "owner",
            w.actionId,
            n.id,
            preview.hash,
            crypto.randomUUID()
        );
        await w.store.updateAnnotation(n.id, (a) => ({ ...a, comment: "Changed private details" }));
        await w.service.run();
        expect(w.writes()).toHaveLength(0);
        expect((await w.store.plugins.history("personal"))[0]?.status).toBe("review");
    });
    it("requires review if feedback becomes private after a manual send was confirmed", async () => {
        const w = await setup("free");
        const n = await w.insert();
        const preview = await w.service.preview("personal", w.actionId, n.id);
        await w.service.enqueue(
            "personal",
            "owner",
            w.actionId,
            n.id,
            preview.hash,
            crypto.randomUUID()
        );
        await w.store.updateAnnotation(n.id, (a) => ({ ...a, peopleOnly: true }));
        await w.service.run();
        expect(w.writes()).toHaveLength(0);
        expect((await w.store.plugins.history("personal"))[0]?.status).toBe("review");
    });
    it("retains a known result for review if recording a successful external create fails", async () => {
        const w = await setup();
        await w.workflow();
        await w.insert();
        const finish = w.store.plugins.finish.bind(w.store.plugins);
        let interrupted = false;
        w.store.plugins.finish = async (...args: Parameters<typeof finish>) => {
            if (args[1] === "succeeded" && !interrupted) {
                interrupted = true;
                throw new Error("Simulated database interruption");
            }
            await finish(...args);
        };
        await w.service.run();
        await w.service.run();
        expect(w.writes()).toHaveLength(1);
        expect((await w.store.plugins.history("personal"))[0]).toMatchObject({
            status: "review",
            result: { url: "https://github.com/example/repo/issues/1" },
        });
        expect(await w.store.plugins.usage("personal", at().slice(0, 7))).toBe(0);
    });
    it("commits feedback and matching workflow jobs together and meters success once", async () => {
        const w = await setup();
        await w.workflow();
        const n = await w.insert();
        expect(await w.store.plugins.history("personal")).toHaveLength(1);
        await expect(w.store.insertAnnotation(n)).rejects.toThrow();
        expect(await w.store.plugins.history("personal")).toHaveLength(1);
        await w.service.run();
        await w.service.run();
        expect(w.writes()).toHaveLength(1);
        expect(await w.store.plugins.usage("personal", at().slice(0, 7))).toBe(1);
    });
    it("excludes private feedback and rechecks visibility at execution time", async () => {
        const w = await setup();
        await w.workflow();
        await w.insert({ peopleOnly: true });
        expect(await w.store.plugins.history("personal")).toHaveLength(0);
        const n = await w.insert();
        await w.store.updateAnnotation(n.id, (a) => ({ ...a, peopleOnly: true }));
        await w.service.run();
        expect(w.writes()).toHaveLength(0);
    });
    it("queues a blocker-only workflow when a matching personal note is shared, once", async () => {
        const w = await setup();
        await w.workflow();
        const workflow = (await w.store.plugins.workflows("personal"))[0];
        if (!workflow) throw new Error("missing workflow");
        await w.service.saveWorkflow({ ...workflow, severity: "blocker" });
        await w.insert({ visibility: "shared", severity: "minor" });
        const note = await w.insert({
            visibility: "personal",
            createdBy: "owner",
            severity: "blocker",
        });
        expect(await w.store.plugins.history("personal")).toHaveLength(0);
        await w.store.updateAnnotation(note.id, (n) => ({ ...n, visibility: "shared" }));
        expect(await w.store.plugins.history("personal")).toHaveLength(1);
        await w.store.updateAnnotation(note.id, (n) => ({ ...n, visibility: "personal" }));
        await w.store.updateAnnotation(note.id, (n) => ({ ...n, visibility: "shared" }));
        expect(await w.store.plugins.history("personal")).toHaveLength(1);
        await w.service.run();
        expect(w.writes()).toHaveLength(1);
        expect((await w.store.plugins.history("personal"))[0]?.status).toBe("succeeded");
    });
    it("enforces the Plus workflow limit while allowing workflows to be paused", async () => {
        const w = await setup();
        const ids = [];
        for (let i = 0; i < 3; i++) ids.push(await w.workflow());
        await expect(w.workflow()).rejects.toThrow("allowance");
        const workflow = (await w.store.plugins.workflows("personal"))[0];
        if (!workflow) throw new Error("missing workflow");
        await w.service.saveWorkflow({ ...workflow, enabled: false });
        await w.workflow();
        expect((await w.store.plugins.workflows("personal")).filter((w) => w.enabled)).toHaveLength(
            3
        );
    });
    it("pauses automatic work at its quota while leaving manual actions available", async () => {
        const w = await setup();
        await w.workflow();
        await w.store.plugins.db.query("INSERT INTO notato.plugin_usage VALUES ($1,$2,250)", [
            "personal",
            at().slice(0, 7),
        ]);
        const n = await w.insert();
        await w.service.run();
        expect(w.writes()).toHaveLength(0);
        expect((await w.store.plugins.history("personal"))[0]?.status).toBe("paused");
        const p = await w.service.preview("personal", w.actionId, n.id);
        await w.service.enqueue("personal", "owner", w.actionId, n.id, p.hash, crypto.randomUUID());
        await w.service.run();
        expect(w.writes()).toHaveLength(1);
        expect(await w.store.plugins.usage("personal", at().slice(0, 7))).toBe(250);
    });
    it("rechecks workspace roles and connection revocation before dispatch", async () => {
        const w = await setup("pro");
        await w.store.upsertUser({ username: "admin", passwordHash: "synthetic", createdAt: at() });
        await w.store.setMembership({
            workspaceId: "personal",
            username: "admin",
            role: "admin",
            createdAt: at(),
        });
        const id = await w.workflow("created", "admin");
        const workflow = (await w.store.plugins.workflows("personal")).find((w) => w.id === id);
        if (!workflow) throw new Error("missing");
        await w.insert();
        await w.store.removeMembership("personal", "admin");
        await w.service.run();
        expect(w.writes()).toHaveLength(0);
        const n = await w.insert();
        const preview = await w.service.preview("personal", w.actionId, n.id);
        await w.service.enqueue(
            "personal",
            "owner",
            w.actionId,
            n.id,
            preview.hash,
            crypto.randomUUID()
        );
        const c = await w.store.plugins.connection("personal", w.connectionId);
        if (!c) throw new Error("missing");
        await w.store.plugins.saveConnection({ ...c, revoked: true, encrypted: "" });
        await w.service.run();
        expect(w.writes()).toHaveLength(0);
    });
    it("keeps uncertain creates for human review and retries only definite rate-limit refusals", async () => {
        const w = await setup();
        await w.workflow();
        await w.insert();
        w.uncertain();
        await w.service.run();
        await w.service.run(new Date(Date.now() + 3600_000));
        expect(w.writes()).toHaveLength(1);
        expect((await w.store.plugins.history("personal"))[0]?.status).toBe("review");
        expect(await w.store.plugins.usage("personal", at().slice(0, 7))).toBe(0);
        const retry = await setup();
        await retry.workflow();
        await retry.insert();
        retry.fail(429);
        await retry.service.run();
        expect((await retry.store.plugins.history("personal"))[0]?.status).toBe("queued");
        retry.fail(201);
        await retry.service.run(new Date(Date.now() + 3600_000));
        expect(retry.writes()).toHaveLength(2);
        expect(await retry.store.plugins.usage("personal", at().slice(0, 7))).toBe(1);
    });
    it("isolates actions and credentials by workspace and cascades project deletion", async () => {
        const w = await setup();
        expect(await w.store.plugins.connection("other", w.connectionId)).toBeNull();
        await expect(w.service.preview("other", w.actionId, "note")).rejects.toThrow("unavailable");
        await w.workflow();
        await w.insert();
        await w.store.deleteProject("p");
        expect(await w.store.plugins.actions("personal")).toEqual([]);
        expect(await w.store.plugins.history("personal")).toEqual([]);
    });
    it("shares a workspace connection while keeping each action limited to its chosen project", async () => {
        const w = await setup();
        await w.store.createProject({
            id: "q",
            name: "Marketing",
            workspaceId: "personal",
            createdAt: at(),
        });
        const a = await w.store.plugins.action("personal", w.actionId);
        if (!a) throw new Error("missing action");
        const other = crypto.randomUUID();
        await w.service.saveAction({
            ...a,
            id: other,
            name: "Marketing issue",
            projectId: "q",
            destination: { provider: "github", repository: "example/marketing", labels: [] },
        });
        const first = await w.insert(),
            second = await w.insert({ projectId: "q" });
        await expect(w.service.preview("personal", w.actionId, second.id)).rejects.toThrow(
            "unavailable"
        );
        await expect(w.service.preview("personal", other, first.id)).rejects.toThrow("unavailable");
        for (const [action, note] of [
            [w.actionId, first.id],
            [other, second.id],
        ] as const) {
            const p = await w.service.preview("personal", action, note);
            await w.service.enqueue("personal", "owner", action, note, p.hash, crypto.randomUUID());
        }
        await w.service.run();
        expect(await w.store.plugins.connections("personal")).toHaveLength(1);
        expect(
            w
                .writes()
                .map((r) => r.url)
                .sort()
        ).toEqual([
            "https://api.github.com/repos/example/marketing/issues",
            "https://api.github.com/repos/example/repo/issues",
        ]);
    });
});
describe("provider contracts", () => {
    const destinations: Destination[] = [
        { provider: "github", repository: "example/repo", labels: ["bug"] },
        { provider: "azure", organization: "example", project: "Web App", workItemType: "Bug" },
        { provider: "teams" },
        { provider: "slack", channel: "C123456789" },
        { provider: "webhook" },
        { provider: "linear", team: crypto.randomUUID(), labels: [] },
        { provider: "gitlab", project: "example/repo", labels: ["bug"] },
    ];
    for (const destination of destinations)
        it(`sends the ${destination.provider} contract without diagnostics`, async () => {
            const calls: Request[] = [];
            const p = new Providers(async (url, init) => {
                const r = new Request(url, init);
                calls.push(r);
                if (destination.provider === "github")
                    return Response.json({
                        html_url: "https://github.com/example/repo/issues/1",
                        number: 1,
                    });
                if (destination.provider === "azure")
                    return Response.json({
                        id: 1,
                        _links: {
                            html: {
                                href: "https://dev.azure.com/example/Web%20App/_workitems/edit/1",
                            },
                        },
                    });
                if (destination.provider === "gitlab")
                    return Response.json({
                        iid: 1,
                        web_url: "https://gitlab.com/example/repo/-/issues/1",
                    });
                if (destination.provider === "linear")
                    return Response.json({
                        data: {
                            issueCreate: {
                                success: true,
                                issue: {
                                    url: "https://linear.app/example/issue/WEB-1/fix",
                                    identifier: "WEB-1",
                                },
                            },
                        },
                    });
                if (destination.provider === "slack") return Response.json({ ok: true, ts: "1.2" });
                return new Response(null, { status: 204 });
            });
            const op = crypto.randomUUID();
            await p.execute(
                destination,
                {
                    token:
                        destination.provider === "webhook" || destination.provider === "teams"
                            ? "https://hooks.example.com/feedback"
                            : "private-token",
                    refreshToken: "signing-secret-32-characters-long",
                },
                payload,
                op
            );
            expect(calls).toHaveLength(1);
            const req = calls[0];
            if (!req) throw new Error("missing request");
            const body = await req.text();
            expect(body).not.toContain("private-token");
            expect(body).toContain("Button is broken");
            expect(req.redirect).toBe("manual");
            if (destination.provider === "webhook") {
                const timestamp = req.headers.get("x-notato-timestamp");
                expect(req.headers.get("x-notato-signature")).toBe(
                    `sha256=${createHmac("sha256", "signing-secret-32-characters-long").update(`${timestamp}.${body}`).digest("hex")}`
                );
            }
            if (destination.provider === "azure")
                expect(req.headers.get("content-type")).toBe("application/json-patch+json");
        });
    it("does not retry an ambiguous server error or trust provider error bodies", async () => {
        const p = new Providers(
            async () => new Response("secret-provider-details", { status: 500 })
        );
        try {
            await p.execute(
                destinations[0] as Destination,
                { token: "secret" },
                payload,
                crypto.randomUUID()
            );
            throw new Error("expected failure");
        } catch (e) {
            expect(e).toBeInstanceOf(ProviderError);
            expect((e as ProviderError).disposition).toBe("review");
            expect((e as Error).message).not.toContain("secret-provider-details");
        }
    });
    it("verifies existing issue links against their configured destination", async () => {
        const p = new Providers(async () =>
            Response.json({ number: 4, html_url: "https://github.com/example/repo/issues/4" })
        );
        await expect(
            p.link(
                destinations[0] as Destination,
                { token: "secret" },
                "https://github.com/other/repo/issues/4"
            )
        ).rejects.toThrow("repository");
        expect(
            await p.link(
                destinations[0] as Destination,
                { token: "secret" },
                "https://github.com/example/repo/issues/4"
            )
        ).toMatchObject({ reference: "4" });
    });
});
it("uses PKCE for Entra authorization and keeps exchanged credentials server-side", async () => {
    const names = ["NOTATO_AZURE_CLIENT_ID", "NOTATO_AZURE_CLIENT_SECRET"] as const;
    const saved = names.map((n) => process.env[n]);
    process.env.NOTATO_AZURE_CLIENT_ID = "test-client";
    process.env.NOTATO_AZURE_CLIENT_SECRET = "test-secret";
    try {
        const started = oauthAuthorize(
            "azure",
            "https://notato.example/plugins/oauth/callback",
            "random-state"
        );
        const url = new URL(started.url);
        expect(url.hostname).toBe("login.microsoftonline.com");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.href).not.toContain("test-secret");
        const secret = await oauthToken(
            "azure",
            {
                grant_type: "authorization_code",
                code: "single-use-code",
                code_verifier: started.verifier,
            },
            async (_url, init) => {
                expect(String(init?.body)).toContain("code_verifier=");
                return Response.json({
                    access_token: "opaque-provider-token",
                    refresh_token: "opaque-refresh-token",
                    expires_in: 3600,
                });
            }
        );
        expect(secret.oauth).toBe(true);
        expect(secret.refreshToken).toBe("opaque-refresh-token");
    } finally {
        names.forEach((n, i) => {
            if (saved[i] === undefined) delete process.env[n];
            else process.env[n] = saved[i];
        });
    }
});

it("upgrades an existing version-16 plan constraint without losing its records", async () => {
    const fixture = await embeddedPostgres();
    defer(() => fixture.database.close());
    await fixture.pg.exec(
        "ALTER TABLE notato.workspace_plans DROP CONSTRAINT workspace_plans_plan_check; ALTER TABLE notato.workspace_plans ADD CONSTRAINT workspace_plans_plan_check CHECK (plan IN ('free','pro','team')); UPDATE notato.meta SET value='16' WHERE key='schema_version'"
    );
    const store = await PostgresStore.open(fixture.database);
    store.setHostedLimits(HOSTED_LIMITS);
    store.setTestPlans(true);
    await store.upsertUser({ username: "upgrade", passwordHash: "synthetic", createdAt: at() });
    await store.createWorkspace({ id: "upgrade", name: "Upgrade", createdAt: at() }, "upgrade", {
        id: "plus",
        extraSeats: 0,
    });
    expect((await store.getWorkspacePlan("upgrade"))?.id).toBe("plus");
    const schema = await fixture.pg.query<{ value: string }>(
        "SELECT value FROM notato.meta WHERE key='schema_version'"
    );
    expect(schema.rows[0]?.value).toBe("20");
    const security = await fixture.pg.query<{ relrowsecurity: boolean }>(
        "SELECT relrowsecurity FROM pg_class WHERE oid='notato.plugin_connections'::regclass"
    );
    expect(security.rows[0]?.relrowsecurity).toBe(true);
});
it("cannot restore a revoked credential through a late token refresh or rename", async () => {
    const w = await setup();
    const c = await w.store.plugins.connection("personal", w.connectionId);
    if (!c) throw new Error("missing connection");
    await w.store.plugins.renameConnection("personal", c.id, "Kept name", "owner");
    expect(await w.store.plugins.rotateConnection(c, c.encrypted)).toBe(true);
    expect((await w.store.plugins.connection("personal", c.id))?.name).toBe("Kept name");
    await w.store.plugins.saveConnection({ ...c, revoked: true, encrypted: "" }, "owner");
    expect(await w.store.plugins.rotateConnection(c, "late-refresh")).toBe(false);
    await w.store.plugins.renameConnection("personal", c.id, "Renamed", "owner");
    expect(await w.store.plugins.connection("personal", c.id)).toMatchObject({
        revoked: true,
        encrypted: "",
        name: "Renamed",
    });
});
it("binds OAuth state to the initiating workspace and account, and consumes it once", async () => {
    const w = await setup();
    await w.store.plugins.oauthState("state", "personal", "owner", "github", "encrypted-verifier");
    expect(await w.store.plugins.consumeOAuth("state", "other", "owner")).toBeNull();
    expect(await w.store.plugins.consumeOAuth("state", "personal", "different")).toBeNull();
    expect(await w.store.plugins.consumeOAuth("state", "personal", "owner")).toMatchObject({
        provider: "github",
    });
    expect(await w.store.plugins.consumeOAuth("state", "personal", "owner")).toBeNull();
});
it("rechecks manager authority after provider verification before saving a connection", async () => {
    const w = await setup("pro");
    await w.store.upsertUser({ username: "admin", passwordHash: "synthetic", createdAt: at() });
    await w.store.setMembership({
        workspaceId: "personal",
        username: "admin",
        role: "admin",
        createdAt: at(),
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
    });
    const pending = new Promise<void>((r) => {
        release = r;
    });
    w.service.providers.verify = async () => {
        entered();
        await pending;
    };
    const connecting = w.service.connect(
        "personal",
        { name: "Late connection", provider: "github", credential: "test-only" },
        "admin"
    );
    await started;
    await w.store.removeMembership("personal", "admin");
    release();
    await expect(connecting).rejects.toThrow("owner or admin");
    expect(await w.store.plugins.connections("personal")).toHaveLength(1);
});
it("pauses old workflows after downgrade and archives actions without removing existing note links", async () => {
    const w = await setup();
    await w.workflow();
    await w.insert();
    await w.store.selectWorkspacePlan("personal", "owner", "free", 0);
    await w.service.run();
    expect(w.writes()).toHaveLength(0);
    expect((await w.store.plugins.history("personal"))[0]?.status).toBe("paused");
    await w.store.plugins.archiveAction("personal", w.actionId, "owner");
    expect((await w.store.plugins.history("personal"))[0]?.status).toBe("canceled");
    expect((await w.store.plugins.workflows("personal"))[0]?.enabled).toBe(false);
});
it("records confirmed deliveries once without repeating the external create", async () => {
    const w = await setup();
    await w.workflow();
    await w.insert();
    w.uncertain();
    await w.service.run();
    const j = (await w.store.plugins.history("personal"))[0];
    if (!j) throw new Error("missing delivery");
    await w.service.review("personal", j.id, true, "https://github.com/example/repo/issues/1");
    expect((await w.store.plugins.history("personal"))[0]?.status).toBe("succeeded");
    expect(await w.store.plugins.usage("personal", at().slice(0, 7))).toBe(1);
    await expect(
        w.service.review("personal", j.id, true, "https://github.com/example/repo/issues/1")
    ).rejects.toThrow("no longer");
    expect(w.writes()).toHaveLength(1);
});
it("retains interrupted deliveries for review rather than replaying them after restart", async () => {
    const w = await setup();
    await w.workflow();
    await w.insert();
    expect(await w.store.plugins.claim(at())).not.toBeNull();
    expect(await w.store.plugins.claim(new Date(Date.now() + 121_000).toISOString())).toBeNull();
    expect((await w.store.plugins.history("personal"))[0]?.status).toBe("review");
    await w.service.run();
    expect(w.writes()).toHaveLength(0);
});
it("distinguishes repeated status transitions from duplicate feedback submissions", async () => {
    const w = await setup();
    await w.workflow("resolved");
    const n = await w.insert();
    await w.store.updateAnnotation(n.id, (a) => ({ ...a, status: "resolved" }));
    await w.store.updateAnnotation(n.id, (a) => ({ ...a, status: "acknowledged" }));
    await w.store.updateAnnotation(n.id, (a) => ({ ...a, status: "resolved" }));
    expect(await w.store.plugins.history("personal")).toHaveLength(2);
});
it("queues daily digests once and excludes private feedback from their payloads", async () => {
    const w = await setup();
    const connectionId = await w.service.connect(
        "personal",
        {
            name: "Webhook",
            provider: "webhook",
            credential: "https://hooks.example.com/feedback",
            signingSecret: "test-signing-secret-at-least-32-characters",
        },
        "owner"
    );
    const actionId = crypto.randomUUID();
    await w.service.saveAction({
        id: actionId,
        name: "Digest",
        creator: "owner",
        workspaceId: "personal",
        updatedAt: at(),
        connectionId,
        projectId: "p",
        destination: { provider: "webhook" },
    });
    const workflowId = crypto.randomUUID();
    await w.service.saveWorkflow({
        id: workflowId,
        name: "Daily digest",
        creator: "owner",
        workspaceId: "personal",
        createdAt: at(),
        actionId,
        enabled: true,
        trigger: "daily_digest",
        hourUtc: 0,
        delayHours: 24,
    });
    await w.insert({ comment: "Public digest feedback" });
    await w.insert({ comment: "private-digest-content", peopleOnly: true });
    await w.store.plugins.scheduled(new Date());
    await w.store.plugins.scheduled(new Date());
    expect(await w.store.plugins.history("personal")).toHaveLength(1);
    await w.service.run();
    const sent = w.calls.find(
        (r) => r.method === "POST" && r.url === "https://hooks.example.com/feedback"
    );
    expect(sent).toBeDefined();
    const body = await sent?.text();
    expect(body).toContain("Public digest feedback");
    expect(body).not.toContain("private-digest-content");
});
it("does not widen a GitHub App installation beyond the connecting user's repositories", async () => {
    const p = new Providers(async () => {
        throw new Error("No request should be sent.");
    });
    await expect(
        p.execute(
            { provider: "github", repository: "example/private-other", labels: [] },
            { token: "", installationId: "123", repositories: ["example/allowed"] },
            payload,
            crypto.randomUUID()
        )
    ).rejects.toThrow("not authorized");
});
it("schedules unanswered reminders once per inactivity period and rechecks recent replies before sending", async () => {
    const w = await setup();
    const connectionId = await w.service.connect(
        "personal",
        {
            name: "Webhook",
            provider: "webhook",
            credential: "https://hooks.example.com/feedback",
            signingSecret: "synthetic-signing-secret-at-least-32-characters",
        },
        "owner"
    );
    const actionId = crypto.randomUUID();
    await w.service.saveAction({
        id: actionId,
        name: "Reminder",
        creator: "owner",
        workspaceId: "personal",
        updatedAt: at(),
        connectionId,
        projectId: "p",
        destination: { provider: "webhook" },
    });
    await w.service.saveWorkflow({
        id: crypto.randomUUID(),
        name: "Unanswered",
        creator: "owner",
        workspaceId: "personal",
        createdAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
        actionId,
        enabled: true,
        trigger: "unanswered",
        hourUtc: 0,
        delayHours: 24,
    });
    const n = await w.insert({
        status: "awaiting_response",
        awaitingResponse: { resumeStatus: "acknowledged" },
    });
    await w.insert({
        peopleOnly: true,
        status: "awaiting_response",
        awaitingResponse: { resumeStatus: "acknowledged" },
    });
    await w.store.plugins.db.query(
        "UPDATE notato.annotations SET activity_received_at=$1 WHERE project_id='p'",
        [new Date(Date.now() - 25 * 3600_000).toISOString()]
    );
    await w.store.plugins.scheduled(new Date());
    await w.store.plugins.scheduled(new Date());
    expect(await w.store.plugins.history("personal")).toHaveLength(1);
    await w.store.updateAnnotation(n.id, (a) => ({
        ...a,
        thread: [
            ...(a.thread ?? []),
            {
                id: "answer",
                createdAt: at(),
                author: { kind: "human", name: "Owner" },
                body: "Please clarify this part.",
            },
        ],
    }));
    await w.service.run();
    expect(w.calls.filter((r) => r.method === "POST")).toHaveLength(0);
    expect((await w.store.plugins.history("personal"))[0]?.status).toBe("failed");
    await w.store.plugins.db.query(
        "UPDATE notato.annotations SET activity_received_at=$1 WHERE id=$2",
        [new Date(Date.now() - 24.5 * 3600_000).toISOString(), n.id]
    );
    await w.store.plugins.scheduled(new Date());
    expect(await w.store.plugins.history("personal")).toHaveLength(2);
    await w.service.run();
    expect(w.calls.filter((r) => r.method === "POST")).toHaveLength(1);
});
it("moves a workflow's project trigger when its saved action is changed", async () => {
    const w = await setup();
    const workflowId = await w.workflow();
    await w.store.createProject({
        id: "q",
        name: "Other project",
        workspaceId: "personal",
        createdAt: at(),
    });
    const action = await w.store.plugins.action("personal", w.actionId);
    const workflow = (await w.store.plugins.workflows("personal")).find((w) => w.id === workflowId);
    if (!action || !workflow) throw new Error("missing action/workflow");
    const actionId = crypto.randomUUID();
    await w.service.saveAction({ ...action, id: actionId, projectId: "q" });
    await w.service.saveWorkflow({ ...workflow, actionId });
    await w.insert();
    expect(await w.store.plugins.history("personal")).toHaveLength(0);
    await w.insert({ projectId: "q" });
    expect(await w.store.plugins.history("personal")).toHaveLength(1);
});
it("edits an action in place, preserves its workflows and history, and cancels old queued approvals", async () => {
    const w = await setup();
    const workflowId = await w.workflow();
    const n = await w.insert();
    const approved = await w.service.preview("personal", w.actionId, n.id);
    await w.service.enqueue(
        "personal",
        "owner",
        w.actionId,
        n.id,
        approved.hash,
        crypto.randomUUID()
    );
    const original = await w.store.plugins.action("personal", w.actionId);
    if (!original) throw new Error("missing action");
    const input = {
        name: "Send triaged bugs",
        connectionId: w.connectionId,
        projectId: "p",
        destination: {
            provider: "github" as const,
            repository: "example/new-repo",
            labels: ["bug"],
        },
        expectedUpdatedAt: original.updatedAt,
    };
    await w.service.editAction("personal", w.actionId, input, "owner");
    const saved = await w.store.plugins.action("personal", w.actionId);
    expect(saved).toMatchObject({
        id: original.id,
        creator: original.creator,
        name: input.name,
        destination: input.destination,
    });
    expect((await w.store.plugins.workflows("personal"))[0]?.id).toBe(workflowId);
    expect((await w.store.plugins.history("personal")).every((j) => j.status === "canceled")).toBe(
        true
    );
    await expect(
        w.service.enqueue("personal", "owner", w.actionId, n.id, approved.hash, crypto.randomUUID())
    ).rejects.toThrow("Preview");
    await expect(
        w.store.plugins.enqueue({
            workspace: "personal",
            action: w.actionId,
            actor: "owner",
            note: n.id,
            operation: "stale-edit-race",
            expectedAction: original,
        })
    ).rejects.toThrow("Preview");
    await expect(w.service.editAction("personal", w.actionId, input, "owner")).rejects.toThrow(
        "changed"
    );
    await w.service.run();
    expect(w.writes()).toHaveLength(0);
    await w.store.createProject({
        id: "q",
        name: "Another project",
        workspaceId: "personal",
        createdAt: at(),
    });
    if (!saved) throw new Error("missing saved action");
    await w.service.editAction(
        "personal",
        w.actionId,
        { ...input, projectId: "q", expectedUpdatedAt: saved.updatedAt },
        "owner"
    );
    await w.insert();
    const next = await w.insert({ projectId: "q" });
    const queued = (await w.store.plugins.history("personal")).filter((j) => j.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.noteId).toBe(next.id);
});

it("blocks action edits during an uncertain delivery and rejects members, foreign projects and archived actions", async () => {
    const w = await setup("pro");
    const original = await w.store.plugins.action("personal", w.actionId);
    if (!original) throw new Error("missing action");
    const input = {
        name: "Edited",
        connectionId: w.connectionId,
        projectId: "p",
        destination: original.destination,
    };
    await w.store.upsertUser({ username: "member", passwordHash: "synthetic", createdAt: at() });
    await w.store.setMembership({
        workspaceId: "personal",
        username: "member",
        role: "member",
        createdAt: at(),
    });
    await expect(w.service.editAction("personal", w.actionId, input, "member")).rejects.toThrow(
        "owner or admin"
    );
    await expect(
        w.service.editAction("personal", w.actionId, { ...input, projectId: "missing" }, "owner")
    ).rejects.toThrow("project");
    await expect(w.service.editAction("other", w.actionId, input, "owner")).rejects.toThrow(
        "not found"
    );
    const n = await w.insert();
    const approved = await w.service.preview("personal", w.actionId, n.id);
    await w.service.enqueue(
        "personal",
        "owner",
        w.actionId,
        n.id,
        approved.hash,
        crypto.randomUUID()
    );
    w.uncertain();
    await w.service.run();
    expect((await w.store.plugins.history("personal"))[0]?.status).toBe("review");
    await expect(w.service.editAction("personal", w.actionId, input, "owner")).rejects.toThrow(
        "in-flight"
    );
    expect(await w.store.plugins.action("personal", w.actionId)).toEqual(original);
    await w.store.plugins.archiveAction("personal", w.actionId, "owner");
    await expect(w.service.editAction("personal", w.actionId, input, "owner")).rejects.toThrow(
        "not found"
    );
});

it("keeps digest workflows on notification destinations when their action is edited", async () => {
    const w = await setup();
    const original = await w.store.plugins.action("personal", w.actionId);
    if (!original) throw new Error("missing action");
    const connectionId = await w.service.connect(
        "personal",
        {
            name: "Webhook",
            provider: "webhook",
            credential: "https://hooks.example.com/feedback",
            signingSecret: "synthetic-signing-secret-at-least-32-characters",
        },
        "owner"
    );
    await w.service.editAction(
        "personal",
        w.actionId,
        {
            name: "Notify",
            projectId: "p",
            connectionId,
            destination: { provider: "webhook" },
        },
        "owner"
    );
    await w.workflow();
    const workflow = (await w.store.plugins.workflows("personal"))[0];
    if (!workflow) throw new Error("missing workflow");
    await w.service.saveWorkflow({ ...workflow, trigger: "daily_digest" });
    const input = {
        name: "Create issue",
        projectId: "p",
        connectionId: w.connectionId,
        destination: original.destination,
    };
    await expect(w.service.editAction("personal", w.actionId, input, "owner")).rejects.toThrow(
        "Pause"
    );
    await w.service.saveWorkflow({ ...workflow, trigger: "daily_digest", enabled: false });
    await w.service.editAction("personal", w.actionId, input, "owner");
    expect((await w.store.plugins.action("personal", w.actionId))?.destination.provider).toBe(
        "github"
    );
    await expect(
        w.store.plugins.saveWorkflow({ ...workflow, trigger: "daily_digest", enabled: true }, 3)
    ).rejects.toThrow("notification");
});

it("edits workflow filters and action while keeping paused state, creation time and history", async () => {
    const w = await setup();
    const id = await w.workflow();
    const original = (await w.store.plugins.workflows("personal"))[0];
    if (!original) throw new Error("missing workflow");
    await w.insert();
    await w.service.saveWorkflow(
        {
            ...original,
            name: "Resolve major bugs",
            trigger: "resolved",
            severity: "major",
            intent: "fix",
            enabled: false,
        },
        original.updatedAt
    );
    const paused = (await w.store.plugins.workflows("personal"))[0];
    expect(paused).toMatchObject({
        id,
        createdAt: original.createdAt,
        enabled: false,
        trigger: "resolved",
        severity: "major",
        intent: "fix",
    });
    expect((await w.store.plugins.history("personal"))[0]?.status).toBe("canceled");
    await expect(w.service.saveWorkflow(original, original.updatedAt)).rejects.toThrow("changed");
    expect(
        await w.store.plugins.enqueue({
            workspace: "personal",
            action: w.actionId,
            workflow: id,
            actor: "owner",
            note: null,
            operation: "stale-workflow-race",
            expectedWorkflow: original,
        })
    ).toBeUndefined();
    if (!paused) throw new Error("missing paused workflow");
    await w.service.saveWorkflow({ ...paused, enabled: true }, paused.updatedAt);
    await w.insert({ severity: "minor" });
    expect(
        (await w.store.plugins.history("personal")).filter((j) => j.status === "queued")
    ).toHaveLength(0);
    const n = await w.insert({ severity: "major", intent: "fix" });
    await w.store.updateAnnotation(n.id, (a) => ({ ...a, status: "resolved" }));
    expect(
        (await w.store.plugins.history("personal")).filter((j) => j.status === "queued")
    ).toHaveLength(1);
});
it("reconnects in place and preserves actions/workflows while requiring fresh approval for queued manual sends", async () => {
    const w = await setup();
    const n = await w.insert();
    const p = await w.service.preview("personal", w.actionId, n.id);
    await w.service.enqueue("personal", "owner", w.actionId, n.id, p.hash, crypto.randomUUID());
    await w.workflow();
    const old = await w.store.plugins.connection("personal", w.connectionId);
    if (!old) throw new Error("missing connection");
    await w.service.connect(
        "personal",
        { name: "Ignored rename", provider: "github", credential: "replacement-synthetic-token" },
        "owner",
        { id: old.id, revision: old.revision }
    );
    const next = await w.store.plugins.connection("personal", old.id);
    expect(next?.name).toBe(old.name);
    expect(next?.revision).not.toBe(old.revision);
    expect(await w.store.plugins.connections("personal")).toHaveLength(1);
    expect(await w.store.plugins.actions("personal")).toHaveLength(1);
    expect(await w.store.plugins.workflows("personal")).toHaveLength(1);
    await w.service.run();
    expect(w.writes()).toHaveLength(0);
    expect((await w.store.plugins.history("personal"))[0]?.status).toBe("review");
    const approved = await w.service.preview("personal", w.actionId, n.id);
    await w.service.enqueue(
        "personal",
        "owner",
        w.actionId,
        n.id,
        approved.hash,
        crypto.randomUUID()
    );
    await w.service.run();
    expect(w.writes()).toHaveLength(1);
});
it("does not restore a connection revoked while reconnect authorization was pending", async () => {
    const w = await setup();
    const old = await w.store.plugins.connection("personal", w.connectionId);
    if (!old) throw new Error("missing connection");
    await w.store.plugins.saveConnection(
        { ...old, revoked: true, encrypted: "", revision: crypto.randomUUID() },
        "owner"
    );
    await expect(
        w.service.connectOAuth(
            "personal",
            "github",
            { token: "late-synthetic-token", oauth: true },
            "owner",
            { id: old.id, revision: old.revision }
        )
    ).rejects.toThrow("changed");
    expect((await w.store.plugins.connection("personal", old.id))?.encrypted).toBe("");
    await w.store.plugins.connectionHealth(old, {
        status: "ready",
        checkedAt: at(),
        message: "Late check",
    });
    expect((await w.store.plugins.connection("personal", old.id))?.health).toBeUndefined();
});
it("checks provider access without creating issues and keeps failures safe", async () => {
    const w = await setup();
    w.service.providers.destinations = async () => [{ id: "example/repo", name: "example/repo" }];
    expect((await w.service.checkConnection("personal", w.connectionId)).status).toBe("ready");
    expect(w.writes()).toHaveLength(0);
    w.service.providers.verify = async () => {
        throw new ProviderError("failed", "private-provider-details", 401);
    };
    const failed = await w.service.checkConnection("personal", w.connectionId);
    expect(failed.status).toBe("attention");
    expect(failed.message).not.toContain("private-provider-details");
});
it("does not send test webhooks when checking endpoint configuration", async () => {
    const w = await setup();
    const id = await w.service.connect(
        "personal",
        {
            name: "Webhook",
            provider: "webhook",
            credential: "https://hooks.example.com/feedback",
            signingSecret: "synthetic-signing-secret-at-least-32-characters",
        },
        "owner"
    );
    const before = w.calls.length;
    expect((await w.service.checkConnection("personal", id)).status).toBe("unchecked");
    expect(w.calls.length).toBe(before);
});
it("checks persisted GitHub installation access without reusing the discarded user token", async () => {
    const w = await setup();
    const c = await w.store.plugins.connection("personal", w.connectionId);
    if (!c) throw new Error("missing connection");
    await w.store.plugins.saveConnection(
        {
            ...c,
            encrypted: encrypt(
                JSON.stringify({
                    token: "",
                    installationId: "123",
                    repositories: ["example/repo"],
                }),
                key,
                `${c.workspaceId}:${c.provider}:${c.id}`
            ),
        },
        "owner"
    );
    w.service.providers.verify = async () => {
        throw new Error("The verifying user's token was discarded.");
    };
    w.service.providers.destinations = async (_provider, secret) => {
        expect(secret.installationId).toBe("123");
        return [{ id: "example/repo", name: "example/repo" }];
    };
    expect((await w.service.checkConnection("personal", c.id)).status).toBe("ready");
});
it("marks connection access as needing attention after a provider denies a delivery", async () => {
    const w = await setup();
    const n = await w.insert();
    const p = await w.service.preview("personal", w.actionId, n.id);
    await w.service.enqueue("personal", "owner", w.actionId, n.id, p.hash, crypto.randomUUID());
    w.fail(401);
    await w.service.run();
    expect((await w.store.plugins.connection("personal", w.connectionId))?.health?.status).toBe(
        "attention"
    );
});
