import { DETAILS } from "@notato/core";
import { useEffect, useState } from "react";
import { AgentsSection, agentsText } from "./Agents.tsx";
import {
    deleteWebhook,
    getSettings,
    getStatus,
    type OnOff,
    type ProjectSummary,
    type ServerStatus,
    type SettingsView,
    type SettingView,
    setSetting,
    type WebhookView,
} from "./api.ts";
import { capitalise, duration, plural } from "./model.ts";
import { KEYS, setBoardName, useBoardName, useRemembered } from "./storage.ts";
import { TestDialog } from "./TestPanel.tsx";
import { FLASH_MS, Icon, Segmented, ThemeSwitch, Toggle } from "./ui.tsx";
import { WebhookEditor } from "./WebhookEditor.tsx";
import { eventsSummary, formatLabel } from "./webhook-form.ts";

const SETTING_LABELS: Record<string, string> = { screenshots: "Screenshots" };
const settingLabel = (name: string) => SETTING_LABELS[name] ?? name;

/** Agents come and go, and the file can change underneath (`notato config`, a restart): the page looks again this often. */
const POLL_MS = 5000;

/** The server's settings (the same file `notato config` edits), its webhooks, and this browser's own preferences. */
export function Settings({ projects }: { projects: ProjectSummary[] | null }) {
    const [view, setView] = useState<SettingsView | null>(null);
    const [status, setStatus] = useState<ServerStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** The change on its way, by what it changes; the controls wait for it. */
    const [busy, setBusy] = useState<string | null>(null);
    /** The webhook being edited, `"new"` for one being added, or null when the form is closed. */
    const [editing, setEditing] = useState<WebhookView | "new" | null>(null);
    /** The saved webhook whose test panel is open. */
    const [testing, setTesting] = useState<WebhookView | null>(null);

    useEffect(() => {
        getSettings().then(
            (v) => {
                setView(v);
                setError(null);
            },
            (e: Error) => setError(e.message)
        );
        getStatus().then(setStatus, () => {});
        // Later looks are quiet: what is on screen stays if the server cannot be reached.
        const timer = setInterval(() => {
            getStatus().then(setStatus, () => {});
            getSettings().then(setView, () => {});
        }, POLL_MS);
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
        setError(`${capitalise(message)}. This is the list as it is now.`);
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

                <CaptureSection
                    settings={view.settings.filter((s) => s.name !== "mcp")}
                    locked={locked}
                    busy={busy !== null}
                    onChange={(name, value) => change(name, () => setSetting(name, value))}
                />

                <WebhooksSection
                    webhooks={view.webhooks}
                    locked={locked}
                    busy={busy !== null}
                    onAdd={() => setEditing("new")}
                    onEdit={setEditing}
                    onTest={setTesting}
                    onDelete={(w) => change(`delete-${w.index}`, () => deleteWebhook(w))}
                />

                <BrowserPreferences />

                {status ? <ServerSection status={status} /> : null}
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

/** The on/off settings for what a note captures (screenshots), each with where its value comes from. */
function CaptureSection({
    settings,
    locked,
    busy,
    onChange,
}: {
    settings: SettingView[];
    locked: boolean;
    busy: boolean;
    /** Sets a setting in the file, or (with null) takes it out so the default applies. */
    onChange(name: string, value: OnOff | null): void;
}) {
    return (
        <section className="set-section">
            <div className="set-label">
                <h2>Capture</h2>
            </div>
            <div className="set-body">
                {settings.map((s) => {
                    const fromEnv = s.source === "env";
                    return (
                        <div key={s.name} className="setting-row">
                            <div className="setting-text">
                                <strong>{settingLabel(s.name)}</strong>
                                <p className="muted small">{s.about}</p>
                                {fromEnv ? (
                                    <p className="small note">
                                        Set to {s.value} by <code>${s.env}</code> where the server
                                        runs, which wins over this file.
                                    </p>
                                ) : s.source === "file" && s.value !== s.default ? (
                                    <button
                                        type="button"
                                        className="link small"
                                        disabled={locked || busy}
                                        onClick={() => onChange(s.name, null)}
                                    >
                                        Back to the default ({s.default})
                                    </button>
                                ) : null}
                            </div>
                            <Toggle
                                label={settingLabel(s.name)}
                                on={s.value === "on"}
                                disabled={locked || fromEnv || busy}
                                onChange={(next) => onChange(s.name, next ? "on" : "off")}
                            />
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

/** The webhooks in the settings file, each with its Test, Edit and Delete, and a way to add one. */
function WebhooksSection({
    webhooks,
    locked,
    busy,
    onAdd,
    onEdit,
    onTest,
    onDelete,
}: {
    webhooks: WebhookView[];
    locked: boolean;
    busy: boolean;
    onAdd(): void;
    onEdit(w: WebhookView): void;
    onTest(w: WebhookView): void;
    onDelete(w: WebhookView): void;
}) {
    return (
        <section className="set-section">
            <div className="set-label">
                <h2>Webhooks</h2>
                <p>Ping Slack, Discord, Teams or your own service when notes arrive or change.</p>
            </div>
            <div className="set-body">
                {webhooks.length === 0 ? (
                    <div className="hooks-empty">
                        <p>No webhooks yet.</p>
                        <p className="muted small">
                            Add one to post new notes to a channel, or to start a flow when an agent
                            resolves something.
                        </p>
                    </div>
                ) : (
                    <ul className="hooks">
                        {webhooks.map((w) => {
                            const title = w.name ?? w.host;
                            return (
                                <li key={`${w.index}:${w.fingerprint}`} className="hook">
                                    <span className="hook-kind">{formatLabel(w.format)}</span>
                                    <div className="hook-main">
                                        <strong className="hook-name">{title}</strong>
                                        <code
                                            className="hook-url"
                                            title="The full URL stays on the server"
                                        >
                                            {w.url}
                                        </code>
                                        <div className="hook-meta">
                                            <span>{eventsSummary(w.events)}</span>
                                            <span>
                                                {w.project ? `only ${w.project}` : "all projects"}
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
                                                <code>${w.secret.name}</code> is not set where the
                                                server runs, so nothing is sent to this webhook.
                                            </p>
                                        ) : null}
                                    </div>
                                    <div className="hook-actions">
                                        <button
                                            type="button"
                                            className="small"
                                            onClick={() => onTest(w)}
                                        >
                                            Test
                                        </button>
                                        <button
                                            type="button"
                                            className="small"
                                            disabled={locked}
                                            onClick={() => onEdit(w)}
                                        >
                                            Edit
                                        </button>
                                        <button
                                            type="button"
                                            className="icon-button danger"
                                            aria-label={`Delete ${title}`}
                                            title="Delete"
                                            disabled={locked || busy}
                                            onClick={() => {
                                                if (
                                                    window.confirm(
                                                        `Stop sending to ${title}? This removes it from the file.`
                                                    )
                                                )
                                                    onDelete(w);
                                            }}
                                        >
                                            <Icon name="trash" size={15} />
                                        </button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
                <button type="button" className="add-button" disabled={locked} onClick={onAdd}>
                    <Icon name="plus" size={14} />
                    Add webhook
                </button>
            </div>
        </section>
    );
}

/** Kept in this browser only: the name on replies, how much a Markdown copy says, and the theme. */
function BrowserPreferences() {
    const saved = useBoardName();
    const [name, setName] = useState(saved);
    const [flash, setFlash] = useState(false);
    const [detail, setDetail] = useRemembered(KEYS.detail, DETAILS, "standard");
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
                        setTimeout(() => setFlash(false), FLASH_MS);
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
                        onChange={setDetail}
                        options={DETAILS.map((d) => ({ id: d, label: capitalise(d) }))}
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

/** What the server says about itself: its mode, version, uptime, and who is connected. */
function ServerSection({ status }: { status: ServerStatus }) {
    return (
        <section className="set-section">
            <div className="set-label">
                <h2>Server</h2>
            </div>
            <dl className="set-body facts-list">
                <dt>Mode</dt>
                <dd>
                    {status.mode === "dev" ? "Development, this machine only" : "Shared server"}
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
                            {plural(status.pages, "page")} and board tab
                            {status.pages === 1 ? "" : "s"}
                        </dd>
                    </>
                ) : null}
            </dl>
        </section>
    );
}
