import { describe, expect, it } from "bun:test";
import { cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { embeddedPostgres } from "./postgres.ts";
import { type Server, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
const write = (cookie: string, body: unknown, method = "POST"): RequestInit => ({
    method,
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
});
type Invite = { invitation: { id: string; workspaceId: string; tokenHash?: string }; url: string };
async function invite(s: Server, cookie: string, email: string, role = "member") {
    const response = await s.call("/workspace/invitations", write(cookie, { email, role }));
    expect(response.status).toBe(201);
    const result = (await response.json()) as Invite;
    expect(result.invitation.tokenHash).toBeUndefined();
    return { ...result, secret: new URL(result.url).searchParams.get("invite") as string };
}
async function setup() {
    const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
    const alice = await customer(s, "alice");
    const bob = await customer(s, "bob");
    const carol = await customer(s, "carol");
    return { s, alice, bob, carol };
}

describe("self-service teams", () => {
    it("redeems invitations once, only for the verified email, and switches to the invited workspace", async () => {
        const { s, alice, bob, carol } = await setup();
        const invited = await invite(s, alice.cookie, "Bob@Example.com");
        const publicInvite = await s.call(`/invitations/${invited.secret}`);
        expect(publicInvite.status).toBe(200);
        expect(await publicInvite.json()).toMatchObject({
            email: "bob@example.com",
            role: "member",
        });
        expect(
            (await s.call(`/invitations/${invited.secret}/accept`, write(carol.cookie, {}))).status
        ).toBe(403);
        expect(
            (await s.call(`/invitations/${invited.secret}/accept`, write(bob.cookie, {}))).status
        ).toBe(200);
        expect(
            (await s.call(`/invitations/${invited.secret}/accept`, write(bob.cookie, {}))).status
        ).toBe(404);
        const me = (await (
            await s.call("/auth/me", { headers: { cookie: bob.cookie } })
        ).json()) as { workspace: { id: string; role: string }; workspaces: unknown[] };
        expect(me.workspace).toMatchObject({ id: invited.invitation.workspaceId, role: "member" });
        expect(me.workspaces).toHaveLength(2);
        const list = (await (
            await s.call("/workspace", { headers: { cookie: alice.cookie } })
        ).json()) as { members: { name: string; passwordHash?: string }[] };
        expect(list.members.map((m) => m.name).sort()).toEqual(["alice", "bob"]);
        expect(JSON.stringify(list)).not.toContain("passwordHash");
        expect(
            (
                await s.call(
                    "/workspace/invitations",
                    write(bob.cookie, { email: "carol@example.com" })
                )
            ).status
        ).toBe(403);
    });

    it("prevents admins promoting themselves, and keeps an owner when members are changed", async () => {
        const { s, alice, bob } = await setup();
        const invited = await invite(s, alice.cookie, "bob@example.com", "admin");
        await s.call(`/invitations/${invited.secret}/accept`, write(bob.cookie, {}));
        const getMe = async (cookie: string) =>
            (await (await s.call("/auth/me", { headers: { cookie } })).json()) as {
                username: string;
                workspace: { id: string };
            };
        const a = await getMe(alice.cookie);
        const b = await getMe(bob.cookie);
        expect(
            (
                await s.call(
                    `/workspace/members/${b.username}`,
                    write(bob.cookie, { role: "owner" }, "PATCH")
                )
            ).status
        ).toBe(403);
        expect(
            (
                await s.call(`/workspace/members/${a.username}`, {
                    method: "DELETE",
                    headers: { cookie: bob.cookie },
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call(`/workspace/members/${a.username}`, {
                    method: "DELETE",
                    headers: { cookie: alice.cookie },
                })
            ).status
        ).toBe(409);
        expect(
            (
                await s.call(
                    `/workspace/members/${a.username}`,
                    write(alice.cookie, { role: "member" }, "PATCH")
                )
            ).status
        ).toBe(409);
        expect(
            (
                await s.call(
                    "/workspace/invitations",
                    write(bob.cookie, { email: "carol@example.com", role: "owner" })
                )
            ).status
        ).toBe(403);
        // Inviting an existing owner as a member cannot demote them, including the last owner.
        const again = await invite(s, bob.cookie, "alice@example.com");
        expect(
            (await s.call(`/invitations/${again.secret}/accept`, write(alice.cookie, {}))).status
        ).toBe(200);
        expect((await s.rt.store.getMembership(a.workspace.id, a.username))?.role).toBe("owner");
    });

    it("honours revocation, expiry and workspace scope; links are never stored as plaintext", async () => {
        const { s, alice, bob, carol } = await setup();
        const invited = await invite(s, alice.cookie, "bob@example.com");
        const rows = await s.rt.store.listInvitations(invited.invitation.workspaceId);
        expect(rows[0]?.tokenHash).toHaveLength(64);
        expect(rows[0]?.tokenHash).not.toContain(invited.secret);
        expect(
            (
                await s.call(`/workspace/invitations/${invited.invitation.id}`, {
                    method: "DELETE",
                    headers: { cookie: carol.cookie },
                })
            ).status
        ).toBe(404);
        expect(
            (
                await s.call(`/workspace/invitations/${invited.invitation.id}`, {
                    method: "DELETE",
                    headers: { cookie: alice.cookie },
                })
            ).status
        ).toBe(204);
        expect((await s.call(`/invitations/${invited.secret}`)).status).toBe(404);
        expect(
            (await s.call(`/invitations/${invited.secret}/accept`, write(bob.cookie, {}))).status
        ).toBe(404);
        const row = rows[0];
        if (!row) throw new Error("no invite");
        await s.rt.store.createInvitation({
            ...row,
            id: "expired",
            tokenHash: "expired",
            expiresAt: "2000-01-01T00:00:00.000Z",
        });
        const me = (await (
            await s.call("/auth/me", { headers: { cookie: bob.cookie } })
        ).json()) as { username: string };
        expect(
            await s.rt.store.acceptInvitation("expired", me.username, new Date().toISOString())
        ).toBeNull();
    });

    it("grants nothing through a manager removed or demoted while their request was still arriving", async () => {
        const { store, pg } = await embeddedPostgres();
        const s = await startServe(defer, { store, managedAuth: fakeManagedAuth() });
        const alice = await customer(s, "alice");
        const bob = await customer(s, "bob");
        const carol = await customer(s, "carol");
        const name = async (cookie: string) =>
            (
                (await (await s.call("/auth/me", { headers: { cookie } })).json()) as {
                    username: string;
                }
            ).username;
        const invited = await invite(s, alice.cookie, "bob@example.com", "admin");
        await s.call(`/invitations/${invited.secret}/accept`, write(bob.cookie, {}));
        const workspaceId = invited.invitation.workspaceId;
        const admin = await name(bob.cookie);
        await s.rt.backend.createWorkspaceProject("team-app", "App", workspaceId);
        const now = new Date();
        const later = new Date(now.getTime() + 86400_000).toISOString();
        // What the admin's slowly sent requests write once they land, after the owner demoted them.
        await store.setMembership({
            workspaceId,
            username: admin,
            role: "member",
            createdAt: now.toISOString(),
        });
        const invitation = {
            id: "late",
            workspaceId,
            email: "carol@example.com",
            role: "member" as const,
            tokenHash: "late",
            createdBy: admin,
            createdAt: now.toISOString(),
            expiresAt: later,
        };
        await expect(store.createInvitation(invitation)).rejects.toMatchObject({ status: 403 });
        const key = {
            id: "late-agent",
            projectId: "team-app",
            workspaceId,
            name: "Agent",
            tokenHash: "late-agent",
            purpose: "agent" as const,
            permission: "full" as const,
            ownership: "project" as const,
            createdBy: admin,
            createdAt: now.toISOString(),
            expiresAt: later,
        };
        await expect(store.createToken(key)).rejects.toMatchObject({ status: 403 });
        expect(await store.getInvitation("late")).toBeNull();
        expect(await store.findToken("late-agent")).toBeNull();
        // An admin still may: but only invite members.
        await store.setMembership({
            workspaceId,
            username: admin,
            role: "admin",
            createdAt: now.toISOString(),
        });
        await expect(
            store.createInvitation({
                ...invitation,
                id: "promote",
                tokenHash: "promote",
                role: "admin",
            })
        ).rejects.toMatchObject({ status: 403 });
        await store.createInvitation(invitation);
        await store.createToken(key);
        // An invitation that landed before these checks: redeeming it asks whether its sender still may grant it.
        await pg.query("DELETE FROM notato.memberships WHERE workspace_id=$1 AND username=$2", [
            workspaceId,
            admin,
        ]);
        expect(await store.getInvitation("late")).toMatchObject({ createdBy: admin });
        expect(
            await store.acceptInvitation("late", await name(carol.cookie), new Date().toISOString())
        ).toBeNull();
    });
});
