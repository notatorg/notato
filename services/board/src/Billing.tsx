import { go } from "@notato/board";
import { useEffect, useState } from "react";
import {
    type BillingInfo,
    changeBillingSubscription,
    checkoutBilling,
    getBilling,
    portalBilling,
    selectTestPlan,
} from "./api.ts";
import { Section } from "./Layout.tsx";

const storageSize = (bytes: number, precise = false) => {
    const gb = bytes >= 1024 ** 3;
    return `${(bytes / (gb ? 1024 ** 3 : 1024 ** 2)).toFixed(precise ? 1 : 0)} ${gb ? "GB" : "MB"}`;
};

export function Billing({ onChanged }: { onChanged?(): void }) {
    const [info, setInfo] = useState<BillingInfo | null>(null),
        [error, setError] = useState<string | null>(null),
        [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    useEffect(() => {
        getBilling().then(setInfo, (e: Error) => setError(e.message));
    }, []);
    const open = async (plan?: string) => {
        setBusy(true);
        setError(null);
        try {
            const { url } = await (plan ? checkoutBilling(plan) : portalBilling());
            window.location.assign(url);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not open billing");
            setBusy(false);
        }
    };
    const choose = async (plan: string, extraSeats: number) => {
        if (plan === "free" && info?.selection?.id !== "free") {
            go("#/x/downgrade");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await selectTestPlan(plan, extraSeats);
            setInfo(await getBilling());
            onChanged?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not select plan");
        } finally {
            setBusy(false);
        }
    };
    return (
        <>
            <Section title="Usage" about="What this workspace has used so far.">
                {!info ? <p className="muted small">Loading usage…</p> : null}
                {!info && error ? (
                    <div className="banner bad" role="alert">
                        <span>{error}</span>
                    </div>
                ) : null}
                {info ? (
                    <>
                        <dl className="stats">
                            {info.monthlyNotes && info.limits?.notesPerMonth ? (
                                <div>
                                    <dt>Notes this month</dt>
                                    <dd>
                                        {info.monthlyNotes.notes.toLocaleString()} /{" "}
                                        {info.limits.notesPerMonth.toLocaleString()}
                                    </dd>
                                </div>
                            ) : null}
                            {Object.entries(info.usage).map(([key, value]) => (
                                <div key={key}>
                                    <dt>
                                        {key === "bytes"
                                            ? "Stored data"
                                            : key === "notes"
                                              ? "Stored notes"
                                              : key === "members"
                                                ? "People"
                                                : key === "tokens"
                                                  ? "Active keys"
                                                  : key.charAt(0).toUpperCase() + key.slice(1)}
                                    </dt>
                                    <dd>
                                        {key === "bytes"
                                            ? storageSize(value, true)
                                            : value.toLocaleString()}
                                        {info.limits?.[key] &&
                                        !(info.selfServicePlans && key === "notes")
                                            ? ` / ${key === "bytes" ? storageSize(info.limits[key]) : info.limits[key].toLocaleString()}`
                                            : ""}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                        {info.limits?.notesPerMonth && info.monthlyNotes ? (
                            <p className="muted small">
                                The monthly allowance resets on{" "}
                                {new Date(info.monthlyNotes.periodEnd).toLocaleDateString(
                                    undefined,
                                    {
                                        month: "short",
                                        day: "numeric",
                                        timeZone: "UTC",
                                    }
                                )}{" "}
                                (UTC). Deleting or resolving notes does not reset it. Deleting
                                feedback frees storage.
                            </p>
                        ) : null}
                    </>
                ) : null}
            </Section>
            {info ? (
                <Section
                    title="Plan"
                    about="What this workspace can hold and do. Plans change what you can store and automate, not what the toolbar can do."
                >
                    {error ? (
                        <div className="banner bad" role="alert">
                            <span>{error}</span>
                        </div>
                    ) : null}
                    {info.selfServicePlans ? (
                        <>
                            <p>Test plans are enabled. No payments are taken.</p>
                            <p>
                                Current plan:{" "}
                                <strong>
                                    {info.plans.find((p) => p.id === info.selection?.id)?.name ??
                                        "Free"}
                                </strong>
                            </p>
                            {info.owner ? (
                                <TestPlanControls
                                    key={`${info.selection?.id}:${info.selection?.extraSeats}`}
                                    info={info}
                                    busy={busy}
                                    onChoose={choose}
                                />
                            ) : (
                                <p className="muted small">
                                    A workspace owner can change the plan and seat allowance.
                                </p>
                            )}
                        </>
                    ) : info.workspacePlans ? (
                        <>
                            <p>
                                Current plan:{" "}
                                <strong>
                                    {info.locked
                                        ? "Subscription inactive"
                                        : (info.plans.find((p) => p.id === info.selection?.id)
                                              ?.name ?? "Free")}
                                </strong>
                            </p>
                            {info.locked ? (
                                <p role="status">
                                    Restore payment or complete the downgrade wizard to use this
                                    workspace. Normal access is paused until an active plan is in
                                    place.
                                </p>
                            ) : null}
                            {info.testMode ? (
                                <p>Stripe is in test mode. No real card is charged.</p>
                            ) : null}
                            {notice ? <p role="status">{notice}</p> : null}
                            {info.owner ? (
                                <>
                                    {info.enabled ? (
                                        <PaidPlanControls
                                            key={`${info.selection?.id}:${info.selection?.extraSeats}:${info.locked}`}
                                            info={info}
                                            busy={busy}
                                            onChoose={async (plan, extraSeats) => {
                                                setBusy(true);
                                                setError(null);
                                                setNotice(null);
                                                try {
                                                    if (
                                                        info.selection?.id !== "free" &&
                                                        !info.locked
                                                    ) {
                                                        const price = info.pricing?.[plan];
                                                        if (!price)
                                                            throw new Error(
                                                                "Reload subscription prices before making a change."
                                                            );
                                                        const result =
                                                            await changeBillingSubscription(
                                                                plan,
                                                                extraSeats,
                                                                price.version,
                                                                price.baseAmount +
                                                                    extraSeats * price.seatAmount
                                                            );
                                                        setNotice(
                                                            result.pendingPayment
                                                                ? "Payment is pending. Open Manage subscription to complete it; your current allowance remains in place until payment is confirmed."
                                                                : "Subscription change requested. Your allowance updates after payment is confirmed."
                                                        );
                                                        setInfo(await getBilling());
                                                        onChanged?.();
                                                    } else {
                                                        const { url } = await checkoutBilling(
                                                            plan,
                                                            extraSeats
                                                        );
                                                        window.location.assign(url);
                                                    }
                                                } catch (e) {
                                                    setError(
                                                        e instanceof Error
                                                            ? e.message
                                                            : "Could not update subscription"
                                                    );
                                                } finally {
                                                    setBusy(false);
                                                }
                                            }}
                                        />
                                    ) : (
                                        <p className="muted small">
                                            Subscription management is currently unavailable.
                                        </p>
                                    )}
                                    <div className="data-actions">
                                        {info.hasCustomer ? (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => void open()}
                                            >
                                                Manage subscription
                                            </button>
                                        ) : null}
                                        {info.locked || info.selection?.id !== "free" ? (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => go("#/x/downgrade")}
                                            >
                                                Convert workspace to Free
                                            </button>
                                        ) : null}
                                    </div>
                                </>
                            ) : (
                                <p className="muted small">
                                    A workspace owner can manage its subscription.
                                </p>
                            )}
                        </>
                    ) : info.enabled ? (
                        <>
                            <p>
                                {info.testMode
                                    ? "Billing is in test mode. Test checkout does not charge a real card."
                                    : "Subscriptions apply to this workspace."}{" "}
                                {info.subscription?.plan
                                    ? `${info.subscription.plan} · ${info.subscription.status}`
                                    : ""}
                            </p>
                            {info.owner ? (
                                <div className="data-actions">
                                    {info.hasCustomer ? (
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() => void open()}
                                        >
                                            Manage subscription
                                        </button>
                                    ) : null}
                                    {!info.subscription ||
                                    ["free", "canceled", "incomplete_expired"].includes(
                                        info.subscription.status
                                    )
                                        ? info.plans.map((p) => (
                                              <button
                                                  key={p.id}
                                                  type="button"
                                                  disabled={busy}
                                                  onClick={() => void open(p.id)}
                                              >
                                                  {p.name}
                                              </button>
                                          ))
                                        : null}
                                </div>
                            ) : (
                                <p className="muted small">
                                    A workspace owner can manage the subscription.
                                </p>
                            )}
                        </>
                    ) : (
                        <p className="muted small">Billing is not enabled for this service.</p>
                    )}
                </Section>
            ) : null}
        </>
    );
}

function TestPlanControls({
    info,
    busy,
    onChoose,
}: {
    info: BillingInfo;
    busy: boolean;
    onChoose(plan: string, extraSeats: number): Promise<void>;
}) {
    const [plan, setPlan] = useState(info.selection?.id ?? "free");
    const [extraSeats, setExtraSeats] = useState(info.selection?.extraSeats ?? 0);
    const selected = info.plans.find((p) => p.id === plan);
    const included = selected?.includedSeats ?? 1;
    return (
        <form
            className="plan-picker"
            onSubmit={(event) => {
                event.preventDefault();
                void onChoose(plan, extraSeats);
            }}
        >
            <label>
                Plan
                <select
                    aria-label="Plan"
                    value={plan}
                    disabled={busy}
                    onChange={(event) => {
                        setPlan(event.target.value as typeof plan);
                        setExtraSeats(0);
                    }}
                >
                    {info.plans.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name}
                        </option>
                    ))}
                </select>
            </label>
            {selected ? (
                <p className="muted small">
                    {selected.limits.projects}{" "}
                    {selected.limits.projects === 1 ? "project" : "projects"} ·{" "}
                    {selected.limits.notesPerMonth?.toLocaleString()} notes/month ·{" "}
                    {storageSize(selected.limits.bytes ?? 0)} ·{" "}
                    {plan === "free"
                        ? "Private workspace, six active app/tester and agent keys"
                        : `${included} ${included === 1 ? "person" : "people"} included`}
                </p>
            ) : null}
            {selected?.automation && (
                <p className="muted small">
                    Manual plugin actions included.{" "}
                    {selected.automation.workflows
                        ? `${selected.automation.workflows} workflows and ${selected.automation.actions.toLocaleString()} automatic actions/month.`
                        : "Upgrade to automate saved actions."}
                </p>
            )}
            {plan === "free" ? (
                <p className="muted small">
                    Your free monthly allowance follows your account if you recreate or upgrade its
                    personal workspace.
                </p>
            ) : null}
            {!["free", "plus"].includes(plan) ? (
                <label>
                    Extra seats (no charge during testing)
                    <input
                        type="number"
                        min={0}
                        max={100 - included}
                        value={extraSeats}
                        disabled={busy}
                        onChange={(event) => setExtraSeats(Number(event.target.value))}
                        required
                    />
                </label>
            ) : null}
            <button
                type="submit"
                className="primary"
                disabled={
                    busy ||
                    (plan === info.selection?.id && extraSeats === info.selection?.extraSeats)
                }
            >
                {busy ? "Saving…" : "Apply plan"}
            </button>
        </form>
    );
}

function PaidPlanControls({
    info,
    busy,
    onChoose,
}: {
    info: BillingInfo;
    busy: boolean;
    onChoose(plan: string, extraSeats: number): Promise<void>;
}) {
    const [plan, setPlan] = useState(
        info.selection?.id !== "free"
            ? (info.selection?.id ?? info.plans[0]?.id ?? "pro")
            : (info.requestedPlan?.id ?? info.plans[0]?.id ?? "pro")
    );
    const [extraSeats, setExtraSeats] = useState(
        info.selection?.id !== "free"
            ? (info.selection?.extraSeats ?? 0)
            : (info.requestedPlan?.extraSeats ?? 0)
    );
    const [reviewing, setReviewing] = useState(false);
    const selected = info.plans.find((p) => p.id === plan),
        included = selected?.includedSeats ?? 1;
    const active = info.selection?.id !== "free" && !info.locked;
    const unchanged =
        active && info.selection?.id === plan && info.selection.extraSeats === extraSeats;
    const price = info.pricing?.[plan];
    const subtotal = price
        ? new Intl.NumberFormat(undefined, { style: "currency", currency: price.currency }).format(
              (price.baseAmount + extraSeats * price.seatAmount) / price.divisor
          )
        : null;
    return (
        <form
            className="plan-picker"
            onSubmit={(event) => {
                event.preventDefault();
                if (active && !reviewing) {
                    setReviewing(true);
                    return;
                }
                void onChoose(plan, extraSeats);
            }}
        >
            <label>
                Subscription plan
                <select
                    aria-label="Subscription plan"
                    value={plan}
                    disabled={busy}
                    onChange={(event) => {
                        setPlan(event.target.value);
                        setExtraSeats(0);
                        setReviewing(false);
                    }}
                >
                    {info.plans.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name}
                        </option>
                    ))}
                </select>
            </label>
            <p className="muted small">
                {included} {included === 1 ? "person" : "people"} included.{" "}
                {plan === "plus"
                    ? "Plus is a private workspace for one person."
                    : "Additional seats remain billed until you reduce this allowance."}{" "}
                Testers using the capture SDK do not need a dashboard seat.
            </p>
            {selected && (
                <p className="muted small">
                    {selected.limits.projects} projects ·{" "}
                    {selected.limits.notesPerMonth?.toLocaleString()} notes/month ·{" "}
                    {storageSize(selected.limits.bytes ?? 0)}
                    {selected.automation
                        ? ` · ${selected.automation.workflows} workflows · ${selected.automation.actions.toLocaleString()} automatic actions/month`
                        : ""}
                </p>
            )}
            {plan !== "plus" && (
                <label>
                    Additional seats
                    <input
                        type="number"
                        min={0}
                        max={100 - included}
                        value={extraSeats}
                        disabled={busy}
                        onChange={(event) => {
                            setExtraSeats(Number(event.target.value));
                            setReviewing(false);
                        }}
                        required
                    />
                </label>
            )}
            {price ? (
                <p>
                    Recurring subtotal:{" "}
                    <strong>
                        {subtotal} /{" "}
                        {price.intervalCount === 1
                            ? price.interval
                            : `${price.intervalCount} ${price.interval}s`}
                    </strong>
                </p>
            ) : (
                <p role="status">
                    Subscription prices are temporarily unavailable. Try again later.
                </p>
            )}
            {reviewing ? (
                <p role="status">
                    Stripe calculates any proration and tax. Confirming may charge your payment
                    method immediately.
                </p>
            ) : null}
            <button
                type="submit"
                disabled={
                    busy ||
                    unchanged ||
                    !selected ||
                    !price ||
                    !Number.isInteger(extraSeats) ||
                    extraSeats < 0 ||
                    included + extraSeats > 100
                }
            >
                {active
                    ? reviewing
                        ? "Confirm subscription update"
                        : "Review subscription change"
                    : "Continue to checkout"}
            </button>
        </form>
    );
}
