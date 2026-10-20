import { expect, it } from "bun:test";
import { Providers } from "../src/plugins/providers.ts";
import { pluginsFor } from "../src/routes/plugins.ts";
import { annotationFixture, cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { issue, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
const at = () => new Date().toISOString();
it("keeps tagged personal routing and history bound to the creator across the HTTP API", async () => {
    const options = {
        key: Buffer.alloc(32, 9),
        providers: new Providers(async () => Response.json({ id: 1 })),
    };
    const s = await startServe(defer, {
        managedAuth: fakeManagedAuth(),
        testPlans: true,
        plugins: options,
    });
    const alice = await customer(s, "alice"),
        bob = await customer(s, "bob");
    const board = {
        cookie: alice.cookie,
        "content-type": "application/json",
        "x-notato-board": "1",
    };
    const me = (await (await s.call("/auth/me", { headers: board })).json()) as {
        username: string;
        workspace: { id: string };
    };
    const other = (await (
        await s.call("/auth/me", { headers: { cookie: bob.cookie } })
    ).json()) as { username: string };
    await s.rt.store.selectWorkspacePlan(me.workspace.id, me.username, "pro", 0);
    await s.rt.store.setMembership({
        workspaceId: me.workspace.id,
        username: other.username,
        role: "admin",
        createdAt: at(),
    });
    const switchWorkspace = await s.call("/auth/workspace", {
        method: "POST",
        headers: { ...board, cookie: bob.cookie },
        body: JSON.stringify({ workspaceId: me.workspace.id }),
    });
    const bobBoard = {
        ...board,
        cookie: switchWorkspace.headers.get("set-cookie")?.split(";")[0] ?? bob.cookie,
    };
    await s.rt.store.createProject({
        id: "tagged-project",
        name: "Tagged project",
        workspaceId: me.workspace.id,
        createdAt: at(),
    });
    const service = pluginsFor(s.rt.backend, "https://notato.example", options);
    const connectionId = await service.connect(
        me.workspace.id,
        { name: "GitHub", provider: "github", credential: "synthetic-provider-token" },
        me.username
    );
    const actionId = crypto.randomUUID();
    await service.saveAction({
        id: actionId,
        name: "Create issue",
        creator: me.username,
        workspaceId: me.workspace.id,
        updatedAt: at(),
        connectionId,
        projectId: "tagged-project",
        destination: { provider: "github", repository: "example/repo", labels: [] },
    });
    const workflow = {
        name: "Tagged personal feedback",
        actionId,
        trigger: "created",
        enabled: true,
        includePersonal: true,
        tag: "#TrIaGe",
    };
    const create = (body: unknown) =>
        s.call("/plugins/workflows", {
            method: "POST",
            headers: board,
            body: JSON.stringify(body),
        });
    expect((await create({ ...workflow, tag: undefined })).status).toBe(400);
    const created = await create(workflow);
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const saved = (await s.rt.store.plugins?.workflows(me.workspace.id))?.find((w) => w.id === id);
    expect(saved?.tag).toBe("triage");
    const note = annotationFixture({
        id: crypto.randomUUID(),
        projectId: "tagged-project",
        screenshots: undefined,
        comment: "#triage My personal feedback",
        visibility: "personal",
        createdBy: me.username,
    });
    await s.rt.store.insertAnnotation(note);
    const own = await (await s.call("/plugins", { headers: board })).json();
    const theirs = await (await s.call("/plugins", { headers: bobBoard })).json();
    expect(own.history).toHaveLength(1);
    expect(theirs.history).toHaveLength(0);
    expect(own.history[0]).not.toHaveProperty("payload");
    const jobId = own.history[0].id;
    expect(
        (
            await s.call(`/plugins/jobs/${jobId}/cancel`, {
                method: "POST",
                headers: bobBoard,
                body: "{}",
            })
        ).status
    ).toBe(404);
    expect(
        (
            await s.call(`/plugins/jobs/${jobId}/review`, {
                method: "POST",
                headers: bobBoard,
                body: JSON.stringify({ delivered: false, confirmed: true }),
            })
        ).status
    ).toBe(404);
    expect(
        (
            await s.call(`/plugins/workflows/${id}`, {
                method: "POST",
                headers: bobBoard,
                body: JSON.stringify({
                    ...workflow,
                    tag: "steal",
                    expectedUpdatedAt: saved?.updatedAt,
                }),
            })
        ).status
    ).toBe(403);
    expect(
        (
            await s.call(`/plugins/workflows/${id}`, {
                method: "POST",
                headers: bobBoard,
                body: JSON.stringify({
                    ...workflow,
                    enabled: false,
                    expectedUpdatedAt: saved?.updatedAt,
                }),
            })
        ).status
    ).toBe(200);
    expect(
        (await s.rt.store.plugins?.workflows(me.workspace.id))?.find((w) => w.id === id)?.creator
    ).toBe(me.username);
    const conditions = {
        match: "any",
        rules: [
            { field: "visibility", value: "shared" },
            { field: "tag", value: "#XYZ" },
        ],
    };
    const grouped = await s.call(`/plugins/workflows/${id}`, {
        method: "POST",
        headers: board,
        body: JSON.stringify({ ...workflow, tag: undefined, conditions }),
    });
    expect(grouped.status).toBe(200);
    const withRules = (await s.rt.store.plugins?.workflows(me.workspace.id))?.find(
        (w) => w.id === id
    );
    expect(withRules?.conditions).toEqual({
        match: "any",
        rules: [
            { field: "visibility", value: "shared" },
            { field: "tag", value: "xyz" },
        ],
    });
    expect(
        (
            await s.call(`/plugins/workflows/${id}`, {
                method: "POST",
                headers: board,
                body: JSON.stringify(workflow),
            })
        ).status
    ).toBe(409);
    expect(
        (
            await s.call(`/plugins/workflows/${id}`, {
                method: "POST",
                headers: bobBoard,
                body: JSON.stringify({ ...workflow, tag: undefined, conditions, name: "Hijacked" }),
            })
        ).status
    ).toBe(403);
});
it("serves the full manual-action API on Free without exposing credentials or crossing workspaces", async () => {
    const providers = new Providers(async (url, init) =>
        new URL(url).pathname.endsWith("/issues") && init?.method === "POST"
            ? Response.json({ html_url: "https://github.com/example/repo/issues/1", number: 1 })
            : Response.json({ id: 1 })
    );
    const pluginOptions = { key: Buffer.alloc(32, 9), providers };
    const s = await startServe(defer, {
        managedAuth: fakeManagedAuth(),
        testPlans: true,
        plugins: pluginOptions,
    });
    const alice = await customer(s, "alice"),
        bob = await customer(s, "bob");
    const board = {
        cookie: alice.cookie,
        "content-type": "application/json",
        "x-notato-board": "1",
    };
    const me = (await (await s.call("/auth/me", { headers: board })).json()) as {
        workspace: { id: string };
    };
    await s.rt.store.createProject({
        id: "p",
        name: "Project",
        workspaceId: me.workspace.id,
        createdAt: at(),
    });
    const n = annotationFixture({
        id: crypto.randomUUID(),
        projectId: "p",
        screenshots: undefined,
    });
    await s.rt.store.insertAnnotation(n);
    const connect = await s.call("/plugins/connections", {
        method: "POST",
        headers: board,
        body: JSON.stringify({
            name: "GitHub",
            provider: "github",
            credential: "private-scoped-provider-token",
        }),
    });
    expect(connect.status).toBe(201);
    const connection = (await connect.json()) as { id: string };
    const action = await s.call("/plugins/actions", {
        method: "POST",
        headers: board,
        body: JSON.stringify({
            name: "Create issue",
            connectionId: connection.id,
            projectId: "p",
            destination: { provider: "github", repository: "example/repo", labels: [] },
        }),
    });
    expect(action.status).toBe(201);
    const { id: actionId } = (await action.json()) as { id: string };
    const listing = await s.call("/plugins", { headers: board });
    expect(listing.status).toBe(200);
    const text = await listing.text();
    expect(text).not.toContain("private-scoped-provider-token");
    expect(text).not.toContain('"encrypted"');
    expect(JSON.parse(text).limits.workflows).toBe(0);
    const original = JSON.parse(text).actions[0];
    const edit = {
        name: "Create triaged issue",
        connectionId: connection.id,
        projectId: "p",
        destination: { provider: "github", repository: "example/repo", labels: ["triage"] },
        expectedUpdatedAt: original.updatedAt,
    };
    expect(
        (
            await s.call(`/plugins/actions/${actionId}`, {
                method: "PATCH",
                headers: { ...board, cookie: bob.cookie },
                body: JSON.stringify(edit),
            })
        ).status
    ).toBe(404);
    expect(
        (
            await s.call(`/plugins/actions/${actionId}`, {
                method: "PATCH",
                headers: board,
                body: JSON.stringify({ ...edit, creator: "someone-else" }),
            })
        ).status
    ).toBe(400);
    expect(
        (
            await s.call(`/plugins/actions/${actionId}`, {
                method: "PATCH",
                headers: { ...board, origin: "https://foreign.example" },
                body: JSON.stringify(edit),
            })
        ).status
    ).toBe(403);
    expect(
        (
            await s.call(`/plugins/actions/${actionId}`, {
                method: "PATCH",
                headers: board,
                body: JSON.stringify(edit),
            })
        ).status
    ).toBe(200);
    const edited = await s.rt.store.plugins?.action(me.workspace.id, actionId);
    expect(edited).toMatchObject({
        id: actionId,
        name: edit.name,
        creator: original.creator,
        destination: edit.destination,
    });
    expect(edited?.updatedAt).not.toBe(original.updatedAt);
    expect(
        (
            await s.call(`/plugins/actions/${actionId}`, {
                method: "PATCH",
                headers: board,
                body: JSON.stringify(edit),
            })
        ).status
    ).toBe(409);
    const preview = await s.call("/plugins/preview", {
        method: "POST",
        headers: board,
        body: JSON.stringify({ actionId, noteId: n.id }),
    });
    expect(preview.status).toBe(200);
    const value = (await preview.json()) as { hash: string };
    const run = await s.call("/plugins/run", {
        method: "POST",
        headers: board,
        body: JSON.stringify({
            actionId,
            noteId: n.id,
            hash: value.hash,
            requestId: crypto.randomUUID(),
        }),
    });
    expect(run.status).toBe(202);
    await pluginsFor(s.rt.backend, s.base, pluginOptions).run();
    expect((await s.rt.store.getAnnotation(n.id))?.annotation.links).toHaveLength(1);
    const forbidden = await s.call("/plugins/workflows", {
        method: "POST",
        headers: board,
        body: JSON.stringify({ name: "Automatic", actionId, trigger: "created" }),
    });
    expect(forbidden.status).toBe(400);
    await s.rt.store.selectWorkspacePlan(me.workspace.id, original.creator, "plus", 0);
    const madeWorkflow = await s.call("/plugins/workflows", {
        method: "POST",
        headers: board,
        body: JSON.stringify({ name: "New bugs", actionId, trigger: "created" }),
    });
    expect(madeWorkflow.status).toBe(201);
    const workflowId = ((await madeWorkflow.json()) as { id: string }).id;
    const workflow = (await s.rt.store.plugins?.workflows(me.workspace.id))?.find(
        (w) => w.id === workflowId
    );
    if (!workflow) throw new Error("Workflow missing");
    const workflowEdit = {
        name: "Resolved major fixes",
        actionId,
        trigger: "resolved",
        severity: "major",
        intent: "fix",
        hourUtc: 18,
        delayHours: 48,
        enabled: false,
        expectedUpdatedAt: workflow.updatedAt,
    };
    expect(
        (
            await s.call(`/plugins/workflows/${workflowId}`, {
                method: "POST",
                headers: { ...board, cookie: bob.cookie },
                body: JSON.stringify(workflowEdit),
            })
        ).status
    ).toBe(404);
    expect(
        (
            await s.call(`/plugins/workflows/${workflowId}`, {
                method: "POST",
                headers: board,
                body: JSON.stringify(workflowEdit),
            })
        ).status
    ).toBe(200);
    expect(
        (await s.rt.store.plugins?.workflows(me.workspace.id))?.find((w) => w.id === workflowId)
    ).toMatchObject({
        id: workflowId,
        name: workflowEdit.name,
        enabled: false,
        createdAt: workflow.createdAt,
        trigger: "resolved",
        severity: "major",
        intent: "fix",
        hourUtc: 18,
        delayHours: 48,
    });
    expect(
        (
            await s.call(`/plugins/workflows/${workflowId}`, {
                method: "POST",
                headers: board,
                body: JSON.stringify(workflowEdit),
            })
        ).status
    ).toBe(409);
    expect(
        (
            await s.call("/plugins/connections", {
                method: "POST",
                headers: { ...board, origin: "https://foreign.example" },
                body: JSON.stringify({
                    name: "Bad",
                    provider: "github",
                    credential: "private-token",
                }),
            })
        ).status
    ).toBe(403);
    const other = await s.call("/plugins/preview", {
        method: "POST",
        headers: { ...board, cookie: bob.cookie },
        body: JSON.stringify({ actionId, noteId: n.id }),
    });
    expect(other.status).toBe(400);
    expect(await other.text()).not.toContain(n.comment);
    expect(
        (
            await s.call(`/plugins/connections/${connection.id}/check`, {
                method: "POST",
                headers: board,
            })
        ).status
    ).toBe(200);
    expect(
        (
            await s.call(`/plugins/connections/${connection.id}/check`, {
                method: "POST",
                headers: { ...board, cookie: bob.cookie },
            })
        ).status
    ).toBe(404);
    const replacement = await s.call(`/plugins/connections/${connection.id}/reconnect`, {
        method: "POST",
        headers: board,
        body: JSON.stringify({
            name: "Ignored",
            provider: "github",
            credential: "synthetic-replacement-token",
        }),
    });
    expect(replacement.status).toBe(200);
    expect(((await replacement.json()) as { id: string }).id).toBe(connection.id);
    const after = await (await s.call("/plugins", { headers: board })).text();
    expect(after).not.toContain("synthetic-replacement-token");
    expect(
        (
            await s.call(`/plugins/connections/${connection.id}/reconnect`, {
                method: "POST",
                headers: board,
                body: JSON.stringify({
                    name: "Wrong provider",
                    provider: "gitlab",
                    credential: "synthetic-token",
                }),
            })
        ).status
    ).toBe(400);
    const token = await issue(s, "p");
    expect(
        (await s.call("/plugins", { headers: { authorization: `Bearer ${token}` } })).status
    ).toBe(403);
});

it("lets a current owner read and export retained feedback during payment recovery", async () => {
    const s = await startServe(defer, { managedAuth: fakeManagedAuth(), workspacePlans: true });
    const alice = await customer(s, "alice"),
        bob = await customer(s, "bob");
    const board = {
        cookie: alice.cookie,
        "content-type": "application/json",
        "x-notato-board": "1",
    };
    const a = (await (await s.call("/auth/me", { headers: board })).json()) as {
        workspace: { id: string };
        username: string;
    };
    const b = (await (await s.call("/auth/me", { headers: { cookie: bob.cookie } })).json()) as {
        workspace: { id: string };
    };
    await s.rt.store.createProject({
        id: "p",
        name: "Retained",
        workspaceId: a.workspace.id,
        createdAt: at(),
    });
    await s.rt.store.createProject({
        id: "other",
        name: "Other",
        workspaceId: b.workspace.id,
        createdAt: at(),
    });
    const n = annotationFixture({
        id: crypto.randomUUID(),
        projectId: "p",
        screenshots: undefined,
    });
    await s.rt.store.insertAnnotation(n);
    await s.rt.store.setBillingCustomer(a.workspace.id, "cus_recovery");
    await s.rt.store.applyBillingEvent(
        "evt_canceled",
        {
            workspaceId: a.workspace.id,
            customerId: "cus_recovery",
            subscriptionId: "sub_recovery",
            plan: "plus",
            status: "canceled",
        },
        at()
    );
    expect((await s.call("/projects/p/annotations", { headers: board })).status).toBe(402);
    const read = await s.call("/billing/recovery/projects/p/notes", { headers: board });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain(n.comment);
    const zip = await s.call("/billing/recovery/projects/p/export", { headers: board });
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect((await zip.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(
        (await s.call("/billing/recovery/projects/other/notes", { headers: board })).status
    ).toBe(404);
    expect(
        (await s.call("/billing/recovery/projects/p/notes", { headers: { cookie: bob.cookie } }))
            .status
    ).toBe(404);
});
