import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { StripeBilling } from "../src/billing.ts";
import { HOSTED_LIMITS, QuotaError } from "../src/storage.ts";
import { cleanupAfterEach } from "./helpers.ts";
import { embeddedPostgres } from "./postgres.ts";

const defer = cleanupAfterEach();
const plan = {
    id: "team",
    name: "Team",
    priceId: "price_team",
    limits: { notes: 20_000, bytes: 2 * 1024 ** 3, projects: 100, tokens: 200 },
};
const secret = "whsec_testing";
const event = (id = "evt_first") =>
    Buffer.from(
        JSON.stringify({
            id,
            type: "customer.subscription.updated",
            livemode: false,
            data: {
                object: {
                    id: "sub_team",
                    customer: "cus_team",
                    status: "active",
                    metadata: { notato_workspace: "someone-else" },
                },
            },
        })
    );
const signature = (raw: Uint8Array, t = String(Math.floor(Date.now() / 1000))) =>
    `t=${t},v1=${createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex")}`;
describe.each(["postgres"] as const)("%s subscription controls", (_kind) => {
    it("trusts signed provider state, deduplicates events, enforces paid limits, and blocks deletion until canceled", async () => {
        const store = (await embeddedPostgres()).store;
        defer(() => store.close());
        store.setHostedLimits({ ...HOSTED_LIMITS, projects: 1 });
        await store.upsertUser({
            username: "owner",
            passwordHash: "hash",
            createdAt: new Date().toISOString(),
        });
        await store.createWorkspace(
            { id: "company", name: "Company", createdAt: new Date().toISOString() },
            "owner"
        );
        await store.createProject({
            id: "first",
            name: "First",
            workspaceId: "company",
            createdAt: new Date().toISOString(),
        });
        await expect(
            store.createProject({
                id: "blocked",
                name: "Blocked",
                workspaceId: "company",
                createdAt: new Date().toISOString(),
            })
        ).rejects.toBeInstanceOf(QuotaError);
        await store.setBillingCustomer("company", "cus_team");
        let status = "active";
        const fake = Object.assign(
            async () =>
                Response.json({
                    id: "sub_team",
                    customer: "cus_team",
                    livemode: false,
                    status,
                    current_period_end: Math.floor(Date.now() / 1000) + 3600,
                    items: { data: [{ price: { id: "price_team" } }] },
                }),
            { preconnect: fetch.preconnect }
        ) as typeof fetch;
        const billing = new StripeBilling({
            key: "sk_test_testing",
            webhookSecret: secret,
            origin: "https://notato.example",
            plans: [plan],
            fetcher: fake,
        });
        const raw = event();
        await expect(billing.webhook(store, raw, "v1=bad")).rejects.toThrow("signature");
        await expect(billing.webhook(store, raw, signature(raw, "1"))).rejects.toThrow("signature");
        await billing.webhook(store, raw, signature(raw));
        expect((await store.getBilling("company"))?.plan).toBe("team");
        expect(await store.getBilling("someone-else")).toBeNull();
        await store.createProject({
            id: "paid",
            name: "Paid",
            workspaceId: "company",
            createdAt: new Date().toISOString(),
        });
        expect((await store.workspaceUsage("company")).projects).toBe(2);
        await expect(store.deleteWorkspace("company", "owner")).rejects.toThrow(
            "cancel the subscription"
        );
        status = "canceled";
        await billing.webhook(store, raw, signature(raw));
        expect((await store.getBilling("company"))?.status).toBe("active");
        const cancel = event("evt_cancel");
        await billing.webhook(store, cancel, signature(cancel));
        expect((await store.getBilling("company"))?.limits).toBeUndefined();
        await expect(
            store.createProject({
                id: "over",
                name: "Over",
                workspaceId: "company",
                createdAt: new Date().toISOString(),
            })
        ).rejects.toBeInstanceOf(QuotaError);
        expect(await store.deleteWorkspace("company", "owner")).toEqual([]);
    });
});
it("rejects live credentials in test mode, duplicate prices and unsafe return origins", () => {
    expect(
        () =>
            new StripeBilling({
                key: "sk_live_bad",
                webhookSecret: secret,
                origin: "https://notato.example",
                plans: [plan],
            })
    ).toThrow("test/live");
    expect(
        () =>
            new StripeBilling({
                key: "sk_test_test",
                webhookSecret: secret,
                origin: "https://notato.example",
                plans: [plan, { ...plan, id: "other" }],
            })
    ).toThrow("unique");
    expect(
        () =>
            new StripeBilling({
                key: "sk_test_test",
                webhookSecret: secret,
                origin: "http://remote.example",
                plans: [plan],
            })
    ).toThrow("HTTPS");
});

it("serializes repeated checkout, reuses a pending session, and detects subscriptions before a webhook arrives", async () => {
    const store = (await embeddedPostgres()).store;
    defer(() => store.close());
    await store.setBillingCustomer("default", "cus_team");
    let sessions = 0,
        subscribed = false;
    const requests: Array<{ path: string; body: string }> = [];
    const fake = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            requests.push({ path, body: String(init?.body ?? "") });
            if (path === "/v1/subscriptions")
                return Response.json({
                    data: subscribed ? [{ id: "sub_existing", status: "active" }] : [],
                });
            if (path.startsWith("/v1/prices/"))
                return Response.json({
                    active: true,
                    recurring: { interval: "month" },
                    livemode: false,
                });
            if (path === "/v1/checkout/sessions") {
                sessions++;
                return Response.json({
                    id: "cs_checkout",
                    url: "https://checkout.stripe.com/c/pay/test",
                    expires_at: Math.floor(Date.now() / 1000) + 1800,
                });
            }
            throw new Error("unexpected provider request");
        },
        { preconnect: fetch.preconnect }
    ) as typeof fetch;
    const billing = new StripeBilling({
        key: "sk_test_test",
        webhookSecret: secret,
        origin: "https://notato.example",
        plans: [plan],
        fetcher: fake,
    });
    const urls = await Promise.all([
        billing.checkout(store, "default", "team"),
        billing.checkout(store, "default", "team"),
    ]);
    expect(urls[0]).toBe(urls[1]);
    expect(sessions).toBe(1);
    expect(requests.at(-1)?.body).toContain("success_url=https%3A%2F%2Fnotato.example");
    await store.saveCheckout("default", null);
    subscribed = true;
    await expect(billing.checkout(store, "default", "team")).rejects.toThrow(
        "existing subscription"
    );
    expect(sessions).toBe(1);
});

it("allows only current owners to start checkout and rejects browser origins and client return URLs", async () => {
    const { startServe } = await import("./serve-helpers.ts"),
        { customer, fakeManagedAuth } = await import("./hosted-helpers.ts");
    let calls = 0;
    const fake = Object.assign(
        async (input: RequestInfo | URL) => {
            calls++;
            const path = new URL(String(input)).pathname;
            if (path === "/v1/customers") return Response.json({ id: "cus_http" });
            if (path === "/v1/subscriptions") return Response.json({ data: [] });
            if (path.startsWith("/v1/prices/"))
                return Response.json({
                    active: true,
                    recurring: { interval: "month" },
                    livemode: false,
                });
            return Response.json({
                id: "cs_http",
                url: "https://checkout.stripe.com/c/pay/http",
                expires_at: Math.floor(Date.now() / 1000) + 1800,
            });
        },
        { preconnect: fetch.preconnect }
    ) as typeof fetch;
    const billing = new StripeBilling({
        key: "sk_test_test",
        webhookSecret: secret,
        origin: "https://notato.example",
        plans: [plan],
        fetcher: fake,
    });
    const s = await startServe(defer, { managedAuth: fakeManagedAuth(), billing }),
        alice = await customer(s, "alice"),
        bob = await customer(s, "bob");
    const checkout = (body: unknown, origin?: string) =>
        s.call("/billing/checkout", {
            method: "POST",
            headers: {
                cookie: alice.cookie,
                "content-type": "application/json",
                ...(origin ? { origin } : {}),
            },
            body: JSON.stringify(body),
        });
    expect((await checkout({ plan: "team" }, "https://evil.example")).status).toBe(403);
    expect((await checkout({ plan: "team", returnUrl: "https://evil.example" })).status).toBe(400);
    expect(calls).toBe(0);
    expect((await checkout({ plan: "team" })).status).toBe(200);
    const aliceMe = (await (
            await s.call("/auth/me", { headers: { cookie: alice.cookie } })
        ).json()) as { username: string; workspace: { id: string } },
        bobMe = (await (await s.call("/auth/me", { headers: { cookie: bob.cookie } })).json()) as {
            username: string;
        };
    await s.rt.store.setMembership({
        workspaceId: aliceMe.workspace.id,
        username: bobMe.username,
        role: "owner",
        createdAt: new Date().toISOString(),
    });
    await s.rt.store.setMembership({
        workspaceId: aliceMe.workspace.id,
        username: aliceMe.username,
        role: "member",
        createdAt: new Date().toISOString(),
    });
    const before = calls;
    expect((await checkout({ plan: "team" })).status).toBe(403);
    expect(calls).toBe(before);
});
