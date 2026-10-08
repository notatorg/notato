import { useCallback, useEffect, useState } from "react";
import { AgentsSection, agentsText } from "./Agents.tsx";
import {
    deleteWebhook,
    getSettings,
    getStatus,
    type ProjectSummary,
    remember,
    remembered,
    type ServerStatus,
    type SettingsView,
    setBoardName,
    setSetting,
    useBoardName,
    type WebhookView,
} from "./api.ts";
import { duration } from "./model.ts";
import { DETAILS, type Detail } from "./Project.tsx";
import { TestDialog } from "./TestPanel.tsx";
import { Icon, Segmented, ThemeSwitch, Toggle } from "./ui.tsx";
import { WebhookEditor } from "./WebhookEditor.tsx";
import { eventsSummary, formatLabel } from "./webhook-form.ts";

const SETTING_LABELS: Record<string, string> = { screenshots: "Screenshots" };

/** The server's settings (the same file `notato config` edits), its webhooks, and this browser's own preferences. */
export function Settings({ projects }: { projects: ProjectSummary[] | null }) {
    const [view, setView] = useState<SettingsView | null>(null);
    const [status, setStatus] = useState<ServerStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    /** The webhook being edited, `"new"` for one being added, or null when the form is closed. */
    const [editing, setEditing] = useState<WebhookView | "new" | null>(null);
    /** The saved webhook whose test panel is open. */
    const [testing, setTesting] = useState<WebhookView | null>(null);

    const load = useCallback(() => {
        getSettings().then(
            (v) => {
                setView(v);
                setError(null);
            },
            (e: Error) => setError(e.message)
        );
        getStatus().then(setStatus, () => {});
    }, []);
    useEffect(() => load(), [load]);
    // Agents come and go, and the file can change underneath (`notato config`, a restart): look again every few seconds.
    useEffect(() => {
        const timer = setInterval(() => {
            getStatus().then(setStatus, () => {});
            getSettings().then(setView, () => {});
        }, 5000);
        return () => clearInterval(timer);
    }, []);

    /** Runs a change and shows the settings it answers with; a refusal (a stale copy, a broken file) is shown instead. */
    const change = async (key: string, fn: () => Promise<SettingsView>) => {
        setBusy(key);
        setError(null);
        try {
            setView(await fn());
        } catch (e) {
            setError(e instanceof Error ? e.message : "That did not work.");
            // What is on screen may be what was out of date.
            getSettings().then(setView, () => {});
        } finally {
            setBusy(null);
        }
    };

    /** Someone changed the webhooks elsewhere: show what is there now, and say why the list moved. */
    const stale = (message: string) => {
        setEditing(null);
        setTesting(null);
        setError(`${message[0]?.toUpperCase()}${message.slice(1)}. This is the list as it is now.`);
        getSettings().then(setView, () => {});
    };

    const head = (
        <header className="sheet-head">
            <div>
                <h1>Settings</h1>
                {view ? (
                    <p>
                        {view.file ? (
                            <>
                                Saved to <code>{view.file}</code>
                                {view.exists ? "" : " (made on the first change)"}, the same file{" "}
                                <code>notato config</code> edits. Changes apply right away.
                            </>
                        ) : (
                            "This server was started without a settings file, so nothing here can be changed."
                        )}
                    </p>
                ) : null}
            </div>
        </header>
    );

    if (!view) {
        return (
            <div className="sheet">
                <div className="sheet-inner settings">
                    {head}
                    {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
                </div>
            </div>
        );
    }

    const locked = Boolean(view.error) || !view.file;

    return (
        <div className="sheet">
            <div className="sheet-inner settings">
                {head}

                {view.error ? (
                    <div className="banner bad" role="alert">
                        <span>
                            <strong>The settings file cannot be read:</strong> {view.error}. Until
                            it is fixed, screenshots are off, agents are refused and no webhooks are
                            sent. Fix or remove it by hand, then reload.
                        </span>
                    </div>
                ) : null}
                {error ? (
                    <div className="banner bad" role="alert">
                        <span>{error}</span>
                        <button
                            type="button"
                            className="icon-button"
                            aria-label="Dismiss"
                            onClick={() => setError(null)}
                        >
                            <Icon name="close" size={14} />
                        </button>
                    </div>
                ) : null}

                <AgentsSection
                    setting={view.settings.find((s) => s.name === "mcp")}
                    status={status}
                    locked={locked}
                    busy={busy !== null}
                    onChange={(value) =>
                        change("mcp", async () => {
                            const next = await setSetting("mcp", value);
                            getStatus().then(setStatus, () => {});
                            return next;
                        })
                    }
                />

                <section className="set-section">
                    <div className="set-label">
                        <h2>Capture</h2>
                    </div>
                    <div className="set-body">
                        {view.settings
                            .filter((s) => s.name !== "mcp")
                            .map((s) => {
                                const on = s.value === "on";
                                const fromEnv = s.source === "env";
                                return (
                                    <div key={s.name} className="setting-row">
                                        <div className="setting-text">
                                            <strong>{SETTING_LABELS[s.name] ?? s.name}</strong>
                                            <p className="muted small">{s.about}</p>
                                            {fromEnv ? (
                                                <p className="small note">
                                                    Set to {s.value} by <code>${s.env}</code> where
                                                    the server runs, which wins over this file.
                                                </p>
                                            ) : s.source === "file" && s.value !== s.default ? (
                                                <button
                                                    type="button"
                                                    className="link small"
                                                    disabled={locked || busy !== null}
                                                    onClick={() =>
                                                        change(s.name, () =>
                                                            setSetting(s.name, null)
                                                        )
                                                    }
                                                >
                                                    Back to the default ({s.default})
                                                </button>
                                            ) : null}
                                        </div>
                                        <Toggle
                                            label={SETTING_LABELS[s.name] ?? s.name}
                                            on={on}
                                            disabled={locked || fromEnv || busy !== null}
                                            onChange={(next) =>
                                                change(s.name, () =>
                                                    setSetting(s.name, next ? "on" : "off")
                                                )
                                            }
                                        />
                                    </div>
                                );
                            })}
                    </div>
                </section>

                <section className="set-section">
                    <div className="set-label">
                        <h2>Webhooks</h2>
                        <p>
                            Ping Slack, Discord, Teams or your own service when notes arrive or
                            change.
                        </p>
                    </div>
                    <div className="set-body">
                        {view.webhooks.length === 0 ? (
                            <div className="hooks-empty">
                                <p>No webhooks yet.</p>
                                <p className="muted small">
                                    Add one to post new notes to a channel, or to start a flow when
                                    an agent resolves something.
                                </p>
                            </div>
                        ) : (
                            <ul className="hooks">
                                {view.webhooks.map((w) => (
                                    <li key={`${w.index}:${w.fingerprint}`} className="hook">
                                        <span className={`hook-kind k-${w.format}`}>
                                            {formatLabel(w.format)}
                                        </span>
                                        <div className="hook-main">
                                            <strong className="hook-name">
                                                {w.name ?? w.host}
                                            </strong>
                                            <code
                                                className="hook-url"
                                                title="The full URL stays on the server"
                                            >
                                                {w.url}
                                            </code>
                                            <div className="hook-meta">
                                                <span>{eventsSummary(w.events)}</span>
                                                <span>
                                                    {w.project
                                                        ? `only ${w.project}`
                                                        : "all projects"}
                                                </span>
                                                {w.format === "json" ? (
                                                    <span>
                                                        {w.secret.kind === "none"
                                                            ? "unsigned"
                                                            : w.secret.kind === "env"
                                                              ? `signed with $${w.secret.name}`
                                                              : "signed"}
                                                    </span>
                                                ) : null}
                                            </div>
                                            {w.secret.kind === "env" && !w.secret.set ? (
                                                <p className="small warn-text">
                                                    <code>${w.secret.name}</code> is not set where
                                                    the server runs, so nothing is sent to this
                                                    webhook.
                                                </p>
                                            ) : null}
                                        </div>
                                        <div className="hook-actions">
                                            <button
                                                type="button"
                                                className="small"
                                                onClick={() => setTesting(w)}
                                            >
                                                Test
                                            </button>
                                            <button
                                                type="button"
                                                className="small"
                                                disabled={locked}
                                                onClick={() => setEditing(w)}
                                            >
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                className="icon-button danger"
                                                aria-label={`Delete ${w.name ?? w.host}`}
                                                title="Delete"
                                                disabled={locked || busy !== null}
                                                onClick={() => {
                                                    if (
                                                        window.confirm(
                                                            `Stop sending to ${w.name ?? w.host}? This removes it from the file.`
                                                        )
                                                    )
                                                        change(`delete-${w.index}`, () =>
                                                            deleteWebhook(w)
                                                        );
                                                }}
                                            >
                                                <Icon name="trash" size={15} />
                                            </button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <button
                            type="button"
                            className="add-button"
                            disabled={locked}
                            onClick={() => setEditing("new")}
                        >
                            <Icon name="plus" size={14} />
                            Add webhook
                        </button>
                    </div>
                </section>

                <BrowserPreferences />

                {status ? (
                    <section className="set-section">
                        <div className="set-label">
                            <h2>Server</h2>
                        </div>
                        <dl className="set-body facts-list">
                            <dt>Mode</dt>
                            <dd>
                                {status.mode === "dev"
                                    ? "Development, this machine only"
                                    : "Shared server"}
                            </dd>
                            <dt>Version</dt>
                            <dd>
                                <code>{status.version}</code>
                            </dd>
                            {status.uptimeSec !== undefined ? (
                                <>
                                    <dt>Running for</dt>
                                    <dd>{duration(status.uptimeSec * 1000)}</dd>
                                </>
                            ) : null}
                            {status.agents ? (
                                <>
                                    <dt>Agents</dt>
                                    <dd>{agentsText(status.agents)}</dd>
                                </>
                            ) : null}
                            {status.pages !== undefined ? (
                                <>
                                    <dt>Listening</dt>
                                    <dd>
                                        {status.pages} page{status.pages === 1 ? "" : "s"} and board
                                        tab
                                        {status.pages === 1 ? "" : "s"}
                                    </dd>
                                </>
                            ) : null}
                        </dl>
                    </section>
                ) : null}
            </div>

            {testing ? (
                <TestDialog
                    webhook={testing}
                    projects={projects ?? []}
                    events={view.events}
                    onClose={() => setTesting(null)}
                    onStale={stale}
                />
            ) : null}

            {editing ? (
                <WebhookEditor
                    existing={editing === "new" ? undefined : editing}
                    projects={projects ?? []}
                    publicUrl={view.publicUrl ?? null}
                    onClose={() => setEditing(null)}
                    onStale={stale}
                    onSaved={(next) => {
                        setView(next);
                        setEditing(null);
                    }}
                />
            ) : null}
        </div>
    );
}

/** Kept in this browser only: the name on replies, how much a Markdown copy says, and the theme. */
function BrowserPreferences() {
    const saved = useBoardName();
    const [name, setName] = useState(saved);
    const [flash, setFlash] = useState(false);
    const [detail, setDetail] = useState<Detail>(() =>
        remembered("notato.detail", DETAILS, "standard")
    );
    // A change made in the sidebar shows here too.
    useEffect(() => setName(saved), [saved]);
    return (
        <section className="set-section">
            <div className="set-label">
                <h2>This browser</h2>
                <p>Stored here only. Other people and browsers have their own.</p>
            </div>
            <div className="set-body">
                <form
                    className="setting-row"
                    onSubmit={(e) => {
                        e.preventDefault();
                        setBoardName(name);
                        setFlash(true);
                        setTimeout(() => setFlash(false), 1500);
                    }}
                >
                    <label className="setting-text" htmlFor="pref-name">
                        <strong>Your name on replies</strong>
                        <span className="muted small">Shown next to what you write.</span>
                    </label>
                    <div className="inline-field">
                        <input
                            id="pref-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Anonymous"
                            maxLength={80}
                        />
                        <button type="submit" className="primary">
                            {flash ? "Saved" : "Save"}
                        </button>
                    </div>
                </form>
                <div className="setting-row">
                    <div className="setting-text">
                        <strong>Markdown detail</strong>
                        <span className="muted small">
                            How much a copied note includes, from one line to everything.
                        </span>
                    </div>
                    <Segmented
                        label="Markdown detail"
                        value={detail}
                        onChange={(next) => {
                            setDetail(next);
                            remember("notato.detail", next);
                        }}
                        options={DETAILS.map((d) => ({
                            id: d,
                            label: `${d[0]?.toUpperCase()}${d.slice(1)}`,
                        }))}
                    />
                </div>
                <div className="setting-row">
                    <div className="setting-text">
                        <strong>Appearance</strong>
                        <span className="muted small">Also at the bottom of the sidebar.</span>
                    </div>
                    <ThemeSwitch />
                </div>
            </div>
        </section>
    );
}
