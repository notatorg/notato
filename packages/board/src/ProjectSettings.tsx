import { type ReactNode, useEffect, useId, useState } from "react";
import {
    deleteProject,
    listBundles,
    listTokens,
    type Me,
    type ProjectSummary,
    projectName,
    renameProject,
} from "./api.ts";
import { projectHref } from "./route.ts";
import { TokenManager } from "./Tokens.tsx";
import { Icon } from "./ui.tsx";

interface Props {
    me: Me;
    project: string;
    summary: ProjectSummary | undefined;
    projects: ProjectSummary[] | null;
    menu: ReactNode;
    onRenamed(): void;
    onDeleted(): void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A project's name, its tokens, and deleting it. Admins only. */
export function ProjectSettings({
    me,
    project,
    summary,
    projects,
    menu,
    onRenamed,
    onDeleted,
}: Props) {
    const name = projectName(summary, project);
    return (
        <div className="sheet">
            <div className="sheet-inner settings">
                <header className="sheet-head">
                    <div>
                        <h1>Project settings</h1>
                        <p>
                            {name}
                            {name !== project ? (
                                <>
                                    {" "}
                                    · <code>{project}</code>
                                </>
                            ) : null}
                            {summary?.createdAt
                                ? ` · made ${new Date(summary.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`
                                : ""}
                        </p>
                    </div>
                    <div className="sheet-tools">{menu}</div>
                </header>

                <Rename project={project} name={name} onRenamed={onRenamed} />

                <section className="set-section">
                    <div className="set-label">
                        <h2>Connect an app</h2>
                        <p>The React, .NET MAUI, SwiftUI and Android SDKs, or any page.</p>
                    </div>
                    <div className="set-body">
                        <div className="setting-row">
                            <div className="setting-text">
                                <span className="muted">
                                    The lines to add to each, with this server and project filled
                                    in.
                                </span>
                            </div>
                            <a className="button-link" href={projectHref(project, "connect")}>
                                <Icon name="plug" size={14} />
                                How to connect an app
                            </a>
                        </div>
                    </div>
                </section>

                {me.authRequired ? (
                    <section className="set-section">
                        <div className="set-label">
                            <h2>Tokens</h2>
                            <p>
                                An app needs one of these to send notes here. Give each app its own,
                                so one can be revoked without the others.
                            </p>
                        </div>
                        <div className="set-body">
                            <TokenManager projects={projects} projectId={project} />
                        </div>
                    </section>
                ) : null}

                <DeleteProject
                    me={me}
                    project={project}
                    name={name}
                    summary={summary}
                    onDeleted={onDeleted}
                />
            </div>
        </div>
    );
}

function Rename({
    project,
    name,
    onRenamed,
}: {
    project: string;
    name: string;
    onRenamed(): void;
}) {
    const id = useId();
    const [draft, setDraft] = useState(name);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    // A rename elsewhere (another tab) shows here too.
    useEffect(() => setDraft(name), [name]);

    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            await renameProject(project, draft.trim());
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
            onRenamed();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not rename it.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="set-section">
            <div className="set-label">
                <h2>Project</h2>
                <p>What the board calls it. Apps keep sending to its id, which never changes.</p>
            </div>
            <div className="set-body">
                <form
                    className="setting-row"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (draft.trim() && draft.trim() !== name) save();
                    }}
                >
                    <label className="setting-text" htmlFor={`${id}-name`}>
                        <strong>Name</strong>
                        <span className="muted small">
                            Its id is <code>{project}</code>.
                        </span>
                    </label>
                    <div className="inline-field">
                        <input
                            id={`${id}-name`}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            maxLength={200}
                        />
                        <button
                            type="submit"
                            className="primary"
                            disabled={busy || !draft.trim() || draft.trim() === name}
                        >
                            {saved ? "Saved" : "Save"}
                        </button>
                    </div>
                </form>
                {error ? (
                    <p className="error small" role="alert">
                        {error}
                    </p>
                ) : null}
            </div>
        </section>
    );
}

function DeleteProject({
    me,
    project,
    name,
    summary,
    onDeleted,
}: {
    me: Me;
    project: string;
    name: string;
    summary: ProjectSummary | undefined;
    onDeleted(): void;
}) {
    const id = useId();
    const [bundles, setBundles] = useState<number | null>(null);
    const [tokens, setTokens] = useState<number | null>(null);
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        listBundles(project).then(
            (b) => setBundles(b.length),
            () => {}
        );
        if (me.authRequired)
            listTokens().then(
                (t) => setTokens(t.filter((x) => x.projectId === project && !x.revokedAt).length),
                () => {}
            );
    }, [project, me.authRequired]);

    const notes = summary?.annotations ?? 0;
    const confirmed = typed === project;

    const remove = async () => {
        setBusy(true);
        setError(null);
        try {
            await deleteProject(project);
            onDeleted();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not delete it.");
            setBusy(false);
        }
    };

    return (
        <section className="set-section danger-zone">
            <div className="set-label">
                <h2>Delete project</h2>
                <p>For everyone, and for good. There is no undo.</p>
            </div>
            <div className="set-body">
                <div className="delete-what">
                    <p>
                        Deleting <strong>{name}</strong> removes:
                    </p>
                    <ul>
                        <li>
                            {notes
                                ? `${plural(notes, "note")}, with their replies and screenshots`
                                : "the project itself (it has no notes yet)"}
                        </li>
                        {bundles ? (
                            <li>{plural(bundles, "imported zip bundle")}, and their record</li>
                        ) : null}
                        {me.authRequired ? (
                            <li>
                                {tokens === 1
                                    ? "its token, which is revoked: apps using it can no longer send"
                                    : tokens === 0
                                      ? "its tokens (none is in use now)"
                                      : `${tokens === null ? "its tokens" : plural(tokens, "token")}, which are revoked: apps using them can no longer send`}
                            </li>
                        ) : null}
                    </ul>
                    <p className="muted small">
                        {me.mode === "serve"
                            ? `Apps that still send to “${project}” are turned away until a project with that id is made again.`
                            : `An app that sends to “${project}” afterwards makes it again, empty.`}{" "}
                        Webhooks set to this project stay in Settings.
                    </p>
                </div>
                <div className="field">
                    <label className="confirm-label" htmlFor={`${id}-confirm`}>
                        Type <code>{project}</code> to confirm
                    </label>
                    <div className="inline-field">
                        <input
                            id={`${id}-confirm`}
                            value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                            autoComplete="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            className="mono"
                        />
                        <button
                            type="button"
                            className="danger-button"
                            disabled={!confirmed || busy}
                            onClick={remove}
                        >
                            <Icon name="trash" size={14} />
                            Delete this project
                        </button>
                    </div>
                </div>
                {error ? (
                    <p className="error small" role="alert">
                        {error}
                    </p>
                ) : null}
            </div>
        </section>
    );
}
