import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Annotation } from "@notato/schema";
import { TOKEN_PREFIX } from "../src/index.ts";
import { cleanupAfterEach, waitFor } from "./helpers.ts";
import { bearer, issue, post, type Server, startServe } from "./serve-helpers.ts";

// `/mcp` on a shared server: agents connect with a token, and a project token keeps its agent to that project.

const defer = cleanupAfterEach();
const start = (options: Parameters<typeof startServe>[1] = {}) => startServe(defer, options);

describe("MCP over streamable HTTP", () => {
    async function mcpClient(s: Server, token: string | null) {
        const client = new Client({ name: "remote", version: "0" });
        const transport = new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
            requestInit: { headers: token ? bearer(token) : {} },
        });
        await client.connect(transport);
        defer(() => client.close().catch(() => {}));
        const call = async (name: string, args: Record<string, unknown> = {}) =>
            (await client.callTool({ name, arguments: args })) as unknown as {
                isError?: boolean;
                content: Array<{ type: string; text?: string }>;
            };
        return { client, call };
    }
    const text = (r: { content: Array<{ text?: string }> }) =>
        r.content.map((c) => c.text ?? "").join("\n");

    it("counts an open session as an agent being there, by its name, until it closes", async () => {
        const s = await start();
        const agent = await issue(s, "*", "claude");
        const { client } = await mcpClient(s, agent);
        // Pages show an agent is there from this: one with the MCP open counts even while it is not watching.
        expect(s.rt.backend.agents.state).toMatchObject({ connected: true, names: ["Remote"] });
        await (client.transport as StreamableHTTPClientTransport).terminateSession();
        await client.close();
        expect(await waitFor(() => !s.rt.backend.agents.state.connected)).toBe(true);
    });

    it("refuses to connect without a valid token", async () => {
        const s = await start();
        await expect(mcpClient(s, null)).rejects.toThrow();
        await expect(mcpClient(s, `${TOKEN_PREFIX}wrong`)).rejects.toThrow();
        const raw = await s.call("/mcp", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
            },
            body: "{}",
        });
        expect(raw.status).toBe(401);
    });

    it("serves the tools and sees what two browsers posted, each with its own project token", async () => {
        const s = await start();
        const alpha = await issue(s, "alpha", "browser-1");
        const beta = await issue(s, "beta", "browser-2");
        const agent = await issue(s, "*", "claude");
        await post(s, alpha, "alpha", { comment: "from the first machine" });
        await post(s, beta, "beta", { comment: "from the second machine" });

        const remote = await mcpClient(s, agent);
        expect((await remote.client.listTools()).tools.map((t) => t.name)).toContain(
            "notato_watch"
        );
        const listed = text(await remote.call("notato_list_open"));
        expect(listed).toContain("from the first machine");
        expect(listed).toContain("from the second machine");

        // And with images, so Claude sees both screens.
        const watched = await remote.call("notato_watch", { timeoutSeconds: 5, windowMs: 0 });
        expect(text(watched)).toContain("2 new annotations");
        expect(watched.content.filter((c) => c.type === "image")).toHaveLength(4);
    });

    it("is woken by an annotation posted while it waits", async () => {
        const s = await start();
        const browser = await issue(s, "p");
        const agent = await issue(s, "*");
        const remote = await mcpClient(s, agent);
        const waiting = remote.call("notato_watch", {
            timeoutSeconds: 20,
            windowMs: 0,
            screenshots: "none",
        });
        await new Promise((r) => setTimeout(r, 200));
        await post(s, browser, "p", { comment: "posted while watching" });
        expect(text(await waiting)).toContain("posted while watching");
    });

    it("lets claude resolve what a browser posted, and the browser's token sees the result", async () => {
        const s = await start();
        const browser = await issue(s, "p");
        const agent = await issue(s, "*");
        const { a } = await post(s, browser, "p", { comment: "fix me" });
        const remote = await mcpClient(s, agent);
        await remote.call("notato_resolve", { id: a.id, summary: "Fixed it" });
        const seen = (await (
            await s.call(`/annotations/${a.id}`, { headers: bearer(browser) })
        ).json()) as {
            annotation: Annotation;
        };
        expect(seen.annotation.status).toBe("resolved");
        expect(seen.annotation.thread[0]?.body).toBe("Resolved: Fixed it");
    });

    it("confines a project token's MCP session to that project", async () => {
        const s = await start();
        const alpha = await issue(s, "alpha");
        const beta = await issue(s, "beta");
        await post(s, alpha, "alpha", { comment: "alpha only" });
        const other = (await post(s, beta, "beta", { comment: "beta only" })).a;

        const remote = await mcpClient(s, alpha);
        const listed = text(await remote.call("notato_list_open"));
        expect(listed).toContain("alpha only");
        expect(listed).not.toContain("beta only");
        expect((await remote.call("notato_get", { id: other.id })).isError).toBe(true);
        expect((await remote.call("notato_resolve", { id: other.id, summary: "x" })).isError).toBe(
            true
        );
        const asked = await remote.call("notato_list_open", { projectId: "beta" });
        expect(asked.isError).toBe(true);
        expect(text(asked)).not.toContain("beta only");
        expect((await s.rt.backend.get(other.id))?.annotation.status).toBe("open");
        const watched = text(
            await remote.call("notato_watch", { projectId: "beta", timeoutSeconds: 1, windowMs: 0 })
        );
        expect(watched).not.toContain("beta only");
    });

    it("does not read files from the server's disk", async () => {
        const s = await start();
        const agent = await issue(s, "*");
        const remote = await mcpClient(s, agent);
        const result = await remote.call("notato_import_bundle", { path: "/etc/hosts" });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("does not read files from disk");
    });

    it("keeps a separate watch cursor per session", async () => {
        const s = await start();
        const browser = await issue(s, "p");
        const agent = await issue(s, "*");
        await post(s, browser, "p", { comment: "backlog item" });
        const one = await mcpClient(s, agent);
        expect(
            text(
                await one.call("notato_watch", {
                    timeoutSeconds: 5,
                    windowMs: 0,
                    screenshots: "none",
                })
            )
        ).toContain("backlog item");
        const two = await mcpClient(s, agent);
        expect(
            text(
                await two.call("notato_watch", {
                    timeoutSeconds: 5,
                    windowMs: 0,
                    screenshots: "none",
                })
            )
        ).toContain("backlog item");
        expect(text(await one.call("notato_watch", { timeoutSeconds: 1, windowMs: 0 }))).toContain(
            "No new annotations"
        );
    });
});
