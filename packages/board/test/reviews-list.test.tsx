import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { href, parseRoute, projectHref } from "../src/route.ts";

const originalDocument = globalThis.document;
globalThis.document ??= { documentElement: { dataset: {} } } as unknown as Document;
const { filterReviews, ReviewsList } = await import("../src/ReviewsList.tsx");
globalThis.document = originalDocument;
type Item = Parameters<typeof filterReviews>[0][number];
const item = (patch: Partial<Item>): Item => ({
    id: "session-1",
    projectId: "shop",
    kind: "session",
    name: "Checkout testing pass",
    createdAt: "2026-10-20T09:00:00Z",
    createdBy: "alice",
    visibility: "shared",
    closed: false,
    ...patch,
});
const items = [
    item({}),
    item({
        id: "pr-42",
        kind: "pull-request",
        name: "Fix checkout validation",
        createdAt: "2026-10-20T10:00:00Z",
        context: "example/shop #42",
    }),
    item({ id: "mine", visibility: "personal", name: "Private testing notes" }),
    item({
        id: "other-private",
        visibility: "personal",
        createdBy: "bob",
        name: "Do not disclose",
    }),
    item({
        id: "different-project",
        projectId: "other",
        kind: "pull-request",
        name: "Other project",
    }),
];

it("combines review types by date while keeping project and personal boundaries", () => {
    expect(filterReviews(items, "shop", "alice").map((r) => r.id)).toEqual([
        "pr-42",
        "mine",
        "session-1",
    ]);
    expect(filterReviews(items, "shop", "alice", "pull-request").map((r) => r.id)).toEqual([
        "pr-42",
    ]);
    expect(filterReviews(items, "shop", "alice", "all", "shared").map((r) => r.id)).toEqual([
        "pr-42",
        "session-1",
    ]);
    expect(filterReviews(items, "shop", "bob", "session", "mine").map((r) => r.id)).toEqual([
        "other-private",
    ]);
});

it("labels each workflow and links directly to the review in its project", () => {
    const html = renderToStaticMarkup(
        <ReviewsList items={items} project="shop" actor="alice" pullRequests loading={false} />
    );
    expect(html).toContain("Testing session");
    expect(html).toContain("Pull request");
    expect(html).toContain("example/shop #42");
    expect(html).toContain('href="#/p/shop/reviews/session/session-1"');
    expect(html).toContain('href="#/p/shop/reviews/pull-request/pr-42"');
    expect(html).not.toContain("Do not disclose");
    expect(html).not.toContain("Other project");
});

it("keeps the lightweight empty state useful without GitHub", () => {
    const html = renderToStaticMarkup(
        <ReviewsList items={[]} project="shop" actor="local" pullRequests={false} loading={false} />
    );
    expect(html).toContain("Start a testing session");
    expect(html).not.toContain("pull request");
});

it("round trips both detail types and creation links, including old session URLs", () => {
    for (const selection of [
        "session/session-1",
        "pull-request/pr-42",
        "new/session",
        "new/pull-request",
    ]) {
        const path = projectHref("checkout web", "sessions", selection);
        expect(path).toContain("/reviews/");
        expect(parseRoute(path)).toEqual({
            page: "project",
            project: "checkout web",
            tab: "sessions",
            selected: selection,
        });
        expect(href(parseRoute(path))).toBe(path);
    }
    expect(parseRoute("#/p/shop/sessions")).toEqual(parseRoute("#/p/shop/reviews"));
    expect(projectHref("shop", "sessions")).toBe("#/p/shop/reviews");
    expect(parseRoute("#/p/shop/reviews/new/unknown")).toEqual({ page: "not-found" });
});
