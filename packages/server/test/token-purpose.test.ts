import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
    Authenticator,
    assertTokenPurpose,
    SqliteStore,
    type TokenRecord,
    tokenPurpose,
} from "../src/index.ts";
import { annotationFixture, cleanupAfterEach, filesFor, multipart } from "./helpers.ts";
import { adminCookie, bearer, issue, post, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
const start = () => startServe(defer);

async function rawToken(s: Awaited<ReturnType<typeof start>>, body: Record<string, unknown>) {
    const cookie = await adminCookie(s);
    return s.call("/admin/tokens", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-notato-board": "1" },
        body: JSON.stringify(body),
    });
}

describe("token purposes", () => {
    it("derives a purpose for tokens made before there were any", () => {
        expect(tokenPurpose({})).toBe("agent");
        expect(tokenPurpose({ permission: "capture" })).toBe("app");
        expect(tokenPurpose({ purpose: "app", permission: "full" })).toBe("app");
        expect(() => assertTokenPurpose({ purpose: "app", projectId: "*" })).toThrow();
        expect(() =>
            assertTokenPurpose({ purpose: "agent", permission: "capture", projectId: "p" })
        ).toThrow();
    });

    it("issues an app token for one project and an agent token for all of them, by default", async () => {
        const s = await start();
        await s.rt.backend.createProject("p");
        const app = (await (await rawToken(s, { projectId: "p", name: "app" })).json()) as {
            record: TokenRecord;
        };
        const agent = (await (await rawToken(s, { projectId: "*", name: "agent" })).json()) as {
            record: TokenRecord;
        };
        expect(app.record).toMatchObject({ purpose: "app", permission: "full" });
        expect(app.record).not.toHaveProperty("tokenHash");
        expect(agent.record).toMatchObject({ purpose: "agent", permission: "full" });
    });

    it("refuses purposes that contradict each other", async () => {
        const s = await start();
        await s.rt.backend.createProject("p");
        expect((await rawToken(s, { projectId: "*", name: "x", purpose: "app" })).status).toBe(400);
        expect(
            (
                await rawToken(s, {
                    projectId: "p",
                    name: "x",
                    purpose: "agent",
                    permission: "capture",
                })
            ).status
        ).toBe(400);
    });

    it("keeps an app token out of MCP and lets an agent token in", async () => {
        const s = await start();
        const app = await issue(s, "p");
        const agent = await issue(s, "p", "agent", { purpose: "agent" });
        const connect = (token: string) =>
            new Client({ name: "t", version: "1" }).connect(
                new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
                    requestInit: { headers: bearer(token) },
                })
            );
        await expect(connect(app)).rejects.toThrow();
        await connect(agent);
    });

    it("stops a capture-only token reading anything back, and makes its notes human", async () => {
        const s = await start();
        await s.rt.backend.createProject("p");
        const token = (await (
            await rawToken(s, { projectId: "p", name: "page", permission: "capture" })
        ).json()) as { token: string };
        const note = annotationFixture({
            projectId: "p",
            author: { kind: "agent", name: "pretend" },
        });
        const sent = await s.call("/projects/p/annotations", {
            method: "POST",
            headers: bearer(token.token),
            body: multipart(note, filesFor()),
        });
        expect(sent.status).toBe(201);
        const kept = (await s.rt.backend.get(note.id))?.annotation;
        expect(kept?.author.kind).toBe("human");
        expect(kept?.context).toMatchObject({ notatoCaptureSource: "unverified app feedback" });

        // Sending the same id again says no, and says nothing about what is stored.
        const again = await s.call("/projects/p/annotations", {
            method: "POST",
            headers: bearer(token.token),
            body: multipart(note, filesFor()),
        });
        expect(again.status).toBe(409);
        expect(
            (await s
                .call("/config?project=p", { headers: bearer(token.token) })
                .then((r) => r.json())) as {
                captureOnly: boolean;
            }
        ).toMatchObject({ captureOnly: true });
    });

    it("lets a capture-only token send notes and check its connection, and nothing else", async () => {
        const s = await start();
        await s.rt.backend.createProject("p");
        const token = (
            (await (
                await rawToken(s, { projectId: "p", name: "page", permission: "capture" })
            ).json()) as { token: string }
        ).token;
        const call = (path: string, init: RequestInit = {}) =>
            s.call(path, { ...init, headers: { ...bearer(token), ...(init.headers ?? {}) } });
        const note = annotationFixture({ projectId: "p" });
        await call("/projects/p/annotations", {
            method: "POST",
            body: multipart(note, filesFor()),
        });
        expect(
            await (await call("/projects/p/connection", { method: "POST" })).json()
        ).toMatchObject({
            ok: true,
            projectId: "p",
            captureOnly: true,
            tokenPurpose: "app",
        });
        for (const path of [
            "/projects/p/annotations",
            `/annotations/${note.id}`,
            "/projects/p/events",
            "/projects",
            "/status",
        ])
            expect((await call(path)).status).toBe(403);
        expect(
            (await call("/projects/p/events", { headers: { "x-notato-agent": "x" } })).status
        ).toBe(403);
    });

    it("keeps an app token away from agent operations", async () => {
        const s = await start();
        const app = await issue(s, "p");
        const agent = await issue(s, "p", "agent", { purpose: "agent" });
        const relay = (token: string) =>
            s.call("/relay/annotate", {
                method: "POST",
                headers: { ...bearer(token), "content-type": "application/json" },
                body: JSON.stringify({
                    projectId: "p",
                    target: "#x",
                    comment: "c",
                    timeoutMs: 1000,
                }),
            });
        expect((await relay(app)).status).toBe(403);
        // No page is connected, which is as far as an agent token gets.
        expect((await relay(agent)).status).toBe(409);
        expect(
            (
                await s.call("/annotations/handed", {
                    method: "POST",
                    headers: { ...bearer(app), "content-type": "application/json" },
                    body: JSON.stringify({ entries: [] }),
                })
            ).status
        ).toBe(403);
    });

    it("makes an agent token with a new project when asked, for that project only", async () => {
        const s = await start();
        const cookie = await adminCookie(s);
        const made = await s.call("/projects", {
            method: "POST",
            headers: { cookie, "content-type": "application/json", "x-notato-board": "1" },
            body: JSON.stringify({ id: "web", agent: true }),
        });
        expect(made.status).toBe(201);
        const body = (await made.json()) as {
            token: { token: string; record: TokenRecord };
            agentToken: { token: string; record: TokenRecord };
        };
        expect(body.token.record).toMatchObject({ purpose: "app", projectId: "web" });
        expect(body.agentToken.record).toMatchObject({ purpose: "agent", projectId: "web" });
        expect(body.agentToken.record).not.toHaveProperty("tokenHash");
        const plain = await s.call("/projects", {
            method: "POST",
            headers: { cookie, "content-type": "application/json", "x-notato-board": "1" },
            body: JSON.stringify({ id: "plain" }),
        });
        expect(await plain.json()).not.toHaveProperty("agentToken");
    });

    it("makes replies from an app token human whatever they claim", async () => {
        const s = await start();
        const app = await issue(s, "p");
        const { a } = await post(s, app, "p");
        const replied = await s.call(`/annotations/${a.id}/replies`, {
            method: "POST",
            headers: { ...bearer(app), "content-type": "application/json" },
            body: JSON.stringify({ body: "hi", author: { kind: "agent", name: "bot" } }),
        });
        expect(replied.status).toBe(201);
        const thread = (await s.rt.backend.get(a.id))?.annotation.thread ?? [];
        expect(thread.at(-1)?.author.kind).toBe("human");
    });

    it("stops an expired token working", async () => {
        const store = new SqliteStore(":memory:");
        await store.createProject({ id: "p", name: "p", createdAt: "2026-01-01T00:00:00.000Z" });
        let clock = new Date("2026-01-01T00:00:00.000Z");
        const auth = new Authenticator(store, { now: () => clock });
        const { token, record } = await auth.issueToken("p", "short", { expiresInDays: 1 });
        expect(record.expiresAt).toBe("2026-01-02T00:00:00.000Z");
        const ask = () =>
            auth.identify(
                new Request("http://x/", { headers: bearer(token) }),
                new URL("http://x/")
            );
        expect(await ask()).toMatchObject({ kind: "token", purpose: "app" });
        clock = new Date("2026-01-02T00:00:01.000Z");
        expect(await ask()).toBeNull();
        store.close();
    });
});
