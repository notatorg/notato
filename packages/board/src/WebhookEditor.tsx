import { useEffect, useId, useRef, useState } from "react";
import {
    addWebhook,
    editWebhook,
    isStale,
    type ProjectSummary,
    type SettingsView,
    type WebhookView,
} from "./api.ts";
import { TestPanel } from "./TestPanel.tsx";
import { Modal } from "./ui.tsx";
import {
    CONFIG_FILE,
    draftOf,
    EVENT_LABELS,
    envName,
    eventLabel,
    FORMATS,
    formFor,
    formProblem,
    orderEvents,
    PICTURED,
    saveProblem,
    secretGoesInFile,
    secretProblem,
    urlProblem,
    type WebhookForm,
} from "./webhook-form.ts";

interface Props {
    /** The webhook being edited; absent when adding one. */
    existing?: WebhookView;
    projects: ProjectSummary[];
    /** Where screenshot links would point, or null when the server cannot be reached from outside. */
    publicUrl: string | null;
    onClose(): void;
    onSaved(next: SettingsView): void;
    /** The webhook was changed elsewhere since the form opened, so the form is out of date. */
    onStale(message: string): void;
}

/** Add or change a webhook, and preview and test it before saving it. */
export function WebhookEditor({ existing, projects, publicUrl, onClose, onSaved, onStale }: Props) {
    const [form, setForm] = useState<WebhookForm>(() => formFor(existing));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** The form, or the test panel for what the form says (saved or not). */
    const [view, setView] = useState<"form" | "test">("form");
    /** What was last tried with the form: a test needs less of it than saving does. */
    const [tried, setTried] = useState<"test" | "save" | null>(null);
    const first = useRef<HTMLInputElement>(null);
    const id = useId();
    const format = FORMATS.find((f) => f.id === form.format) ?? FORMATS[0];
    const problem = formProblem(form, existing);
    const shown =
        tried === "save" ? saveProblem(form, existing) : tried === "test" ? problem : null;
    const events = orderEvents(Object.keys(EVENT_LABELS));
    /** A secret typed as it is, which saving would write into the settings file. */
    const literalSecret = secretGoesInFile(form);

    const set = (next: Partial<WebhookForm>) => setForm((f) => ({ ...f, ...next }));

    useEffect(() => first.current?.focus(), []);

    const test = () => {
        setTried("test");
        if (!problem) setView("test");
    };

    const save = async () => {
        setTried("save");
        if (saveProblem(form, existing)) return;
        setBusy(true);
        setError(null);
        try {
            const draft = draftOf(form, existing);
            const options = { secretInFile: literalSecret && form.secretInFile };
            onSaved(
                await (existing
                    ? editWebhook(existing, draft, options)
                    : addWebhook(draft, options))
            );
        } catch (e) {
            if (isStale(e)) return onStale((e as Error).message);
            setError(e instanceof Error ? e.message : "Could not save.");
            setBusy(false);
        }
    };

    const title =
        view === "test" ? "Preview and test" : existing ? "Edit webhook" : "Add a webhook";

    return (
        <Modal
            title={title}
            onClose={onClose}
            // The form says what is wrong with the URL itself, `env:NAME` included.
            noValidate
            onSubmit={(e) => {
                e.preventDefault();
                save();
            }}
        >
            {view === "test" ? (
                <TestPanel
                    hook={draftOf(form, existing)}
                    existing={existing}
                    projects={projects}
                    events={events}
                    closeLabel="Back"
                    onClose={() => setView("form")}
                    onStale={onStale}
                />
            ) : (
                <>
                    <div className="modal-body">
                        <fieldset className="field">
                            <legend>Send to</legend>
                            <div className="kinds">
                                {FORMATS.map((f) => (
                                    <label
                                        key={f.id}
                                        className={form.format === f.id ? "kind on" : "kind"}
                                    >
                                        <input
                                            ref={f.id === form.format ? first : undefined}
                                            type="radio"
                                            className="sr"
                                            name={`${id}-format`}
                                            checked={form.format === f.id}
                                            onChange={() => set({ format: f.id })}
                                        />
                                        <strong>{f.label}</strong>
                                        <span>{f.about}</span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>

                        <label className="field">
                            <span>Name</span>
                            <input
                                value={form.name}
                                onChange={(e) => set({ name: e.target.value })}
                                placeholder={
                                    form.format === "json" ? "Release flow" : "#design-feedback"
                                }
                                maxLength={100}
                            />
                        </label>

                        <div className="field">
                            <label htmlFor={`${id}-url`}>Webhook URL</label>
                            {existing && !form.replaceUrl ? (
                                <div className="locked">
                                    <code className="locked-value">{existing.url}</code>
                                    <button
                                        type="button"
                                        className="small"
                                        onClick={() => set({ replaceUrl: true })}
                                    >
                                        Replace
                                    </button>
                                </div>
                            ) : (
                                <input
                                    id={`${id}-url`}
                                    type="url"
                                    value={form.url}
                                    onChange={(e) => set({ url: e.target.value })}
                                    placeholder={format?.placeholder}
                                    autoComplete="off"
                                    spellCheck={false}
                                    aria-invalid={
                                        tried && urlProblem(form, existing) ? true : undefined
                                    }
                                />
                            )}
                            <span className="field-hint">
                                {existing && !form.replaceUrl ? (
                                    envName(existing.url) !== undefined ? (
                                        "Read from that environment variable where the server runs, so it is in no file."
                                    ) : (
                                        "The full URL stays on the server: it works like a password for the channel."
                                    )
                                ) : (
                                    <>
                                        {format?.help} Or write <code>env:NAME</code> to have the
                                        server read it from that environment variable, so it never
                                        goes in the settings file.
                                    </>
                                )}
                            </span>
                        </div>

                        <div className="field">
                            <label htmlFor={`${id}-project`}>Project</label>
                            <input
                                id={`${id}-project`}
                                list={`${id}-projects`}
                                value={form.project}
                                onChange={(e) => set({ project: e.target.value })}
                                placeholder="All projects"
                            />
                            <datalist id={`${id}-projects`}>
                                {projects.map((p) => (
                                    <option key={p.id} value={p.id} />
                                ))}
                            </datalist>
                            <span className="field-hint">
                                Leave empty for every project on this server.
                            </span>
                        </div>

                        <fieldset className="field">
                            <legend>When</legend>
                            <label className="check">
                                <input
                                    type="radio"
                                    name={`${id}-when`}
                                    checked={form.allEvents}
                                    onChange={() => set({ allEvents: true })}
                                />
                                Every event
                            </label>
                            <label className="check">
                                <input
                                    type="radio"
                                    name={`${id}-when`}
                                    checked={!form.allEvents}
                                    onChange={() => set({ allEvents: false })}
                                />
                                Only these
                            </label>
                            {!form.allEvents ? (
                                <div className="event-grid">
                                    {events.map((e) => (
                                        <label key={e} className="check">
                                            <input
                                                type="checkbox"
                                                checked={form.events.includes(e)}
                                                onChange={(ev) =>
                                                    set({
                                                        events: ev.target.checked
                                                            ? [...form.events, e]
                                                            : form.events.filter((x) => x !== e),
                                                    })
                                                }
                                            />
                                            {eventLabel(e)}
                                        </label>
                                    ))}
                                </div>
                            ) : null}
                        </fieldset>

                        {PICTURED.includes(form.format) ? (
                            <div className="field">
                                <label className="check">
                                    <input
                                        type="checkbox"
                                        checked={form.screenshots}
                                        onChange={(e) => set({ screenshots: e.target.checked })}
                                    />
                                    {form.format === "teams"
                                        ? "Show the screenshot in the card"
                                        : "Link to the screenshot"}
                                </label>
                                <span className="field-hint">
                                    {publicUrl
                                        ? `Through a private link at ${new URL(publicUrl).host} that opens that one image and nothing else, without signing in. It works while this server is running.`
                                        : "This server has no address the outside world can reach, so messages go without it for now. Start it with --tunnel, or set NOTATO_PUBLIC_URL."}
                                </span>
                            </div>
                        ) : null}

                        {form.format === "json" ? (
                            <div className="field">
                                <label htmlFor={`${id}-secret`}>Signing secret</label>
                                {existing?.secret.kind === "file" &&
                                form.secretAction === "keep" ? (
                                    <div className="locked">
                                        <span className="locked-value muted">
                                            A secret is set (it stays on the server)
                                        </span>
                                        <button
                                            type="button"
                                            className="small"
                                            onClick={() => set({ secretAction: "set", secret: "" })}
                                        >
                                            Replace
                                        </button>
                                        <button
                                            type="button"
                                            className="small"
                                            onClick={() => set({ secretAction: "remove" })}
                                        >
                                            Remove
                                        </button>
                                    </div>
                                ) : form.secretAction === "remove" ? (
                                    <div className="locked">
                                        <span className="locked-value muted">
                                            The secret will be removed when you save.
                                        </span>
                                        <button
                                            type="button"
                                            className="small"
                                            onClick={() => set({ secretAction: "keep" })}
                                        >
                                            Undo
                                        </button>
                                    </div>
                                ) : (
                                    <input
                                        id={`${id}-secret`}
                                        value={form.secret}
                                        onChange={(e) =>
                                            set({ secret: e.target.value, secretAction: "set" })
                                        }
                                        placeholder="env:NOTATO_WEBHOOK_SECRET"
                                        autoComplete="off"
                                        spellCheck={false}
                                        aria-invalid={
                                            tried === "save" && secretProblem(form)
                                                ? true
                                                : undefined
                                        }
                                    />
                                )}
                                {literalSecret ? (
                                    <>
                                        <label className="check">
                                            <input
                                                type="checkbox"
                                                checked={form.secretInFile}
                                                onChange={(e) =>
                                                    set({ secretInFile: e.target.checked })
                                                }
                                            />
                                            Store this secret in {CONFIG_FILE}
                                        </label>
                                        <span className="field-hint">
                                            That file is meant to be committed, so anyone who can
                                            read it could sign messages as this server. Better:
                                            write <code>env:NAME</code> here and set that variable
                                            where the server runs.
                                        </span>
                                    </>
                                ) : (
                                    <span className="field-hint">
                                        Optional. Signs each body (HMAC-SHA256 in{" "}
                                        <code>X-Notato-Signature</code>). Write{" "}
                                        <code>env:NAME</code> to read it from an environment
                                        variable where the server runs, so it never goes in the
                                        settings file.
                                    </span>
                                )}
                            </div>
                        ) : null}
                    </div>

                    {shown || error ? (
                        // Outside the scrolling part, so what the save said is always in view.
                        <div className="modal-status">
                            {shown ? (
                                <p className="error small" role="alert">
                                    {shown}
                                </p>
                            ) : null}
                            {error ? (
                                <p className="error small" role="alert">
                                    {error}
                                </p>
                            ) : null}
                        </div>
                    ) : null}

                    <footer className="modal-foot">
                        <button type="button" onClick={test}>
                            Preview and test…
                        </button>
                        <span className="grow" />
                        <button type="button" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="primary" disabled={busy}>
                            {existing ? "Save" : "Add webhook"}
                        </button>
                    </footer>
                </>
            )}
        </Modal>
    );
}
