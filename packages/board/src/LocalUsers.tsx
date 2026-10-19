import { useCallback, useEffect, useState } from "react";
import { getMe, json, request, signedOut } from "./api.ts";
export function LocalUsers() {
    const [users, setUsers] = useState<Array<{ username: string; isAdmin?: boolean }> | null>(null);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const load = useCallback(
        () =>
            request<{ items: Array<{ username: string; isAdmin?: boolean }> }>("/admin/users").then(
                (data) => setUsers(data.items)
            ),
        []
    );
    useEffect(() => {
        load().catch(() => {});
    }, [load]);
    if (!users) return null;
    return (
        <section className="set-section">
            <div className="set-label">
                <h2>Server accounts</h2>
                <p>
                    Give each developer their own login, then add them to a project. Each person
                    uses their own app and agent tokens.
                </p>
            </div>
            <div className="set-body">
                {users.map((user) => (
                    <p key={user.username}>
                        {user.username} · {user.isAdmin ? "Server administrator" : "Member"}
                    </p>
                ))}
                {error ? <p className="error">{error}</p> : null}
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        request("/admin/users", json("POST", { username, password }))
                            .then(() => {
                                setUsername("");
                                setPassword("");
                                return load();
                            })
                            .catch((e: Error) => setError(e.message));
                    }}
                >
                    <label className="field">
                        Username
                        <input
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            required
                        />
                    </label>
                    <label className="field">
                        Initial password
                        <input
                            type="password"
                            autoComplete="new-password"
                            minLength={12}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </label>
                    <button type="submit">Create member account</button>
                </form>
            </div>
        </section>
    );
}

export function LocalPassword() {
    const [enabled, setEnabled] = useState(false);
    const [error, setError] = useState("");
    const [current, setCurrent] = useState("");
    const [password, setPassword] = useState("");
    useEffect(() => {
        getMe().then(
            (me) => setEnabled(Boolean(me.localAccounts && me.username)),
            () => {}
        );
    }, []);
    if (!enabled) return null;
    return (
        <section className="set-section">
            <div className="set-label">
                <h2>Your password</h2>
                <p>Changing your password signs out every browser session.</p>
            </div>
            <div className="set-body">
                {error ? <p className="error">{error}</p> : null}
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        request(
                            "/auth/password",
                            json("POST", { currentPassword: current, password })
                        )
                            .then(signedOut)
                            .catch((e: Error) => setError(e.message));
                    }}
                >
                    <label className="field">
                        Current password
                        <input
                            type="password"
                            autoComplete="current-password"
                            value={current}
                            onChange={(e) => setCurrent(e.target.value)}
                            required
                        />
                    </label>
                    <label className="field">
                        New password
                        <input
                            type="password"
                            autoComplete="new-password"
                            minLength={12}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </label>
                    <button type="submit">Change password</button>
                </form>
            </div>
        </section>
    );
}
