import { expect, it } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { FileBlobStore } from "@notato/server";
import { CloudBackend } from "../src/backend.ts";
import { Metrics } from "../src/metrics.ts";
import { annotationFixture, cleanupAfterEach, tempDir, waitFor } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { embeddedPostgres } from "./postgres.ts";
import { adminCookie, startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
it("keeps aggregate metrics operator-only and readiness depends on usable storage", async () => {
    const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
    expect((await s.call("/ready")).status).toBe(200);
    expect((await s.call("/metrics")).status).toBe(401);
    const alice = await customer(s, "alice");
    expect((await s.call("/metrics", { headers: { cookie: alice.cookie } })).status).toBe(403);
    const admin = await adminCookie(s);
    expect(
        await waitFor(async () =>
            (await (await s.call("/metrics", { headers: { cookie: admin } })).text()).includes(
                'notato_maintenance_runs_total{task="retention",result="success"} 1'
            )
        )
    ).toBe(true);
    const res = await s.call("/metrics", { headers: { cookie: admin } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("notato_http_responses_total");
    expect(text).toContain('notato_maintenance_last_run_failed{task="retention"} 0');
    expect(text).not.toContain("alice");
    expect(text).not.toContain("127.0.0.1");
    const original = s.rt.store.getWorkspace.bind(s.rt.store);
    s.rt.store.getWorkspace = async () => {
        throw new Error("secret database connection");
    };
    const down = await s.call("/ready");
    expect(down.status).toBe(503);
    expect(await down.text()).not.toContain("secret");
    s.rt.store.getWorkspace = original;
});
it("collects old orphans while preserving recent uploads and assets referenced by other projects", async () => {
    const root = tempDir(defer),
        store = (await embeddedPostgres()).store;
    defer(() => store.close());
    const dir = join(root, "assets"),
        blobs = new FileBlobStore(dir),
        backend = new CloudBackend(store, blobs);
    const now = Date.now();
    const orphan = await blobs.put(new Uint8Array([1])),
        referenced = await blobs.put(new Uint8Array([2])),
        recent = await blobs.put(new Uint8Array([3]));
    for (const ref of [orphan, referenced])
        utimesSync(
            join(dir, ref.id.slice(0, 2), ref.id),
            new Date(now - 48 * 3600_000),
            new Date(now - 48 * 3600_000)
        );
    await store.createProject({ id: "test", name: "Test", createdAt: new Date().toISOString() });
    await store.insertAnnotation(
        annotationFixture({
            projectId: "test",
            screenshots: { full: { id: referenced.id, mime: "image/png", w: 1, h: 1 } },
        })
    );
    expect(await backend.collectOrphanAssets(now)).toBe(1);
    expect(await blobs.get(orphan.id)).toBeNull();
    expect(await blobs.get(referenced.id)).not.toBeNull();
    expect(await blobs.get(recent.id)).not.toBeNull();
});

it("reports service capacity for alerts and counts an error that escapes a handler as a 500", async () => {
    const s = await startServe(defer, { managedAuth: fakeManagedAuth() });
    const admin = await adminCookie(s);
    const before = await (await s.call("/metrics", { headers: { cookie: admin } })).text();
    const gauge = (text: string, name: string) =>
        Number(new RegExp(`^${name} (\\S+)$`, "m").exec(text)?.[1]);
    expect(gauge(before, "notato_database_bytes")).toBeGreaterThan(0);
    expect(gauge(before, "notato_stored_bytes")).toBe(0);
    expect(gauge(before, "notato_data_volume_bytes")).toBeGreaterThan(0);
    expect(gauge(before, "notato_data_volume_free_bytes")).toBeGreaterThan(0);
    expect(before).not.toContain("notato_object_egress_bytes_total");

    // MCP identifies its caller outside the server's error handling: a failing store must still count as a 500.
    s.rt.store.findToken = async () => {
        throw new Error("database unavailable");
    };
    const failed = await s.call("/mcp", {
        method: "POST",
        headers: { authorization: "Bearer notato_unreachable", "content-type": "application/json" },
        body: "{}",
    });
    expect(failed.status).toBe(500);
    const after = await (await s.call("/metrics", { headers: { cookie: admin } })).text();
    expect(after).toContain('notato_http_responses_total{status="500"} 1');
});

it("samples capacity at most once a minute and keeps the last sample when one fails", async () => {
    let now = 1_000_000;
    let calls = 0;
    let fail = false;
    const metrics = new Metrics(() => now);
    metrics.measureCapacity(async () => {
        calls++;
        if (fail) throw new Error("database unavailable");
        return { databaseBytes: calls * 100 };
    });
    await Promise.all([metrics.refresh(), metrics.refresh()]);
    expect(calls).toBe(1);
    expect(metrics.render()).toContain("notato_database_bytes 100\n");
    now += 30_000;
    await metrics.refresh();
    expect(calls).toBe(1);
    now += 31_000;
    fail = true;
    await metrics.refresh();
    expect(calls).toBe(2);
    expect(metrics.render()).toContain("notato_database_bytes 100\n");
    expect(metrics.render()).toContain("notato_capacity_sampled_timestamp_seconds 1000\n");
    fail = false;
    await metrics.refresh();
    expect(metrics.render()).toContain("notato_database_bytes 300\n");
});

it("limits a dedicated monitoring credential to metrics and refuses browser use", async () => {
    const token = "a".repeat(40);
    process.env.NOTATO_MONITORING_TOKEN = token;
    const s = await startServe(defer);
    delete process.env.NOTATO_MONITORING_TOKEN;
    const call = (path: string, origin?: string) =>
        s.rt.handle(
            new Request(`http://127.0.0.1${path}`, {
                headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) },
            })
        );
    expect((await call("/metrics")).status).toBe(200);
    expect((await call("/projects")).status).toBe(401);
    expect((await call("/metrics", "http://127.0.0.1")).status).toBe(401);
});
