import { describe, expect, it } from "bun:test";
import type { Annotation } from "@notato/schema";
import { TOKEN_PREFIX } from "../src/index.ts";
import {
    annotationFixture,
    cleanupAfterEach,
    makeBundleZip,
    multipart,
    waitFor,
} from "./helpers.ts";
import {
    adminCookie,
    bearer,
    createProject,
    issue,
    post,
    sse,
    startServe,
} from "./serve-helpers.ts";

// Project tokens on a shared server: how the admin issues and revokes them, and how far each one reaches.

const defer = cleanupAfterEach();
const start = (options: Parameters<typeof startServe>[1] = {}) => startServe(defer, options);

describe("project tokens", () => {
    it("are created by the admin, shown once, listed without their secret, and revocable", async () => {
        const s = await start();
        const cookie = await adminCookie(s);
        await createProject(s, "checkout-web");
        const created = await s.call("/admin/tokens", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ projectId: "checkout-web", name: "ci" }),
        });
        const { token, record } = (await created.json()) as {
            token: string;
            record: Record<string, string>;
        };
        expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
        expect(token.length).toBeGreaterThan(40);
        expect(record.tokenHash).toBeUndefined();

        const list = (await (await s.call("/admin/tokens", { headers: { cookie } })).json()) as {
            items: Array<Record<string, string>>;
        };
        expect(list.items).toHaveLength(1);
        expect(JSON.stringify(list)).not.toContain(token);
        expect(list.items[0]).toMatchObject({ projectId: "checkout-web", name: "ci" });
        expect(list.items[0]?.tokenHash).toBeUndefined();

        expect((await s.call("/projects", { headers: bearer(token) })).status).toBe(200);
        expect(
            (await s.call(`/admin/tokens/${record.id}`, { method: "DELETE", headers: { cookie } }))
                .status
        ).toBe(204);
        expect((await s.call("/projects", { headers: bearer(token) })).status).toBe(401);
        expect(
            (await s.call(`/admin/tokens/${record.id}`, { method: "DELETE", headers: { cookie } }))
                .status
        ).toBe(404);
    });

    it("never store the plaintext", async () => {
        const s = await start();
        const token = await issue(s, "p");
        const dump = JSON.stringify(await s.rt.store.listTokens());
        expect(dump).not.toContain(token);
        expect(dump).not.toContain(token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 16));
    });

    it("cannot administer: no token listing, issuing or revoking", async () => {
        const s = await start();
        const token = await issue(s, "*");
        expect((await s.call("/admin/tokens", { headers: bearer(token) })).status).toBe(403);
        expect(
            (
                await s.call("/admin/tokens", {
                    method: "POST",
                    headers: { ...bearer(token), "content-type": "application/json" },
                    body: JSON.stringify({ projectId: "p", name: "x" }),
                })
            ).status
        ).toBe(403);
    });

    it("validate what the admin asks for", async () => {
        const s = await start();
        const cookie = await adminCookie(s);
        const bad = async (body: unknown) =>
            (
                await s.call("/admin/tokens", {
                    method: "POST",
                    headers: { cookie, "content-type": "application/json" },
                    body: JSON.stringify(body),
                })
            ).status;
        expect(await bad({ projectId: "has space", name: "x" })).toBe(400);
        expect(await bad({ projectId: "p", name: "" })).toBe(400);
        expect(await bad({ name: "x" })).toBe(400);
    });

    it("record when they were last used", async () => {
        const s = await start();
        const token = await issue(s, "p");
        await s.call("/projects", { headers: bearer(token) });
        expect(
            await waitFor(async () => (await s.rt.store.listTokens())[0]?.lastUsedAt !== undefined)
        ).toBe(true);
    });
});

describe("one project's token against another project", () => {
    async function twoProjects() {
        const s = await start();
        const a = await issue(s, "alpha");
        const b = await issue(s, "beta");
        const all = await issue(s, "*");
        const alpha = (await post(s, a, "alpha", { comment: "alpha note" })).a;
        const beta = (await post(s, b, "beta", { comment: "beta note" })).a;
        return { s, a, b, all, alpha, beta };
    }

    it("lets a token read and write its own project", async () => {
        const { s, a, alpha } = await twoProjects();
        expect((await s.call(`/projects/alpha/annotations`, { headers: bearer(a) })).status).toBe(
            200
        );
        expect((await s.call(`/annotations/${alpha.id}`, { headers: bearer(a) })).status).toBe(200);
        const patched = await s.call(`/annotations/${alpha.id}`, {
            method: "PATCH",
            headers: bearer(a),
            body: JSON.stringify({ status: "acknowledged" }),
        });
        expect(patched.status).toBe(200);
        expect(
            (
                await s.call(`/annotations/${alpha.id}/replies`, {
                    method: "POST",
                    headers: bearer(a),
                    body: JSON.stringify({ body: "hi" }),
                })
            ).status
        ).toBe(201);
    });

    it("forbids reading, writing and listing another project, by project URL", async () => {
        const { s, a } = await twoProjects();
        for (const [path, init] of [
            ["/projects/beta/annotations", {}],
            ["/projects/beta/events", {}],
            ["/projects/beta/bundles", {}],
            ["/projects/beta/export", {}],
        ] as const) {
            expect((await s.call(path, { ...init, headers: bearer(a) })).status, path).toBe(403);
        }
        const betaPost = annotationFixture({ projectId: "beta" });
        expect(
            (
                await s.call("/projects/beta/annotations", {
                    method: "POST",
                    headers: bearer(a),
                    body: multipart(betaPost),
                })
            ).status
        ).toBe(403);
        expect((await s.call("/projects/*/events", { headers: bearer(a) })).status).toBe(403);
    });

    it("forbids reaching another project's data by id", async () => {
        const { s, a, beta } = await twoProjects();
        expect((await s.call(`/annotations/${beta.id}`, { headers: bearer(a) })).status).toBe(403);
        expect(
            (
                await s.call(`/annotations/${beta.id}`, {
                    method: "PATCH",
                    headers: bearer(a),
                    body: JSON.stringify({ status: "resolved" }),
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call(`/annotations/${beta.id}/replies`, {
                    method: "POST",
                    headers: bearer(a),
                    body: JSON.stringify({ body: "x" }),
                })
            ).status
        ).toBe(403);
        expect(
            (await s.call(`/annotations/${beta.id}`, { method: "DELETE", headers: bearer(a) }))
                .status
        ).toBe(403);
        // ...and the data is untouched.
        expect((await s.rt.backend.get(beta.id))?.annotation).toMatchObject({
            status: "open",
            thread: [],
        });
    });

    it("confines list, wait and status to the token's own project", async () => {
        const { s, a, all } = await twoProjects();
        const comments = async (token: string, qs = "") =>
            (
                (await (await s.call(`/annotations${qs}`, { headers: bearer(token) })).json()) as {
                    items: Array<{ annotation: Annotation }>;
                }
            ).items.map((i) => i.annotation.comment);
        expect(await comments(a)).toEqual(["alpha note"]);
        expect(await comments(a, "?project=alpha")).toEqual(["alpha note"]);
        expect((await s.call("/annotations?project=beta", { headers: bearer(a) })).status).toBe(
            403
        );
        expect((await comments(all)).sort()).toEqual(["alpha note", "beta note"]);

        const wait = (await (
            await s.call("/annotations/wait?timeoutMs=50&status=open", { headers: bearer(a) })
        ).json()) as { ready: boolean };
        expect(wait.ready).toBe(true);
        const status = (await (await s.call("/status", { headers: bearer(a) })).json()) as {
            projects: Array<{ id: string }>;
        };
        expect(status.projects.map((p) => p.id)).toEqual(["alpha"]);
        const projects = (await (await s.call("/projects", { headers: bearer(a) })).json()) as {
            items: Array<{ id: string }>;
        };
        expect(projects.items.map((p) => p.id)).toEqual(["alpha"]);
    });

    it("lets a * token and the admin see everything", async () => {
        const { s, all, beta } = await twoProjects();
        expect((await s.call(`/annotations/${beta.id}`, { headers: bearer(all) })).status).toBe(
            200
        );
        expect((await s.call("/projects/beta/annotations", { headers: bearer(all) })).status).toBe(
            200
        );
        const cookie = await adminCookie(s);
        expect((await s.call(`/annotations/${beta.id}`, { headers: { cookie } })).status).toBe(200);
        const status = (await (await s.call("/status", { headers: { cookie } })).json()) as {
            projects: unknown[];
        };
        expect(status.projects).toHaveLength(2);
    });

    it("scopes bundles: import is held to the token's project, export to what it can see", async () => {
        const { s, a, b } = await twoProjects();
        const { zip } = await makeBundleZip(1, () => ({ projectId: "beta" }), {
            projectId: "beta",
            id: "BUNDLE-BETA",
        });
        const asAlpha = await s.call("/bundles", {
            method: "POST",
            headers: { ...bearer(a), "content-type": "application/zip" },
            body: zip as BodyInit,
        });
        expect(asAlpha.status).toBe(400);
        expect(await asAlpha.text()).toContain("not");
        expect(
            (
                await s.call("/projects/beta/bundles", {
                    method: "POST",
                    headers: { ...bearer(a), "content-type": "application/zip" },
                    body: zip as BodyInit,
                })
            ).status
        ).toBe(403);

        const asBeta = await s.call("/bundles", {
            method: "POST",
            headers: { ...bearer(b), "content-type": "application/zip" },
            body: zip as BodyInit,
        });
        expect(asBeta.status).toBe(201);
        expect((await s.call("/bundles/BUNDLE-BETA", { headers: bearer(a) })).status).toBe(403);
        expect((await s.call("/bundles/BUNDLE-BETA/export", { headers: bearer(a) })).status).toBe(
            403
        );
        expect((await s.call("/bundles/BUNDLE-BETA/export", { headers: bearer(b) })).status).toBe(
            200
        );
    });

    it("scopes the agent relay: only to its own project's page, and results only from it", async () => {
        const { s, a, b } = await twoProjects();
        // A beta page registers (agent=1) and waits for a request.
        const controller = new AbortController();
        const events = await s.call("/projects/beta/events?agent=1", {
            headers: bearer(b),
            signal: controller.signal,
        });
        const next = sse(events);
        await next("hello");

        // alpha's token cannot aim a relay request at beta, by body or by omission.
        const aimed = await s.call("/relay/annotate", {
            method: "POST",
            headers: bearer(a),
            body: JSON.stringify({ projectId: "beta", target: "#x", comment: "c" }),
        });
        expect(aimed.status).toBe(403);
        const implicit = await s.call("/relay/annotate", {
            method: "POST",
            headers: bearer(a),
            body: JSON.stringify({ target: "#x", comment: "c", timeoutMs: 1000 }),
        });
        expect(implicit.status).toBe(409); // alpha has no page; it never touches beta's

        // beta asks its own page; alpha's token cannot answer for it.
        const pending = s.call("/relay/annotate", {
            method: "POST",
            headers: bearer(b),
            body: JSON.stringify({ target: "#x", comment: "c", timeoutMs: 5000 }),
        });
        const { requestId } = (await next("annotate-request")) as { requestId: string };
        expect(requestId).toBeDefined();
        expect(
            (
                await s.call(`/relay/${requestId}/result`, {
                    method: "POST",
                    headers: bearer(a),
                    body: JSON.stringify({ ok: false, error: "forged" }),
                })
            ).status
        ).toBe(403);
        expect(
            (
                await s.call(`/relay/${requestId}/result`, {
                    method: "POST",
                    headers: bearer(b),
                    body: JSON.stringify({ ok: false, error: "no element" }),
                })
            ).status
        ).toBe(200);
        expect(await (await pending).json()).toEqual({ ok: false, error: "no element" });
        controller.abort();
    });
});
