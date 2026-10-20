import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuditEntry } from "../src/api.ts";

const originalDocument = globalThis.document;
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { AuditLog } = await import("../src/AccountSecurity.tsx");
globalThis.document = originalDocument;

const entries: AuditEntry[] = Array.from({ length: 25 }, (_, index) => ({
    id: `audit-${index}`,
    actor: "member:alice",
    action: `Event ${index + 1}`,
    outcome: 200,
    createdAt: "2026-10-19T12:00:00.000Z",
}));
it("shows only ten recent security events and offers navigation for the rest", () => {
    const html = renderToStaticMarkup(<AuditLog entries={entries} />);
    expect(html).toContain("1–10 of 25 recent events");
    expect(html).toContain(">Event 10<");
    expect(html).not.toContain(">Event 11<");
    expect(html.match(/<tr>/g)).toHaveLength(11);
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
});
it("keeps short and empty audit histories compact", () => {
    expect(renderToStaticMarkup(<AuditLog entries={[]} />)).toContain("No security activity yet.");
    const html = renderToStaticMarkup(<AuditLog entries={entries.slice(0, 4)} />);
    expect(html).toContain("1–4 of 4 recent events");
    expect(html).not.toContain("Previous");
    expect(html).not.toContain("Next");
});
