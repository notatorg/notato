import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const originalDocument = globalThis.document;
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { AccountPage } = await import("../src/AccountPage.tsx");
globalThis.document = originalDocument;

const me = {
    authenticated: true,
    username: "alice",
    email: "alice@example.com",
    accountDeletionAvailable: true,
    emailPreferencesEnabled: false,
    workspace: { id: "w1", name: "Alice's workspace", role: "owner" as const },
} as never;

it("puts what belongs to the person on its own page, in the board's settings layout", () => {
    const html = renderToStaticMarkup(<AccountPage me={me} />);
    expect(html).toContain("Your sign-in and email choices");
    expect(html).toContain("alice@example.com");
    expect(html).toContain("Sign-in sessions");
    expect(html).toContain("Delete account");
    expect(html).toContain("Delete my account");
    // Settings-style sections, not the old boxed panels.
    expect(html.match(/class="set-section/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("danger-zone");
    expect(html).not.toContain("plugin-panel");
    // Workspace-level items do not belong here.
    expect(html).not.toContain("Security activity");
    expect(html).not.toContain("Usage");
});

it("hides email choices until the service offers them", () => {
    expect(renderToStaticMarkup(<AccountPage me={me} />)).not.toContain("Email preferences");
});
