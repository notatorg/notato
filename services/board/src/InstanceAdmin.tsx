import { useCallback, useEffect, useState } from "react";
import { Avatar, json, type Me, request } from "./api.ts";
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

export function InstanceAdmin({ me, embedded = false }: { me: Me; embedded?: boolean }) {
    usePageTitle(me.administration?.title ?? "Instance administration");
    const [users, setUsers] = useState<User[] | null>(null);
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
    return (
        <div className={embedded ? undefined : "sheet"}>
            <div className={embedded ? undefined : "sheet-inner settings cloud-page"}>
                {!embedded && (
                    <header className="sheet-head">
                        <div>
                            <h1>Instance</h1>
                            <p>
                                Manage accounts and invitations across your self-hosted Notato
                                server.
                            </p>
                        </div>
                    </header>
                )}
                {!me.instanceAdmin ? (
                    <div className="banner bad" role="alert">
                        <span>Instance administrator access required.</span>
                    </div>
                ) : (
                    <>
                        {error && (
                            <div className="banner bad" role="alert">
                                <span>{error}</span>
                            </div>
                        )}
                        {notice && (
                            <div className="banner ok" role="status">
                                <span>{notice}</span>
                            </div>
                        )}
                        <Section
                            title="Invite an account"
                            about="Invitations work when public registration is closed. The recipient chooses their password and verifies their email."
                        >
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void run(async () => {
                                        await request(
                                            "/instance/invitations",
                                            json("POST", { email })
                                        );
                                        setNotice("Invitation sent.");
                                        setEmail("");
                                    });
                                }}
                            >
                                <label>
                                    Email
                                    <input
                                        type="email"
                                        name="email"
                                        autoComplete="email"
                                        placeholder="teammate@example.com"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        maxLength={254}
                                        disabled={busy}
                                        required
                                    />
                                </label>
                                <button type="submit" className="primary" disabled={busy}>
                                    Send invitation
                                </button>
                            </form>
                        </Section>
                        <Section
                            title="Accounts"
                            about="The original instance administrator is protected from deletion, suspension and demotion."
                        >
                            {users === null ? (
                                <p className="muted" role="status">
                                    {error ? "Accounts could not be loaded." : "Loading accounts…"}
                                </p>
                            ) : users.length === 0 ? (
                                <p className="muted">No accounts to display.</p>
                            ) : (
                                <div className="member-list instance-accounts">
                                    {users.map((user) => (
                                        <div className="member-row" key={user.id}>
                                            <Avatar
                                                author={{ kind: "human", name: user.name }}
                                                size={32}
                                            />
                                            <div className="member-text">
                                                <strong>{user.name}</strong>
                                                <span className="muted small">{user.email}</span>
                                                {user.banned && (
                                                    <span className="error small">Suspended</span>
                                                )}
                                            </div>
                                            <div className="member-actions">
                                                <span className="role-pill">
                                                    {user.protected
                                                        ? "Protected administrator"
                                                        : user.role}
                                                </span>
                                                {!user.protected && (
                                                    <button
                                                        type="button"
                                                        className={
                                                            user.banned ? "link" : "link danger"
                                                        }
                                                        aria-label={`${user.banned ? "Restore access for" : "Suspend"} ${user.name}`}
                                                        disabled={busy}
                                                        onClick={() =>
                                                            void run(async () => {
                                                                authError(
                                                                    (user.banned
                                                                        ? await authClient.admin.unbanUser(
                                                                              { userId: user.id }
                                                                          )
                                                                        : await authClient.admin.banUser(
                                                                              { userId: user.id }
                                                                          )
                                                                    ).error
                                                                );
                                                            })
                                                        }
                                                    >
                                                        {user.banned ? "Restore access" : "Suspend"}
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </Section>
                    </>
                )}
            </div>
        </div>
    );
}
