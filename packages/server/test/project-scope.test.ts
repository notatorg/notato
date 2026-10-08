import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    AgentPresence,
    type AgentState,
    createMcpServer,
    type DevRuntime,
    decodeAgentProjects,
    encodeAgentProjects,
    filterFromQuery,
    filterToQuery,
    type LocalBackend,
    parseProjects,
    runDev,
} from "../src/index.ts";
import {
    annotationFixture,
    cleanupAfterEach,
    connectMcp,
    filesFor,
    makeBackend,
    type ToolResult,
    tempDir,
    toolText as text,
} from "./helpers.ts";

// Several repositories sharing one server: an agent kept to its own projects (`notato dev --project`,
// `/mcp?project=`) is handed only their notes, and counts as there only on their pages.

const defer = cleanupAfterEach();

const connect = (server: McpServer) => connectMcp(server, defer);

const add = async (backend: LocalBackend, projectId: string, comment: string) =>
    (await backend.ingest(annotationFixture({ projectId, comment }), filesFor())).stored.annotation;

/** One server shared by three apps, and an agent kept to `projects`. */
async function shared(projects?: string[]) {
    const ctx = makeBackend();
    defer(ctx.cleanup);
    const shop = await add(ctx.backend, "shop", "shop: the basket total is wrong");
    const admin = await add(ctx.backend, "admin", "admin: the table header overlaps");
    const blog = await add(ctx.backend, "blog", "blog: the byline is grey on grey");
    const agent = await connect(createMcpServer({ backend: ctx.backend, version: "t", projects }));
    return { ...ctx, ...agent, shop, admin, blog };
}

const quickWatch = { timeoutSeconds: 1, windowMs: 0, screenshots: "none" };

describe("an agent kept to its own projects", () => {
    it("is handed only that project's notes, by notato_watch and notato_list_open", async () => {
        const t = await shared(["shop"]);
        const listed = text(await t.call("notato_list_open"));
        expect(listed).toContain("shop: the basket total");
        expect(listed).not.toContain("admin:");
        expect(listed).not.toContain("blog:");
        const watched = text(await t.call("notato_watch", quickWatch));
        expect(watched).toContain("1 new annotation.");
        expect(watched).toContain("shop: the basket total");
        expect(watched).not.toContain("admin:");
    });

    it("is not woken by a note for another project", async () => {
        const t = await shared(["shop"]);
        await t.call("notato_watch", quickWatch);
        const waiting = t.call("notato_watch", { ...quickWatch, timeoutSeconds: 2 });
        await Bun.sleep(200);
        await add(t.backend, "admin", "admin: a new one");
        expect(text(await waiting)).toBe(
            "No new annotations. Call notato_watch again to keep waiting."
        );
    });

    it("works on several projects when given several", async () => {
        const t = await shared(["shop", "admin"]);
        const listed = text(await t.call("notato_list_open"));
        expect(listed).toContain("shop:");
        expect(listed).toContain("admin:");
        expect(listed).not.toContain("blog:");
        // Narrowing to one of its own is fine.
        const one = text(await t.call("notato_list_open", { projectId: "admin" }));
        expect(one).toContain("admin:");
        expect(one).not.toContain("shop:");
    });

    it("refuses a call that names a project it does not work on", async () => {
        const t = await shared(["shop"]);
        for (const tool of ["notato_list_open", "notato_watch"]) {
            const result = await t.call(tool, { ...quickWatch, projectId: "blog" });
            expect(result.isError).toBe(true);
            expect(text(result)).toContain("This session works on project shop, not blog");
            expect(text(result)).not.toContain("byline");
        }
    });

    it("reads another project's note when asked by id, labelled, but never changes it", async () => {
        const t = await shared(["shop"]);
        const got = text(await t.call("notato_get", { id: t.admin.id, screenshots: "none" }));
        expect(got).toContain("Not this session's: this note is for project admin");
        expect(got).toContain("admin: the table header overlaps");
        const attempts: Array<[string, Record<string, unknown>]> = [
            ["notato_acknowledge", {}],
            ["notato_reply", { body: "On it" }],
            ["notato_resolve", { summary: "Fixed" }],
            ["notato_dismiss", { reason: "Not mine" }],
            [
                "notato_variants_ready",
                {
                    group: "header",
                    options: [
                        { name: "Original", summary: "As it was" },
                        { name: "Tight", summary: "Less padding" },
                    ],
                },
            ],
            ["notato_reverted", { summary: "Undone" }],
        ];
        for (const [tool, args] of attempts) {
            const result = await t.call(tool, { id: t.admin.id, ...args });
            expect(result.isError).toBe(true);
            expect(text(result)).toContain(
                "is for project admin, and this session works on project shop"
            );
        }
        const after = await t.backend.get(t.admin.id);
        expect(after?.annotation.status).toBe("open");
        expect(after?.annotation.thread).toEqual([]);
        // Its own notes are as before.
        expect((await t.call("notato_resolve", { id: t.shop.id, summary: "Fixed" })).isError).toBe(
            undefined
        );
    });

    it("says which projects it works on in its instructions", async () => {
        const t = await shared(["shop", "admin"]);
        expect(t.client.getInstructions()).toContain("This session works on projects shop, admin.");
        const all = await shared();
        expect(all.client.getInstructions()).not.toContain("This session works on");
    });

    it("asks the page of its own project to annotate", async () => {
        const t = await shared(["shop"]);
        // No page is open, so the relay says which project it looked for.
        const result = await t.call("notato_annotate", { target: "button", comment: "Too small" });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain('for project "shop"');
        const several = await shared(["shop", "admin"]);
        const unsure = await several.call("notato_annotate", {
            target: "button",
            comment: "Too small",
        });
        expect(text(unsure)).toContain("pass projectId");
    });

    it("without a scope, is handed every project's notes, as before", async () => {
        const t = await shared();
        const listed = text(await t.call("notato_list_open"));
        for (const app of ["shop:", "admin:", "blog:"]) expect(listed).toContain(app);
    });
});

describe("several projects in a filter", () => {
    it("travels as a repeated query parameter, and back", () => {
        const query = filterToQuery({ projectId: ["shop", "admin"], status: "open" });
        expect(query.getAll("project")).toEqual(["shop", "admin"]);
        expect(filterFromQuery(query).projectId).toEqual(["shop", "admin"]);
        expect(filterFromQuery(new URLSearchParams("project=shop")).projectId).toBe("shop");
        // The URL's project wins over the query's.
        expect(filterFromQuery(query, "blog").projectId).toBe("blog");
    });

    it("is read from the store with IN, and an empty list matches nothing", async () => {
        const t = await shared();
        const both = await t.backend.list({ projectId: ["shop", "admin"] });
        expect(both.map((s) => s.annotation.projectId).sort()).toEqual(["admin", "shop"]);
        expect(await t.backend.list({ projectId: [] })).toEqual([]);
    });

    it("parses --project and NOTATO_PROJECT, repeated or comma-separated, each once", () => {
        expect(parseProjects(["shop", "admin,blog", " shop "])).toEqual(["shop", "admin", "blog"]);
        expect(parseProjects("shop, admin")).toEqual(["shop", "admin"]);
        expect(parseProjects([])).toBeUndefined();
        expect(parseProjects(",")).toBeUndefined();
        expect(parseProjects(undefined)).toBeUndefined();
    });

    it("names an attached agent's projects in a header that survives odd characters", () => {
        const projects = ["shop", "a,b", "café@2"];
        expect(decodeAgentProjects(encodeAgentProjects(projects))).toEqual(projects);
        expect(decodeAgentProjects("")).toBeUndefined();
        expect(decodeAgentProjects("%E0%A4%A")).toBeUndefined();
    });
});

describe("whether an agent is there, per project", () => {
    it("counts an agent kept to some projects only on their pages", () => {
        const presence = new AgentPresence();
        defer(() => presence.stop());
        const release = presence.hold("pfa_shop", "Claude", ["shop"]);
        presence.touch("pfa_any", "Codex");
        expect(presence.stateFor("shop")).toMatchObject({
            sessions: 2,
            names: ["Claude", "Codex"],
        });
        expect(presence.stateFor("admin")).toMatchObject({ sessions: 1, names: ["Codex"] });
        // The board's own stream (every project) and the overall state see everyone.
        expect(presence.stateFor("*").sessions).toBe(2);
        expect(presence.state.sessions).toBe(2);
        release();
        const waited = presence.waitStarted(["shop"]);
        expect(presence.stateFor("shop").watching).toBe(true);
        expect(presence.stateFor("admin").watching).toBe(false);
        waited();
    });

    it("tells each page about its own project only", () => {
        const presence = new AgentPresence();
        defer(() => presence.stop());
        const shop: AgentState[] = [];
        const admin: AgentState[] = [];
        presence.subscribe((s) => shop.push(s), "shop");
        presence.subscribe((s) => admin.push(s), "admin");
        const release = presence.hold("pfa_shop", "Claude", ["shop"]);
        expect(shop.map((s) => s.connected)).toEqual([true]);
        expect(admin).toEqual([]);
        release();
        expect(shop.map((s) => s.connected)).toEqual([true, false]);
        expect(admin).toEqual([]);
    });
});

describe("several repositories sharing one dev server", () => {
    const tmp = () => tempDir(defer, "notato-scope-");
    const dev = async (options: { port?: number; projects?: string[] } = {}) => {
        const rt: DevRuntime = await runDev({
            port: options.port ?? 0,
            dir: tmp(),
            configFile: join(tmp(), "notato.config.json"),
            version: "t",
            stdio: false,
            projects: options.projects,
            log: () => {},
        });
        defer(() => rt.close());
        return rt;
    };

    it("keeps an attached agent to its projects, over the HTTP API, and says so only on their pages", async () => {
        const server = await dev();
        const local = server.local as LocalBackend;
        await add(local, "shop", "shop: the basket total is wrong");
        await add(local, "admin", "admin: the table header overlaps");
        await add(local, "blog", "blog: the byline is grey on grey");

        const attached = await dev({ port: server.port, projects: ["shop", "admin"] });
        expect(attached.role).toBe("client");
        expect(attached.projects).toEqual(["shop", "admin"]);
        const { call } = await connect(attached.mcp);
        const listed = text(await call("notato_list_open"));
        expect(listed).toContain("shop:");
        expect(listed).toContain("admin:");
        expect(listed).not.toContain("blog:");

        // The request above was its heartbeat.
        expect(local.agents.stateFor("shop").connected).toBe(true);
        expect(local.agents.stateFor("admin").connected).toBe(true);
        expect(local.agents.stateFor("blog").connected).toBe(false);
    });

    it("takes the projects from NOTATO_PROJECT when none are passed", async () => {
        const before = process.env.NOTATO_PROJECT;
        process.env.NOTATO_PROJECT = "shop,admin";
        defer(() => {
            if (before === undefined) delete process.env.NOTATO_PROJECT;
            else process.env.NOTATO_PROJECT = before;
        });
        expect((await dev()).projects).toEqual(["shop", "admin"]);
        expect((await dev({ projects: ["blog"] })).projects).toEqual(["blog"]);
    });

    it("keeps an agent connected to /mcp?project= to that project", async () => {
        const server = await dev();
        const local = server.local as LocalBackend;
        await add(local, "shop", "shop: the basket total is wrong");
        await add(local, "blog", "blog: the byline is grey on grey");
        const client = new Client({ name: "claude-code", version: "0" });
        await client.connect(
            new StreamableHTTPClientTransport(
                new URL(`http://127.0.0.1:${server.port}/mcp?project=shop`)
            )
        );
        defer(() => client.close());
        const listed = text(
            (await client.callTool({ name: "notato_list_open", arguments: {} })) as ToolResult
        );
        expect(listed).toContain("shop:");
        expect(listed).not.toContain("blog:");
        expect(local.agents.stateFor("shop").connected).toBe(true);
        expect(local.agents.stateFor("blog").connected).toBe(false);
    });
});
