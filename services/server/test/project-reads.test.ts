import { describe, expect, it } from "bun:test";
import { annotationFixture, cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { adminCookie, bearer, issue, post, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();

describe("project read state", () => {
    it("uses the current account, rejects tokens, unknown fields, future markers and foreign origins", async () => {
        const s = await startServe(defer);
        const token = await issue(s, "notes");
        const { res } = await post(s, token, "notes", { visibility: "shared" });
        expect(res.status).toBe(201);
        const cookie = await adminCookie(s);
        const projects = async (headers: Record<string, string>) =>
            (await (await s.call("/projects", { headers })).json()) as {
                items: Array<{
                    id: string;
                    lastActivityAt: string;
                    readAt?: string;
                    unread?: number;
                }>;
            };
        const project = (await projects({ cookie })).items.find((p) => p.id === "notes");
        if (!project) throw new Error("missing project");
        expect(project.unread).toBe(1);
        const save = (body: unknown, headers: Record<string, string> = { cookie }, id = "notes") =>
            s.call(`/projects/${id}/read`, {
                method: "PUT",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify(body),
            });
        expect((await save({ at: project.lastActivityAt }, bearer(token))).status).toBe(403);
        expect((await save({ at: project.lastActivityAt }, {})).status).toBe(401);
        expect((await save({ at: project.lastActivityAt, username: "someone-else" })).status).toBe(
            400
        );
        expect((await save({ at: "9999-01-01T00:00:00.000Z" })).status).toBe(400);
        expect((await save({ at: "garbage" })).status).toBe(400);
        expect(
            (await save({ at: project.lastActivityAt }, { cookie, origin: "http://other.example" }))
                .status
        ).toBe(403);
        expect((await save({ at: project.lastActivityAt }, { cookie }, "missing")).status).toBe(
            404
        );
        expect((await save({ at: project.lastActivityAt })).status).toBe(200);
        // A different session/browser for the same account sees the saved visit.
        const secondCookie = await adminCookie(s);
        const seen = (await projects({ cookie: secondCookie })).items.find((p) => p.id === "notes");
        expect(seen?.readAt).toBe(project.lastActivityAt);
        expect(seen?.unread).toBe(0);
        expect((await projects(bearer(token))).items[0]?.unread).toBeUndefined();
    });

    it("allows workspace members to save their own visits without crossing workspace boundaries", async () => {
        const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const bob = await customer(s, "bob");
        const me = (await (
            await s.call("/auth/me", { headers: { cookie: alice.cookie } })
        ).json()) as {
            username: string;
            workspace: { id: string };
        };
        await s.rt.backend.createWorkspaceProject("alice-notes", "Alice notes", me.workspace.id);
        await s.rt.backend.ingest(
            annotationFixture({ projectId: "alice-notes", screenshots: undefined }),
            new Map()
        );
        const project = (await s.rt.store.listProjects(me.workspace.id))[0];
        if (!project) throw new Error("missing project");
        const save = (cookie: string) =>
            s.call("/projects/alice-notes/read", {
                method: "PUT",
                headers: { cookie, "content-type": "application/json", "X-Notato-Board": "1" },
                body: JSON.stringify({ at: project.lastActivityAt }),
            });
        expect((await save(bob.cookie)).status).toBe(403);
        const bobMe = (await (
            await s.call("/auth/me", { headers: { cookie: bob.cookie } })
        ).json()) as { username: string };
        await s.rt.store.setMembership({
            username: bobMe.username,
            workspaceId: me.workspace.id,
            role: "member",
            createdAt: new Date().toISOString(),
        });
        const selection = await s.call("/auth/workspace", {
            method: "POST",
            headers: {
                cookie: bob.cookie,
                "content-type": "application/json",
                "X-Notato-Board": "1",
            },
            body: JSON.stringify({ workspaceId: me.workspace.id }),
        });
        expect(selection.status).toBe(200);
        expect((await save(bob.cookie)).status).toBe(200);
        expect((await s.rt.store.listProjects(me.workspace.id, bobMe.username))[0]?.unread).toBe(0);
        expect((await s.rt.store.listProjects(me.workspace.id, me.username))[0]?.unread).toBe(1);
    });
});
