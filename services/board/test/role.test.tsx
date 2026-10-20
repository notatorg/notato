import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const originalDocument = globalThis.document;
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { GuestNotice, RoleNote, whoIs } = await import("../src/Role.tsx");
globalThis.document = originalDocument;

const person = (role: "owner" | "admin" | "member", extra: Record<string, unknown> = {}) =>
    ({
        authenticated: true,
        workspace: { id: "w", name: "W", role, memberCount: 3, ...extra },
    }) as never;

it("tells owners, admins, members, guests and the operator apart", () => {
    expect(whoIs(person("owner"))).toMatchObject({ manager: true, owner: true, guest: false });
    expect(whoIs(person("admin"))).toMatchObject({ manager: true, owner: false, label: "Admin" });
    expect(whoIs(person("member"))).toMatchObject({
        manager: false,
        owner: false,
        label: "Member",
    });
    expect(whoIs(person("member", { projectOnly: true }))).toMatchObject({
        manager: false,
        guest: true,
        label: "Guest",
    });
    expect(
        whoIs({ isAdmin: true, workspace: { id: "w", name: "W", role: "member" } } as never)
    ).toMatchObject({
        manager: true,
        owner: true,
        operator: true,
    });
});

it("knows a person working alone from a team", () => {
    expect(whoIs(person("owner", { memberCount: 1 })).solo).toBe(true);
    expect(whoIs(person("owner", { memberCount: 4 })).solo).toBe(false);
    // Unknown size is treated as a team: nothing is hidden by mistake.
    expect(whoIs({ workspace: { id: "w", name: "W", role: "owner" } } as never).solo).toBe(false);
});

it("explains, to those who cannot manage something, who can", () => {
    expect(renderToStaticMarkup(<RoleNote me={person("owner")} can="connect tools" />)).toBe("");
    expect(renderToStaticMarkup(<RoleNote me={person("admin")} can="connect tools" />)).toBe("");
    const member = renderToStaticMarkup(<RoleNote me={person("member")} can="connect tools" />);
    expect(member).toContain("a member of this workspace");
    expect(member).toContain("Owners and admins connect tools");
    expect(
        renderToStaticMarkup(<RoleNote me={person("member", { projectOnly: true })} can="x" />)
    ).toContain("guest of one project");
});

it("keeps workspace pages from guests, saying why", () => {
    const html = renderToStaticMarkup(<GuestNotice what="Integrations" />);
    expect(html).toContain("Integrations");
    expect(html).toContain("invited to specific projects");
});
