import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const originalDocument = globalThis.document;
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { EmailChoice, EmailWelcome } = await import("../src/EmailPreferences.tsx");
globalThis.document = originalDocument;

const prefs = {
    available: true as const,
    marketing: { enabled: false, decided: false, revision: 0 },
    copy: {
        version: "2026-10-19",
        label: "Email me Notato product news, tips and offers.",
        note: "Optional — unsubscribe at any time.",
    },
    privacyUrl: "https://example.com/privacy",
    controller: "Example Ltd",
};

it("offers the marketing choice unticked, with its wording and privacy notice, and keeps service mail separate", () => {
    const html = renderToStaticMarkup(<EmailWelcome prefs={prefs} onDone={() => {}} />);
    expect(html).toContain("Email me Notato product news, tips and offers.");
    expect(html).toContain("Optional");
    expect(html).toContain('href="https://example.com/privacy"');
    expect(html).toContain("Sent by Example Ltd");
    expect(html).toContain("account, security and anything you ask");
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toContain("Continue");
    // Declining is just continuing: there is no required tick and no second step.
    expect(html).not.toContain("required");
});

it("reflects an existing choice and explains a blocked address without offering to override it", () => {
    const on = renderToStaticMarkup(
        <EmailChoice
            prefs={{ ...prefs, marketing: { enabled: true, decided: true, revision: 2 } }}
            checked
            onChange={() => {}}
        />
    );
    expect(on).toMatch(/<input[^>]*checked/);
    const blocked = renderToStaticMarkup(
        <EmailChoice
            prefs={{
                ...prefs,
                marketing: { enabled: false, decided: true, revision: 2, blocked: "complaint" },
            }}
            checked={false}
            onChange={() => {}}
        />
    );
    expect(blocked).toMatch(/<input[^>]*disabled/);
    expect(blocked).toContain("cannot be sent to this address");
});
