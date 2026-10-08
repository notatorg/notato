import { useState } from "react";
import { type OnOff, remember, remembered, type ServerStatus, type SettingsView } from "./api.ts";
import { GuideView } from "./Connect.tsx";
import { type AgentClient, agentGuides } from "./connect.ts";
import { href } from "./route.ts";
import { Segmented, Toggle } from "./ui.tsx";

const CLIENTS: AgentClient[] = ["claude", "codex", "cursor", "gemini", "vscode", "other"];

/** "Claude, watching for notes", from what the server says about the agents with its MCP open. */
export function agentsText(agents: ServerStatus["agents"]): string {
    if (!agents?.connected) return "None connected";
    const who = agents.names?.length
        ? agents.names.join(", ")
        : `${agents.sessions} session${agents.sessions === 1 ? "" : "s"}`;
    return `${who}${agents.watching ? ", watching for notes" : ", connected"}`;
}

/**
 * Settings › Agents: whether coding agents may connect over MCP (the `mcp` setting), where they connect, who is
 * connected now, and the few lines that connect each agent.
 */
export function AgentsSection({
    setting,
    status,
    locked,
    busy,
    onChange,
}: {
    setting: SettingsView["settings"][number] | undefined;
    status: ServerStatus | null;
    /** The settings file cannot be written (none, or broken). */
    locked: boolean;
    busy: boolean;
    onChange(value: OnOff | null): void;
}) {
    const [client, setClient] = useState<AgentClient>(() =>
        remembered("notato.agent", CLIENTS, "claude")
    );
    if (!setting) return null;
    const on = setting.value === "on";
    const serve = status?.mode === "serve";
    // In dev mode agents connect on this machine, even when this board was opened through the tunnel.
    const url = status?.mcpUrl ?? `${window.location.origin}/mcp`;
    const guides = agentGuides({ url, needsToken: serve });
    const guide = guides.find((g) => g.id === client) ?? guides[0];
    const pinned = setting.source === "env" || setting.source === "flag";

    return (
        <section className="set-section">
            <div className="set-label">
                <h2>Agents</h2>
                <p>Coding agents get the notes, and reply and resolve them, over MCP.</p>
            </div>
            <div className="set-body">
                <div className="setting-row">
                    <div className="setting-text">
                        <strong>Let agents connect</strong>
                        <p className="muted small">
                            {serve
                                ? "Agents connect with a token. Off closes the MCP and refuses agent tokens; apps keep sending notes."
                                : "Agents on this computer connect with no token. Web pages never can, and nothing can through the dev tunnel."}
                        </p>
                        {setting.source === "env" ? (
                            <p className="small note">
                                Set to {setting.value} by <code>${setting.env}</code> where the
                                server runs, which wins over this file.
                            </p>
                        ) : setting.source === "flag" ? (
                            <p className="small note">
                                Set to {setting.value} by <code>--no-mcp</code> when the server was
                                started, which wins over this file until it restarts.
                            </p>
                        ) : setting.source === "file" && setting.value !== setting.default ? (
                            <button
                                type="button"
                                className="link small"
                                disabled={locked || busy}
                                onClick={() => onChange(null)}
                            >
                                Back to the default ({setting.default})
                            </button>
                        ) : null}
                    </div>
                    <Toggle
                        label="Let agents connect"
                        on={on}
                        disabled={locked || pinned || busy}
                        onChange={(next) => onChange(next ? "on" : "off")}
                    />
                </div>

                {on ? (
                    <>
                        <dl className="facts-list">
                            <dt>Address</dt>
                            <dd>
                                <code>{url}</code>
                            </dd>
                            <dt>Connected</dt>
                            <dd>{agentsText(status?.agents)}</dd>
                            {serve ? (
                                <>
                                    <dt>Token</dt>
                                    <dd>
                                        An agent token from{" "}
                                        <a href={href({ page: "tokens" })}>Tokens</a> (for every
                                        project), or one project's token.
                                    </dd>
                                </>
                            ) : null}
                        </dl>
                        <Segmented
                            label="Agent"
                            className="platforms"
                            value={client}
                            onChange={(next) => {
                                setClient(next);
                                remember("notato.agent", next);
                            }}
                            options={guides.map((g) => ({ id: g.id, label: g.label }))}
                        />
                        {guide ? <GuideView guide={guide} /> : null}
                    </>
                ) : (
                    <p className="muted small">
                        Agents are refused while this is off: they are told it is turned off, and
                        how to turn it back on. Notes from apps keep arriving.
                    </p>
                )}
            </div>
        </section>
    );
}
