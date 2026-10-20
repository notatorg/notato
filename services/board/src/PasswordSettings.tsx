import { useContext, useState } from "react";
import { authClient, authError } from "./auth-client.ts";
import { signOutOtherDevices } from "./HostedLogin.tsx";
import { Section } from "./Layout.tsx";
import { AccountRefreshContext } from "./ProfileSettings.tsx";

/** Matches `minPasswordLength` in the service's Better Auth settings, which stays the authority. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Change the password with the current one, without waiting for an email. Other devices are signed out by default,
 * because a changed password is usually the answer to a lost device or a shared one.
 */
export function PasswordSettings() {
    const refresh = useContext(AccountRefreshContext);
    const [current, setCurrent] = useState("");
    const [next, setNext] = useState("");
    const [confirm, setConfirm] = useState("");
    const [others, setOthers] = useState(true);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState("");
    const [error, setError] = useState("");
    const mismatch = Boolean(confirm) && next !== confirm;
    const ready = Boolean(current) && next.length >= MIN_PASSWORD_LENGTH && next === confirm;
    const edit = (set: (value: string) => void) => (event: { target: { value: string } }) => {
        set(event.target.value);
        setSaved("");
        setError("");
    };
    return (
        <Section
            title="Password"
            about="Change your password here. If you have forgotten it, use Forgot password on the sign-in page instead."
        >
            <form
                onSubmit={async (event) => {
                    event.preventDefault();
                    if (busy || !ready) return;
                    setBusy(true);
                    setError("");
                    setSaved("");
                    try {
                        authError(
                            (
                                await authClient.changePassword({
                                    currentPassword: current,
                                    newPassword: next,
                                    revokeOtherSessions: false,
                                })
                            ).error
                        );
                        setCurrent("");
                        setNext("");
                        setConfirm("");
                        refresh();
                        if (others) {
                            try {
                                await signOutOtherDevices();
                                setSaved("Password changed. Other devices were signed out.");
                            } catch {
                                setSaved(
                                    "Password changed, but other devices could not be signed out. Revoke them under Sign-in sessions."
                                );
                            }
                        } else setSaved("Password changed.");
                    } catch (reason) {
                        setError(
                            reason instanceof Error
                                ? reason.message
                                : "Could not change your password"
                        );
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                <label>
                    Current password
                    <input
                        type="password"
                        name="current-password"
                        autoComplete="current-password"
                        value={current}
                        onChange={edit(setCurrent)}
                        required
                        disabled={busy}
                    />
                </label>
                <label>
                    New password
                    <input
                        type="password"
                        name="new-password"
                        autoComplete="new-password"
                        value={next}
                        onChange={edit(setNext)}
                        minLength={MIN_PASSWORD_LENGTH}
                        maxLength={256}
                        required
                        disabled={busy}
                    />
                </label>
                <p className="muted small">At least {MIN_PASSWORD_LENGTH} characters.</p>
                <label>
                    Confirm new password
                    <input
                        type="password"
                        name="confirm-password"
                        autoComplete="new-password"
                        value={confirm}
                        onChange={edit(setConfirm)}
                        required
                        disabled={busy}
                    />
                </label>
                {mismatch && (
                    <p className="error" role="alert">
                        The new passwords do not match.
                    </p>
                )}
                <label className="check">
                    <input
                        type="checkbox"
                        checked={others}
                        onChange={(event) => setOthers(event.target.checked)}
                        disabled={busy}
                    />{" "}
                    Sign out my other devices
                </label>
                <button type="submit" disabled={busy || !ready}>
                    {busy ? "Changing…" : "Change password"}
                </button>
                {saved && <p role="status">{saved}</p>}
                {error && (
                    <p className="error" role="alert">
                        {error}
                    </p>
                )}
            </form>
        </Section>
    );
}

/** Shown to the instance administrator until the generated password in the settings file has been replaced. */
export function BootstrapPasswordNotice() {
    return (
        <p className="banner" role="status">
            You are still signed in with the password generated for this instance, which is stored
            in plain text in its settings file. <a href="#/settings/account">Change it</a>.
        </p>
    );
}
