import { describe, expect, it } from "bun:test";
import type { Annotation, Reply } from "@notato/schema";
import type { AuthProvider, Principal } from "../src/index.ts";
import { cleanupAfterEach, makeApp, makeBundleZip, waitFor } from "./helpers.ts";

// Who a credential may speak for. An app's token and a member are people, never an agent: what they bring in says so,
// and their waiting for notes does not make a page say an agent is watching. The admin and agent tokens are trusted
// with both, as they are when they reply or change a status.

const defer = cleanupAfterEach();

const PROJECT = "checkout-web";
const WHO: Record<string, Principal> = {
    admin: { kind: "admin", username: "admin" },
    member: { kind: "member", username: "mia", name: "Mia", projectIds: [PROJECT] },
    app: {
        kind: "token",
        tokenId: "t-app",
        projectId: PROJECT,
        purpose: "app",
        permission: "full",
    },
    named: {
        kind: "token",
        tokenId: "t-named",
        projectId: PROJECT,
        purpose: "app",
        permission: "full",
        authorName: "Kiosk",
    },
    agent: {
        kind: "token",
        tokenId: "t-agent",
        projectId: PROJECT,
        purpose: "agent",
        permission: "full",
    },
};

const LABEL: Record<string, string> = {
    admin: "the admin",
    member: "a member",
    app: "an app token",
    named: "an app token with a name of its own",
    agent: "an agent token",
};

/** A server where each request is whoever its `x-as` header names (see `WHO`). */
function server() {
    const auth = {
        identify: async (req: Request) => WHO[req.headers.get("x-as") ?? ""] ?? null,
    } as unknown as AuthProvider;
    const ctx = makeApp({ auth });
    defer(ctx.cleanup);
    const as = (who: string, path: string, init: RequestInit = {}) =>
        ctx.call(path, { ...init, headers: { ...init.headers, "x-as": who } });
    return { ...ctx, as };
}

const AGENT = { kind: "agent" as const, name: "Claude" };
const fixed: Reply = {
    id: "r-fixed",
    author: AGENT,
    body: "Fixed in commit abc123.",
    createdAt: "2026-10-05T10:01:00.000Z",
};

/** A bundle that says an agent wrote, fixed, offered and filed its one note. */
const agentWork = (id: string) =>
    makeBundleZip(
        1,
        () => ({
            author: AGENT,
            status: "resolved",
            thread: [fixed],
            variants: {
                group: "cta",
                options: [{ name: "A" }, { name: "B" }],
                offeredAt: "2026-10-05T10:00:30.000Z",
            },
            links: [
                {
                    plugin: "github",
                    url: "https://github.com/acme/web/issues/1",
                    createdAt: "2026-10-05T10:00:40.000Z",
                },
            ],
        }),
        { id }
    );

describe("importing a bundle", () => {
    for (const [who, name] of [
        ["app", "Claude"],
        ["named", "Kiosk"],
        ["member", "Claude"],
    ] as const)
        it(`brings an agent's work in as a person's new note, for ${LABEL[who]}`, async () => {
            const s = server();
            const { zip, bundle, originals } = await agentWork(`BUNDLE-${who.toUpperCase()}`);
            const res = await s.as(who, `/projects/${PROJECT}/bundles`, {
                method: "POST",
                headers: { "content-type": "application/zip" },
                body: zip as BodyInit,
            });
            expect(res.status).toBe(201);
            const kept = (await s.backend.get(originals[0]?.id ?? ""))?.annotation as Annotation;
            expect(kept.author).toEqual({ kind: "human", name });
            expect(kept.status).toBe("open");
            expect(kept.thread).toEqual([]);
            expect(kept.variants).toBeUndefined();
            expect(kept.links).toBeUndefined();
            expect(kept.bundleId).toBe(bundle.id);
            expect((await s.backend.getBundle(bundle.id))?.projectId).toBe(PROJECT);
        });

    for (const who of ["admin", "agent"])
        it(`keeps the bundle as it was for ${LABEL[who]}`, async () => {
            const s = server();
            const { zip, originals } = await agentWork(`BUNDLE-${who.toUpperCase()}`);
            const res = await s.as(who, `/projects/${PROJECT}/bundles`, {
                method: "POST",
                headers: { "content-type": "application/zip" },
                body: zip as BodyInit,
            });
            expect(res.status).toBe(201);
            const kept = (await s.backend.get(originals[0]?.id ?? ""))?.annotation as Annotation;
            expect(kept.author).toEqual(AGENT);
            expect(kept.status).toBe("resolved");
            expect(kept.thread).toEqual([fixed]);
            expect(kept.variants?.group).toBe("cta");
            expect(kept.links).toHaveLength(1);
        });
});

describe("waiting for notes", () => {
    for (const [who, watching] of [
        ["app", false],
        ["member", false],
        ["agent", true],
        ["admin", true],
    ] as const)
        it(`${watching ? "shows" : "does not show"} an agent watching for ${LABEL[who]}`, async () => {
            const s = server();
            const waiting = s.as(who, `/annotations/wait?project=${PROJECT}&timeoutMs=1500`);
            // Give the wait its moment to start, then look at what pages are told.
            expect(await waitFor(() => s.backend.agents.state.watching, 500)).toBe(watching);
            expect(s.backend.agents.stateFor(PROJECT).watching).toBe(watching);
            expect((await waiting).status).toBe(200);
        });
});
