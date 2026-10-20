import { assertBoard, json, RequestError, readJson } from "@notato/server";
import { z } from "zod";
import type { CloudRoutes } from "../context.ts";
import { FREE_PLAN, TEST_PLANS } from "../plans.ts";

export const billingWebhook: CloudRoutes<import("../auth.ts").Principal | null> = async (
    { req, path, method },
    { backend, options }
) => {
    if (path !== "/billing/webhook" || method !== "POST") return null;
    if (!options.billing) return json({ error: "billing is disabled" }, 404);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = req.body?.getReader();
    try {
        if (reader)
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.length;
                if (size > 65536) {
                    await reader.cancel();
                    throw new RequestError("billing event is too large", 413);
                }
                chunks.push(chunk.value);
            }
    } finally {
        reader?.releaseLock();
    }
    await options.billing.webhook(
        backend.store,
        Buffer.concat(chunks),
        req.headers.get("stripe-signature")
    );
    return json({ received: true });
};
export const billingRoutes: CloudRoutes = async (
    { req, path, method, principal },
    { auth, backend, options }
) => {
    if (
        ![
            "/billing",
            "/billing/checkout",
            "/billing/portal",
            "/billing/plan",
            "/billing/subscription",
            "/billing/free",
        ].includes(path)
    )
        return null;
    if (!auth || principal.kind !== "member")
        throw new RequestError("workspace sign-in required", 403);
    const owner =
        (await auth.store.getMembership(principal.workspaceId, principal.username))?.role ===
        "owner";
    if (path === "/billing" && method === "GET") {
        const state = await backend.store.getBilling(principal.workspaceId);
        const selection =
            options.testPlans || options.workspacePlans
                ? ((await backend.store.getWorkspacePlan(principal.workspaceId)) ?? FREE_PLAN)
                : null;
        const access = options.workspacePlans
            ? await backend.store.getWorkspaceEntitlement(principal.workspaceId)
            : null;
        let pricing:
            | Awaited<ReturnType<NonNullable<typeof options.billing>["pricing"]>>
            | undefined;
        let pricesUnavailable = false;
        if (owner && options.billing?.workspacePlans) {
            try {
                pricing = await options.billing.pricing();
            } catch {
                pricesUnavailable = true;
            }
        }
        return json({
            enabled: Boolean(options.billing),
            testMode:
                Boolean(options.testPlans) || (options.billing ? !options.billing.live : false),
            selfServicePlans: Boolean(options.testPlans),
            workspacePlans: Boolean(options.workspacePlans),
            locked: access?.locked ?? false,
            requestedPlan: access?.requestedPlan,
            pricing,
            pricesUnavailable,
            owner,
            usage: await backend.store.workspaceUsage(principal.workspaceId),
            limits: (await backend.store.getWorkspaceLimits(principal.workspaceId)) ?? null,
            monthlyNotes: await backend.store.monthlyNoteUsage(principal.workspaceId),
            selection,
            subscription:
                options.testPlans && selection
                    ? { plan: selection.id, status: "test" }
                    : state
                      ? { plan: state.plan, status: state.status, periodEnd: state.periodEnd }
                      : null,
            hasCustomer: Boolean(state),
            plans: options.testPlans
                ? TEST_PLANS
                : (options.billing?.plans.map(
                      ({ priceId: _secret, seatPriceId: _seat, ...plan }) => plan
                  ) ?? []),
        });
    }
    if (method !== "POST") return null;
    assertBoard(req, "billing");
    if (!owner) throw new RequestError("workspace owner required", 403);
    if (path === "/billing/plan") {
        if (!options.testPlans) throw new RequestError("test plan selection is disabled", 403);
        const { plan, extraSeats } = await readJson(
            req,
            z
                .object({
                    plan: z.enum(["free", "plus", "pro", "team"]),
                    extraSeats: z.number().int().min(0).max(99).default(0),
                })
                .strict()
        );
        const selected = await backend.store.selectWorkspacePlan(
            principal.workspaceId,
            principal.username,
            plan,
            extraSeats
        );
        await auth.store.appendAudit({
            id: crypto.randomUUID(),
            workspaceId: principal.workspaceId,
            actor: principal.username,
            action: `Test plan: ${plan}, extra seats: ${extraSeats}`,
            outcome: 200,
            createdAt: new Date().toISOString(),
        });
        return json(selected);
    }
    if (path === "/billing/free") {
        if (!options.workspacePlans)
            throw new RequestError("workspace plan billing is disabled", 403);
        await readJson(req, z.object({}).strict());
        return json(
            await backend.store.selectWorkspacePlan(
                principal.workspaceId,
                principal.username,
                "free",
                0
            )
        );
    }
    const billing = options.billing;
    if (!billing) throw new RequestError("billing is disabled", 503);
    if (path === "/billing/subscription") {
        if (!billing.workspacePlans)
            throw new RequestError("workspace plan billing is disabled", 403);
        const { plan, extraSeats, confirmed, priceVersion, expectedAmount } = await readJson(
            req,
            z
                .object({
                    plan: z.enum(["plus", "pro", "team"]),
                    extraSeats: z.number().int().min(0).max(99),
                    confirmed: z.literal(true),
                    priceVersion: z.string().regex(/^[0-9a-f]{64}$/),
                    expectedAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
                })
                .strict()
        );
        if (!confirmed) throw new RequestError("Confirm the subscription change", 400);
        await billing.confirmPrice(plan, extraSeats, priceVersion, expectedAmount);
        return json(
            await billing.changeSubscription(backend.store, principal.workspaceId, plan, extraSeats)
        );
    }
    if (path === "/billing/checkout") {
        const { plan, extraSeats } = await readJson(
            req,
            z
                .object({
                    plan: z.string().max(40),
                    extraSeats: z.number().int().min(0).max(99).default(0),
                })
                .strict()
        );
        const user = await auth.store.getUser(principal.username);
        return json({
            url: await billing.checkout(
                backend.store,
                principal.workspaceId,
                plan,
                user?.email,
                extraSeats
            ),
        });
    }
    await readJson(req, z.object({}).strict());
    return json({ url: await billing.portal(backend.store, principal.workspaceId) });
};
