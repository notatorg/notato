import { afterEach, beforeEach, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Me } from "../src/api.ts";

const originalDocument = globalThis.document;
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { BoardExtensionProvider } = await import("@notato/board");
const { Sidebar } = await import("../../../packages/board/src/Sidebar.tsx");
const { cloudExtension } = await import("../src/extension.tsx");
const { Administration, administrationTabs } = await import("../src/Administration.tsx");
const { PersonalSettings } = await import("../src/PersonalSettings.tsx");
const { Workspace } = await import("../src/Workspace.tsx");
globalThis.document = originalDocument;
const originalWindow = globalThis.window;
beforeEach(() => {
    globalThis.window = { matchMedia: () => ({ matches: false }) } as unknown as Window &
        typeof globalThis;
});
afterEach(() => {
    globalThis.window = originalWindow;
});

const workspace = { id: "w1", name: "Example workspace", role: "owner" as const };

const owner: Me = {
    mode: "serve",
    authenticated: true,
    authRequired: true,
    username: "alice",
    name: "Alice",
    workspace,
};
const sidebar = (me: Me, service = true) =>
    renderToStaticMarkup(
        <BoardExtensionProvider value={service ? cloudExtension : undefined}>
            <Sidebar
                me={me}
                route={{ page: "home" }}
                current={null}
                projects={[]}
                onSignOut={async () => {}}
            />
        </BoardExtensionProvider>
    );

it("keeps workspace tools above projects and personal controls in the account menu", () => {
    const html = sidebar({ ...owner, instanceAdmin: true });
    const tools = html.slice(
        html.indexOf('<section class="workspace-links"'),
        html.indexOf("</section>")
    );
    expect(tools).not.toContain("Reviews");
    expect(html).not.toContain('href="#/x/pr-reviews"');
    expect(tools).toContain("Integrations");
    expect(tools).not.toContain("Administration");
    expect(html.indexOf("Workspace tools")).toBeLessThan(html.indexOf("Switch project"));
    expect(html).toContain("Workspace settings");
    expect(html).toContain("Administration");
    expect(html).toContain('href="#/settings/account"');
    expect(html).toContain('href="#/settings/appearance"');
    expect(html).toContain("Sign out");
    expect(html).not.toContain('href="#/settings"');
});

it("never turns workspace ownership or workspace admin into global administration", () => {
    for (const role of ["owner", "admin", "member"] as const) {
        const me = { ...owner, workspace: { ...workspace, role } };
        expect(administrationTabs(me)).toEqual([]);
        expect(sidebar(me)).not.toContain('href="#/x/administration"');
        const denied = renderToStaticMarkup(
            <Administration me={me} projects={[]} tab="accounts" />
        );
        expect(denied).toContain("Administrator access required");
        expect(denied).not.toContain("Send invitation");
    }
});

it("keeps the global permissions independent and lets a cloud deployment name its operator area", () => {
    expect(administrationTabs({ ...owner, betaAdmin: true }).map((t) => t.id)).toEqual([
        "admissions",
    ]);
    expect(administrationTabs({ ...owner, isAdmin: true }).map((t) => t.id)).toEqual([
        "server",
        "tokens",
    ]);
    expect(administrationTabs({ ...owner, instanceAdmin: true }).map((t) => t.id)).toEqual([
        "accounts",
    ]);
    const html = renderToStaticMarkup(
        <Administration
            me={{
                ...owner,
                instanceAdmin: true,
                administration: { title: "Platform administration" },
            }}
            projects={[]}
        />
    );
    expect(html).toContain("Platform administration");
    expect(html).toContain("Send invitation");
    expect(html).not.toContain("Server settings");
});

it("gives project guests their account controls without workspace navigation", () => {
    const html = sidebar({ ...owner, workspace: { ...workspace, projectOnly: true } });
    expect(html).not.toContain("Workspace tools");
    expect(html).not.toContain('href="#/x/workspace"');
    expect(html).toContain('href="#/settings/account"');
    expect(html).toContain('href="#/x/workspace/tokens"');
});

it("keeps a guest's scoped token page available without workspace management controls", () => {
    const guest = {
        ...owner,
        workspace: { ...workspace, role: "member" as const, projectOnly: true },
    };
    const html = renderToStaticMarkup(
        <Workspace me={guest} tab="tokens" projects={[]} onChanged={() => {}} />
    );
    expect(html).toContain("Access tokens");
    expect(html).not.toContain("not part of your access");
    expect(html).not.toContain("Team members");
    expect(html).not.toContain("Workspace name");
});

it("keeps the lightweight board's Settings and browser name controls", () => {
    const html = sidebar({ mode: "dev", authRequired: false, authenticated: true }, false);
    expect(html).toContain('href="#/settings"');
    expect(html).toContain("Add your name");
    expect(html).not.toContain("account-menu");
});

it("personal preferences contain appearance without workspace keys or server controls", () => {
    const html = renderToStaticMarkup(
        <PersonalSettings
            me={owner}
            tab="appearance"
            projects={[]}
            manageServer={false}
            accountName="Alice"
        />
    );
    expect(html).toContain("Appearance");
    expect(html).toContain("Markdown detail");
    expect(html).not.toContain("Access tokens");
    expect(html).not.toContain("Webhooks");
});
