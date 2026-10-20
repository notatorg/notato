import type { ReactNode } from "react";

/** What a person needs to do on the other tool's side, in the order they will do it. */
export interface ProviderGuide {
    /** The label of the one secret Notato asks for. */
    credential: string;
    steps: ReactNode[];
}

const link = (href: string, text: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
        {text}
    </a>
);

export function providerGuide(provider: string, githubApp: boolean): ProviderGuide {
    switch (provider) {
        case "github":
            return {
                credential: "GitHub personal access token",
                steps: [
                    <>
                        {link(
                            "https://github.com/settings/personal-access-tokens/new",
                            "Create a fine-grained token on GitHub"
                        )}
                        . Under <strong>Repository access</strong> choose only the repositories you
                        want.
                    </>,
                    <>
                        Give it <strong>Issues: Read and write</strong>. Add{" "}
                        <strong>Pull requests: Read and write</strong> if you will use pull request
                        reviews. Metadata (read) is added for you.
                    </>,
                    <>Copy the token, paste it below and add the connection.</>,
                    ...(githubApp
                        ? [
                              <>
                                  Prefer not to use a personal token? Use the GitHub App options
                                  further down.
                              </>,
                          ]
                        : []),
                ],
            };
        case "slack":
            return {
                credential: "Slack bot token (starts xoxb-)",
                steps: [
                    <>
                        {link("https://api.slack.com/apps", "Create a Slack app")}, add the{" "}
                        <strong>chat:write</strong> scope and install it to your workspace.
                    </>,
                    <>
                        Copy the <strong>Bot User OAuth Token</strong> and paste it below.
                    </>,
                    <>
                        Invite the app to the channel you want to use (type{" "}
                        <code>/invite @YourApp</code> there).
                    </>,
                ],
            };
        case "teams":
            return {
                credential: "Teams Workflow webhook URL",
                steps: [
                    <>
                        In Microsoft Teams open <strong>Workflows</strong> and create one from “Post
                        to a channel when a webhook request is received”.
                    </>,
                    <>
                        Pick the team and channel, then copy the URL it gives you and paste it
                        below.
                    </>,
                ],
            };
        case "linear":
            return {
                credential: "Linear API key",
                steps: [
                    <>
                        In Linear open <strong>Settings → Account → Security &amp; access</strong>{" "}
                        and create a personal API key.
                    </>,
                    <>Copy it and paste it below.</>,
                ],
            };
        case "gitlab":
            return {
                credential: "GitLab personal access token",
                steps: [
                    <>
                        {link(
                            "https://gitlab.com/-/user_settings/personal_access_tokens",
                            "Create a personal access token on GitLab.com"
                        )}{" "}
                        with the <strong>api</strong> scope.
                    </>,
                    <>Copy it and paste it below.</>,
                ],
            };
        case "azure":
            return {
                credential: "Microsoft Entra access token",
                steps: [
                    <>
                        Azure DevOps needs a Microsoft Entra access token for your organisation. If
                        “Connect with Azure DevOps” appears below, use that instead; it avoids
                        handling a token by hand.
                    </>,
                ],
            };
        default:
            return {
                credential: "HTTPS webhook URL",
                steps: [
                    <>
                        Use any HTTPS address you control, such as an automation tool or your own
                        service. Notato posts JSON to it and signs each request.
                    </>,
                    <>
                        Generate a signing secret below, then put the same secret in the receiving
                        service so it can check each signature.
                    </>,
                ],
            };
    }
}

/** A random 256-bit secret, as 64 hexadecimal characters. */
export function generateSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SetupStep {
    id: string;
    title: string;
    hint: string;
    done: boolean;
    tab: string;
}

/** Where a new workspace is in connecting its first tool: what is done, and the one thing to do next. */
export function SetupChecklist({
    steps,
    current,
    onGo,
}: {
    steps: SetupStep[];
    /** The page already open: its step needs no "Go there". */
    current: string;
    onGo(tab: string): void;
}) {
    const next = steps.find((s) => !s.done);
    return (
        <section className="card plugin-start" aria-labelledby="plugin-start-title">
            <h2 id="plugin-start-title">Get started</h2>
            <p className="muted">
                A <strong>connection</strong> is your account on another tool. An{" "}
                <strong>action</strong> says which project's feedback goes where. A{" "}
                <strong>workflow</strong> runs an action for you automatically.
            </p>
            <ol className="plugin-steps">
                {steps.map((s) => (
                    <li key={s.id} className={s.done ? "done" : s === next ? "next" : undefined}>
                        <span aria-hidden="true">{s.done ? "✓" : s === next ? "→" : "·"}</span>{" "}
                        <strong>{s.title}</strong>
                        {s.done ? <span className="muted"> — done</span> : null}
                        {s === next ? (
                            <>
                                <br />
                                <span className="muted">{s.hint}</span>{" "}
                                {s.tab !== current && (
                                    <button type="button" onClick={() => onGo(s.tab)}>
                                        Go there
                                    </button>
                                )}
                            </>
                        ) : null}
                    </li>
                ))}
            </ol>
        </section>
    );
}
