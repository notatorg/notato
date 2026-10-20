import { Logo } from "@notato/board";
import { type FormEvent, useState } from "react";
import { revokeOtherAccountSessions } from "./api.ts";
import { authClient, authError } from "./auth-client.ts";

export async function forgetIdentitySession() {
    authError((await authClient.signOut()).error);
}
export async function signOutOtherDevices() {
    await revokeOtherAccountSessions();
    authError((await authClient.revokeOtherSessions()).error);
}

/** The session cookie is HttpOnly. Passwords and second-factor challenges go only to this instance. */
export function HostedLogin({
    onDone,
    signupMode = "closed",
    invitedEmail,
}: {
    onDone(): void;
    invitedEmail?: string;
    signupMode?: "closed" | "allowlist" | "open";
}) {
    const params = new URL(window.location.href).searchParams;
    const invitation = params.get("registration") ?? params.get("invite");
    const [mode, setMode] = useState<"login" | "signup" | "recover" | "reset" | "mfa">(
        params.has("reset") ? "reset" : invitation || invitedEmail ? "signup" : "login"
    );
    const [email, setEmail] = useState(params.get("email") ?? invitedEmail ?? "");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [code, setCode] = useState("");
    const [backup, setBackup] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        setNotice("");
        try {
            if (mode === "signup") {
                const result = await authClient.signUp.email({
                    email,
                    password,
                    name,
                    callbackURL: `${window.location.origin}/${params.has("invite") ? `?invite=${encodeURIComponent(params.get("invite") ?? "")}` : ""}`,
                    fetchOptions: {
                        headers: invitation ? { "x-notato-invitation": invitation } : {},
                    },
                });
                authError(result.error);
                setNotice("Check your email to verify your address, then sign in.");
                setMode("login");
            } else if (mode === "recover") {
                authError(
                    (
                        await authClient.requestPasswordReset({
                            email,
                            redirectTo: `${window.location.origin}/?reset=1`,
                        })
                    ).error
                );
                setNotice("If that account exists, a password reset link is on its way.");
            } else if (mode === "reset") {
                const token = params.get("token");
                if (!token) throw new Error("This reset link is invalid. Request another one.");
                authError((await authClient.resetPassword({ newPassword: password, token })).error);
                window.history.replaceState({}, "", "/");
                setMode("login");
                setNotice("Password changed. Sign in to continue.");
            } else if (mode === "mfa") {
                authError(
                    (backup
                        ? await authClient.twoFactor.verifyBackupCode({ code })
                        : await authClient.twoFactor.verifyTotp({ code })
                    ).error
                );
                onDone();
            } else {
                const result = await authClient.signIn.email({ email, password });
                authError(result.error);
                if (
                    result.data &&
                    "twoFactorRedirect" in result.data &&
                    result.data.twoFactorRedirect
                )
                    setMode("mfa");
                else onDone();
            }
            setPassword("");
            setCode("");
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Could not sign in");
        } finally {
            setBusy(false);
        }
    };
    return (
        <main className="instance-login">
            <section className="login">
                <Logo size={48} />
                <h1>
                    {mode === "signup"
                        ? "Create your account"
                        : mode === "mfa"
                          ? "Verify it’s you"
                          : mode === "recover"
                            ? "Reset your password"
                            : mode === "reset"
                              ? "Choose a new password"
                              : "Sign in to Notato"}
                </h1>
                <form onSubmit={submit}>
                    {!["mfa", "reset"].includes(mode) && (
                        <label>
                            Email
                            <input
                                type="email"
                                autoComplete="username"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                disabled={busy}
                            />
                        </label>
                    )}
                    {mode === "signup" && (
                        <label>
                            Name
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                maxLength={80}
                                required
                                disabled={busy}
                            />
                        </label>
                    )}
                    {!["mfa", "recover"].includes(mode) && (
                        <label>
                            Password
                            <input
                                type="password"
                                autoComplete={
                                    mode === "login" ? "current-password" : "new-password"
                                }
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                minLength={mode === "login" ? 1 : 12}
                                maxLength={256}
                                required
                                disabled={busy}
                            />
                        </label>
                    )}
                    {mode === "mfa" && (
                        <label>
                            {backup ? "Recovery code" : "Authenticator code"}
                            <input
                                autoComplete="one-time-code"
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                required
                                disabled={busy}
                            />
                        </label>
                    )}
                    {error && (
                        <p role="alert" className="error">
                            {error}
                        </p>
                    )}
                    {notice && <p role="status">{notice}</p>}
                    <button type="submit" className="primary" disabled={busy}>
                        {busy
                            ? "Please wait…"
                            : mode === "recover"
                              ? "Send reset link"
                              : mode === "signup"
                                ? "Create account"
                                : mode === "reset"
                                  ? "Set password"
                                  : "Continue"}
                    </button>
                </form>
                {mode === "login" && (
                    <>
                        <button type="button" className="link" onClick={() => setMode("recover")}>
                            Forgot password?
                        </button>
                        {(signupMode !== "closed" || invitation || invitedEmail) && (
                            <button
                                type="button"
                                className="link"
                                onClick={() => setMode("signup")}
                            >
                                Create account
                            </button>
                        )}
                        {signupMode === "closed" && !invitation && (
                            <p className="muted small">
                                Registration is invitation-only. Contact your instance
                                administrator.
                            </p>
                        )}
                    </>
                )}
                {mode === "mfa" && (
                    <button type="button" className="link" onClick={() => setBackup(!backup)}>
                        {backup ? "Use authenticator" : "Use a recovery code"}
                    </button>
                )}
                {mode !== "login" && (
                    <button
                        type="button"
                        className="link"
                        disabled={busy}
                        onClick={() => {
                            setMode("login");
                            setError("");
                        }}
                    >
                        Back to sign in
                    </button>
                )}
            </section>
        </main>
    );
}
