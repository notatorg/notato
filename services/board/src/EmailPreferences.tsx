import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import {
    getEmailPreferences,
    type EmailPreferences as Loaded,
    saveEmailPreference,
} from "./api.ts";
import { Section } from "./Layout.tsx";

type Available = Extract<Loaded, { available: true }>;

/** The optional, unticked choice, worded exactly as the server's versioned copy records it. */
export function EmailChoice({
    prefs,
    checked,
    onChange,
    disabled,
}: {
    prefs: Available;
    checked: boolean;
    onChange(value: boolean): void;
    disabled?: boolean;
}) {
    const id = useId();
    return (
        <div className="email-choice">
            <label htmlFor={id}>
                <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || Boolean(prefs.marketing.blocked)}
                    onChange={(event) => onChange(event.target.checked)}
                />{" "}
                {prefs.copy.label} <span className="muted">{prefs.copy.note}</span>
            </label>
            <p className="muted small">
                Sent by {prefs.controller}.{" "}
                <a href={prefs.privacyUrl} target="_blank" rel="noreferrer">
                    How we use your email address
                </a>
            </p>
            {prefs.marketing.blocked ? (
                <p className="muted small">
                    Marketing email cannot be sent to this address. Account and security emails are
                    not affected.
                </p>
            ) : null}
        </div>
    );
}

/** Loads the signed-in account's choice once; null while loading or when the service does not offer it. */
export function useEmailPreferences(enabled: boolean) {
    const [prefs, setPrefs] = useState<Available | null>(null);
    const [loaded, setLoaded] = useState(!enabled);
    const [error, setError] = useState<string | null>(null);
    const load = useCallback(async () => {
        try {
            const result = await getEmailPreferences();
            setPrefs(result.available ? result : null);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Could not load email preferences");
        } finally {
            setLoaded(true);
        }
    }, []);
    useEffect(() => {
        if (enabled) void load();
    }, [enabled, load]);
    return { prefs, loaded, error, reload: load, setPrefs };
}

async function save(prefs: Available, enabled: boolean, source: "onboarding" | "settings") {
    const { marketing } = await saveEmailPreference({
        enabled,
        expectedRevision: prefs.marketing.revision,
        copyVersion: prefs.copy.version,
        source,
    });
    return { ...prefs, marketing };
}

/**
 * Shown once, after the first verified sign-in, before the board. Continuing records the choice either way, and a
 * failure never traps the person: they can carry on and will be asked again next time.
 */
export function EmailWelcome({ prefs, onDone }: { prefs: Available; onDone(): void }): ReactNode {
    const [checked, setChecked] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    return (
        <div className="sheet">
            <div className="sheet-inner">
                <header className="sheet-head">
                    <div>
                        <h1>Welcome to Notato</h1>
                        <p>Your account is ready. One optional choice before you start.</p>
                    </div>
                </header>
                <section>
                    <h2>Email</h2>
                    <p className="muted small">
                        We will always email you about your account, security and anything you ask
                        for, such as invitations and receipts. This choice only covers product news,
                        tips and offers.
                    </p>
                    <EmailChoice
                        prefs={prefs}
                        checked={checked}
                        onChange={setChecked}
                        disabled={busy}
                    />
                    {error ? (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    ) : null}
                    <p>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                setBusy(true);
                                setError(null);
                                save(prefs, checked, "onboarding").then(onDone, (reason: Error) => {
                                    setError(
                                        `${reason.message} You can choose later under Settings → Account.`
                                    );
                                    setBusy(false);
                                });
                            }}
                        >
                            Continue
                        </button>
                        {error ? (
                            <button type="button" className="link" onClick={onDone}>
                                Continue without choosing
                            </button>
                        ) : null}
                    </p>
                </section>
            </div>
        </div>
    );
}

/** Settings → Account → Email preferences. Personal to the account, whichever workspace is selected. */
export function EmailPreferences({ enabled }: { enabled: boolean }) {
    const { prefs, error: loadError, setPrefs } = useEmailPreferences(enabled);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    if (!enabled || !prefs) return null;
    const change = async (value: boolean) => {
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
            setPrefs(await save(prefs, value, "settings"));
            setSaved(true);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Could not save your choice");
        } finally {
            setBusy(false);
        }
    };
    return (
        <Section
            title="Email preferences"
            about="Applies to your account in every workspace. Account, security, invitation and billing emails are not affected."
        >
            <EmailChoice
                prefs={prefs}
                checked={prefs.marketing.enabled}
                onChange={(value) => void change(value)}
                disabled={busy}
            />
            <p className="muted small">
                <a href="/account/email-preferences/export" download>
                    Download the records of your choice
                </a>
            </p>
            <p role="status" className="muted small">
                {saved ? (prefs.marketing.enabled ? "Subscribed." : "Unsubscribed.") : ""}
            </p>
            {error || loadError ? (
                <div className="banner bad" role="alert">
                    <span>{error ?? loadError}</span>
                </div>
            ) : null}
        </Section>
    );
}
