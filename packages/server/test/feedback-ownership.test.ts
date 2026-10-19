import { describe, expect, it } from "bun:test";
import { buildBundle, writeBundle } from "@notato/core";
import {
    Authenticator,
    createApp,
    createMcpServer,
    initializeProject,
    type Principal,
    ReviewSessions,
    ScopedBackend,
} from "../src/index.ts";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    filesFor,
    makeBackend,
    multipart,
    PNG,
    toolText,
} from "./helpers.ts";

import { sse } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
async function setup() {
    const context = makeBackend();
    defer(context.cleanup);
    const { store, backend } = context;
    for (const username of ["alice", "bob"])
        await store.upsertUser({
            username,
            passwordHash: "unused",
            createdAt: new Date().toISOString(),
            isAdmin: username === "alice",
        });
    await backend.createProject("app");
    await backend.createProject("other");
    await initializeProject(store.coordination, "app", "alice");
    await initializeProject(store.coordination, "other", "alice");
    const auth = new Authenticator(store);
    const identify = auth.identify.bind(auth);
    auth.identify = async (req, url): Promise<Principal | null> => {
        const username = req.headers.get("x-test-user");
        if (!username) return identify(req, url);
        return username === "alice"
            ? { kind: "admin", username }
            : { kind: "member", username, projectIds: await store.accessibleProjectIds(username) };
    };
    const app = createApp({ backend, auth, version: "test", mode: "serve", allowedHosts: "any" });
    const call = (path: string, user = "alice", init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (user) headers.set("x-test-user", user);
        headers.set("x-notato-board", "1");
        return app(new Request("http://localhost:4899" + path, { ...init, headers }));
    };
    const json = (method: string, body: unknown): RequestInit => ({
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    expect(
        (await call("/projects/app/members", "alice", json("POST", { username: "bob" }))).status
    ).toBe(200);
    const capture = async (user: string, over: Parameters<typeof annotationFixture>[0] = {}) => {
        const annotation = annotationFixture({ projectId: "app", mode: "dev", ...over });
        const response = await call("/projects/app/annotations", user, {
            method: "POST",
            body: multipart(annotation),
        });
        return { response, data: (await response.json()) as { annotation: typeof annotation } };
    };
    return { ...context, auth, call, json, capture };
}

describe("private feedback and collaboration", () => {
    it("does not mistake inherited JavaScript property names for project membership", async () => {
        const t = await setup();
        await t.store.upsertUser({
            username: "constructor",
            passwordHash: "unused",
            createdAt: new Date().toISOString(),
            isAdmin: false,
        });
        expect(await t.store.accessibleProjectIds("constructor")).toEqual([]);
        expect((await t.call("/projects/app/annotations", "constructor")).status).toBe(403);
        expect(
            (
                await t.call(
                    "/projects/app/owner",
                    "alice",
                    t.json("PATCH", { username: "constructor" })
                )
            ).status
        ).toBe(400);
    });

    it("turns a named package into a persistent review without moving its original testing notes", async () => {
        const t = await setup();
        const note = await t.capture("alice", { mode: "test", sessionId: "review_original_run" });
        const { bundle } = buildBundle([{ annotation: note.data.annotation, assets: new Map() }], {
            id: "named-package",
            projectId: "app",
            session: { name: "Keyboard audit", description: "Check every dialog" },
        });
        const result = await t.backend.importBundle(await writeBundle(bundle, async () => PNG), {
            feedbackActorId: "alice",
        });
        expect(result.reviewSessionId).toBe("review_bundle_named-package");
        const data = await (
            await t.call("/review-sessions/" + result.reviewSessionId, "bob")
        ).json();
        expect(data.session).toMatchObject({
            name: "Keyboard audit",
            description: "Check every dialog",
            visibility: "shared",
        });
        expect(
            data.items.map((item: { annotation: { id: string } }) => item.annotation.id)
        ).toEqual([note.data.annotation.id]);
        expect((await t.backend.get(note.data.annotation.id))?.annotation.sessionId).toBe(
            "review_original_run"
        );
    });

    it("derives ownership from authentication and protects notes and assets, then shares only on request", async () => {
        const t = await setup();
        const { data } = await t.capture("alice", {
            createdBy: "bob",
            comment: "private exploration",
        });
        expect(data.annotation).toMatchObject({ createdBy: "alice", visibility: "personal" });
        expect((await t.call("/annotations/" + data.annotation.id, "bob")).status).toBe(404);
        expect(
            (await t.call("/assets/" + data.annotation.screenshots!.full.id, "bob")).status
        ).toBe(404);
        expect((await t.call("/annotations?project=app", "bob")).status).toBe(200);
        expect((await (await t.call("/annotations?project=app", "bob")).json()).items).toHaveLength(
            0
        );
        await t.call(
            "/annotations/" + data.annotation.id,
            "alice",
            t.json("PATCH", { visibility: "shared" })
        );
        expect((await t.call("/annotations/" + data.annotation.id, "bob")).status).toBe(200);
        expect(
            (
                await t.call(
                    "/annotations/" + data.annotation.id,
                    "bob",
                    t.json("PATCH", { visibility: "personal" })
                )
            ).status
        ).toBe(403);
    });

    it("shares an individual annotation without exposing its private session or siblings", async () => {
        const t = await setup();
        const result = await t.call(
            "/projects/app/review-sessions",
            "alice",
            t.json("POST", { name: "Private thoughts", description: "secret session focus" })
        );
        const { session } = await result.json();
        const first = await t.capture("alice", {
            sessionId: session.id,
            comment: "share just this",
        });
        await t.capture("alice", { sessionId: session.id, comment: "keep this private" });
        await t.call(
            "/annotations/" + first.data.annotation.id,
            "alice",
            t.json("PATCH", { visibility: "shared" })
        );
        const visible = await t.call("/annotations/" + first.data.annotation.id, "bob");
        expect(visible.status).toBe(200);
        expect(await visible.text()).not.toContain("secret session focus");
        expect((await t.call("/review-sessions/" + session.id, "bob")).status).toBe(404);
        expect((await t.call("/annotations?sessionId=" + session.id, "bob")).status).toBe(404);
        expect(
            (await (await t.call("/projects/app/review-sessions", "bob")).json()).items
        ).toHaveLength(0);
        await t.call(
            "/review-sessions/" + session.id,
            "alice",
            t.json("PATCH", { visibility: "shared" })
        );
        const shared = await (await t.call("/review-sessions/" + session.id, "bob")).json();
        expect(shared.items).toHaveLength(1);
        expect(
            await t.store.listAnnotations({
                projectId: "app",
                feedbackActorId: "alice",
                feedbackScope: "mine",
            })
        ).toHaveLength(1);
        expect(
            (
                await t.call(
                    "/review-sessions/" + session.id + "/replies",
                    "bob",
                    t.json("POST", { body: "Please focus on keyboard support." })
                )
            ).status
        ).toBe(200);
    });

    it("creates a shared Test session on capture and prevents cloud ingestion of local-only feedback", async () => {
        const t = await setup();
        const captured = await t.capture("bob", { mode: "test", sessionId: "review_testing_pass" });
        expect(captured.response.status).toBe(201);
        const data = await (await t.call("/review-sessions/review_testing_pass", "alice")).json();
        expect(data.session).toMatchObject({ createdBy: "bob", visibility: "shared" });
        expect(data.items).toHaveLength(1);
        expect((await t.capture("bob", { localOnly: true })).response.status).toBe(400);
        await t.call(
            "/review-sessions/review_testing_pass",
            "bob",
            t.json("PATCH", { closed: true })
        );
        expect(
            (await t.capture("bob", { mode: "test", sessionId: "review_testing_pass" })).response
                .status
        ).toBe(409);
    });

    it("keeps project credentials isolated and revokes access when a member is removed", async () => {
        const t = await setup();
        const token = await t.auth.issueToken("app", "Bob app", {
            purpose: "app",
            createdBy: "bob",
        });
        const principal = await t.auth.identify(
            new Request("http://localhost", {
                headers: { Authorization: "Bearer " + token.token },
            }),
            new URL("http://localhost")
        );
        expect(principal?.kind).toBe("token");
        expect(principal && "projectIds" in principal ? principal.projectIds : []).toEqual(["app"]);
        const owned = await t.capture("bob", { comment: "Bob private" });
        expect((await t.call("/projects/other/annotations", "bob")).status).toBe(403);
        await t.call("/projects/app/members/bob", "alice", { method: "DELETE" });
        expect((await t.call("/annotations/" + owned.data.annotation.id, "bob")).status).toBe(403);
        expect((await t.store.getAnnotation(owned.data.annotation.id))?.annotation.visibility).toBe(
            "personal"
        );
        const revoked = await t.auth.identify(
            new Request("http://localhost", {
                headers: { Authorization: "Bearer " + token.token },
            }),
            new URL("http://localhost")
        );
        expect(revoked && "projectIds" in revoked ? revoked.projectIds : []).toEqual([]);
    });

    it("lets an agent take an explicit session without widening its access to unrelated feedback", async () => {
        const t = await setup();
        const sessions = new ReviewSessions(t.store.coordination);
        const session = await sessions.create("app", "alice", {
            name: "Test pass",
            description: "Keyboard navigation",
            visibility: "shared",
        });
        await t.capture("alice", {
            sessionId: session.id,
            visibility: "shared",
            comment: "Fix tab order",
        });
        const other = await t.capture("bob", { comment: "Unrelated private task" });
        await t.capture("alice", { sessionId: session.id, comment: "Alice private in session" });
        const scoped = new ScopedBackend(t.backend, ["app"], "bob");
        const mcp = await connectMcp(
            createMcpServer({ backend: scoped, feedbackActorId: "bob", version: "test" }),
            defer
        );
        const mine = toolText(await mcp.call("notato_list_open", {}));
        expect(mine).toContain("Unrelated private task");
        expect(mine).not.toContain("Fix tab order");
        const picked = toolText(await mcp.call("notato_get_review_session", { id: session.id }));
        expect(picked).toContain("Fix tab order");
        expect(picked).not.toContain("Alice private in session");
        expect(
            (await mcp.call("notato_get", { id: other.data.annotation.id, screenshots: "none" }))
                .isError
        ).toBe(true);
        expect(toolText(await mcp.call("notato_list_open", { sessionId: session.id }))).toContain(
            "Fix tab order"
        );
    });
});

it("wakes the shared agent for an older note explicitly shared later and removes withdrawn notes from teammate streams", async () => {
    const t = await setup();
    const earlier = await t.capture("alice", { comment: "Share this once ready" });
    await t.capture("alice", { comment: "Newer shared note", visibility: "shared" });
    const mcp = await connectMcp(
        createMcpServer({
            backend: new ScopedBackend(t.backend, ["app"], "bob"),
            feedbackActorId: "bob",
            version: "test",
        }),
        defer
    );
    const first = toolText(
        await mcp.call("notato_watch", {
            scope: "shared",
            timeoutSeconds: 1,
            windowMs: 0,
            screenshots: "none",
        })
    );
    expect(first).toContain("Newer shared note");
    expect(first).not.toContain("Share this once ready");
    const abort = new AbortController();
    defer(() => abort.abort());
    const next = sse(await t.call("/projects/app/events", "bob", { signal: abort.signal }));
    await next("hello");
    await t.call(
        "/annotations/" + earlier.data.annotation.id,
        "alice",
        t.json("PATCH", { visibility: "shared" })
    );
    expect(await next("updated")).toMatchObject({ id: earlier.data.annotation.id });
    expect(
        toolText(
            await mcp.call("notato_watch", {
                scope: "shared",
                timeoutSeconds: 1,
                windowMs: 0,
                screenshots: "none",
            })
        )
    ).toContain("Share this once ready");
    await t.call(
        "/annotations/" + earlier.data.annotation.id,
        "alice",
        t.json("PATCH", { visibility: "personal", comment: "Now private" })
    );
    const removed = await next("deleted");
    expect(removed).toMatchObject({ id: earlier.data.annotation.id });
    expect(removed).not.toHaveProperty("annotation");
});

it("manually groups shared feedback from other Test runs while preserving its original grouping and every personal boundary", async () => {
    const t = await setup();
    const fromTest = await t.capture("bob", {
        mode: "test",
        sessionId: "review_bob_pass",
        visibility: "shared",
        comment: "Tester result",
    });
    const privateNote = await t.capture("alice", { comment: "Alice private plan" });
    const created = await (
        await t.call(
            "/projects/app/review-sessions",
            "alice",
            t.json("POST", { name: "Fix checkout", visibility: "shared" })
        )
    ).json();
    expect(
        (
            await t.call(
                "/review-sessions/" + created.session.id + "/annotations",
                "alice",
                t.json("POST", {
                    ids: [fromTest.data.annotation.id, privateNote.data.annotation.id],
                })
            )
        ).status
    ).toBe(200);
    expect((await t.store.getAnnotation(fromTest.data.annotation.id))?.annotation.sessionId).toBe(
        "review_bob_pass"
    );
    const visible = await (await t.call("/review-sessions/" + created.session.id, "bob")).json();
    expect(visible.session).not.toHaveProperty("annotationIds");
    expect(visible.items.map((item: { annotation: { id: string } }) => item.annotation.id)).toEqual(
        [fromTest.data.annotation.id]
    );
    const mcp = await connectMcp(
        createMcpServer({
            backend: new ScopedBackend(t.backend, ["app"], "bob"),
            feedbackActorId: "bob",
            version: "test",
        }),
        defer
    );
    expect(
        toolText(await mcp.call("notato_get_review_session", { id: created.session.id }))
    ).toContain("Tester result");
    expect(
        (await mcp.call("notato_get", { id: fromTest.data.annotation.id, screenshots: "none" }))
            .isError
    ).not.toBe(true);
    expect(
        toolText(await mcp.call("notato_list_open", { sessionId: created.session.id }))
    ).not.toContain("Alice private plan");
});
