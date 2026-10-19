import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
    Authenticator,
    type AuthProvider,
    json,
    type Principal,
    type ProjectRecord,
    RequestError,
    readJson,
    type ServerExtension,
    SqliteStore,
} from "../src/index.ts";
import { annotationFixture, cleanupAfterEach, filesFor, multipart, toolText } from "./helpers.ts";
import { sse, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();

/**
 * A stand-in for a hosted deployment: accounts that are not the built-in admin, each reaching only its own projects,
 * a limit on notes, an extra route and a worker with a lifetime.
 */
function fakeCloud() {
    const events: string[] = [];
    const reach: Record<string, string[]> = { alice: ["a1", "a2"], bob: ["b1"], carol: ["a1"] };
    let store: SqliteStore | undefined;
    const extension: ServerExtension = {
        name: "fake-cloud",
        store: () => {
            store = new SqliteStore(":memory:");
            events.push("store");
            return store;
        },
        auth: ({ store }) => {
            const inner = new Authenticator(store);
            const provider: AuthProvider = {
                store,
                identify: async (req, url) => {
                    const who = req.headers.get("x-user");
                    if (who && reach[who])
                        return {
                            kind: "member",
                            username: who,
                            projectIds: reach[who] ?? [],
                            scope: `workspace-${who}`,
                            ...(who === "carol" ? { locked: true } : {}),
                        } satisfies Principal;
                    return inner.identify(req, url);
                },
                login: (...args) => inner.login(...args),
                logout: (...args) => inner.logout(...args),
                issueToken: (...args) => inner.issueToken(...args),
                listTokens: () => inner.listTokens(),
                revokeToken: (id) => inner.revokeToken(id),
            };
            return provider;
        },
        http: () => ({
            routes: {
                public: [
                    async ({ path }) => (path === "/ext/hello" ? json({ hello: "world" }) : null),
                ],
                private: [
                    async ({ path, principal }) =>
                        path === "/ext/me" ? json({ kind: principal.kind }) : null,
                ],
                isPublic: (_method, path) => path === "/ext/hello",
            },
            around: async ({ path, principal }, next) => {
                if (principal?.kind === "member" && path === "/ext/locked")
                    return json({ error: "workspace locked" }, 402);
                events.push(`request ${path}`);
                return next();
            },
            originsFor: (_req, url) =>
                url.pathname.startsWith("/projects/a1") ? ["https://alice.example"] : [],
            responseHeaders: () => ({ "x-extension": "fake-cloud" }),
        }),
        hooks: () => ({
            beforeIngest: async (_note, bytes) => {
                events.push(`ingest ${bytes > 0 ? "with" : "without"} screenshots`);
                if (events.filter((e) => e.startsWith("ingest")).length > 2)
                    throw new RequestError("workspace is over its limit", 402);
            },
        }),
        fetch: () => async (req, _info, next) => {
            events.push(`fetch ${new URL(req.url).pathname}`);
            return next();
        },
        start: () => {
            events.push("start");
            return () => {
                events.push("stop");
            };
        },
    };
    return { extension, events, store: () => store };
}

describe("a server extension", () => {
    it("brings its own store, accounts, routes and limits to the same server", async () => {
        const cloud = fakeCloud();
        const s = await startServe(defer, { extension: cloud.extension });
        expect(cloud.events).toContain("store");
        expect(cloud.events).toContain("start");
        await s.rt.backend.createProject("a1");
        await s.rt.backend.createProject("a2");
        await s.rt.backend.createProject("b1");

        // Its public route answers anyone; its private one needs a credential.
        expect(await (await s.call("/ext/hello")).json()).toEqual({ hello: "world" });
        expect((await s.call("/ext/me")).status).toBe(401);
        expect(await (await s.call("/ext/me", { headers: { "x-user": "bob" } })).json()).toEqual({
            kind: "member",
        });

        // A member reaches only their projects.
        const note = annotationFixture({ projectId: "a1" });
        const sent = await s.call("/projects/a1/annotations", {
            method: "POST",
            headers: { "x-user": "alice" },
            body: multipart(note, filesFor()),
        });
        expect(sent.status).toBe(201);
        const denied = await s.call("/projects/a1/annotations", {
            method: "POST",
            headers: { "x-user": "bob" },
            body: multipart(annotationFixture({ projectId: "a1" }), filesFor()),
        });
        expect(denied.status).toBe(403);
        const bobs = (await (
            await s.call("/projects", { headers: { "x-user": "bob" } })
        ).json()) as { items: Array<{ id: string }> };
        expect(bobs.items.map((p) => p.id)).toEqual(["b1"]);
        const read = await s.call(`/annotations/${note.id}`, { headers: { "x-user": "bob" } });
        expect(read.status).toBe(403);

        // The hook sees each note and its screenshot bytes, and can refuse.
        expect(cloud.events).toContain("ingest with screenshots");
        const second = await s.call("/projects/a2/annotations", {
            method: "POST",
            headers: { "x-user": "alice" },
            body: multipart(annotationFixture({ projectId: "a2" }), filesFor()),
        });
        expect(second.status).toBe(201);
        const third = await s.call("/projects/a2/annotations", {
            method: "POST",
            headers: { "x-user": "alice" },
            body: multipart(annotationFixture({ projectId: "a2" }), filesFor()),
        });
        expect(third.status).toBe(402);
        expect(((await third.json()) as { error: string }).error).toContain("over its limit");
    });

    it("can wrap requests, allow a project's own origins and add headers", async () => {
        const cloud = fakeCloud();
        const s = await startServe(defer, { extension: cloud.extension });
        await s.rt.backend.createProject("a1");
        const locked = await s.call("/ext/locked", { headers: { "x-user": "alice" } });
        expect(locked.status).toBe(402);
        const me = await s.call("/ext/me", { headers: { "x-user": "alice" } });
        expect(me.headers.get("x-extension")).toBe("fake-cloud");
        expect(cloud.events).toContain("request /ext/me");
        // The project's own site may make a cross-origin call; another may not.
        const allowed = await s.call("/projects/a1/annotations", {
            headers: { "x-user": "alice", origin: "https://alice.example" },
        });
        expect(allowed.headers.get("access-control-allow-origin")).toBe("https://alice.example");
        const other = await s.call("/projects/a1/annotations", {
            headers: { "x-user": "alice", origin: "https://evil.example" },
        });
        expect(other.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("keeps an agent connected as a member to that member's projects", async () => {
        const cloud = fakeCloud();
        const s = await startServe(defer, { extension: cloud.extension });
        for (const id of ["a1", "b1"]) await s.rt.backend.createProject(id);
        await s.rt.backend.ingest(
            annotationFixture({ projectId: "a1", comment: "alice's note" }),
            filesFor(),
            {
                projectId: "a1",
                feedbackActorId: "alice",
            }
        );
        await s.rt.backend.ingest(
            annotationFixture({ projectId: "b1", comment: "bob's note" }),
            filesFor(),
            {
                projectId: "b1",
                feedbackActorId: "bob",
            }
        );
        const client = new Client({ name: "t", version: "1" });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
                requestInit: { headers: { "x-user": "alice" } },
            })
        );
        const listed = toolText(
            (await client.callTool({ name: "notato_list_open", arguments: {} })) as never
        );
        expect(listed).toContain("alice's note");
        expect(listed).not.toContain("bob's note");
        await client.close();
    });

    it("keeps a member's event stream and relay to their own projects", async () => {
        const cloud = fakeCloud();
        const s = await startServe(defer, { extension: cloud.extension });
        for (const id of ["a1", "a2", "b1"]) await s.rt.backend.createProject(id);
        const stream = await s.call("/projects/*/events", { headers: { "x-user": "alice" } });
        const next = sse(stream);
        await next("hello");
        await s.rt.backend.ingest(
            annotationFixture({ projectId: "b1", comment: "bob's note" }),
            filesFor(),
            { projectId: "b1", feedbackActorId: "bob" }
        );
        const mine = annotationFixture({ projectId: "a2", comment: "alice's note" });
        await s.rt.backend.ingest(mine, filesFor(), { projectId: "a2", feedbackActorId: "alice" });
        // Only the note in a project alice reaches comes down her stream, even though she asked for every project.
        const seen = (await next("created")) as { annotation: { comment: string } };
        expect(seen.annotation.comment).toBe("alice's note");

        // With two projects she must say which one a relay is for.
        const unnamed = await s.call("/relay/annotate", {
            method: "POST",
            headers: { "x-user": "alice", "content-type": "application/json" },
            body: JSON.stringify({ target: "#x", comment: "hi", timeoutMs: 1000 }),
        });
        expect(unnamed.status).toBe(403);
        expect(((await unnamed.json()) as { error: string }).error).toContain("name a project");
        const foreign = await s.call("/relay/annotate", {
            method: "POST",
            headers: { "x-user": "alice", "content-type": "application/json" },
            body: JSON.stringify({ projectId: "b1", target: "#x", comment: "hi", timeoutMs: 1000 }),
        });
        expect(foreign.status).toBe(403);
    });

    it("tells a suspended credential why, on MCP and everywhere else, and lists nothing for it", async () => {
        const initialize = (s: Awaited<ReturnType<typeof startServe>>) =>
            s.call("/mcp", {
                method: "POST",
                headers: {
                    "x-user": "carol",
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
            });
        const cloud = fakeCloud();
        const s = await startServe(defer, { extension: cloud.extension });
        await s.rt.backend.createProject("a1");
        const plain = await initialize(s);
        expect(plain.status).toBe(403);
        expect(((await plain.json()) as { error: { message: string } }).error.message).toBe(
            "access is suspended for this account"
        );
        const projects = (await (
            await s.call("/projects", { headers: { "x-user": "carol" } })
        ).json()) as { items: unknown[] };
        expect(projects.items).toEqual([]);
        expect(
            (await s.call("/projects/a1/annotations", { headers: { "x-user": "carol" } })).status
        ).toBe(403);

        // The deployment says how a suspension is answered, and what to do about it.
        const worded = fakeCloud();
        const told = await startServe(defer, {
            extension: {
                ...worded.extension,
                mcp: () => ({
                    lockedRefusal: { status: 402, message: "ask an admin to lift the suspension" },
                }),
            },
        });
        const refused = await initialize(told);
        expect(refused.status).toBe(402);
        expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
            "ask an admin to lift the suspension"
        );
    });

    it("decides who manages projects, what each lists and what a new one is made with", async () => {
        const cloud = fakeCloud();
        const made: ProjectRecord[] = [];
        const s = await startServe(defer, {
            extension: {
                ...cloud.extension,
                hooks: () => ({ beforeCreateProject: (project) => void made.push(project) }),
                http: (context) => ({
                    ...cloud.extension.http?.(context),
                    projectRules: {
                        // alice runs her team's projects; the other members do not.
                        assertManager: (who) => {
                            if (
                                who.kind !== "admin" &&
                                !(who.kind === "member" && who.username === "alice")
                            )
                                throw new RequestError("only alice manages projects", 403);
                        },
                        list: async () =>
                            (await context.store.listProjects()).map((p) => ({
                                ...p,
                                name: p.name.toUpperCase(),
                            })),
                        create: async (who, body) => ({
                            id: `made-${String(body.color)}`,
                            fields: { owner: who.kind === "member" ? who.username : "admin" },
                            appToken: { expiresInDays: 7 },
                            agentToken: { createdBy: "rules" },
                        }),
                    },
                }),
            },
        });
        for (const id of ["a1", "b1"]) await s.rt.backend.createProject(id);
        const asUser = (user: string, init: RequestInit = {}) => ({
            ...init,
            headers: { "x-user": user, "content-type": "application/json" },
        });

        // The list is the rules', and still only what the credential reaches.
        const listed = (await (await s.call("/projects", asUser("bob"))).json()) as {
            items: Array<{ id: string; name: string }>;
        };
        expect(listed.items.map((p) => [p.id, p.name])).toEqual([["b1", "B1"]]);

        const created = await s.call(
            "/projects",
            asUser("alice", {
                method: "POST",
                body: JSON.stringify({ id: "chosen", name: "Shop", color: "red", agent: true }),
            })
        );
        expect(created.status).toBe(201);
        const body = (await created.json()) as {
            project: { id: string; name: string };
            token: { record: { expiresAt?: string; purpose: string } };
            agentToken: { record: { createdBy?: string; purpose: string } };
        };
        expect(body.project).toMatchObject({ id: "made-red", name: "SHOP" });
        expect(made.at(-1)).toMatchObject({ id: "made-red", owner: "alice" });
        expect(body.token.record.expiresAt).toBeString();
        expect(body.agentToken.record).toMatchObject({ createdBy: "rules", purpose: "agent" });
        expect(await s.rt.store.getProject("chosen")).toBeNull();

        for (const init of [
            { method: "POST", body: JSON.stringify({ id: "x", color: "blue" }) },
            { method: "PATCH", body: JSON.stringify({ name: "Mine" }) },
            { method: "DELETE" },
        ]) {
            const path = init.method === "POST" ? "/projects" : "/projects/b1";
            const refused = await s.call(path, asUser("bob", init));
            expect(refused.status, init.method).toBe(403);
            expect(((await refused.json()) as { error: string }).error).toBe(
                "only alice manages projects"
            );
        }
        expect((await s.rt.store.getProject("b1"))?.name).toBe("b1");
    });

    it("lets members hold tokens of their own, see only theirs and say who they are", async () => {
        const cloud = fakeCloud();
        const s = await startServe(defer, {
            extension: {
                ...cloud.extension,
                http: (context) => ({
                    ...cloud.extension.http?.(context),
                    tokenRules: {
                        assertManager: (who) => {
                            if (who?.kind !== "member" && who?.kind !== "admin")
                                throw new RequestError("sign in with an account", 403);
                        },
                        visible: (who, token) =>
                            who.kind === "admin" ||
                            (who.kind === "member" && token.createdBy === who.username),
                        issue: async (who, req) => {
                            const { projectId } = await readJson(
                                req,
                                z.object({ projectId: z.string() }).strict()
                            );
                            return context.auth.issueToken(projectId, "mine", {
                                createdBy: who.kind === "member" ? who.username : "admin",
                            });
                        },
                        shown: ({ tokenHash: _hash, createdBy: _by, ...record }) => record,
                    },
                    aboutCaller: async (who) => ({
                        team: who?.kind === "member" ? who.scope : null,
                    }),
                }),
            },
        });
        await s.rt.backend.createProject("a1");
        const asUser = (user: string, init: RequestInit = {}) => ({
            ...init,
            headers: { "x-user": user, "content-type": "application/json" },
        });
        const issued = await s.call(
            "/tokens",
            asUser("alice", { method: "POST", body: JSON.stringify({ projectId: "a1" }) })
        );
        expect(issued.status).toBe(201);
        const { token, record } = (await issued.json()) as {
            token: string;
            record: { id: string; name: string; tokenHash?: string; createdBy?: string };
        };
        expect(record.name).toBe("mine");
        expect(record.tokenHash).toBeUndefined();
        expect(record.createdBy).toBeUndefined();
        expect((await s.rt.store.listTokens())[0]?.createdBy).toBe("alice");

        const listed = async (user: string) =>
            (
                (await (await s.call("/tokens", asUser(user))).json()) as {
                    items: Array<{ id: string }>;
                }
            ).items.map((t) => t.id);
        expect(await listed("alice")).toEqual([record.id]);
        expect(await listed("bob")).toEqual([]);
        // `/admin/tokens` stays an admin's, and a token cannot manage tokens.
        expect((await s.call("/admin/tokens", asUser("alice"))).status).toBe(403);
        expect(
            (await s.call("/tokens", { headers: { authorization: `Bearer ${token}` } })).status
        ).toBe(403);
        // Someone else's token is one that does not exist.
        expect(
            (await s.call(`/tokens/${record.id}`, asUser("bob", { method: "DELETE" }))).status
        ).toBe(404);
        expect(
            (await s.call(`/tokens/${record.id}`, asUser("alice", { method: "DELETE" }))).status
        ).toBe(204);

        expect(await (await s.call("/auth/me", asUser("alice"))).json()).toMatchObject({
            authenticated: true,
            username: "alice",
            team: "workspace-alice",
        });
        expect(await (await s.call("/auth/me")).json()).toMatchObject({
            authenticated: false,
            team: null,
        });
    });

    it("stops the extension before the store closes", async () => {
        const cloud = fakeCloud();
        const s = await startServe(defer, { extension: cloud.extension });
        await s.rt.stop();
        expect(cloud.events.at(-1)).toBe("stop");
    });

    it("leaves a server without an extension as it was", async () => {
        const s = await startServe(defer);
        expect((await s.call("/ext/hello")).status).toBe(401);
    });
});
