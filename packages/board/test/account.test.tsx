import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { accountNameOf } from "../src/extension.tsx";

globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { Settings } = await import("../src/Settings.tsx");
const me = { mode: "serve" as const, authRequired: true, authenticated: true, username: "alice" };

const originalWindow = globalThis.window;
beforeEach(() => {
    globalThis.window = { matchMedia: () => ({ matches: false }) } as unknown as Window &
        typeof globalThis;
});
afterEach(() => {
    globalThis.window = originalWindow;
});

describe("account settings", () => {
    it("uses the account name, falling back to the login, while local development keeps its browser name", () => {
        expect(accountNameOf(me, { name: "test", accountName: () => "Alice" })).toBe("Alice");
        expect(accountNameOf(me)).toBe("alice");
        expect(accountNameOf(me, { name: "test", accountName: () => "  " })).toBe("alice");
        expect(accountNameOf({ ...me, mode: "dev", authRequired: false })).toBeUndefined();
    });
    it("shows the signed-in identity and sign-out in Settings without an editable anonymous name", () => {
        const html = renderToStaticMarkup(
            <Settings
                projects={[]}
                manageServer={false}
                accountName="Alice"
                onSignOut={async () => {}}
            />
        );
        expect(html).toContain("Alice");
        expect(html).toContain("Provided by your signed-in account");
        expect(html).toContain("Sign out");
        expect(html).not.toContain('id="pref-name"');
        const local = renderToStaticMarkup(<Settings projects={[]} manageServer={false} />);
        expect(local).toContain('id="pref-name"');
        expect(local).not.toContain("Sign out");
    });
});
