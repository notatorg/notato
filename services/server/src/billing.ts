import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { RequestError } from "@notato/server";
import { z } from "zod";
import { FREE_PLAN, paidPlan, planLimits, TEST_PLANS } from "./plans.ts";
import { HOSTED_LIMITS, type Store, type WorkspaceBilling, type WorkspacePlan } from "./storage.ts";

const Limits = z
    .object({
        notes: z.number().int().positive().max(1_000_000),
        notesPerMonth: z.number().int().positive().max(1_000_000).optional(),
        bytes: z
            .number()
            .int()
            .positive()
            .max(100 * 1024 ** 3),
        projects: z.number().int().positive().max(10_000),
        tokens: z.number().int().positive().max(10_000),
        members: z.number().int().positive().max(10_000).optional(),
    })
    .strict();
const Plan = z
    .object({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
        name: z.string().trim().min(1).max(80),
        priceId: z.string().regex(/^price_[\w]{1,150}$/),
        limits: Limits,
        includedSeats: z.number().int().min(1).max(100).optional(),
        seatPriceId: z
            .string()
            .regex(/^price_[\w]{1,150}$/)
            .optional(),
    })
    .strict();
const WorkspacePrice = z
    .object({
        id: z.enum(["plus", "pro", "team"]),
        priceId: z.string().regex(/^price_[\w]{1,150}$/),
        seatPriceId: z
            .string()
            .regex(/^price_[\w]{1,150}$/)
            .optional(),
    })
    .strict();
export type WorkspacePriceConfig = z.infer<typeof WorkspacePrice>;
export interface WorkspacePricing {
    currency: string;
    baseAmount: number;
    seatAmount: number;
    interval: string;
    intervalCount: number;
    divisor: number;
    version: string;
}
export type BillingPlan = z.infer<typeof Plan> & {
    automation?: { workflows: number; actions: number };
};
export interface BillingOptions {
    key: string;
    webhookSecret: string;
    origin: string;
    plans: Array<BillingPlan | WorkspacePriceConfig>;
    workspacePlans?: boolean;
    live?: boolean;
    fetcher?: typeof fetch;
}
const ACTIVE = new Set(["active", "trialing"]);
const Customer = z.string().regex(/^cus_[\w]{1,150}$/);

/** A single-instance billing adapter. Only owners start checkout; signed webhooks reconcile authoritative provider state. */
export class StripeBilling {
    readonly plans: BillingPlan[];
    readonly live: boolean;
    readonly workspacePlans: boolean;
    private turns = new Map<string, Promise<unknown>>();
    private fetcher: typeof fetch;
    private priceCache?: { until: number; data: Record<string, WorkspacePricing> };
    private loadingPrices?: Promise<Record<string, WorkspacePricing>>;
    constructor(private options: BillingOptions) {
        this.live = options.live ?? false;
        if (
            !options.key.startsWith(this.live ? "sk_live_" : "sk_test_") &&
            !options.key.startsWith(this.live ? "rk_live_" : "rk_test_")
        )
            throw new Error("Stripe key does not match the configured test/live mode");
        if (!/^whsec_[\w-]+$/.test(options.webhookSecret))
            throw new Error("Stripe webhook signing secret is required");
        const origin = new URL(options.origin);
        if (
            origin.protocol !== "https:" &&
            !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))
        )
            throw new Error("billing needs a canonical HTTPS origin");
        if (
            origin.username ||
            origin.password ||
            origin.pathname !== "/" ||
            origin.search ||
            origin.hash
        )
            throw new Error("billing origin must not contain paths or credentials");
        this.workspacePlans = options.workspacePlans ?? false;
        this.plans = this.workspacePlans
            ? z
                  .array(WorkspacePrice)
                  .min(1)
                  .max(3)
                  .parse(options.plans)
                  .map((entry) => {
                      const known = TEST_PLANS.find((p) => p.id === entry.id);
                      if (!known) throw new Error("unknown workspace plan");
                      if ((entry.id === "plus") !== !entry.seatPriceId)
                          throw new Error("Plus has no seat price; Pro and Team require one");
                      return {
                          ...entry,
                          name: known.name,
                          automation: known.automation,
                          includedSeats: known.includedSeats,
                          limits: {
                              ...known.limits,
                              notes: 1_000_000,
                              members: known.includedSeats,
                          },
                      };
                  })
            : z.array(Plan).min(1).max(20).parse(options.plans);
        if (
            this.workspacePlans &&
            this.plans.some((p) => this.plans.some((other) => other.priceId === p.seatPriceId))
        )
            throw new Error("seat prices must be separate from workspace base prices");
        if (
            new Set(this.plans.map((p) => p.id)).size !== this.plans.length ||
            new Set(this.plans.map((p) => p.priceId)).size !== this.plans.length
        )
            throw new Error("billing plan IDs and prices must be unique");
        this.fetcher = options.fetcher ?? fetch;
    }
    private async api(
        path: string,
        method = "GET",
        body?: URLSearchParams,
        idempotency?: string
    ): Promise<Record<string, unknown>> {
        try {
            const response = await this.fetcher(`https://api.stripe.com/v1/${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.options.key}`,
                    "Stripe-Version": "2024-06-20",
                    ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
                    ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
                },
                ...(body ? { body: body.toString() } : {}),
                signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok)
                throw new RequestError("billing provider is unavailable; try again", 503);
            return (await response.json()) as Record<string, unknown>;
        } catch {
            throw new RequestError("billing provider is unavailable; try again", 503);
        }
    }
    private redirect(value: unknown, host: string): string {
        if (typeof value !== "string")
            throw new RequestError("billing provider did not return a checkout address", 503);
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password)
            throw new RequestError("billing provider returned an unexpected address", 503);
        return url.href;
    }
    private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
        if (this.turns.size >= 128 && !this.turns.has(key))
            throw new RequestError("billing is busy; try again", 429);
        const before = this.turns.get(key) ?? Promise.resolve();
        const next = before.catch(() => {}).then(work);
        this.turns.set(key, next);
        try {
            return await next;
        } finally {
            if (this.turns.get(key) === next) this.turns.delete(key);
        }
    }
    private selection(plan: BillingPlan, extraSeats: number): WorkspacePlan {
        if (!this.workspacePlans) {
            if (extraSeats) throw new RequestError("extra seats require workspace plan billing");
            return FREE_PLAN;
        }
        const result = { id: plan.id as WorkspacePlan["id"], extraSeats };
        planLimits(result);
        return result;
    }
    /** Public amounts only. Immutable price IDs are cached; provider failures never hide workspace usage. */
    pricing(): Promise<Record<string, WorkspacePricing>> {
        if (!this.workspacePlans) return Promise.resolve({});
        if (this.priceCache && this.priceCache.until > Date.now())
            return Promise.resolve(this.priceCache.data);
        this.loadingPrices ??= Promise.all(
            this.plans.map(async (plan) => {
                const [base, seat] = await Promise.all([
                    this.api(`prices/${encodeURIComponent(plan.priceId)}`),
                    plan.seatPriceId
                        ? this.api(`prices/${encodeURIComponent(plan.seatPriceId)}`)
                        : Promise.resolve(null),
                ]);
                const pricedSeat = seat ?? { ...base, unit_amount: 0 };
                const a = base.recurring as Record<string, unknown> | undefined,
                    b = pricedSeat.recurring as Record<string, unknown> | undefined;
                if (
                    base.active !== true ||
                    pricedSeat.active !== true ||
                    base.livemode !== this.live ||
                    pricedSeat.livemode !== this.live ||
                    base.billing_scheme !== "per_unit" ||
                    pricedSeat.billing_scheme !== "per_unit" ||
                    !a ||
                    !b ||
                    a.usage_type !== "licensed" ||
                    b.usage_type !== "licensed" ||
                    a.interval !== b.interval ||
                    (a.interval_count ?? 1) !== (b.interval_count ?? 1) ||
                    !["day", "week", "month", "year"].includes(String(a.interval)) ||
                    !Number.isInteger(a.interval_count ?? 1) ||
                    Number(a.interval_count ?? 1) < 1 ||
                    typeof base.currency !== "string" ||
                    !/^[a-z]{3}$/.test(base.currency) ||
                    pricedSeat.currency !== base.currency ||
                    !Number.isSafeInteger(base.unit_amount) ||
                    !Number.isSafeInteger(pricedSeat.unit_amount) ||
                    Number(base.unit_amount) < 0 ||
                    Number(pricedSeat.unit_amount) < 0
                )
                    throw new RequestError("subscription prices are unavailable", 503);
                const zero = new Set([
                    "bif",
                    "clp",
                    "djf",
                    "gnf",
                    "jpy",
                    "kmf",
                    "krw",
                    "mga",
                    "pyg",
                    "rwf",
                    "vnd",
                    "vuv",
                    "xaf",
                    "xof",
                    "xpf",
                ]);
                const value = {
                    currency: base.currency,
                    baseAmount: Number(base.unit_amount),
                    seatAmount: Number(pricedSeat.unit_amount),
                    interval: String(a.interval),
                    intervalCount: Number(a.interval_count ?? 1),
                    divisor: zero.has(base.currency) ? 1 : 100,
                };
                if (!Number.isSafeInteger(value.baseAmount + 99 * value.seatAmount))
                    throw new RequestError("subscription price exceeds the supported range", 503);
                const version = createHash("sha256")
                    .update(
                        JSON.stringify([
                            this.live,
                            plan.id,
                            plan.priceId,
                            plan.seatPriceId,
                            plan.includedSeats,
                            plan.limits,
                            value,
                        ])
                    )
                    .digest("hex");
                return [plan.id, { ...value, version }] as const;
            })
        )
            .then((entries) => {
                const data = Object.fromEntries(entries);
                this.priceCache = { until: Date.now() + 300_000, data };
                return data;
            })
            .finally(() => {
                this.loadingPrices = undefined;
            });
        return this.loadingPrices;
    }
    async confirmPrice(planId: string, extraSeats: number, version: string, amount: number) {
        const price = (await this.pricing())[planId];
        if (
            !price ||
            price.version !== version ||
            price.baseAmount + extraSeats * price.seatAmount !== amount
        )
            throw new RequestError(
                "Prices changed. Reload and review the subscription again.",
                409
            );
    }
    private async checkPrices(plan: BillingPlan, extraSeats: number) {
        const base = await this.api(`prices/${encodeURIComponent(plan.priceId)}`);
        const recurring = base.recurring as Record<string, unknown> | undefined;
        if (base.active !== true || !recurring || base.livemode !== this.live)
            throw new RequestError("this plan is not available", 503);
        if (!this.workspacePlans) return;
        if (recurring.usage_type !== "licensed" || typeof base.currency !== "string")
            throw new RequestError("workspace prices must use licensed recurring billing", 503);
        if (extraSeats) {
            const seat = await this.api(`prices/${encodeURIComponent(plan.seatPriceId ?? "")}`),
                seatRecurring = seat.recurring as Record<string, unknown> | undefined;
            if (
                seat.active !== true ||
                seat.livemode !== this.live ||
                seat.currency !== base.currency ||
                !seatRecurring ||
                seatRecurring.usage_type !== "licensed" ||
                seatRecurring.interval !== recurring.interval ||
                (seatRecurring.interval_count ?? 1) !== (recurring.interval_count ?? 1)
            )
                throw new RequestError(
                    "seat price does not match the workspace billing period and currency",
                    503
                );
        }
    }
    private subscription(id: string) {
        return this.api(
            `subscriptions/${encodeURIComponent(id)}${this.workspacePlans ? "?expand%5B%5D=latest_invoice" : ""}`
        );
    }
    private subscriptionState(
        current: Record<string, unknown>,
        existing: WorkspaceBilling
    ): WorkspaceBilling {
        const items =
            (
                current.items as {
                    data?: Array<{
                        id?: string;
                        price?: { id?: string };
                        quantity?: number;
                        current_period_end?: number;
                    }>;
                }
            )?.data ?? [];
        const bases = items.filter((i) => this.plans.some((p) => p.priceId === i.price?.id));
        const base = bases.length === 1 ? bases[0] : undefined;
        const plan = this.plans.find((p) => p.priceId === base?.price?.id);
        const seats = items.filter((i) => i !== base);
        const extraSeats =
            seats.length === 0
                ? 0
                : seats.length === 1 && seats[0]?.price?.id === plan?.seatPriceId
                  ? seats[0]?.quantity
                  : undefined;
        let selected: WorkspacePlan | undefined;
        if (
            plan &&
            base?.quantity === 1 &&
            typeof extraSeats === "number" &&
            Number.isInteger(extraSeats) &&
            !(current.items as { has_more?: boolean })?.has_more
        ) {
            try {
                selected = this.selection(plan, extraSeats);
            } catch {
                /* Invalid quantities never grant capacity. */
            }
        }
        const end = Number(current.current_period_end ?? base?.current_period_end);
        const state: WorkspaceBilling = {
            workspaceId: existing.workspaceId,
            customerId: existing.customerId,
            subscriptionId: String(current.id),
            status: String(current.status),
            ...(plan ? { plan: plan.id } : {}),
            ...(Number.isFinite(end) ? { periodEnd: new Date(end * 1000).toISOString() } : {}),
        };
        const invoice = current.latest_invoice as { status?: string } | undefined;
        if (selected && ACTIVE.has(state.status) && end * 1000 > Date.now()) {
            if (state.status === "trialing" || invoice?.status === "paid") {
                state.entitlement = selected;
                state.limits = planLimits(selected);
            } else if (
                current.pending_update &&
                paidPlan(existing) &&
                existing.entitlement?.id === selected.id &&
                existing.entitlement.extraSeats === selected.extraSeats
            ) {
                state.entitlement = existing.entitlement;
                state.limits = planLimits(existing.entitlement);
                state.periodEnd = new Date(
                    Math.min(end * 1000, Date.parse(existing.periodEnd ?? ""))
                ).toISOString();
            }
        }
        return state;
    }
    async changeSubscription(
        store: Store,
        workspaceId: string,
        planId: string,
        extraSeats: number
    ) {
        if (!this.workspacePlans) throw new RequestError("workspace plan billing is disabled", 403);
        const plan = this.plans.find((p) => p.id === planId);
        if (!plan) throw new RequestError("unknown billing plan");
        const selected = this.selection(plan, extraSeats),
            limits = planLimits(selected),
            usage = await store.workspaceUsage(workspaceId);
        if (
            usage.members > (limits.members ?? 1) ||
            usage.projects > limits.projects ||
            usage.bytes > limits.bytes ||
            usage.tokens > limits.tokens
        )
            throw new RequestError(
                "Remove excess people, projects, keys or storage before reducing the subscription",
                409
            );
        return this.serial(workspaceId, async () => {
            const account = await store.getBilling(workspaceId);
            if (!account?.subscriptionId || !paidPlan(account))
                throw new RequestError("an active workspace subscription is required", 409);
            const current = await this.subscription(account.subscriptionId);
            if (
                current.id !== account.subscriptionId ||
                current.customer !== account.customerId ||
                current.livemode !== this.live ||
                !ACTIVE.has(String(current.status))
            )
                throw new RequestError("billing account mismatch", 409);
            if (current.pending_update)
                throw new RequestError(
                    "Complete or cancel the pending payment in the billing portal first",
                    409
                );
            const items =
                (current.items as { data?: Array<{ id?: string; price?: { id?: string } }> })
                    ?.data ?? [];
            const base = items.find((i) => this.plans.some((p) => p.priceId === i.price?.id));
            if (!base?.id || !/^si_[\w]+$/.test(base.id) || items.length > 2)
                throw new RequestError("subscription items need review", 409);
            await this.checkPrices(plan, extraSeats);
            const fields = new URLSearchParams({
                payment_behavior: "pending_if_incomplete",
                proration_behavior: "always_invoice",
                "items[0][id]": base.id,
                "items[0][price]": plan.priceId,
                "items[0][quantity]": "1",
            });
            const oldSeat = items.find((i) => i !== base);
            if (oldSeat && (!oldSeat.id || !/^si_[\w]+$/.test(oldSeat.id)))
                throw new RequestError("subscription items need review", 409);
            if (oldSeat) {
                fields.set("items[1][id]", String(oldSeat.id));
                if (extraSeats) {
                    fields.set("items[1][price]", plan.seatPriceId ?? "");
                    fields.set("items[1][quantity]", String(extraSeats));
                } else fields.set("items[1][deleted]", "true");
            } else if (extraSeats) {
                fields.set("items[1][price]", plan.seatPriceId ?? "");
                fields.set("items[1][quantity]", String(extraSeats));
            }
            const changed = await this.api(
                `subscriptions/${encodeURIComponent(account.subscriptionId)}`,
                "POST",
                fields
            );
            // Webhooks reconcile capacity; the update response alone cannot grant seats or reset usage.
            return { pendingPayment: Boolean(changed.pending_update) };
        });
    }
    private async customer(
        store: Store,
        workspaceId: string,
        email?: string
    ): Promise<WorkspaceBilling> {
        const found = await store.getBilling(workspaceId);
        if (found) return found;
        const workspace = await store.getWorkspace(workspaceId);
        if (!workspace) throw new RequestError("workspace not found", 404);
        const fields = new URLSearchParams({
            name: workspace.name,
            "metadata[notato_workspace]": workspaceId,
        });
        if (email) fields.set("email", email);
        const fingerprint = createHash("sha256")
            .update(`${this.options.origin}|${workspaceId}|${workspace.createdAt}`)
            .digest("hex");
        const made = await this.api("customers", "POST", fields, `notato-customer-${fingerprint}`);
        return store.setBillingCustomer(workspaceId, Customer.parse(made.id));
    }
    async checkout(
        store: Store,
        workspaceId: string,
        planId: string,
        email?: string,
        extraSeats = 0
    ): Promise<string> {
        const plan = this.plans.find((p) => p.id === planId);
        if (!plan) throw new RequestError("unknown billing plan");
        this.selection(plan, extraSeats);
        return this.serial(workspaceId, async () => {
            const account = await this.customer(store, workspaceId, email);
            if (
                account.subscriptionId &&
                !["canceled", "incomplete_expired", "free"].includes(account.status)
            )
                throw new RequestError(
                    "manage the existing subscription in the billing portal",
                    409
                );
            if (account.checkout && account.checkout.expiresAt > new Date().toISOString()) {
                if (
                    account.checkout.plan === planId &&
                    (account.checkout.extraSeats ?? 0) === extraSeats
                )
                    return account.checkout.url;
                const old = await this.api(
                    `checkout/sessions/${encodeURIComponent(account.checkout.id)}`
                );
                if (old.status === "complete")
                    throw new RequestError("checkout completed; wait for the billing update", 409);
                if (old.status === "open")
                    await this.api(
                        `checkout/sessions/${encodeURIComponent(account.checkout.id)}/expire`,
                        "POST",
                        new URLSearchParams()
                    );
            }
            // A delayed webhook must not let a second checkout create another paid subscription.
            const subscriptions = await this.api(
                `subscriptions?customer=${encodeURIComponent(account.customerId)}&status=all&limit=100`
            );
            const rows = Array.isArray(subscriptions.data)
                ? (subscriptions.data as Array<{ status?: string }>)
                : [];
            if (
                subscriptions.has_more ||
                rows.some(
                    (row) => row.status && !["canceled", "incomplete_expired"].includes(row.status)
                )
            )
                throw new RequestError(
                    "manage the existing subscription in the billing portal",
                    409
                );
            await this.checkPrices(plan, extraSeats);
            const fields = new URLSearchParams({
                mode: "subscription",
                customer: account.customerId,
                "line_items[0][price]": plan.priceId,
                "line_items[0][quantity]": "1",
                success_url: `${this.options.origin}/#/workspace`,
                cancel_url: `${this.options.origin}/#/workspace`,
                client_reference_id: workspaceId,
                "subscription_data[metadata][notato_workspace]": workspaceId,
            });
            if (this.workspacePlans) {
                fields.set("payment_method_types[0]", "card");
                if (extraSeats) {
                    fields.set("line_items[1][price]", plan.seatPriceId ?? "");
                    fields.set("line_items[1][quantity]", String(extraSeats));
                }
            }
            const session = await this.api("checkout/sessions", "POST", fields);
            const url = this.redirect(session.url, "checkout.stripe.com");
            const id = z
                .string()
                .regex(/^cs_[\w]{1,150}$/)
                .parse(session.id);
            const expiresAt = new Date(
                z.number().int().positive().parse(session.expires_at) * 1000
            ).toISOString();
            await store.saveCheckout(workspaceId, { id, url, plan: planId, expiresAt, extraSeats });
            return url;
        });
    }
    async portal(store: Store, workspaceId: string): Promise<string> {
        const state = await store.getBilling(workspaceId);
        if (!state) throw new RequestError("no billing account yet", 404);
        const session = await this.api(
            "billing_portal/sessions",
            "POST",
            new URLSearchParams({
                customer: state.customerId,
                return_url: `${this.options.origin}/#/workspace`,
            })
        );
        return this.redirect(session.url, "billing.stripe.com");
    }
    private verify(raw: Uint8Array, signature: string | null): void {
        const parts = (signature ?? "").split(",");
        const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
        if (
            !timestamp ||
            !/^\d+$/.test(timestamp) ||
            Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
        )
            throw new RequestError("invalid billing signature");
        const expected = createHmac("sha256", this.options.webhookSecret)
            .update(`${timestamp}.`)
            .update(raw)
            .digest();
        const valid = parts
            .filter((p) => p.startsWith("v1="))
            .some((p) => {
                const hex = p.slice(3);
                if (!/^[\da-f]{64}$/i.test(hex)) return false;
                return timingSafeEqual(expected, Buffer.from(hex, "hex"));
            });
        if (!valid) throw new RequestError("invalid billing signature");
    }
    async webhook(store: Store, raw: Uint8Array, signature: string | null): Promise<void> {
        this.verify(raw, signature);
        let parsed: unknown;
        try {
            parsed = JSON.parse(new TextDecoder().decode(raw));
        } catch {
            throw new RequestError("invalid billing event");
        }
        const checked = z
            .object({
                id: z.string().regex(/^evt_[\w]{1,150}$/),
                type: z.string().max(100),
                livemode: z.boolean(),
                data: z.object({ object: z.record(z.string(), z.unknown()) }),
            })
            .safeParse(parsed);
        if (!checked.success) throw new RequestError("invalid billing event");
        const event = checked.data;
        if (event.livemode !== this.live) throw new RequestError("billing mode mismatch");
        if (
            ![
                "customer.subscription.created",
                "customer.subscription.updated",
                "customer.subscription.deleted",
                "checkout.session.completed",
                ...(this.workspacePlans
                    ? [
                          "invoice.paid",
                          "invoice.payment_failed",
                          "invoice.payment_action_required",
                          "customer.subscription.pending_update_applied",
                          "customer.subscription.pending_update_expired",
                      ]
                    : []),
            ].includes(event.type)
        )
            return;
        const object = event.data.object;
        const customer = typeof object.customer === "string" ? object.customer : null;
        if (!customer) return;
        const workspaceId = await store.billingWorkspace(customer);
        if (!workspaceId) return;
        await this.serial(workspaceId, async () => {
            const subscriptionId =
                event.type === "checkout.session.completed" || event.type.startsWith("invoice.")
                    ? object.subscription
                    : object.id;
            if (typeof subscriptionId !== "string" || !/^sub_[\w]{1,150}$/.test(subscriptionId))
                return;
            const current = await this.subscription(subscriptionId);
            if (
                current.customer !== customer ||
                current.livemode !== this.live ||
                (this.workspacePlans && current.id !== subscriptionId)
            )
                throw new RequestError("billing account mismatch");
            const existing = await store.getBilling(workspaceId);
            if (!existing || existing.customerId !== customer) return;
            if (
                existing.subscriptionId &&
                existing.subscriptionId !== subscriptionId &&
                !["canceled", "incomplete_expired", "free"].includes(existing.status)
            )
                return;
            if (this.workspacePlans) {
                const state = this.subscriptionState(current, existing);
                await store.applyBillingEvent(event.id, state, new Date().toISOString());
                return;
            }
            const item = ((
                current.items as {
                    data?: Array<{ price?: { id?: string }; current_period_end?: number }>;
                }
            )?.data ?? [])[0];
            const plan = this.plans.find((p) => p.priceId === item?.price?.id);
            const end = Number(current.current_period_end ?? item?.current_period_end);
            const active =
                ACTIVE.has(String(current.status)) &&
                plan &&
                Number.isFinite(end) &&
                end * 1000 > Date.now();
            const state: WorkspaceBilling = {
                workspaceId,
                customerId: customer,
                subscriptionId,
                status: String(current.status),
                ...(plan ? { plan: plan.id } : {}),
                ...(Number.isFinite(end) ? { periodEnd: new Date(end * 1000).toISOString() } : {}),
                ...(active ? { limits: { ...HOSTED_LIMITS, ...plan.limits } } : {}),
            };
            await store.applyBillingEvent(event.id, state, new Date().toISOString());
        });
    }
}

export function billingFromEnv(origin: string | undefined): StripeBilling | undefined {
    const key = process.env.NOTATO_STRIPE_KEY,
        webhookSecret = process.env.NOTATO_STRIPE_WEBHOOK_SECRET,
        raw = process.env.NOTATO_BILLING_PLANS;
    if (!key && !webhookSecret && !raw) return undefined;
    if (!key || !webhookSecret || !raw || !origin)
        throw new Error(
            "billing requires the Stripe key, webhook secret, plans and public origin together"
        );
    const mode = process.env.NOTATO_BILLING_MODE ?? "test";
    if (!["test", "live"].includes(mode)) throw new Error("billing mode must be test or live");
    return new StripeBilling({
        key,
        webhookSecret,
        origin,
        plans: JSON.parse(raw),
        workspacePlans: billingModel() === "workspace",
        live: mode === "live",
    });
}

export function billingModel(model = process.env.NOTATO_BILLING_MODEL ?? "workspace") {
    if (!["workspace", "legacy"].includes(model))
        throw new Error("NOTATO_BILLING_MODEL must be workspace or legacy");
    return model;
}
