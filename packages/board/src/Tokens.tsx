import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import {
    createToken,
    listTokens,
    type ProjectSummary,
    revokeToken,
    type TokenInfo,
} from "./api.ts";
import { projectName } from "./model.ts";
import { go, projectHref } from "./route.ts";
import { keepFreshToken } from "./storage.ts";
import { CodeBlock, Icon } from "./ui.tsx";

/** The Tokens page: every token on the server, and making one for a project or for an agent. */
export function Tokens({ projects }: { projects: ProjectSummary[] | null }) {
    return (
        <>
            <header className="sheet-head">
                <div>
                    <h1>Tokens</h1>
                    <p>
                        A token for one project lets an app's SDK send and read that project's
                        notes. A token for <code>*</code> lets your coding agent read and answer all
                        of them over MCP.
                    </p>
                </div>
            </header>
            <TokenManager projects={projects} />
        </>
    );
}

/** Tokens, with making and revoking them: every one on the server, or one project's when `projectId` is given. */
export function TokenManager({
    projects,
    projectId,
}: {
    projects: ProjectSummary[] | null;
    projectId?: string;
}) {
    const id = useId();
    const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
    const [project, setProject] = useState(projectId ?? "");
    const [name, setName] = useState("");
    const [fresh, setFresh] = useState<{ token: string; projectId: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
        listTokens().then(setTokens, (e: Error) => setError(e.message));
    }, []);
    useEffect(() => load(), [load]);

    const create = async (ev: FormEvent) => {
        ev.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const made = await createToken(project, name.trim());
            setFresh({ token: made.token, projectId: made.record.projectId });
            setName("");
            load();
        } catch (e) {
            // The server's own words: an unknown project, a name it refuses. The list may be out of date too.
            setError(e instanceof Error ? e.message : "Could not create the token");
            load();
        } finally {
            setBusy(false);
        }
    };

    const revoke = (t: TokenInfo) => {
        if (
            !window.confirm(
                `Revoke “${t.name}”? Anything using it can no longer send or read notes. This cannot be undone.`
            )
        )
            return;
        setError(null);
        revokeToken(t.id).then(load, (e: Error) => setError(e.message));
    };

    const shown = (tokens ?? []).filter((t) => !projectId || t.projectId === projectId);
    const choices = [...(projects ?? [])].sort((x, y) =>
        projectName(x, x.id).localeCompare(projectName(y, y.id))
    );
    /** A token's project as the table shows it: its name, or "All projects" for an agent token. */
    const label = (pid: string) =>
        pid === "*"
            ? "All projects"
            : projectName(
                  projects?.find((p) => p.id === pid),
                  pid
              );

    return (
        <div className="tokens">
            {fresh ? (
                <TokenReveal
                    token={fresh.token}
                    projectId={fresh.projectId}
                    onDone={() => setFresh(null)}
                />
            ) : null}

            <form className={projectId ? "token-form one" : "token-form"} onSubmit={create}>
                {projectId ? null : (
                    <label htmlFor={`${id}-project`}>
                        Project
                        <select
                            id={`${id}-project`}
                            value={project}
                            onChange={(e) => setProject(e.target.value)}
                            required
                        >
                            <option value="" disabled>
                                {projects === null ? "Loading…" : "Choose a project"}
                            </option>
                            {choices.map((p) => {
                                const name = projectName(p, p.id);
                                return (
                                    <option key={p.id} value={p.id}>
                                        {name === p.id ? p.id : `${name} (${p.id})`}
                                    </option>
                                );
                            })}
                            <option value="*">* All projects, for a coding agent</option>
                        </select>
                    </label>
                )}
                <label htmlFor={`${id}-name`}>
                    Name
                    <input
                        id={`${id}-name`}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={projectId ? "iOS test build" : "staging testers"}
                        maxLength={100}
                        required
                    />
                </label>
                <button
                    type="submit"
                    className="primary"
                    disabled={busy || !project || !name.trim()}
                >
                    Create token
                </button>
            </form>
            {!projectId && projects?.length === 0 ? (
                <p className="muted small">
                    A token is for a project this server has: create the project first, or make one
                    for <code>*</code>.
                </p>
            ) : null}
            {error ? (
                <p className="error" role="alert">
                    {error}
                </p>
            ) : null}

            {tokens === null ? (
                error ? null : (
                    <p className="muted">Loading…</p>
                )
            ) : shown.length === 0 ? (
                <p className="muted">No tokens yet.</p>
            ) : (
                <div className="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Name</th>
                                {projectId ? null : <th>Project</th>}
                                <th>Created</th>
                                <th>Last used</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((t) => (
                                <tr key={t.id} className={t.revokedAt ? "revoked" : ""}>
                                    <td>{t.name}</td>
                                    {projectId ? null : (
                                        <td title={t.projectId}>
                                            {label(t.projectId)}
                                            {t.projectId !== "*" &&
                                            label(t.projectId) !== t.projectId ? (
                                                <code className="token-project">{t.projectId}</code>
                                            ) : null}
                                        </td>
                                    )}
                                    <td>{new Date(t.createdAt).toLocaleDateString()}</td>
                                    <td>
                                        {t.lastUsedAt
                                            ? new Date(t.lastUsedAt).toLocaleString()
                                            : "never"}
                                    </td>
                                    <td className="end">
                                        {t.revokedAt ? (
                                            <span className="muted">revoked</span>
                                        ) : (
                                            <button
                                                type="button"
                                                className="link danger"
                                                onClick={() => revoke(t)}
                                            >
                                                Revoke
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

/** A token just made: the one time anyone sees it, with what to do with it. */
export function TokenReveal({
    token,
    projectId,
    onDone,
    connect = true,
}: {
    token: string;
    projectId: string;
    onDone?: () => void;
    /** Offer the page that shows how to connect an app with it (not on that page itself). */
    connect?: boolean;
}) {
    const origin = window.location.origin;
    return (
        <div className="secret" role="status">
            <p className="secret-head">
                <Icon name="warn" size={15} />
                <strong>Copy it now: it is shown once.</strong>
            </p>
            <p className="small">
                The server keeps only a fingerprint of it, so it cannot be shown again. If it is
                lost, make another and revoke this one.
            </p>
            <CodeBlock code={token} label="Copy the token" className="token" />
            {projectId === "*" ? (
                <>
                    <p className="small">
                        Connect your coding agent to every project. Claude Code:
                    </p>
                    <CodeBlock
                        code={`claude mcp add --transport http notato ${origin}/mcp --header "Authorization: Bearer ${token}"`}
                    />
                    <p className="small">
                        Codex, in <code>~/.codex/config.toml</code>, with the token in{" "}
                        <code>NOTATO_TOKEN</code>:
                    </p>
                    <CodeBlock
                        code={`[mcp_servers.notato]\nurl = "${origin}/mcp"\nbearer_token_env_var = "NOTATO_TOKEN"`}
                    />
                    <p className="small">
                        Any other agent (Cursor, Gemini CLI, Copilot…): an HTTP MCP server at{" "}
                        <code>{origin}/mcp</code> with the header{" "}
                        <code>Authorization: Bearer {"<token>"}</code>.
                    </p>
                </>
            ) : null}
            {(connect && projectId !== "*") || onDone ? (
                <div className="secret-actions">
                    {connect && projectId !== "*" ? (
                        <button
                            type="button"
                            onClick={() => {
                                keepFreshToken(projectId, token);
                                go(projectHref(projectId, "connect"));
                            }}
                        >
                            <Icon name="plug" size={14} />
                            Connect an app with it
                        </button>
                    ) : null}
                    {onDone ? (
                        <button type="button" className="ghost" onClick={onDone}>
                            I have copied it
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
