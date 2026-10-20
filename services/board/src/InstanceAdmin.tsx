import { useCallback, useEffect, useState } from "react";
import { json, type Me, request } from "./api.ts";
import { authClient, authError } from "./auth-client.ts";
import { Section, usePageTitle } from "./Layout.tsx";

type User = {
    id: string;
    name: string;
    email: string;
    role: string;
    banned: boolean;
    protected: boolean;
};

export function InstanceAdmin({ me }: { me: Me }) {
    usePageTitle("Instance administration");
    const [users, setUsers] = useState<User[]>([]);
    const [email, setEmail] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const load = useCallback(
        () =>
            request<{ items: User[] }>("/instance/users").then(
                (result) => setUsers(result.items),
                (e: Error) => setError(e.message)
            ),
        []
    );
    useEffect(() => {
        if (me.instanceAdmin) void load();
    }, [me.instanceAdmin, load]);
    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
            await action();
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not complete this action");
        } finally {
            setBusy(false);
        }
    };
    if (!me.instanceAdmin)
        return <p className="center error">Instance administrator access required.</p>;
    return (
        <div className="cloud-page">
            <h1>Instance administration</h1>
            {error && (
                <p className="error" role="alert">
                    {error}
                </p>
            )}
            {notice && <p role="status">{notice}</p>}
            <Section
                title="Invite an account"
                about="Invitations work when public registration is closed. The recipient chooses their password and verifies their email."
            >
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                            await request("/instance/invitations", json("POST", { email }));
                            setNotice("Invitation sent.");
                            setEmail("");
                        });
                    }}
                >
                    <label>
                        Email
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </label>
                    <button type="submit" disabled={busy}>
                        Send invitation
                    </button>
                </form>
            </Section>
            <Section
                title="Accounts"
                about="The original instance administrator is protected from deletion, suspension and demotion."
            >
                {users.map((user) => (
                    <div className="setting-row" key={user.id}>
                        <div>
                            <strong>{user.name}</strong>
                            <p className="muted small">
                                {user.email} · {user.role}
                                {user.banned ? " · suspended" : ""}
                            </p>
                        </div>
                        <button
                            type="button"
                            disabled={busy || user.protected}
                            onClick={() =>
                                void run(async () => {
                                    authError(
                                        (user.banned
                                            ? await authClient.admin.unbanUser({ userId: user.id })
                                            : await authClient.admin.banUser({ userId: user.id })
                                        ).error
                                    );
                                })
                            }
                        >
                            {user.protected
                                ? "Protected administrator"
                                : user.banned
                                  ? "Restore access"
                                  : "Suspend"}
                        </button>
                    </div>
                ))}
            </Section>
        </div>
    );
}
