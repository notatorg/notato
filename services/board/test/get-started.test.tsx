import { expect, it } from "bun:test";

const originalDocument = globalThis.document;
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { stepsFor } = await import("../src/GetStarted.tsx");
globalThis.document = originalDocument;

const me = (role: "owner" | "admin" | "member", extra: Record<string, unknown> = {}) =>
    ({
        authenticated: true,
        workspace: { id: "w", name: "W", role, memberCount: 1, ...extra },
    }) as never;
const project = (annotations = 0, statuses: Record<string, number> = {}) =>
    ({ id: "p1", name: "Shop", annotations, open: annotations, statuses }) as never;
const ids = (steps: Array<{ id: string }>) => steps.map((s) => s.id);

it("gives a solo builder three steps, then optional ones that are about growing", () => {
    const steps = stepsFor({
        me: me("owner"),
        projects: [],
        agentSeen: false,
        toolsConnected: false,
    });
    expect(ids(steps)).toEqual(["project", "app", "agent", "tools", "team"]);
    expect(steps.filter((s) => !s.optional).map((s) => s.done)).toEqual([false, false, false]);
    expect(steps.find((s) => s.id === "team")).toMatchObject({ optional: true, done: false });
});

it("marks steps done from what has really happened", () => {
    const after = stepsFor({
        me: me("owner"),
        projects: [project(3, { acknowledged: 1 })],
        agentSeen: false,
        toolsConnected: true,
    });
    const done = Object.fromEntries(after.map((s) => [s.id, s.done]));
    // A project exists, a note arrived, and an agent has worked on one, even if none is connected right now.
    expect(done).toMatchObject({ project: true, app: true, agent: true, tools: true });
    expect(
        stepsFor({
            me: me("owner"),
            projects: [project(0)],
            agentSeen: true,
            toolsConnected: null,
        }).find((s) => s.id === "agent")?.done
    ).toBe(true);
});

it("does not ask a member to create projects or invite people, and explains what is shared", () => {
    const steps = stepsFor({
        me: me("member", { memberCount: 4 }),
        projects: [project(0)],
        agentSeen: false,
        toolsConnected: null,
    });
    expect(ids(steps)).toEqual(["project", "app", "agent", "share"]);
    expect(steps[0]?.title).toBe("Open your project");
    expect(steps.find((s) => s.id === "share")?.optional).toBe(true);
    expect(ids(steps)).not.toContain("setup");
});

it("keeps a guest to the basics", () => {
    const steps = stepsFor({
        me: me("member", { memberCount: 4, projectOnly: true }),
        projects: [project(0)],
        agentSeen: false,
        toolsConnected: null,
    });
    expect(ids(steps)).toEqual(["project", "app", "agent"]);
});

it("does not offer tools when the service has none, and links to the project's Connect page", () => {
    const steps = stepsFor({
        me: me("owner"),
        projects: [project(0)],
        agentSeen: false,
        toolsConnected: null,
    });
    expect(ids(steps)).not.toContain("tools");
    expect(steps.find((s) => s.id === "app")?.action?.href).toContain("connect");
});
