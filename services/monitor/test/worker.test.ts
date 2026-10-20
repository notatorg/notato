import { expect, it } from "bun:test";
import { check, type Env, heartbeat, type KV } from "../src/worker.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 14, 12, 0);
const MONITORING = "m".repeat(40);
const HEARTBEAT = "h".repeat(40);
const RESEND = "re_test_monitor_key";

class MemoryKV implements KV {
    values = new Map<string, string>();
    async get(key: string) {
        return this.values.get(key) ?? null;
    }
    async put(key: string, value: string) {
        this.values.set(key, value);
    }
}

/** The monitored service and Resend, as the Worker reaches them. */
function world(env: Partial<Env> = {}) {
    const service = { ready: true, live: true, metrics: "", metricsStatus: 200 };
    const mail: { headers: Headers; body: { to: string[]; subject: string; text: string } }[] = [];
    const attempts: typeof mail = [];
    let resendStatus = 200;
    const fetcher = async (input: string | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin === "https://api.resend.com") {
            const message = { headers: request.headers, body: await request.json() };
            attempts.push(message);
            if (resendStatus !== 200) return new Response("unavailable", { status: resendStatus });
            mail.push(message);
            return Response.json({ id: crypto.randomUUID() });
        }
        expect(url.origin).toBe("https://test.notato.dev");
        expect(request.redirect).toBe("manual");
        if (url.pathname === "/ready")
            return Response.json({ ok: service.ready }, { status: service.ready ? 200 : 503 });
        if (url.pathname === "/health")
            return service.live ? Response.json({ ok: true }) : new Response(null, { status: 502 });
        if (url.pathname === "/metrics") {
            if (request.headers.get("authorization") !== `Bearer ${MONITORING}`)
                return new Response(null, { status: 401 });
            return new Response(service.metrics, { status: service.metricsStatus });
        }
        throw new Error(`unexpected request ${url}`);
    };
    const kv = new MemoryKV();
    const config: Env = {
        MONITOR: kv,
        NOTATO_MONITOR_TARGET: "https://test.notato.dev",
        NOTATO_MONITOR_LABEL: "test",
        NOTATO_MONITOR_INSTANCE: "notato-server-test",
        NOTATO_ALERT_FROM: "Notato monitor <monitor@internal.notato.dev>",
        NOTATO_ALERT_TO: "ops@example.com, second@example.com",
        NOTATO_RESEND_API_KEY: RESEND,
        NOTATO_MONITORING_TOKEN: MONITORING,
        NOTATO_BACKUP_HEARTBEAT_TOKEN: HEARTBEAT,
        ...env,
    };
    return {
        service,
        mail,
        attempts,
        kv,
        env: config,
        run: (at: number) => check(config, at, fetcher),
        failMail(status: number) {
            resendStatus = status;
        },
    };
}

const metrics = (over: Record<string, number> = {}) =>
    Object.entries({
        'notato_http_responses_total{status="200"}': 100,
        notato_uptime_seconds: 1000,
        notato_database_bytes: 20 * 1024 * 1024,
        notato_stored_bytes: 1024 * 1024,
        notato_data_volume_bytes: 100 * 1024 ** 3,
        notato_data_volume_free_bytes: 60 * 1024 ** 3,
        ...over,
    })
        .map(([name, value]) => `${name} ${value}`)
        .join("\n");

function report(token: string, body: unknown) {
    return new Request("https://monitor.notato.dev/backup-heartbeat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

const valid = {
    instance: "notato-server-test",
    verified_at: new Date(T0 - 2 * 3600_000).toISOString(),
    bytes: 1234,
    images: 2,
};

it("mails an outage once, with no credential in it, and mails its recovery", async () => {
    const w = world();
    w.service.metrics = metrics();
    expect((await heartbeat(report(HEARTBEAT, valid), w.env, T0)).status).toBe(204);
    await w.run(T0);
    w.service.ready = false;
    w.service.live = false;
    await w.run(T0 + 5 * MINUTE);
    expect(w.mail).toEqual([]);
    await w.run(T0 + 10 * MINUTE);
    await w.run(T0 + 15 * MINUTE);
    expect(w.mail).toHaveLength(1);
    const alert = w.mail[0];
    expect(alert?.body.subject).toBe("[Notato test] Alert: The service is not answering");
    expect(alert?.body.to).toEqual(["ops@example.com", "second@example.com"]);
    expect(alert?.body.text).toContain("Monitored: https://test.notato.dev (notato-server-test)");
    expect(alert?.headers.get("authorization")).toBe(`Bearer ${RESEND}`);
    expect(alert?.headers.get("idempotency-key")).toStartWith("notato-monitor/down/alert/");
    for (const secret of [MONITORING, HEARTBEAT, RESEND])
        expect(JSON.stringify(alert?.body)).not.toContain(secret);

    w.service.ready = true;
    w.service.metrics = metrics({ notato_uptime_seconds: 30 });
    await w.run(T0 + 20 * MINUTE);
    expect(w.mail.map((m) => m.body.subject)).toEqual([
        "[Notato test] Alert: The service is not answering",
        "[Notato test] Resolved: The service is not answering",
    ]);
});

it("reports a refused monitoring credential after fifteen minutes", async () => {
    const w = world({ NOTATO_MONITORING_TOKEN: "x".repeat(40) });
    expect((await heartbeat(report(HEARTBEAT, valid), w.env, T0)).status).toBe(204);
    for (let i = 0; i < 3; i++) await w.run(T0 + i * 5 * MINUTE);
    expect(w.mail.map((m) => m.body.subject)).toEqual([
        "[Notato test] Warning: The monitoring credential is refused",
    ]);
});

it("keeps to the daily mail limit and sends what waited the next day", async () => {
    const w = world({ NOTATO_ALERT_DAILY_LIMIT: "1" });
    expect((await heartbeat(report(HEARTBEAT, valid), w.env, T0)).status).toBe(204);
    w.service.metrics = metrics({
        notato_database_bytes: 490 * 1024 * 1024,
        notato_data_volume_free_bytes: 1024 ** 3,
    });
    await w.run(T0);
    await w.run(T0 + 5 * MINUTE);
    expect(w.mail).toHaveLength(1);
    expect(w.mail[0]?.body.text).toContain("Daily alert mail limit: 1.");
    const tomorrow = Date.UTC(2026, 9, 15, 0, 5);
    expect(
        (
            await heartbeat(
                report(HEARTBEAT, { ...valid, verified_at: new Date(tomorrow).toISOString() }),
                w.env,
                tomorrow
            )
        ).status
    ).toBe(204);
    await w.run(tomorrow);
    expect(w.mail).toHaveLength(2);
    expect(w.mail[1]?.body.subject).toStartWith("[Notato test] Alert:");
});

it("retries an alert the mail provider did not accept", async () => {
    const w = world();
    w.service.metrics = metrics({ notato_data_volume_free_bytes: 1024 ** 3 });
    expect((await heartbeat(report(HEARTBEAT, valid), w.env, T0)).status).toBe(204);
    w.failMail(500);
    await w.run(T0);
    expect(w.mail).toEqual([]);
    w.failMail(200);
    await w.run(T0 + 5 * MINUTE);
    expect(w.mail.map((m) => m.body.subject)).toEqual([
        "[Notato test] Alert: The server's disk is 99% full",
    ]);
    expect(w.attempts[0]?.body).toEqual(w.attempts[1]?.body);
    expect(w.attempts[0]?.headers.get("idempotency-key")).toBe(
        w.attempts[1]?.headers.get("idempotency-key")
    );
});

it("retains a failed recovery message after the alert has cleared", async () => {
    const w = world();
    await heartbeat(report(HEARTBEAT, valid), w.env, T0);
    w.service.metrics = metrics({ notato_data_volume_free_bytes: 1024 ** 3 });
    await w.run(T0);
    w.service.metrics = metrics();
    w.failMail(500);
    const failed = await w.run(T0 + 5 * MINUTE);
    expect(failed.state.alerts).toEqual({});
    expect(failed.state.pendingMail).toHaveLength(1);
    expect(failed.state.pendingMail?.[0]?.kind).toBe("resolved");
    w.failMail(200);
    const recovered = await w.run(T0 + 10 * MINUTE);
    expect(recovered.notifications).toEqual([]);
    expect(recovered.state.pendingMail).toEqual([]);
    expect(w.mail[1]?.body.subject).toStartWith("[Notato test] Resolved:");
    expect(w.attempts[1]?.body).toEqual(w.attempts[2]?.body);
    expect(w.attempts[1]?.headers.get("idempotency-key")).toBe(
        w.attempts[2]?.headers.get("idempotency-key")
    );
});

it("retains a failed weekly summary after its reporting period advances", async () => {
    const w = world();
    const start = Date.UTC(2026, 9, 5, 8);
    const monday = start + 7 * 24 * 60 * MINUTE;
    const backup = (at: number) =>
        heartbeat(
            report(HEARTBEAT, { ...valid, verified_at: new Date(at).toISOString() }),
            w.env,
            at
        );
    w.service.metrics = metrics();
    await backup(start);
    await w.run(start);
    await backup(monday);
    w.failMail(500);
    const failed = await w.run(monday);
    expect(failed.state.summaryAt).toBe(monday);
    expect(failed.state.pendingMail?.[0]?.kind).toBe("summary");
    w.failMail(200);
    const retried = await w.run(monday + 5 * MINUTE);
    expect(retried.notifications).toEqual([]);
    expect(retried.state.pendingMail).toEqual([]);
    expect(w.mail).toHaveLength(1);
    expect(w.mail[0]?.body.subject).toStartWith("[Notato test] Weekly status:");
    expect(w.attempts[0]?.body).toEqual(w.attempts[1]?.body);
});

it("accepts only an authentic, well-formed backup report and never moves it backwards", async () => {
    const w = world();
    const status = async (request: Request) => (await heartbeat(request, w.env, T0)).status;
    expect(await status(report("wrong".repeat(10), valid))).toBe(401);
    expect(
        await status(
            new Request("https://monitor.notato.dev/backup-heartbeat", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(valid),
            })
        )
    ).toBe(401);
    expect(
        await status(new Request("https://monitor.notato.dev/backup-heartbeat", { method: "GET" }))
    ).toBe(405);
    expect(await status(report(HEARTBEAT, { ...valid, instance: "another" }))).toBe(400);
    expect(
        await status(
            report(HEARTBEAT, { ...valid, verified_at: new Date(T0 + 3600_000).toISOString() })
        )
    ).toBe(400);
    expect(await status(report(HEARTBEAT, { ...valid, bytes: -1 }))).toBe(400);
    for (const invalid of [null, [], true, 42, "invalid"])
        expect(await status(report(HEARTBEAT, invalid))).toBe(400);
    expect(await status(report(HEARTBEAT, { ...valid, padding: "x".repeat(4096) }))).toBe(413);
    expect(w.kv.values.has("backup")).toBe(false);

    expect(await status(report(HEARTBEAT, valid))).toBe(204);
    expect(
        await status(
            report(HEARTBEAT, { ...valid, verified_at: new Date(T0 - 9 * 3600_000).toISOString() })
        )
    ).toBe(204);
    expect(JSON.parse(w.kv.values.get("backup") ?? "{}")).toEqual({
        verifiedAt: T0 - 2 * 3600_000,
        bytes: 1234,
        images: 2,
        receivedAt: T0,
    });

    const unconfigured = world({ NOTATO_BACKUP_HEARTBEAT_TOKEN: undefined });
    expect((await heartbeat(report(HEARTBEAT, valid), unconfigured.env, T0)).status).toBe(401);
});

it("delivers alerts through the SMTP adapter without any provider API key", async () => {
    const notifications: string[] = [];
    const w = world({
        NOTATO_RESEND_API_KEY: undefined,
        async sendMail(notification, to) {
            expect(to).toEqual(["ops@example.com", "second@example.com"]);
            notifications.push(notification.subject);
        },
    });
    w.service.ready = false;
    w.service.live = false;
    await w.run(T0);
    await w.run(T0 + 5 * MINUTE);
    expect(notifications.length).toBeGreaterThan(0);
    expect(w.mail).toHaveLength(0);
});
