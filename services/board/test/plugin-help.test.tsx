import { expect, it } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const originalDocument = globalThis.document;
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { generateSecret, providerGuide, SetupChecklist } = await import("../src/PluginHelp.tsx");
const { Section } = await import("../src/Layout.tsx");
globalThis.document = originalDocument;
const list = (nodes: ReactNode[]) => renderToStaticMarkup(createElement("ol", null, ...nodes));

const steps = [
    { id: "connect", title: "Connect a tool", hint: "Add GitHub.", done: true, tab: "connections" },
    {
        id: "action",
        title: "Choose where it goes",
        hint: "Save an action.",
        done: false,
        tab: "actions",
    },
    { id: "send", title: "Send a note", hint: "Pick a note.", done: false, tab: "actions" },
];

it("tells a new workspace exactly one thing to do next, and what each word means", () => {
    const html = renderToStaticMarkup(
        <SetupChecklist steps={steps} current="connections" onGo={() => {}} />
    );
    expect(html).toContain("connection</strong> is your account on another tool");
    expect(html).toContain("Connect a tool");
    expect(html).toContain("— done");
    // Only the next step carries its hint and a way there.
    expect(html).toContain("Save an action.");
    expect(html).not.toContain("Pick a note.");
    expect(html).toContain("Go there");
    // A step on the page already open needs no button.
    expect(
        renderToStaticMarkup(<SetupChecklist steps={steps} current="actions" onGo={() => {}} />)
    ).not.toContain("Go there");
});

it("explains every tool in plain steps and names the one secret it needs", () => {
    for (const provider of ["github", "azure", "teams", "slack", "webhook", "linear", "gitlab"]) {
        const guide = providerGuide(provider, false);
        expect(guide.steps.length, provider).toBeGreaterThan(0);
        expect(guide.credential.length, provider).toBeGreaterThan(5);
    }
    const github = list(providerGuide("github", false).steps);
    expect(github).toContain("github.com/settings/personal-access-tokens/new");
    expect(github).toContain("Issues: Read and write");
    expect(github).not.toContain("GitHub App options");
    expect(list(providerGuide("github", true).steps)).toContain("GitHub App options");
    expect(providerGuide("github", false).credential).toBe("GitHub personal access token");
});

it("generates a long random secret for signed webhooks", () => {
    const a = generateSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret()).not.toBe(a);
});

it("lays a section out like the board's settings", () => {
    const html = renderToStaticMarkup(
        <Section title="Connections" about="Your accounts.">
            <p>body</p>
        </Section>
    );
    expect(html).toContain('class="set-section"');
    expect(html).toContain("<h2>Connections</h2>");
    expect(html).toContain("Your accounts.");
    expect(html).toContain('class="set-body"');
});
