import { describe, expect, it } from "bun:test";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import {
    Authenticator,
    createApp,
    FileBlobStore,
    LocalBackend,
    SqliteStore,
    TeamCoordinator,
    teamBackend,
    type WorkRecord,
    workId,
} from "../src/index.ts";
import { cleanupAfterEach, PNG, tempDir } from "./helpers.ts";

const defer = cleanupAfterEach();
async function setup() {
    const dir = tempDir(defer),
        store = new SqliteStore(`${dir}/team.db`),
        backend = new LocalBackend(store, new FileBlobStore(`${dir}/assets`));
    defer(() => {
        backend.agents.stop();
        store.close();
    });
    await backend.createProject("shop");
    const teams = new TeamCoordinator(store),
        contexts = await Promise.all(
            ["Dominic", "Sam", "Priya", "Alex"].map((name) =>
                teams.create("shop", name, name, `feature/${name.toLowerCase()}`)
            )
        );
    const app = createApp({ backend, mode: "dev", version: "test" });
    const auth = new Authenticator(store);
    const token = async (contextId: string, purpose: "app" | "agent") =>
        (
            await auth.issueToken("shop", purpose, {
                developmentContextId: contextId,
                purpose,
                permission: purpose === "app" ? "capture" : "full",
            })
        ).token;
    const call = (path: string, method = "GET", body?: unknown, bearer?: string) =>
        app(
            new Request(`http://localhost:4899${path}`, {
                method,
                headers: {
                    Host: "localhost:4899",
                    "X-Notato-Board": "1",
                    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
        );
    const note = async (id: string, contextId?: string, review?: Annotation["review"]) => {
        const a = {
            ...sampleAnnotation,
            id,
            projectId: "shop",
            screenshots: undefined,
            review,
            thread: [],
        };
        if (contextId) await teams.route(a, contextId);
        return (await backend.ingest(a, new Map())).stored.annotation;
    };
    return { store, backend, teams, contexts, app, token, call, note };
}
describe("checkout ownership", () => {
    it("isolates four developers, direct IDs, assets, export and legacy agents", async () => {
        const s = await setup();
        for (const [i, c] of s.contexts.entries()) await s.note(`note-${i}`, c.id);
        for (const [i, c] of s.contexts.entries()) {
            const t = await s.token(c.id, "agent");
            const list = (await (
                await s.call("/projects/shop/annotations", "GET", undefined, t)
            ).json()) as { items: Array<{ annotation: Annotation }> };
            expect(list.items.map((i) => i.annotation.id)).toEqual([`note-${i}`]);
            expect(
                (await s.call(`/annotations/note-${(i + 1) % 4}`, "GET", undefined, t)).status
            ).toBe(404);
            const agent = teamBackend(s.backend, s.store, c.id, async () => {});
            expect((await agent.list()).map((i) => i.annotation.id)).toEqual([`note-${i}`]);
            expect(await agent.get(`note-${(i + 1) % 4}`)).toBeNull();
        }
        const legacy = (
            await new Authenticator(s.store).issueToken("shop", "legacy", { purpose: "agent" })
        ).token;
        expect(
            (
                (await (
                    await s.call("/projects/shop/annotations", "GET", undefined, legacy)
                ).json()) as { items: unknown[] }
            ).items
        ).toEqual([]);
        expect((await s.call("/projects/shop/annotations")).status).toBe(200);
    });
    it("lets only one agent claim a whole review and fences stale mutations after reassignment", async () => {
        const s = await setup(),
            [a, b] = s.contexts;
        const n = await s.note("target-1", a!.id, {
            id: "review-one",
            instruction: "Fix both",
            total: 2,
        });
        const one = teamBackend(s.backend, s.store, a!.id, async () => {}),
            two = teamBackend(s.backend, s.store, a!.id, async () => {});
        await expect(one.claimWork!(n.id, "claim")).rejects.toThrow("every review target");
        await expect(s.teams.assign(n, b!.id, "manager")).rejects.toThrow("every review target");
        await s.note("target-2", a!.id, n.review);
        const races = await Promise.allSettled([
            one.claimWork!(n.id, "claim"),
            two.claimWork!(n.id, "claim"),
        ]);
        expect(races.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const winner = races[0]!.status === "fulfilled" ? one : two,
            loser = winner === one ? two : one;
        await expect(loser.setStatus("target-2", "acknowledged")).rejects.toThrow("notato_claim");
        expect(await loser.list()).toHaveLength(0);
        await winner.setStatus("target-2", "acknowledged");
        await expect(s.teams.assign(n, b!.id, "manager")).rejects.toThrow("Confirm recovery");
        await s.teams.assign(n, b!.id, "manager", true);
        await expect(winner.setStatus("target-2", "resolved")).rejects.toThrow();
        expect(await teamBackend(s.backend, s.store, b!.id, async () => {}).list()).toHaveLength(2);
    });
    it("requires human recovery after lease expiry and archive revokes existing sessions", async () => {
        const s = await setup(),
            c = s.contexts[0]!,
            n = await s.note("lease-note", c.id),
            agent = teamBackend(s.backend, s.store, c.id, async () => {});
        await agent.claimWork!(n.id, "claim");
        await s.teams.records.change<WorkRecord>(workId(n), "shop", "work", (r) => ({
            ...r!,
            claim: { ...r!.claim!, expiresAt: Date.now() - 1 },
        }));
        await expect(agent.reply(n.id, "Late reply")).rejects.toThrow("expired");
        await expect(agent.claimWork!(n.id, "claim")).rejects.toThrow("recover");
        await s.teams.assign(n, c.id, "person", true);
        await agent.claimWork!(n.id, "claim");
        await agent.recordResolution!(n.id, "feature/cart", "a".repeat(40));
        expect((await agent.getWork!(n.id))?.resolution?.commit).toBe("a".repeat(40));
        await s.call(`/contexts/${c.id}`, "PATCH", { archived: true });
        await expect(agent.get(n.id)).rejects.toThrow("revoked");
    });
    it("restricts raw screenshots and browser relay to the paired checkout", async () => {
        const s = await setup(),
            a = s.contexts[0],
            b = s.contexts[1];
        if (!a || !b) throw new Error("fixture");
        const asset = await s.backend.blobs.put(PNG),
            note = {
                ...sampleAnnotation,
                id: "image-note",
                projectId: "shop",
                screenshots: { full: { id: asset.id, mime: "image/png" as const, w: 1, h: 1 } },
            };
        await s.teams.route(note, a.id);
        await s.backend.ingest(note, new Map([[asset.id, PNG]]));
        const ta = await s.token(a.id, "agent"),
            tb = await s.token(b.id, "agent");
        expect((await s.call(`/assets/${asset.id}`, "GET", undefined, ta)).status).toBe(200);
        expect((await s.call(`/assets/${asset.id}`, "GET", undefined, tb)).status).toBe(404);
        let aCalls = 0,
            bCalls = 0;
        const offA = s.backend.relay.register(
            "shop",
            (r) => {
                aCalls++;
                s.backend.relay.complete(r.requestId, { ok: true, annotationId: "image-note" });
            },
            a.id
        );
        const offB = s.backend.relay.register(
            "shop",
            (r) => {
                bCalls++;
                s.backend.relay.complete(r.requestId, { ok: true, annotationId: "other" });
            },
            b.id
        );
        await teamBackend(s.backend, s.store, a.id, async () => {}).requestAnnotation(
            "shop",
            { target: "button", comment: "Check" },
            1000
        );
        expect(aCalls).toBe(1);
        expect(bCalls).toBe(0);
        offA();
        offB();
    });
    it("refuses assignment based on stale ownership", async () => {
        const s = await setup(),
            a = s.contexts[0],
            b = s.contexts[1];
        if (!a || !b) throw new Error("fixture");
        const n = await s.note("assignment-race", a.id);
        await s.teams.assign(n, b.id, "manager");
        await expect(s.teams.assign(n, a.id, "old-request", false, 0)).rejects.toThrow(
            "ownership changed"
        );
        expect((await s.teams.work(workId(n)))?.contextId).toBe(b.id);
    });
    it("keeps shared publication separate from checkout ownership", async () => {
        const s = await setup(),
            c = s.contexts[0];
        if (!c) throw new Error("fixture");
        const privateNote = await s.note("personal-origin", c.id);
        expect((await s.teams.work(workId(privateNote)))?.shared).toBe(false);
        await s.teams.assign(privateNote, null, "person");
        await s.teams.assign(privateNote, c.id, "person");
        expect((await s.teams.work(workId(privateNote)))?.shared).toBe(true);
    });
    it("rechecks a revoked credential inside the write fence", async () => {
        const s = await setup(),
            c = s.contexts[0];
        if (!c) throw new Error("fixture");
        const n = await s.note("revoked-write", c.id),
            auth = new Authenticator(s.store);
        const credential = await auth.issueToken("shop", "Agent", {
            purpose: "agent",
            developmentContextId: c.id,
        });
        const agent = teamBackend(s.backend, s.store, c.id, async () => {}, credential.record.id);
        await agent.claimWork!(n.id, "claim");
        await auth.revokeToken(credential.record.id);
        await expect(agent.setStatus(n.id, "resolved")).rejects.toThrow("revoked");
        await expect(agent.recordResolution!(n.id, "feature/cart", "a".repeat(40))).rejects.toThrow(
            "revoked"
        );
        expect((await s.backend.get(n.id))?.annotation.status).toBe("open");
    });
    it("requires the reviewed PR commit before an agent can claim work", async () => {
        const s = await setup(),
            c = s.contexts[0];
        if (!c) throw new Error("fixture");
        const n = await s.note("pr-target", c.id),
            agent = teamBackend(s.backend, s.store, c.id, async () => {});
        await s.teams.records.change<WorkRecord>(workId(n), "shop", "work", (r) => {
            if (!r) throw new Error("fixture");
            return {
                ...r,
                pullRequest: {
                    connectionId: "fake",
                    repository: "example/shop",
                    number: 42,
                    title: "Checkout",
                    url: "https://github.com/example/shop/pull/42",
                    headSha: "a".repeat(40),
                    baseSha: "b".repeat(40),
                    state: "open",
                    merged: false,
                    checkedAt: new Date().toISOString(),
                    creator: "Dominic",
                },
            };
        });
        await expect(agent.claimWork!(n.id, "claim")).rejects.toThrow("checkoutHead");
        await expect(agent.claimWork!(n.id, "claim", "c".repeat(40))).rejects.toThrow(
            "checkoutHead"
        );
        await agent.claimWork!(n.id, "claim", "a".repeat(40));
        await agent.setStatus(n.id, "acknowledged");
    });
    it("binds capture to credentials, rejects forged work IDs and imported-bundle bypass", async () => {
        const s = await setup(),
            c = s.contexts[0]!,
            capture = await s.token(c.id, "app"),
            form = new FormData();
        form.set(
            "annotation",
            JSON.stringify({
                ...sampleAnnotation,
                id: "captured",
                projectId: "shop",
                screenshots: undefined,
                workId: "forged",
            })
        );
        const res = await s.app(
            new Request("http://localhost:4899/projects/shop/annotations", {
                method: "POST",
                headers: { Host: "localhost:4899", Authorization: `Bearer ${capture}` },
                body: form,
            })
        );
        expect(res.status).toBe(201);
        const note = (await s.backend.get("captured"))!.annotation;
        expect(note.workId).toBeUndefined();
        expect((await s.teams.work(workId(note)))?.contextId).toBe(c.id);
        expect((await s.call("/projects/shop/bundles", "POST", {}, capture)).status).toBe(403);
    });
});
