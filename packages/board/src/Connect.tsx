import { type ReactNode, useEffect, useState } from "react";
import { createToken, getStatus, type Me } from "./api.ts";
import { connectGuides, type Guide, type Platform } from "./connect.ts";
import { projectHref } from "./route.ts";
import {
    forgetFreshToken,
    forgetMadeHere,
    freshToken,
    KEYS,
    useRemembered,
    wasMadeHere,
} from "./storage.ts";
import { TokenReveal } from "./Tokens.tsx";
import { CodeBlock, Icon, Inline, Segmented } from "./ui.tsx";

const PLATFORMS: Platform[] = [
    "react",
    "angular",
    "react-native",
    "flutter",
    "page",
    "maui",
    "swift",
    "android",
];

/**
 * How to send this project notes from an app: its token where the server needs one (the one just made, shown once,
 * or a button to make one), then each SDK's few lines with this server, project and token filled in.
 */
function ConnectApp({ me, project, name }: { me: Me; project: string; name: string }) {
    const [token, setToken] = useState(() => freshToken(project));
    const [platform, setPlatform] = useRemembered(KEYS.connect, PLATFORMS, "react");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Shown once: leaving the page lets it go.
    useEffect(() => () => void forgetFreshToken(project), [project]);

    // The server's version is every SDK's (one release): the snippets that name a version use it.
    const [version, setVersion] = useState<string | undefined>();
    useEffect(() => {
        getStatus()
            .then((s) => setVersion(s.version))
            .catch(() => {});
    }, []);

    const needsToken = me.authRequired;
    const guides = connectGuides({
        server: window.location.origin,
        project,
        needsToken,
        token,
        version,
    });
    const guide = guides.find((g) => g.id === platform) ?? guides[0];

    const makeToken = async () => {
        setBusy(true);
        setError(null);
        try {
            setToken((await createToken(project, `${name} app`)).token);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not create a token.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="connect">
            {!needsToken ? (
                <div className="connect-note">
                    <Icon name="check" size={15} className="note-icon" />
                    <p>
                        <strong>No token needed.</strong> Apps on this computer send to{" "}
                        <code>{window.location.origin}</code> as they are. A phone reaches this
                        server through a dev tunnel (<code>notato dev --tunnel</code>), with the
                        device token kept in the data folder's <code>device.json</code>.
                    </p>
                </div>
            ) : token ? (
                <TokenReveal token={token} projectId={project} connect={false} />
            ) : (
                <div className="connect-note need">
                    <Icon name="key" size={15} className="note-icon" />
                    <div className="connect-note-body">
                        <p>
                            <strong>Apps need a token for this project.</strong> Where the snippets
                            say <code>notato_…</code>, put one. A token is shown only once, when it
                            is made: make one here, or under{" "}
                            <a href={projectHref(project, "settings")}>Project settings</a>.
                        </p>
                        <button
                            type="button"
                            className="small primary"
                            disabled={busy}
                            onClick={makeToken}
                        >
                            Create a token
                        </button>
                        {error ? (
                            <p className="error small" role="alert">
                                {error}
                            </p>
                        ) : null}
                    </div>
                </div>
            )}

            <Segmented
                label="Platform"
                className="platforms"
                value={platform}
                onChange={setPlatform}
                options={guides.map((g) => ({ id: g.id, label: g.label }))}
            />
            {guide ? <GuideView guide={guide} /> : null}
        </div>
    );
}

/** One guide's numbered steps, each with its code to copy, and the notes under them. */
export function GuideView({ guide }: { guide: Guide<string> }) {
    return (
        <div className="guide" role="tabpanel">
            <ol className="steps">
                {guide.steps.map((step) => (
                    <li key={step.text}>
                        <p>
                            <Inline text={step.text} />
                        </p>
                        {step.code ? <CodeBlock code={step.code} /> : null}
                        {step.link ? (
                            <a
                                className="button-link"
                                href={step.link.href}
                                target="_blank"
                                rel="noreferrer"
                            >
                                {step.link.label}
                                <Icon name="external" size={12} />
                            </a>
                        ) : null}
                    </li>
                ))}
            </ol>
            {guide.notes.length ? (
                <ul className="guide-notes">
                    {guide.notes.map((n) => (
                        <li key={n}>
                            <Inline text={n} />
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

/** The page after a project is made, and an empty inbox: connect an app, and its notes land here. */
export function ConnectPage({
    me,
    project,
    name,
    menu,
    empty,
}: {
    me: Me;
    project: string;
    name: string;
    menu: ReactNode;
    /** Shown as the project's inbox, which has no notes yet. */
    empty?: boolean;
}) {
    const [made] = useState(() => wasMadeHere(project));
    useEffect(() => () => void forgetMadeHere(project), [project]);
    return (
        <div className="sheet">
            <div className="sheet-inner connect-page">
                <header className="sheet-head">
                    <div>
                        <h1>{empty ? name : "Connect an app"}</h1>
                        <p>
                            {empty ? (
                                <>
                                    No notes yet. Connect an app, and they land here as they are
                                    made.
                                </>
                            ) : (
                                <>
                                    Notes from the apps you connect land in{" "}
                                    <a href={projectHref(project)}>{name}</a>'s inbox as they are
                                    made. Its id is <code>{project}</code>.
                                </>
                            )}
                        </p>
                    </div>
                    <div className="sheet-tools">{menu}</div>
                </header>
                {made && !empty ? (
                    <div className="banner ok" role="status">
                        <span>
                            <strong>{name}</strong> is ready.
                            {me.mode === "serve"
                                ? " Apps can send to it now that it exists."
                                : " Connect an app below."}
                        </span>
                    </div>
                ) : null}
                <ConnectApp me={me} project={project} name={name} />
                {empty ? null : (
                    <p className="connect-foot">
                        <a className="button-link primary" href={projectHref(project)}>
                            Go to the inbox
                        </a>
                    </p>
                )}
            </div>
        </div>
    );
}
