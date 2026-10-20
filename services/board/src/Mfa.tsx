import { useState } from "react";
import { authClient, authError } from "./auth-client.ts";
import { Section } from "./Layout.tsx";

/** Optional TOTP enrollment only completes after a valid code. Recovery codes are shown once. */
export function MfaSettings() {
    const { data, refetch } = authClient.useSession();
    const [password, setPassword] = useState("");
    const [uri, setUri] = useState("");
    const [code, setCode] = useState("");
    const [codes, setCodes] = useState<string[]>([]);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        setError("");
        try {
            await action();
            refetch();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not update two-factor authentication");
        } finally {
            setBusy(false);
        }
    };
    return (
        <Section
            title="Two-factor authentication"
            about="Optional. Add an authenticator app to protect your account, and keep your recovery codes somewhere safe."
        >
            <p>{data?.user.twoFactorEnabled ? "Enabled" : "Not enabled"}</p>
            {!uri && (
                <label>
                    Current password
                    <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
            )}
            {uri ? (
                <>
                    <p>In your authenticator app, add an account with this setup key:</p>
                    <code>{new URL(uri).searchParams.get("secret")}</code>
                    <p className="muted small">
                        Account: {data?.user.email}. Type: time based, six digits, 30 seconds.
                    </p>
                    <label>
                        Authenticator code
                        <input
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            autoComplete="one-time-code"
                        />
                    </label>
                    <button
                        type="button"
                        disabled={busy || !code}
                        onClick={() =>
                            void run(async () => {
                                authError((await authClient.twoFactor.verifyTotp({ code })).error);
                                setUri("");
                                setCode("");
                            })
                        }
                    >
                        Verify and enable
                    </button>
                </>
            ) : (
                <button
                    type="button"
                    disabled={busy || !password}
                    onClick={() =>
                        void run(async () => {
                            if (data?.user.twoFactorEnabled) {
                                authError((await authClient.twoFactor.disable({ password })).error);
                                setCodes([]);
                            } else {
                                const result = await authClient.twoFactor.enable({ password });
                                authError(result.error);
                                if (result.data && "totpURI" in result.data) {
                                    setUri(result.data.totpURI);
                                    setCodes(result.data.backupCodes);
                                }
                            }
                            setPassword("");
                        })
                    }
                >
                    {data?.user.twoFactorEnabled
                        ? "Disable two-factor authentication"
                        : "Set up authenticator"}
                </button>
            )}
            {codes.length > 0 && (
                <div>
                    <p>Save these recovery codes now. Each works once.</p>
                    <pre>{codes.join("\n")}</pre>
                    <button type="button" onClick={() => setCodes([])}>
                        I’ve saved these codes
                    </button>
                </div>
            )}
            {error && (
                <p className="error" role="alert">
                    {error}
                </p>
            )}
        </Section>
    );
}
