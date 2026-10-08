import { type FormEvent, useState } from "react";
import { login } from "./api.ts";
import { Logo } from "./ui.tsx";

export function Login({ onDone }: { onDone(): void }) {
    const [username, setUsername] = useState("admin");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (ev: FormEvent) => {
        ev.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await login(username, password);
            onDone();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not sign in");
            setBusy(false);
        }
    };

    return (
        <form className="login" onSubmit={submit}>
            <h1 className="brand-title">
                <Logo size={44} tilt={-8} />
                <span className="wordmark">notato</span>
            </h1>
            <p className="muted">Sign in to see the feedback.</p>
            <label>
                Username
                <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                />
            </label>
            <label>
                Password
                <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                />
            </label>
            {error ? (
                <p className="error" role="alert">
                    {error}
                </p>
            ) : null}
            <button type="submit" className="primary" disabled={busy || !password}>
                Sign in
            </button>
        </form>
    );
}
