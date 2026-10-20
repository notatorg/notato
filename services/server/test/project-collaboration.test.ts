import { expect, it } from "bun:test";
import type { Annotation } from "@notato/schema";
import { annotationFixture, cleanupAfterEach, multipart } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
async function setup() {
    const server = await startServe(defer, { managedAuth: fakeManagedAuth(), testPlans: true });
    const alice = await customer(server, "alice"),
        bob = await customer(server, "bob");
    const me = async (cookie: string) =>
        (await (await server.call("/auth/me", { headers: { cookie } })).json()) as {
            username: string;
            workspace: { id: string };
        };
    const a = await me(alice.cookie),
        b = await me(bob.cookie);
    await server.rt.store.selectWorkspacePlan(a.workspace.id, a.username, "team", 0);
    const api = (
        path: string,
        body?: unknown,
        cookie = alice.cookie,
        method = body === undefined ? "GET" : "POST"
    ) =>
        server.call(path, {
            method,
            headers: { cookie, "x-notato-board": "1", "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const response = await api("/projects", { name: "Checkout", agent: true });
    expect(response.status).toBe(201);
    const project = (await response.json()) as {
        project: { id: string };
        token: { token: string };
        agentToken: { token: string };
    };
    const capture = async (token: string, over: Partial<Annotation> = {}) => {
        const note = annotationFixture({
            projectId: project.project.id,
            mode: "dev",
            screenshots: undefined,
            ...over,
        });
        const response = await server.call("/projects/" + project.project.id + "/annotations", {
            method: "POST",
            headers: { Authorization: "Bearer " + token },
            body: multipart(note, new Map()),
        });
        expect(response.status).toBe(201);
        return (await response.json()).annotation as Annotation;
    };
    return { server, alice, bob, a, b, api, project, capture };
}
it("invites a collaborator to one project, preserves personal feedback and revokes removed project access", async () => {
    const t = await setup(),
        id = t.project.project.id;
    await t.server.rt.store.createProject({
        id: "legacy-team-project",
        name: "Legacy",
        workspaceId: t.a.workspace.id,
        createdAt: new Date().toISOString(),
    });
    const personal = await t.capture(t.project.token.token, { comment: "Alice private" });
    const shared = await t.capture(t.project.token.token, {
        comment: "Shared QA feedback",
        visibility: "shared",
    });
    const invitation = await t.api("/projects/" + id + "/invitations", {
        email: "bob@example.com",
    });
    expect(invitation.status).toBe(201);
    const token = new URL((await invitation.json()).url).searchParams.get("invite")!;
    expect((await t.api("/invitations/" + token + "/accept", {}, t.bob.cookie)).status).toBe(200);
    const members = await (await t.api(`/projects/${id}/members`)).json();
    expect(members.labels).toMatchObject({
        [t.a.username]: { name: "alice" },
        [t.b.username]: { name: "bob" },
    });
    expect(members.labels[t.a.username]).not.toHaveProperty("email");
    expect((await t.api(`/projects/${id}/members`, { username: "bob@example.com" })).status).toBe(
        200
    );
    expect(
        (await (await t.api("/projects", undefined, t.bob.cookie)).json()).items.map(
            (project: { id: string }) => project.id
        )
    ).toEqual([id]);
    expect((await t.api("/annotations/" + personal.id, undefined, t.bob.cookie)).status).toBe(404);
    expect((await t.api("/annotations/" + shared.id, undefined, t.bob.cookie)).status).toBe(200);
    const key = await t.api(
        "/tokens",
        {
            projectId: id,
            name: "Bob app",
            purpose: "app",
            ownership: "user",
            permission: "full",
            expiresInDays: 30,
        },
        t.bob.cookie
    );
    expect(key.status).toBe(201);
    const bobNote = await t.capture((await key.json()).token, { comment: "Bob private" });
    expect(bobNote.createdBy).toBe(t.b.username);
    expect((await t.api("/annotations/" + bobNote.id)).status).toBe(404);
    expect(
        (
            await t.api(
                "/projects/" + id + "/members/" + t.b.username,
                undefined,
                t.alice.cookie,
                "DELETE"
            )
        ).status
    ).toBe(204);
    expect((await t.api("/annotations/" + bobNote.id, undefined, t.bob.cookie)).status).toBe(403);
    expect((await t.server.rt.store.getAnnotation(bobNote.id))?.annotation.visibility).toBe(
        "personal"
    );
});
it("moves a project and its history to a team without sharing private feedback or retaining old credentials", async () => {
    const t = await setup(),
        id = t.project.project.id;
    const personal = await t.capture(t.project.token.token, {
        comment: "Keep private after transfer",
    });
    const shared = await t.capture(t.project.token.token, {
        visibility: "shared",
        comment: "Team feedback",
    });
    const sessionResponse = await t.api("/projects/" + id + "/review-sessions", {
        name: "Private review",
        description: "Personal focus",
    });
    const session = (await sessionResponse.json()).session;
    await t.api("/review-sessions/" + session.id + "/annotations", { ids: [personal.id] });
    await t.server.rt.store.selectWorkspacePlan(t.b.workspace.id, t.b.username, "team", 0);
    await t.server.rt.store.setMembership({
        workspaceId: t.b.workspace.id,
        username: t.a.username,
        role: "admin",
        createdAt: new Date().toISOString(),
    });
    const db = t.server.rt.store.plugins!.db;
    await db.query(
        "INSERT INTO notato.plugin_connections (id,workspace_id,json) VALUES ('transfer-connection',$1,'{}')",
        [t.a.workspace.id]
    );
    await db.query(
        "INSERT INTO notato.plugin_actions (id,workspace_id,connection_id,project_id,json) VALUES ('transfer-action',$1,'transfer-connection',$2,'{}')",
        [t.a.workspace.id, id]
    );
    await db.query(
        "INSERT INTO notato.plugin_workflows (id,workspace_id,action_id,json) VALUES ('transfer-workflow',$1,'transfer-action',$2)",
        [t.a.workspace.id, JSON.stringify({ enabled: true })]
    );
    await db.query(
        "INSERT INTO notato.plugin_jobs (id,operation,workspace_id,action_id,actor,status,created_at,next_at,payload) VALUES ('transfer-job','transfer-job',$1,'transfer-action',$2,'running',$3,$4,'{}')",
        [t.a.workspace.id, t.a.username, new Date().toISOString(), "2100-01-01T00:00:00Z"]
    );
    expect(
        (await t.api("/projects/" + id + "/transfer", { workspaceId: t.b.workspace.id })).status
    ).toBe(409);
    expect((await t.server.rt.store.getProject(id))?.workspaceId).toBe(t.a.workspace.id);
    await db.query("UPDATE notato.plugin_jobs SET status='queued' WHERE id='transfer-job'");
    await db.query(
        "INSERT INTO notato.plugin_jobs (id,operation,workspace_id,action_id,actor,status,created_at,next_at,payload) VALUES ('transfer-private-job','transfer-private-job',$1,'transfer-action',$2,'queued',$3,$3,$4)",
        [
            t.a.workspace.id,
            t.a.username,
            new Date().toISOString(),
            JSON.stringify({
                personalActor: t.a.username,
                content: { text: "private outbound content" },
            }),
        ]
    );
    const moved = await t.api("/projects/" + id + "/transfer", { workspaceId: t.b.workspace.id });
    expect(moved.status).toBe(200);
    expect(
        (
            await db.query<{ status: string; payload: unknown }>(
                "SELECT status,payload FROM notato.plugin_jobs WHERE id='transfer-job'"
            )
        )[0]
    ).toMatchObject({ status: "canceled", payload: null });
    const privateJob = (
        await db.query<{ payload: string }>(
            "SELECT payload FROM notato.plugin_jobs WHERE id='transfer-private-job'"
        )
    )[0];
    expect(JSON.parse(privateJob?.payload ?? "{}")).toEqual({ personalActor: t.a.username });
    expect(
        await t.server.rt.store.plugins?.job(t.a.workspace.id, "transfer-private-job", t.b.username)
    ).toBeNull();
    expect(
        JSON.parse(
            (
                await db.query<{ json: string }>(
                    "SELECT json FROM notato.plugin_workflows WHERE id='transfer-workflow'"
                )
            )[0]!.json
        ).enabled
    ).toBe(false);
    expect(
        JSON.parse(
            (
                await db.query<{ json: string }>(
                    "SELECT json FROM notato.plugin_actions WHERE id='transfer-action'"
                )
            )[0]!.json
        ).archived
    ).toBe(true);
    expect((await t.server.rt.store.getProject(id))?.workspaceId).toBe(t.b.workspace.id);
    expect(
        (
            await t.server.call("/config", {
                headers: { Authorization: "Bearer " + t.project.token.token },
            })
        ).status
    ).toBe(401);
    expect((await t.api("/annotations/" + personal.id, undefined, t.bob.cookie)).status).toBe(404);
    expect((await t.api("/annotations/" + shared.id, undefined, t.bob.cookie)).status).toBe(200);
    await t.api("/auth/workspace", { workspaceId: t.b.workspace.id });
    expect((await t.api("/annotations/" + personal.id)).status).toBe(200);
    expect((await t.api("/review-sessions/" + session.id)).status).toBe(200);
    expect((await t.api("/review-sessions/" + session.id, undefined, t.bob.cookie)).status).toBe(
        404
    );
    expect((await t.server.rt.store.getAnnotation(personal.id))?.annotation).toMatchObject({
        createdBy: t.a.username,
        visibility: "personal",
    });
});
it("refuses transfers without destination management rights and leaves ownership and credentials intact", async () => {
    const t = await setup(),
        id = t.project.project.id;
    expect(
        (await t.api("/projects/" + id + "/transfer", { workspaceId: t.b.workspace.id })).status
    ).toBe(403);
    expect((await t.server.rt.store.getProject(id))?.workspaceId).toBe(t.a.workspace.id);
    expect(
        (
            await t.server.call("/config", {
                headers: { Authorization: "Bearer " + t.project.token.token },
            })
        ).status
    ).toBe(200);
});
