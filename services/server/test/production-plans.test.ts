import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { StripeBilling } from "../src/billing.ts";
import { FREE_PLAN, planLimits } from "../src/plans.ts";
import {
    HOSTED_LIMITS,
    QuotaError,
    type Store,
    type WorkspaceBilling,
    type WorkspacePlan,
} from "../src/storage.ts";
import { annotationFixture, cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { embeddedPostgres } from "./postgres.ts";
import { startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach(),
    at = () => new Date().toISOString();
const workspace = (id: string) => ({ id, name: id, createdAt: at() });
async function setup(_kind: "postgres") {
    const s = (await embeddedPostgres()).store;
    defer(() => s.close());
    s.setHostedLimits(HOSTED_LIMITS);
    await s.setWorkspacePlans(true);
    await s.upsertUser({ username: "owner", passwordHash: "synthetic", createdAt: at() });
    await s.createWorkspace(workspace("personal"), "owner", FREE_PLAN);
    await s.createProject({ id: "p", name: "Project", createdAt: at(), workspaceId: "personal" });
    return s;
}
async function bill(s: Store, id: string, plan: WorkspacePlan, status = "active") {
    await s.setBillingCustomer(id, `cus_${id}`);
    const state: WorkspaceBilling = {
        workspaceId: id,
        customerId: `cus_${id}`,
        subscriptionId: `sub_${id}`,
        plan: plan.id,
        status,
        periodEnd: new Date(Date.now() + 3600_000).toISOString(),
        ...(["active", "trialing"].includes(status)
            ? { entitlement: plan, limits: planLimits(plan) }
            : {}),
    };
    await s.applyBillingEvent(crypto.randomUUID(), state, at());
}
describe.each(["postgres"] as const)("%s production workspace plans", (kind) => {
    it("preserves metered legacy usage and permits only one active Free personal workspace after migration", async () => {
        const s = (await embeddedPostgres()).store;
        defer(() => s.close());
        s.setHostedLimits(HOSTED_LIMITS);
        await s.upsertUser({ username: "legacy", passwordHash: "!", createdAt: at() });
        for (const id of ["first", "second"]) {
            await s.createWorkspace(workspace(id), "legacy");
            await s.createProject({ id, workspaceId: id, name: id, createdAt: at() });
            for (let n = 0; n < 5; n++)
                await s.insertAnnotation(
                    annotationFixture({ id: crypto.randomUUID(), projectId: id })
                );
        }
        await s.setWorkspacePlans(true);
        expect((await s.getWorkspaceEntitlement("first")).locked).toBe(false);
        expect((await s.getWorkspaceEntitlement("second")).locked).toBe(true);
        expect((await s.monthlyNoteUsage("first")).notes).toBe(10);
        await expect(
            s.insertAnnotation(annotationFixture({ id: crypto.randomUUID(), projectId: "second" }))
        ).rejects.toBeInstanceOf(QuotaError);
        await s.deleteWorkspace("first", "legacy");
        expect((await s.getWorkspaceEntitlement("second")).locked).toBe(false);
        expect((await s.monthlyNoteUsage("second")).notes).toBe(10);
    });

    it("enforces private Free limits and one personal workspace without trusting test selections", async () => {
        const s = await setup(kind);
        expect((await s.getWorkspaceLimits("personal"))?.projects).toBe(1);
        await expect(s.createWorkspace(workspace("another"), "owner", FREE_PLAN)).rejects.toThrow(
            "already has a free"
        );
        await expect(
            s.createProject({
                id: "second",
                name: "Second",
                createdAt: at(),
                workspaceId: "personal",
            })
        ).rejects.toBeInstanceOf(QuotaError);
        await expect(s.selectWorkspacePlan("personal", "owner", "team", 90)).rejects.toThrow(
            "verified subscription"
        );
        await expect(
            s.createInvitation({
                id: "invite",
                workspaceId: "personal",
                email: "guest@example.com",
                role: "member",
                tokenHash: "hash",
                createdBy: "owner",
                createdAt: at(),
                expiresAt: new Date(Date.now() + 86400_000).toISOString(),
            })
        ).rejects.toThrow("private");
        const token = (id: string, permission: "capture" | "full") => ({
            id,
            name: id,
            permission,
            projectId: "p",
            workspaceId: "personal",
            createdBy: "owner",
            tokenHash: id,
            createdAt: at(),
        });
        await s.createToken(token("capture", "capture"));
        await s.createToken(token("agent", "full"));
        for (let i = 0; i < 4; i++)
            await s.createToken(token(`additional-${i}`, i % 2 ? "full" : "capture"));
        await expect(s.createToken(token("extra", "capture"))).rejects.toBeInstanceOf(QuotaError);
        expect((await s.getWorkspacePlan("personal"))?.id).toBe("free");
    });
    it("keeps paid drafts locked, verifies seats, and preserves data through expiry and safe Free conversion", async () => {
        const s = await setup(kind);
        await s.createWorkspace(workspace("company"), "owner", { id: "pro", extraSeats: 2 });
        expect((await s.getWorkspaceEntitlement("company")).locked).toBe(true);
        await expect(
            s.createProject({
                id: "company-p",
                name: "Company",
                createdAt: at(),
                workspaceId: "company",
            })
        ).rejects.toBeInstanceOf(QuotaError);
        await bill(s, "company", { id: "pro", extraSeats: 2 });
        expect((await s.getWorkspaceLimits("company"))?.members).toBe(5);
        await s.createProject({
            id: "company-p",
            name: "Company",
            createdAt: at(),
            workspaceId: "company",
        });
        const note = annotationFixture({ id: crypto.randomUUID(), projectId: "company-p" });
        await s.insertAnnotation(note);
        for (const name of ["one", "two", "three"]) {
            await s.upsertUser({ username: name, passwordHash: "!", createdAt: at() });
            await s.setMembership({
                workspaceId: "company",
                username: name,
                role: "member",
                createdAt: at(),
            });
        }
        await bill(s, "company", { id: "pro", extraSeats: 0 });
        expect(await s.listWorkspaceMembers("company")).toHaveLength(4);
        await expect(
            s.insertAnnotation(
                annotationFixture({ id: crypto.randomUUID(), projectId: "company-p" })
            )
        ).rejects.toThrow("seat allowance");
        await bill(s, "company", { id: "pro", extraSeats: 0 }, "past_due");
        expect((await s.getWorkspaceEntitlement("company")).locked).toBe(true);
        expect(await s.getAnnotation(note.id)).not.toBeNull();
        await expect(s.selectWorkspacePlan("company", "owner", "free", 0)).rejects.toThrow(
            "Cancel the subscription"
        );
        await bill(s, "company", { id: "pro", extraSeats: 0 }, "canceled");
        await expect(s.selectWorkspacePlan("company", "owner", "free", 0)).rejects.toThrow(
            "already has a free"
        );
        await s.deleteWorkspace("personal", "owner");
        for (const name of ["one", "two", "three"]) await s.removeMembership("company", name);
        await s.selectWorkspacePlan("company", "owner", "free", 0);
        expect((await s.getWorkspaceEntitlement("company")).locked).toBe(false);
        expect(await s.getAnnotation(note.id)).not.toBeNull();
        expect((await s.monthlyNoteUsage("company")).notes).toBe(1);
    });
    it("keeps monthly Free receipts across deletion and cannot turn a test upgrade into a paid allowance", async () => {
        const s = await setup(kind);
        for (let n = 0; n < 100; n++)
            await s.insertAnnotation(
                annotationFixture({ id: crypto.randomUUID(), projectId: "p" })
            );
        await s.deleteProject("p");
        await s.createProject({
            id: "replacement",
            name: "Replacement",
            createdAt: at(),
            workspaceId: "personal",
        });
        await expect(
            s.insertAnnotation(
                annotationFixture({ id: crypto.randomUUID(), projectId: "replacement" })
            )
        ).rejects.toThrow("monthly note allowance");
        await bill(s, "personal", { id: "pro", extraSeats: 0 });
        await s.insertAnnotation(
            annotationFixture({ id: crypto.randomUUID(), projectId: "replacement" })
        );
        expect((await s.monthlyNoteUsage("personal")).notes).toBe(101);
        await s.createWorkspace(workspace("new-personal"), "owner", FREE_PLAN);
        expect((await s.monthlyNoteUsage("new-personal")).notes).toBe(100);
        await s.createWorkspace(workspace("draft"), "owner", { id: "team", extraSeats: 90 });
        expect((await s.getWorkspaceLimits("draft"))?.tokens).toBe(0);
    });
});

const secret = "whsec_production_test";
const prices = [
    { id: "plus" as const, priceId: "price_plus" },
    { id: "pro" as const, priceId: "price_pro", seatPriceId: "price_pro_seat" },
    { id: "team" as const, priceId: "price_team", seatPriceId: "price_team_seat" },
];
interface SyntheticSubscription {
    id: string;
    customer: string;
    livemode: boolean;
    status: string;
    current_period_end: number;
    latest_invoice: { status: string };
    items: { data: Array<{ id: string; price: { id: string }; quantity: number }> };
    pending_update?: { expires_at: number } | null;
}
function provider() {
    let current: SyntheticSubscription = {
        id: "sub_personal",
        customer: "cus_personal",
        livemode: false,
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 3600,
        latest_invoice: { status: "paid" },
        items: {
            data: [
                { id: "si_base", price: { id: "price_pro" }, quantity: 1 },
                { id: "si_seat", price: { id: "price_pro_seat" }, quantity: 2 },
            ],
        },
    };
    const writes: Array<{ path: string; body: URLSearchParams }> = [];
    const fake = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input)),
                path = url.pathname.replace("/v1/", "");
            if (init?.method === "POST")
                writes.push({ path, body: new URLSearchParams(String(init.body ?? "")) });
            if (path.startsWith("prices/"))
                return Response.json({
                    active: true,
                    livemode: false,
                    currency: "gbp",
                    billing_scheme: "per_unit",
                    unit_amount: path.includes("_seat")
                        ? 200
                        : path.includes("team")
                          ? 2000
                          : path.includes("plus")
                            ? 300
                            : 1000,
                    recurring: { usage_type: "licensed", interval: "month", interval_count: 1 },
                });
            if (path === "subscriptions") return Response.json({ data: [], has_more: false });
            if (path === "checkout/sessions")
                return Response.json({
                    id: "cs_synthetic",
                    url: "https://checkout.stripe.com/c/pay/synthetic",
                    expires_at: Math.floor(Date.now() / 1000) + 3600,
                });
            if (path.startsWith("subscriptions/sub_")) return Response.json(current);
            throw new Error("Unexpected provider path");
        },
        { preconnect: fetch.preconnect }
    ) as typeof fetch;
    const billing = new StripeBilling({
        key: "sk_test_testing",
        webhookSecret: secret,
        origin: "https://notato.example",
        workspacePlans: true,
        plans: prices,
        fetcher: fake,
    });
    async function event(
        s: Store,
        id = `evt_${crypto.randomUUID().replaceAll("-", "")}`,
        type = "customer.subscription.updated"
    ) {
        const raw = Buffer.from(
            JSON.stringify({
                id,
                type,
                livemode: false,
                data: {
                    object: {
                        id: type.startsWith("invoice.") ? "in_synthetic" : "sub_personal",
                        customer: "cus_personal",
                        subscription: "sub_personal",
                    },
                },
            })
        );
        const time = String(Math.floor(Date.now() / 1000)),
            sig = createHmac("sha256", secret).update(`${time}.`).update(raw).digest("hex");
        await billing.webhook(s, raw, `t=${time},v1=${sig}`);
    }
    return {
        billing,
        event,
        writes,
        get current() {
            return current;
        },
        set current(value: SyntheticSubscription) {
            current = value;
        },
    };
}
it("checks out Plus without seats and applies its verified subscription once while retaining receipts", async () => {
    const s = await setup("postgres"),
        p = provider();
    await s.setBillingCustomer("personal", "cus_personal");
    await s.insertAnnotation(annotationFixture({ id: crypto.randomUUID(), projectId: "p" }));
    await p.billing.checkout(s, "personal", "plus");
    const checkout = p.writes.find((w) => w.path === "checkout/sessions");
    expect(checkout?.body.get("line_items[0][price]")).toBe("price_plus");
    expect(checkout?.body.has("line_items[1][price]")).toBe(false);
    expect((await s.getWorkspacePlan("personal"))?.id).toBe("free");
    p.current = {
        ...p.current,
        items: { data: [{ id: "si_base", price: { id: "price_plus" }, quantity: 1 }] },
    };
    await p.event(s, "evt_plus_replayed");
    await p.event(s, "evt_plus_replayed");
    expect(await s.getWorkspaceLimits("personal")).toMatchObject({
        projects: 5,
        members: 1,
        notesPerMonth: 500,
        tokens: 20,
    });
    expect((await s.monthlyNoteUsage("personal")).notes).toBe(1);
    await expect(p.billing.changeSubscription(s, "personal", "plus", 1)).rejects.toThrow(
        "invalid plan"
    );
    p.current = { ...p.current, status: "past_due", latest_invoice: { status: "open" } };
    await p.event(s);
    expect((await s.getWorkspaceEntitlement("personal")).locked).toBe(true);
});
it("derives seats from verified subscription items and retains paid capacity while a seat invoice is pending", async () => {
    const s = await setup("postgres"),
        p = provider();
    await s.setBillingCustomer("personal", "cus_personal");
    await p.event(s);
    expect((await s.getWorkspaceLimits("personal"))?.members).toBe(5);
    p.current = {
        ...p.current,
        pending_update: { expires_at: 1 },
        latest_invoice: { status: "open" },
    };
    await p.event(s);
    expect((await s.getWorkspaceLimits("personal"))?.members).toBe(5);
    p.current = {
        ...p.current,
        pending_update: null,
        latest_invoice: { status: "paid" },
        items: {
            data: p.current.items.data.map((item, n) =>
                n === 1 ? { ...item, quantity: 4 } : item
            ),
        },
    };
    await p.event(s, undefined, "invoice.paid");
    expect((await s.getWorkspaceLimits("personal"))?.members).toBe(7);
    p.current = {
        ...p.current,
        items: {
            data: p.current.items.data.map((item, n) =>
                n === 1 ? { ...item, quantity: 100 } : item
            ),
        },
    };
    await p.event(s);
    expect((await s.getWorkspaceEntitlement("personal")).locked).toBe(true);
    expect((await s.getWorkspaceLimits("personal"))?.projects).toBe(0);
});
it("binds checkout to base plus extra-seat prices and requests subscription changes without granting capacity", async () => {
    const s = await setup("postgres"),
        p = provider();
    await s.setBillingCustomer("personal", "cus_personal");
    await p.billing.checkout(s, "personal", "pro", undefined, 2);
    const checkout = p.writes.find((w) => w.path === "checkout/sessions");
    expect(checkout?.body.get("line_items[0][quantity]")).toBe("1");
    expect(checkout?.body.get("line_items[1][price]")).toBe("price_pro_seat");
    expect(checkout?.body.get("line_items[1][quantity]")).toBe("2");
    await p.event(s);
    p.current = { ...p.current, pending_update: { expires_at: 1 } };
    await expect(p.billing.changeSubscription(s, "personal", "pro", 4)).rejects.toThrow(
        "pending payment"
    );
    p.current = { ...p.current, pending_update: null };
    await p.billing.changeSubscription(s, "personal", "team", 1);
    const update = p.writes.find((w) => w.path === "subscriptions/sub_personal");
    expect(update?.body.get("payment_behavior")).toBe("pending_if_incomplete");
    expect(update?.body.get("proration_behavior")).toBe("always_invoice");
    expect(update?.body.get("items[0][price]")).toBe("price_team");
    expect(update?.body.get("items[1][quantity]")).toBe("1");
    expect((await s.getWorkspaceLimits("personal"))?.members).toBe(5);
    await expect(p.billing.checkout(s, "personal", "team", undefined, 91)).rejects.toThrow(
        "invalid plan"
    );
});

it("rejects unpaid, expired and foreign subscription state without granting paid capacity", async () => {
    const s = await setup("postgres"),
        p = provider();
    await s.setBillingCustomer("personal", "cus_personal");
    await p.event(s);
    p.current = { ...p.current, latest_invoice: { status: "open" } };
    await p.event(s);
    expect((await s.getWorkspaceEntitlement("personal")).locked).toBe(true);
    p.current = { ...p.current, latest_invoice: { status: "paid" } };
    await p.event(s);
    expect((await s.getWorkspaceLimits("personal"))?.members).toBe(5);
    p.current = { ...p.current, customer: "cus_foreign" };
    await expect(p.event(s)).rejects.toThrow("billing account mismatch");
    expect((await s.getWorkspaceLimits("personal"))?.members).toBe(5);
    p.current = {
        ...p.current,
        customer: "cus_personal",
        current_period_end: Math.floor(Date.now() / 1000) - 1,
    };
    await p.event(s);
    expect((await s.getWorkspaceEntitlement("personal")).locked).toBe(true);
    expect((await s.getWorkspaceLimits("personal"))?.tokens).toBe(0);
});

it("refuses a paid-seat reduction below current membership before requesting payment changes", async () => {
    const s = await setup("postgres"),
        p = provider();
    await s.setBillingCustomer("personal", "cus_personal");
    await p.event(s);
    for (const name of ["one", "two", "three"]) {
        await s.upsertUser({ username: name, passwordHash: "!", createdAt: at() });
        await s.setMembership({
            workspaceId: "personal",
            username: name,
            role: "member",
            createdAt: at(),
        });
    }
    await expect(p.billing.changeSubscription(s, "personal", "pro", 0)).rejects.toThrow(
        "Remove excess"
    );
    expect(p.writes).toHaveLength(0);
});

it("enforces canonical Free rules only when plan enforcement is explicitly enabled", async () => {
    const s = await startServe(defer, {
        managedAuth: fakeManagedAuth(),
        billing: null,
        testPlans: false,
        workspacePlans: true,
    });
    const alice = await customer(s, "alice"),
        headers = { cookie: alice.cookie, "content-type": "application/json" };
    const info = (await (await s.call("/billing", { headers })).json()) as {
        enabled: boolean;
        workspacePlans: boolean;
        limits: { projects: number; members: number; notesPerMonth: number };
    };
    expect(info.enabled).toBe(false);
    expect(info.workspacePlans).toBe(true);
    expect(info.limits).toMatchObject({ projects: 1, members: 1, notesPerMonth: 100 });
    expect(
        (
            await s.call("/workspaces", {
                method: "POST",
                headers,
                body: JSON.stringify({ name: "Another" }),
            })
        ).status
    ).toBe(409);
    expect(
        (
            await s.call("/workspaces", {
                method: "POST",
                headers,
                body: JSON.stringify({ name: "Unpaid", plan: "team" }),
            })
        ).status
    ).toBe(409);
});

it("requires explicit confirmation of the current recurring price before an owner can change a paid subscription", async () => {
    const p = provider(),
        s = await startServe(defer, {
            managedAuth: fakeManagedAuth(),
            billing: p.billing,
            testPlans: false,
        });
    const alice = await customer(s, "alice"),
        headers = { cookie: alice.cookie, "content-type": "application/json" };
    const me = (await (await s.call("/auth/me", { headers })).json()) as {
        workspace: { id: string };
    };
    await s.rt.store.setBillingCustomer(me.workspace.id, "cus_personal");
    await p.event(s.rt.store);
    const info = (await (await s.call("/billing", { headers })).json()) as {
        pricing: Record<string, { version: string; baseAmount: number; seatAmount: number }>;
    };
    const price = info.pricing.pro;
    if (!price) throw new Error("Missing price");
    expect(price.baseAmount).toBe(1000);
    expect(price.seatAmount).toBe(200);
    const update = (data: unknown, origin?: string) =>
        s.call("/billing/subscription", {
            method: "POST",
            headers: { ...headers, ...(origin ? { origin } : {}) },
            body: JSON.stringify(data),
        });
    expect((await update({ plan: "pro", extraSeats: 4 })).status).toBe(400);
    const body = {
        plan: "pro",
        extraSeats: 4,
        confirmed: true,
        priceVersion: price.version,
        expectedAmount: 1800,
    };
    expect((await update({ ...body, priceVersion: "0".repeat(64) })).status).toBe(409);
    expect((await update({ ...body, expectedAmount: 1000 })).status).toBe(409);
    expect((await update(body, "https://untrusted.test")).status).toBe(403);
    expect(p.writes).toHaveLength(0);
    expect((await update(body)).status).toBe(200);
    expect(p.writes.filter((w) => w.path === "subscriptions/sub_personal")).toHaveLength(1);
    expect((await s.rt.store.getWorkspaceLimits(me.workspace.id))?.members).toBe(5);
});
it("makes owner-only production controls available while the test selector stays disabled", async () => {
    const p = provider(),
        s = await startServe(defer, {
            managedAuth: fakeManagedAuth(),
            billing: p.billing,
            testPlans: false,
        });
    const alice = await customer(s, "alice"),
        bob = await customer(s, "bob");
    const headers = { cookie: alice.cookie, "content-type": "application/json" };
    const me = (await (await s.call("/auth/me", { headers })).json()) as {
        username: string;
        workspace: { id: string };
    };
    const info = (await (await s.call("/billing", { headers })).json()) as {
        workspacePlans: boolean;
        limits: { projects: number };
        plans: unknown[];
    };
    expect(info.workspacePlans).toBe(true);
    expect(info.limits.projects).toBe(1);
    expect(JSON.stringify(info.plans)).not.toContain("price_pro");
    expect(
        (
            await s.call("/billing/plan", {
                method: "POST",
                headers,
                body: JSON.stringify({ plan: "team", extraSeats: 0 }),
            })
        ).status
    ).toBe(403);
    expect(
        (
            await s.call("/workspaces", {
                method: "POST",
                headers,
                body: JSON.stringify({ name: "Second private", plan: "free" }),
            })
        ).status
    ).toBe(409);
    expect(
        (
            await s.call("/workspaces", {
                method: "POST",
                headers,
                body: JSON.stringify({ name: "Company", plan: "pro" }),
            })
        ).status
    ).toBe(201);
    const selected = (await (await s.call("/auth/me", { headers })).json()) as {
        workspace: { id: string };
    };
    const bobName = (
        (await (await s.call("/auth/me", { headers: { cookie: bob.cookie } })).json()) as {
            username: string;
        }
    ).username;
    await bill(s.rt.store, selected.workspace.id, { id: "pro", extraSeats: 0 });
    await s.rt.store.setMembership({
        workspaceId: selected.workspace.id,
        username: bobName,
        role: "member",
        createdAt: at(),
    });
    // A member can select the company, but cannot alter its paid subscription.
    await s.call("/auth/workspace", {
        method: "POST",
        headers: { cookie: bob.cookie, "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: selected.workspace.id }),
    });
    expect(
        (
            await s.call("/billing/subscription", {
                method: "POST",
                headers: { cookie: bob.cookie, "content-type": "application/json" },
                body: JSON.stringify({ plan: "team", extraSeats: 1 }),
            })
        ).status
    ).toBe(403);
    expect(me.username).toBeTruthy();
});

it("counts an existing Free workspace even when legacy sharing makes it require cleanup", async () => {
    const { store } = await embeddedPostgres();
    defer(() => store.close());
    const at = new Date().toISOString();
    for (const username of ["owner", "member"])
        await store.upsertUser({ username, passwordHash: "synthetic", createdAt: at });
    await store.createWorkspace(
        { id: "legacy-free", name: "Existing personal", createdAt: at },
        "owner"
    );
    await store.setMembership({
        workspaceId: "legacy-free",
        username: "member",
        role: "member",
        createdAt: at,
    });
    store.setHostedLimits(HOSTED_LIMITS);
    await store.setWorkspacePlans(true);
    await expect(
        store.createWorkspace({ id: "extra-free", name: "Extra", createdAt: at }, "owner")
    ).rejects.toThrow("already has a free");
    expect((await store.ownedFreeWorkspace("owner"))?.id).toBe("legacy-free");
});
