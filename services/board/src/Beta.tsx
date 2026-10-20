import { Logo } from "@notato/board";
import { type FormEvent, useState } from "react";
import { json, request } from "./api.ts";

export interface BetaStatus {
    enabled: boolean;
    paused: boolean;
    invitedEmail?: string;
    expiresAt?: string;
}
export const betaStatus = () => request<BetaStatus>("/beta/status");

export function BetaAdmissionPaused({
    email,
    onCheck,
    onSignIn,
}: {
    email: string;
    onCheck(): Promise<void>;
    onSignIn(): void;
}) {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    return (
        <main className="beta-landing">
            <section className="beta-card">
                <h1>Your invitation is ready</h1>
                <p>You've been invited as {email}.</p>
                <h2>Account creation is temporarily paused</h2>
                <p>
                    The service owner has paused new beta accounts. You don't need a password yet:
                    when admissions reopen, you can choose your name and password here, then confirm
                    your email and set up an authenticator.
                </p>
                <p>Keep your invitation email so you can return before the link expires.</p>
                {message ? <p role="status">{message}</p> : null}
                <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        setMessage(null);
                        try {
                            await onCheck();
                            setMessage("New accounts are still paused. Please try again later.");
                        } catch (reason) {
                            setMessage(
                                reason instanceof Error
                                    ? reason.message
                                    : "Could not check admissions. Please try again."
                            );
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {busy ? "Checking…" : "Check again"}
                </button>
                <button type="button" className="link" onClick={onSignIn} disabled={busy}>
                    Already have a Notato account? Sign in
                </button>
            </section>
        </main>
    );
}

export function BetaWaitlist({ signedIn = false }: { signedIn?: boolean } = {}) {
    const [email, setEmail] = useState("");
    const [sdk, setSdk] = useState("");
    const [useCase, setUseCase] = useState("");
    const [website, setWebsite] = useState("");
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (busy || done) return;
        setBusy(true);
        setError(null);
        try {
            await request("/beta/waitlist", json("POST", { email, sdk, useCase, website }));
            setDone(true);
        } catch (reason) {
            setError(
                reason instanceof Error
                    ? reason.message
                    : "Could not save your request. Try again shortly."
            );
        } finally {
            setBusy(false);
        }
    };
    return (
        <main className="beta-landing">
            <a className="brand" href="https://notato.dev">
                <Logo size={42} />
                <span className="wordmark">notato</span>
            </a>
            <div className="beta-intro">
                <span className="beta-tag">Notato · Limited registration</span>
                <h1>Your feedback, together.</h1>
                <p>
                    A hosted home for your app's notes, screenshots and conversations with your team
                    and coding agents.
                </p>
                <p>
                    We're inviting a small group of developers and teams while we test and improve
                    the service. Beta access is free, with usage limits. Invitations go out in small
                    batches.
                </p>
            </div>
            <section className="beta-card">
                {done ? (
                    <div role="status">
                        <h2>You're on the list</h2>
                        <p>
                            Thanks for your interest. We'll contact you when a beta place is
                            available.
                        </p>
                        <p>You don't need to create an account yet.</p>
                    </div>
                ) : (
                    <form onSubmit={submit}>
                        <h2>Request beta access</h2>
                        <label>
                            Email
                            <input
                                type="email"
                                autoComplete="email"
                                required
                                maxLength={254}
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                disabled={busy}
                            />
                        </label>
                        <label>
                            <span>
                                Your framework or SDK <span className="muted">(optional)</span>
                            </span>
                            <select
                                value={sdk}
                                onChange={(e) => setSdk(e.target.value)}
                                disabled={busy}
                            >
                                <option value="">Choose one</option>
                                {[
                                    "React",
                                    "Angular",
                                    "Browser / JavaScript",
                                    "Swift",
                                    "Android",
                                    ".NET MAUI",
                                    "Flutter",
                                    "React Native",
                                    "Other",
                                ].map((v) => (
                                    <option key={v}>{v}</option>
                                ))}
                            </select>
                        </label>
                        <label>
                            <span>
                                What would you like to use it for?{" "}
                                <span className="muted">(optional)</span>
                            </span>
                            <textarea
                                rows={3}
                                maxLength={1200}
                                value={useCase}
                                onChange={(e) => setUseCase(e.target.value)}
                                disabled={busy}
                            />
                        </label>
                        <div className="beta-honeypot" aria-hidden="true">
                            <label>
                                Website
                                <input
                                    tabIndex={-1}
                                    autoComplete="off"
                                    value={website}
                                    onChange={(e) => setWebsite(e.target.value)}
                                />
                            </label>
                        </div>
                        <p className="muted small">
                            We'll use these details to review your request and contact you about
                            beta access. Please leave passwords, tokens and customer data out of
                            your message.
                        </p>
                        {error ? (
                            <p className="error" role="alert">
                                {error}
                            </p>
                        ) : null}
                        <button className="primary" type="submit" disabled={busy}>
                            {busy ? "Sending…" : "Join the waitlist"}
                        </button>
                    </form>
                )}
            </section>
            <p className="beta-links">
                <a href="#/">{signedIn ? "Back to workspace" : "Already invited? Sign in"}</a>
                <a href="https://notato.dev/docs/index.html">Use Notato locally</a>
            </p>
        </main>
    );
}

export function BetaInvitation({ token }: { token: string }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    return (
        <main className="beta-landing">
            <div className="beta-card">
                <h1>Your beta invitation</h1>
                <p>
                    Set up your Notato account using the email address this invitation was sent to.
                    You'll choose your name and a new password, confirm your email, and optionally
                    enable two-factor authentication. Already have an account? You can sign in
                    instead.
                </p>
                {error ? (
                    <p className="error" role="alert">
                        {error}
                    </p>
                ) : null}
                <button
                    className="primary"
                    disabled={busy}
                    type="button"
                    onClick={async () => {
                        if (busy) return;
                        setBusy(true);
                        setError(null);
                        try {
                            await request("/beta/invitation", json("POST", { token }));
                            // The server keeps the invitation in a short-lived HttpOnly cookie across email confirmation and MFA.
                            window.location.replace(new URL("/", window.location.origin));
                        } catch (reason) {
                            setError(
                                reason instanceof Error
                                    ? reason.message
                                    : "Could not open this invitation"
                            );
                            setBusy(false);
                        }
                    }}
                >
                    {busy ? "Checking invitation…" : "Set up my account"}
                </button>
                <a href="#/x/beta">Request beta access</a>
            </div>
        </main>
    );
}

/** Admissions run on the same instance as accounts and workspaces. */
export { BetaAdmin as BetaAdminMoved } from "./BetaAdmin.tsx";
