import { useCallback, useEffect, useState } from "react";
import { json, request } from "./api.ts";
import { Section, usePageTitle } from "./Layout.tsx";

type Entry = { id: string; email: string; sdk: string; useCase: string; state: string };
type Overview = {
    paused: boolean;
    maxUsers: number;
    pending: number;
    active: number;
    invited: number;
};
export function BetaAdmin() {
    usePageTitle("Admissions");
    const [overview, setOverview] = useState<Overview | null>(null);
    const [items, setItems] = useState<Entry[]>([]);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [link, setLink] = useState("");
    const load = useCallback(async () => {
        const [info, list] = await Promise.all([
            request<Overview>("/beta/admin"),
            request<{ items: Entry[] }>("/beta/admin/requests"),
        ]);
        setOverview(info);
        setItems(list.items);
    }, []);
    useEffect(() => {
        load().catch((e: Error) => setError(e.message));
    }, [load]);
    const run = async (action: () => Promise<unknown>) => {
        setBusy(true);
        setError("");
        try {
            await action();
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not update admissions");
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="cloud-page">
            <h1>Admissions</h1>
            {error && (
                <p className="error" role="alert">
                    {error}
                </p>
            )}
            {overview && (
                <Section
                    title="Registration capacity"
                    about={`${overview.active} active accounts, ${overview.invited} invitations and ${overview.pending} pending requests.`}
                >
                    <label>
                        Maximum accounts
                        <input
                            type="number"
                            min={1}
                            max={1000}
                            value={overview.maxUsers}
                            onChange={(e) =>
                                setOverview({ ...overview, maxUsers: Number(e.target.value) })
                            }
                        />
                    </label>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                            void run(() =>
                                request(
                                    "/beta/admin",
                                    json("PATCH", {
                                        paused: !overview.paused,
                                        maxUsers: overview.maxUsers,
                                    })
                                )
                            )
                        }
                    >
                        {overview.paused ? "Open admissions" : "Pause admissions"}
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                            void run(() =>
                                request(
                                    "/beta/admin",
                                    json("PATCH", {
                                        paused: overview.paused,
                                        maxUsers: overview.maxUsers,
                                    })
                                )
                            )
                        }
                    >
                        Save capacity
                    </button>
                </Section>
            )}
            {link && (
                <p>
                    Invitation link: <a href={link}>{link}</a>
                </p>
            )}
            <Section
                title="Requests"
                about="Review requests, send or resend invitations, and revoke access."
            >
                {items.map((item) => (
                    <div className="setting-row" key={item.id}>
                        <div>
                            <strong>{item.email}</strong>
                            <p className="muted small">
                                {item.state} · {item.sdk}
                            </p>
                            <p>{item.useCase}</p>
                        </div>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                                void run(async () => {
                                    const result = await request<{ url: string }>(
                                        `/beta/admin/requests/${item.id}/invite`,
                                        json("POST", { days: 7 })
                                    );
                                    setLink(result.url);
                                })
                            }
                        >
                            Send invitation
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                                void run(() =>
                                    request(
                                        `/beta/admin/requests/${item.id}/revoke`,
                                        json("POST", {})
                                    )
                                )
                            }
                        >
                            Revoke
                        </button>
                    </div>
                ))}
            </Section>
        </div>
    );
}
