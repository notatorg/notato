import { createContext, useContext, useEffect, useState } from "react";
import type { Me } from "./api.ts";
import { authClient, authError } from "./auth-client.ts";
import { Section } from "./Layout.tsx";

/** Refreshes the board's account name as well as the identity session after a profile edit. */
export const AccountRefreshContext = createContext<() => void>(() => {});

export function ProfileSettings({ me }: { me: Me }) {
    const refresh = useContext(AccountRefreshContext);
    const [name, setName] = useState(me.name ?? "");
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => setName(me.name ?? ""), [me.name]);
    return (
        <Section title="Profile" about="Choose the name people see when you collaborate in Notato.">
            <form
                onSubmit={async (event) => {
                    event.preventDefault();
                    const next = name.trim();
                    if (busy || !next || next === me.name) return;
                    setBusy(true);
                    setError("");
                    setSaved(false);
                    try {
                        authError((await authClient.updateUser({ name: next })).error);
                        setName(next);
                        setSaved(true);
                        refresh();
                    } catch (reason) {
                        setError(
                            reason instanceof Error ? reason.message : "Could not save your name"
                        );
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                <label>
                    Display name
                    <input
                        name="name"
                        autoComplete="name"
                        value={name}
                        onChange={(event) => {
                            setName(event.target.value);
                            setSaved(false);
                            setError("");
                        }}
                        required
                        maxLength={100}
                        disabled={busy}
                    />
                </label>
                <button type="submit" disabled={busy || !name.trim() || name.trim() === me.name}>
                    {busy ? "Saving…" : "Save name"}
                </button>
                {saved && <p role="status">Name saved.</p>}
                {error && (
                    <p className="error" role="alert">
                        {error}
                    </p>
                )}
            </form>
        </Section>
    );
}
