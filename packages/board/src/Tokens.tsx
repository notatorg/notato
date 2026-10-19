import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import {
    createToken,
    listTokens,
    type Me,
    type ProjectSummary,
    revokeToken,
    type TokenInfo,
    tokenLabel,
    tokenPurpose,
} from "./api.ts";
import { useBoardExtension } from "./extension.tsx";
import { projectName } from "./model.ts";
import { go, projectHref } from "./route.ts";
import { keepFreshToken } from "./storage.ts";
import { CodeBlock, Icon, Modal, Segmented } from "./ui.tsx";

/** The Tokens page: every token on the server, and making one for a project or for an agent. */
export function Tokens({
    me,
    projects,
    embedded = false,
}: {
    me: Me;
    projects: ProjectSummary[] | null;
    /** Inside a Settings tab: the intro is a line of text, not a page heading. */
    embedded?: boolean;
}) {
    const intro =
        "App/tester tokens let people capture feedback, with optional access to read and change it. Agent tokens connect coding agents through MCP. An agent token is restricted to the projects it is issued for.";
    return (
        <>
            {embedded ? (
                <p className="muted settings-intro">{intro}</p>
            ) : (
                <header className="sheet-head">
                    <div>
                        <h1>Tokens</h1>
                        <p>{intro}</p>
                    </div>
                </header>
            )}
            <TokenManager me={me} projects={projects} />
        </>
    );
}

/** Tokens, with making and revoking them: every one on the server, or one project's when `projectId` is given. */
export function TokenManager({
    me,
    projects,
    projectId,
}: {
    me: Me;
    projects: ProjectSummary[] | null;
    projectId?: string;
}) {
    const id = useId();
    const extension = useBoardExtension();
    const requireExpiry = extension?.requireTokenExpiry ?? false;
    const [choice, setChoice] = useState("");
    const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
    const [project, setProject] = useState(projectId ?? "");
    const [name, setName] = useState("");
    const [tokenType, setTokenType] = useState<"capture" | "feedback" | "agent">("capture");
    const [days, setDays] = useState(90);
    const tokenChoices =
        extension?.tokens?.choices?.(me, tokenType === "agent" ? "agent" : "app") ?? [];
    const selectedChoice = tokenChoices.find((item) => item.id === choice) ?? tokenChoices[0];
    const [fresh, setFresh] = useState<{
        token: string;
        projectId: string;
        permission?: "capture" | "full";
        purpose?: "app" | "agent";
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [creating, setCreating] = useState(false);

    const load = useCallback(() => {
        listTokens().then(setTokens, (e: Error) => setError(e.message));
    }, []);
    useEffect(() => load(), [load]);

    const create = async (ev: FormEvent) => {
        ev.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const made = await createToken(project, name.trim(), {
                ...selectedChoice?.options,
                permission: tokenType === "capture" ? "capture" : "full",
                purpose: tokenType === "agent" ? "agent" : "app",
                ...(days ? { expiresInDays: days } : {}),
            });
            setFresh({
                token: made.token,
                projectId: made.record.projectId,
                permission: made.record.permission,
                purpose: tokenPurpose(made.record),
            });
            setName("");
            setCreating(false);
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
            <div className="token-toolbar">
                <span className="muted small">
                    {tokens ? `${shown.filter((t) => !t.revokedAt).length} active tokens` : ""}
                </span>
                <button
                    type="button"
                    className="primary"
                    onClick={() => {
                        setError(null);
                        setTokenType("capture");
                        setChoice("");
                        setProject(projectId ?? "");
                        setCreating(true);
                    }}
                >
                    <Icon name="plus" size={15} />
                    Add token
                </button>
            </div>
            {fresh ? (
                <Modal title="Token created" onClose={() => setFresh(null)} size="wide">
                    <div className="modal-body">
                        <TokenReveal
                            token={fresh.token}
                            projectId={fresh.projectId}
                            onDone={() => setFresh(null)}
                            purpose={fresh.purpose}
                            permission={fresh.permission}
                        />
                    </div>
                </Modal>
            ) : null}
            {creating ? (
                <Modal
                    title="Create token"
                    onClose={() => {
                        if (!busy) setCreating(false);
                    }}
                    onSubmit={create}
                >
                    <div className="modal-body token-form">
                        {projectId ? null : (
                            <label htmlFor={`${id}-project`}>
                                Project
                                <select
                                    aria-label="Project"
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
                                    {extension?.tokens?.allowAllProjects !== false ? (
                                        <option value="*" disabled={tokenType !== "agent"}>
                                            * All projects, for a coding agent
                                        </option>
                                    ) : null}
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
                        <label>
                            Token type
                            <select
                                aria-label="Token type"
                                value={tokenType}
                                onChange={(e) => {
                                    const next = e.target.value as typeof tokenType;
                                    setTokenType(next);
                                    setChoice("");
                                    if (next !== "agent" && project === "*")
                                        setProject(projectId ?? "");
                                }}
                            >
                                <option value="capture">App/tester — capture only</option>
                                <option value="feedback">App/tester — capture and feedback</option>
                                {extension?.tokens?.canCreateAgent?.(me) !== false ? (
                                    <option value="agent">Agent — MCP access</option>
                                ) : null}
                            </select>
                        </label>
                        <p className="muted small" role="status">
                            {tokenType === "agent"
                                ? "For coding agents and MCP clients. Reads and changes feedback. Keep this token on the agent machine; it cannot be used in a cross-origin browser app."
                                : tokenType === "feedback"
                                  ? "For developers and testers using the SDK. Anyone with this token can capture, read and change feedback in the selected project. MCP access is blocked."
                                  : "For apps and testers that only send new feedback. Existing notes and replies stay private. MCP access is blocked."}
                        </p>
                        {tokenChoices.length > 1 ? (
                            <label>
                                Belongs to
                                <select
                                    aria-label="Token owner"
                                    value={selectedChoice?.id ?? ""}
                                    onChange={(e) => setChoice(e.target.value)}
                                >
                                    {tokenChoices.map((item) => (
                                        <option key={item.id} value={item.id}>
                                            {item.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        ) : null}
                        {selectedChoice ? (
                            <p className="muted small">{selectedChoice.description}</p>
                        ) : null}
                        <label>
                            Lifetime
                            <select
                                aria-label="Lifetime"
                                value={days}
                                onChange={(e) => setDays(Number(e.target.value))}
                            >
                                {!requireExpiry && <option value={0}>No expiry</option>}
                                <option value={7}>7 days</option>
                                <option value={30}>30 days</option>
                                <option value={90}>90 days</option>
                                <option value={365}>365 days</option>
                            </select>
                        </label>
                        {error ? (
                            <p className="error" role="alert">
                                {error}
                            </p>
                        ) : null}
                    </div>
                    <footer className="modal-foot">
                        <button
                            type="button"
                            className="ghost"
                            disabled={busy}
                            onClick={() => setCreating(false)}
                        >
                            Cancel
                        </button>
                        <span className="grow" />
                        <button
                            type="submit"
                            className="primary"
                            disabled={busy || !project || !name.trim()}
                        >
                            {busy ? "Creating…" : "Create token"}
                        </button>
                    </footer>
                </Modal>
            ) : null}
            {!projectId && projects?.length === 0 ? (
                <p className="muted small">
                    A token is for a project this server has: create the project first, or make one
                    for <code>*</code>.
                </p>
            ) : null}
            {error && !creating ? (
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
                                <th>Access / expiry</th>
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
                                        {tokenLabel(t)}
                                        {extension?.tokens?.describe?.(t) ? (
                                            <div className="muted small">
                                                {extension.tokens.describe(t)}
                                            </div>
                                        ) : null}
                                        <br />
                                        {t.expiresAt
                                            ? new Date(t.expiresAt).toLocaleDateString()
                                            : "No expiry"}
                                    </td>
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
    purpose = "app",
    permission,
}: {
    token: string;
    projectId: string;
    onDone?: () => void;
    /** Offer the page that shows how to connect an app with it (not on that page itself). */
    connect?: boolean;
    purpose?: "app" | "agent";
    permission?: "capture" | "full";
}) {
    const [agent, setAgent] = useState<"claude" | "codex" | "other">("claude");
    const origin = window.location.origin;
    const mcpUrl = `${origin}/mcp${projectId === "*" ? "" : `?project=${encodeURIComponent(projectId)}`}`;
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
            {purpose === "app" ? (
                <p className="small">
                    App/tester token
                    {permission
                        ? ` · ${permission === "full" ? "Capture and feedback" : "Capture only"}`
                        : ""}
                    . Use it with this project's SDK. It cannot connect to MCP.
                </p>
            ) : null}
            {purpose === "agent" ? (
                <div className="token-guide">
                    <p className="small">
                        Agent token: use this credential on the agent machine for MCP. It can read
                        and modify feedback. Set it in <code>NOTATO_TOKEN</code>.
                    </p>
                    <Segmented<"claude" | "codex" | "other">
                        label="Agent setup"
                        value={agent}
                        onChange={setAgent}
                        options={[
                            { id: "claude", label: "Claude Code" },
                            { id: "codex", label: "Codex" },
                            { id: "other", label: "Other agents" },
                        ]}
                    />
                    {agent === "claude" ? (
                        <CodeBlock
                            code={`claude mcp add --transport http notato ${mcpUrl} --header "Authorization: Bearer $NOTATO_TOKEN"`}
                        />
                    ) : agent === "codex" ? (
                        <>
                            <p className="small">
                                Add to <code>~/.codex/config.toml</code>:
                            </p>
                            <CodeBlock
                                code={`[mcp_servers.notato]\nurl = "${mcpUrl}"\nbearer_token_env_var = "NOTATO_TOKEN"`}
                            />
                        </>
                    ) : (
                        <>
                            <p className="small">
                                Use an HTTP MCP server with this address and header:
                            </p>
                            <CodeBlock code={mcpUrl} label="Copy MCP address" />
                            <CodeBlock
                                code="Authorization: Bearer <token>"
                                label="Copy header template"
                            />
                        </>
                    )}
                </div>
            ) : null}
            {(connect && projectId !== "*" && purpose !== "agent") || onDone ? (
                <div className="secret-actions">
                    {connect && projectId !== "*" && purpose !== "agent" ? (
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
