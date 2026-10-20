import { expect, it } from "bun:test";
import { cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();

it("tells the board how big a workspace is and whether the caller is a guest", async () => {
    const s = await startServe(defer, { managedAuth: fakeManagedAuth(), testPlans: true });
    const alice = await customer(s, "alice");
    const bob = await customer(s, "bob");
    const me = async (cookie: string) =>
        (await (await s.call("/auth/me", { headers: { cookie } })).json()) as {
            username: string;
            workspace: { id: string; memberCount: number; projectOnly: boolean; role: string };
        };
    const first = await me(alice.cookie);
    expect(first.workspace).toMatchObject({ memberCount: 1, projectOnly: false, role: "owner" });
    const bobMe = await me(bob.cookie);
    // Room for a second person, then make them a guest of one project (what accepting a project invitation does).
    await s.rt.store.selectWorkspacePlan(first.workspace.id, first.username, "pro", 0);
    await s.rt.store.setMembership({
        workspaceId: first.workspace.id,
        username: bobMe.username,
        role: "member",
        createdAt: new Date().toISOString(),
    });
    await (
        s.rt.store as unknown as { db: { query(sql: string, params: unknown[]): Promise<unknown> } }
    ).db.query(
        "UPDATE notato.memberships SET project_only=TRUE WHERE workspace_id=$1 AND username=$2",
        [first.workspace.id, bobMe.username]
    );
    const chosen = await s.call("/auth/workspace", {
        method: "POST",
        headers: { cookie: bob.cookie, "x-notato-board": "1", "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: first.workspace.id }),
    });
    const bobCookie = (chosen.headers.get("set-cookie") ?? bob.cookie).split(";")[0] ?? bob.cookie;
    expect((await me(alice.cookie)).workspace.memberCount).toBe(2);
    expect((await me(bobCookie)).workspace).toMatchObject({ projectOnly: true, role: "member" });
});
