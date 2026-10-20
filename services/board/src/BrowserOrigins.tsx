import { useEffect, useState } from "react";
import { getProjectOrigins, setProjectOrigins } from "./api.ts";

/** The websites and extensions that may call this project's API from a browser. */
export function BrowserOrigins({ project }: { project: string }) {
    const [draft, setDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);
    useEffect(() => {
        getProjectOrigins(project).then(
            (result) => setDraft(result.origins.join("\n")),
            (reason: Error) => setError(reason.message)
        );
    }, [project]);
    return (
        <section className="set-section">
            <div className="set-label">
                <h2>Browser origins</h2>
                <p>
                    Allow your website or browser extension to connect to this project. Nothing else
                    may call it from a browser.
                </p>
            </div>
            <form
                className="set-body"
                onSubmit={(event) => {
                    event.preventDefault();
                    setBusy(true);
                    setError(null);
                    setSaved(false);
                    setProjectOrigins(
                        project,
                        draft
                            .split(/\n|,/)
                            .map((value) => value.trim())
                            .filter(Boolean)
                    )
                        .then(
                            (result) => {
                                setDraft(result.origins.join("\n"));
                                setSaved(true);
                            },
                            (reason: Error) => setError(reason.message)
                        )
                        .finally(() => setBusy(false));
                }}
            >
                <label>
                    Website or extension origins, one per line
                    <textarea
                        value={draft}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            setSaved(false);
                        }}
                        rows={4}
                        maxLength={15000}
                        placeholder={
                            "https://app.example.com\nchrome-extension://your-extension-id"
                        }
                    />
                </label>
                <p className="muted small">
                    Include the scheme and any port. For the Chrome extension, use
                    chrome-extension:// followed by its ID from chrome://extensions. Apps and
                    extensions still need a project token.
                </p>
                {error ? (
                    <p className="error" role="alert">
                        {error}
                    </p>
                ) : null}
                <button type="submit" className="primary" disabled={busy}>
                    {saved ? "Saved" : "Save origins"}
                </button>
            </form>
        </section>
    );
}
