import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Annotation } from "@notato/schema";
import { runServe } from "../src/index.ts";
import { annotationFixture, ingest, makeApp, multipart } from "./helpers.ts";

let ctx: ReturnType<typeof makeApp> | undefined;
const serves: Array<Awaited<ReturnType<typeof runServe>>> = [];
const dirs: string[] = [];
afterEach(async () => {
    ctx?.cleanup();
    ctx = undefined;
    for (const s of serves.splice(0)) await s.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A shared server, an admin cookie, and a way to call it. */
async function shared() {
    const dir = mkdtempSync(join(tmpdir(), "notato-projects-"));
    dirs.push(dir);
    const rt = await runServe({
        port: 0,
        dir,
        version: "t",
        adminPassword: "correct horse",
        log: () => {},
    });
    serves.push(rt);
    const base = `http://127.0.0.1:${rt.port}`;
    const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
    const login = await call("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "correct horse" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const asAdmin = (init: RequestInit = {}) => ({
        ...init,
        headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    return { rt, base, call, asAdmin };
}

const send = (
    call: (path: string, init?: RequestInit) => Promise<Response>,
    annotation: Annotation,
    headers: Record<string, string> = {}
) =>
    call(`/projects/${annotation.projectId}/annotations`, {
        method: "POST",
        headers,
        body: multipart(annotation),
    });

describe("projects on a shared server", () => {
    it("must be created before an app can send to them, and come with their first token", async () => {
        const s = await shared();
        const note = annotationFixture({ projectId: "shop" });
        // No such project: a typo or a stray app cannot invent one.
        const refused = await send(s.call, note, { cookie: s.asAdmin().headers.cookie });
        expect(refused.status).toBe(404);
        expect(((await refused.json()) as { error: string }).error).toContain(
            "notato project create shop"
        );
        const tokenFirst = await s.call(
            "/admin/tokens",
            s.asAdmin({ method: "POST", body: JSON.stringify({ projectId: "shop", name: "x" }) })
        );
        expect(tokenFirst.status).toBe(404);

        const created = await s.call(
            "/projects",
            s.asAdmin({ method: "POST", body: JSON.stringify({ id: "shop", name: "The shop" }) })
        );
        expect(created.status).toBe(201);
        const body = (await created.json()) as {
            project: { id: string; name: string; annotations: number };
            token: { token: string; record: { projectId: string; tokenHash?: string } };
        };
        expect(body.project).toMatchObject({ id: "shop", name: "The shop", annotations: 0 });
        expect(body.token.record.projectId).toBe("shop");
        expect(body.token.record.tokenHash).toBeUndefined();
        const sent = await send(s.call, note, { authorization: `Bearer ${body.token.token}` });
        expect(sent.status).toBe(201);

        const again = await s.call(
            "/projects",
            s.asAdmin({ method: "POST", body: JSON.stringify({ id: "shop" }) })
        );
        expect(again.status).toBe(409);
    });

    it("are listed with no notes yet, renamed, and deleted with their notes and tokens", async () => {
        const s = await shared();
        const { token } = (await (
            await s.call(
                "/projects",
                s.asAdmin({ method: "POST", body: JSON.stringify({ id: "shop" }) })
            )
        ).json()) as { token: { token: string } };
        const list = (await (await s.call("/projects", s.asAdmin())).json()) as {
            items: Array<{ id: string; name: string }>;
        };
        expect(list.items.map((p) => p.id)).toEqual(["shop"]);

        const renamed = await s.call(
            "/projects/shop",
            s.asAdmin({ method: "PATCH", body: JSON.stringify({ name: "  Shop\nfront  " }) })
        );
        expect(((await renamed.json()) as { name: string }).name).toBe("Shop front");

        const bearer = { authorization: `Bearer ${token.token}` };
        const sent = (await (
            await send(s.call, annotationFixture({ projectId: "shop" }), bearer)
        ).json()) as { annotation: Annotation };
        const shot = sent.annotation.screenshots?.full.id as string;
        expect((await s.call(`/assets/${shot}`, { headers: bearer })).status).toBe(200);

        // A token cannot delete its own project; an admin can.
        expect((await s.call("/projects/shop", { method: "DELETE", headers: bearer })).status).toBe(
            403
        );
        expect((await s.call("/projects/shop", s.asAdmin({ method: "DELETE" }))).status).toBe(204);
        expect(await s.rt.backend.list({ projectId: "shop" })).toEqual([]);
        expect((await s.call(`/assets/${shot}`, s.asAdmin())).status).toBe(404);
        // Its token stopped working with it.
        expect((await s.call("/projects/shop/annotations", { headers: bearer })).status).toBe(401);
    });

    it("are changed only from the board, never from an app's page", async () => {
        const s = await shared();
        const foreign = await s.call(
            "/projects",
            s.asAdmin({
                method: "POST",
                headers: { origin: "http://localhost:3000" },
                body: JSON.stringify({ id: "shop" }),
            })
        );
        expect(foreign.status).toBe(403);
        expect(await s.rt.store.getProject("shop")).toBeNull();
    });
});

describe("projects on a local dev server", () => {
    it("are made by the first note, with no token to hand out", async () => {
        ctx = makeApp();
        const { res } = await ingest(ctx.call, { projectId: "fresh-app" });
        expect(res.status).toBe(201);
        expect((await ctx.store.getProject("fresh-app"))?.name).toBe("fresh-app");
        const created = await ctx.call("/projects", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: "second", name: "Second" }),
        });
        expect(created.status).toBe(201);
        expect(((await created.json()) as { token?: unknown }).token).toBeUndefined();
    });

    it("cannot be deleted by a page on a local network", async () => {
        ctx = makeApp();
        await ingest(ctx.call, { projectId: "keep" });
        const res = await ctx.call("/projects/keep", {
            method: "DELETE",
            headers: { origin: "http://192.168.1.20:5173" },
        });
        expect(res.status).toBe(403);
        expect(await ctx.backend.list({ projectId: "keep" })).toHaveLength(1);
    });

    it("refuse an id that is only dots", async () => {
        ctx = makeApp();
        const res = await ctx.call("/projects", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: ".." }),
        });
        expect(res.status).toBe(400);
    });
});

describe("one project cannot reach another's notes", () => {
    it("by sending a note with an id the other project already uses", async () => {
        const s = await shared();
        const tokens: Record<string, string> = {};
        for (const id of ["alpha", "beta"]) {
            tokens[id] = (
                (await (
                    await s.call(
                        "/projects",
                        s.asAdmin({ method: "POST", body: JSON.stringify({ id }) })
                    )
                ).json()) as { token: { token: string } }
            ).token.token;
        }
        const secret = annotationFixture({ projectId: "alpha", comment: "the alpha secret" });
        expect(
            (await send(s.call, secret, { authorization: `Bearer ${tokens.alpha}` })).status
        ).toBe(201);
        const copy = { ...secret, projectId: "beta", comment: "anything" };
        const res = await send(s.call, copy, { authorization: `Bearer ${tokens.beta}` });
        expect(res.status).toBe(409);
        expect(await res.text()).not.toContain("the alpha secret");
    });

    it("by fetching or reusing its screenshots by hash", async () => {
        const s = await shared();
        const tokens: Record<string, string> = {};
        for (const id of ["alpha", "beta"]) {
            tokens[id] = (
                (await (
                    await s.call(
                        "/projects",
                        s.asAdmin({ method: "POST", body: JSON.stringify({ id }) })
                    )
                ).json()) as { token: { token: string } }
            ).token.token;
        }
        const sent = (await (
            await send(s.call, annotationFixture({ projectId: "alpha" }), {
                authorization: `Bearer ${tokens.alpha}`,
            })
        ).json()) as { annotation: Annotation };
        const shot = sent.annotation.screenshots?.full as NonNullable<
            Annotation["screenshots"]
        >["full"];
        const beta = { authorization: `Bearer ${tokens.beta}` };
        expect((await s.call(`/assets/${shot.id}`, { headers: beta })).status).toBe(404);
        // Naming the hash without sending the bytes does not copy the image into beta.
        const adopt = annotationFixture({
            projectId: "beta",
            screenshots: { full: shot },
        });
        const res = await s.call("/projects/beta/annotations", {
            method: "POST",
            headers: beta,
            body: multipart(adopt, new Map()),
        });
        expect(res.status).toBe(400);
        expect((await s.call(`/assets/${shot.id}`, { headers: beta })).status).toBe(404);
    });
});

describe("lists and exports", () => {
    it("page with a cursor, and an export has every note", async () => {
        ctx = makeApp();
        for (let i = 0; i < 7; i += 1) {
            await ctx.backend.ingest(
                annotationFixture({ projectId: "big", screenshots: undefined }),
                new Map()
            );
        }
        const first = (await (await ctx.call("/projects/big/annotations?limit=5")).json()) as {
            items: Array<{ seq: number }>;
            next?: number;
        };
        expect(first.items).toHaveLength(5);
        expect(first.next).toBe(first.items[4]?.seq);
        const rest = (await (
            await ctx.call(`/projects/big/annotations?limit=5&afterSeq=${first.next}`)
        ).json()) as { items: unknown[]; next?: number };
        expect(rest.items).toHaveLength(2);
        expect(rest.next).toBeUndefined();

        for (let i = 0; i < 200; i += 1) {
            await ctx.backend.ingest(
                annotationFixture({ projectId: "big", screenshots: undefined }),
                new Map()
            );
        }
        const markdown = await (await ctx.call("/projects/big/markdown?detail=compact")).text();
        expect(markdown.match(/comment \d+/g)?.length).toBe(207);
    });
});

describe("PATCH /annotations/:id", () => {
    it("changes nothing when part of the change is refused", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        const res = await ctx.call(`/annotations/${annotation.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ severity: "blocker", status: "revert_requested" }),
        });
        expect(res.status).toBe(409);
        expect((await ctx.backend.get(annotation.id))?.annotation.severity).toBe(
            annotation.severity
        );
    });

    it("can be sent as a POST that says it means PATCH, for HTTP stacks without PATCH", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        const res = await ctx.call(`/annotations/${annotation.id}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-http-method-override": "PATCH" },
            body: JSON.stringify({ status: "acknowledged" }),
        });
        expect(res.status).toBe(200);
        expect((await ctx.backend.get(annotation.id))?.annotation.status).toBe("acknowledged");
    });

    it("leaves a reply when a finished note is reopened without one, so a watching agent hears of it", async () => {
        ctx = makeApp();
        const { annotation } = await ingest(ctx.call);
        await ctx.backend.setStatus(annotation.id, "resolved", "Done.", { kind: "agent" });
        await ctx.call(`/annotations/${annotation.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "open" }),
        });
        const thread = (await ctx.backend.get(annotation.id))?.annotation.thread ?? [];
        expect(thread.at(-1)).toMatchObject({ author: { kind: "human" }, body: "Reopened." });
    });
});

describe("annotation ids", () => {
    it("are refused when they could name a folder outside an SDK's store", async () => {
        ctx = makeApp();
        const bad = annotationFixture({ id: "../.." });
        const res = await ctx.call(`/projects/${bad.projectId}/annotations`, {
            method: "POST",
            body: multipart(bad),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain("id");
    });
});

describe("notes by who wrote them", () => {
    it("with no name on them can be asked for on their own, for an export of what an unnamed agent wrote", async () => {
        ctx = makeApp();
        await ingest(ctx.call, { projectId: "w", author: { kind: "agent" } });
        await ingest(ctx.call, { projectId: "w", author: { kind: "agent", name: "Codex" } });
        const list = (await (
            await ctx.call("/projects/w/annotations?author=agent&unnamed=1")
        ).json()) as { items: Array<{ annotation: Annotation }> };
        expect(list.items.map((i) => i.annotation.author.name)).toEqual([undefined]);
    });

    it("can be asked for by the name of who wrote them, as JSON and as Markdown", async () => {
        const app = makeApp();
        ctx = app;
        await ingest(app.call, { comment: "from dom", author: { kind: "human", name: "Dom" } });
        await ingest(app.call, { comment: "from ana", author: { kind: "human", name: "Ana" } });
        await ingest(app.call, { comment: "from an agent", author: { kind: "agent" } });
        const by = async (name: string) =>
            (
                (await (
                    await app.call(
                        `/projects/checkout-web/annotations?by=${encodeURIComponent(name)}`
                    )
                ).json()) as {
                    items: Array<{ annotation: Annotation }>;
                }
            ).items.map((i) => i.annotation.comment);
        expect(await by("Dom")).toEqual(["from dom"]);
        expect(await by("Ana")).toEqual(["from ana"]);
        expect(await by("Nobody")).toEqual([]);
        expect(
            await (await app.call("/projects/checkout-web/markdown?by=Ana&detail=compact")).text()
        ).toContain("from ana");
    });
});
