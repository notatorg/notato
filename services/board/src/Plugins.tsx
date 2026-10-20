import type { Annotation } from "@notato/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    type WorkflowConditions,
    workflowConditions,
    workflowTags,
} from "../../server/src/plugins/conditions.ts";
import type {
    Action,
    Connection,
    Destination,
    Job,
    Payload,
    Provider,
    Workflow,
} from "../../server/src/plugins/model.ts";
import {
    getAnnotation,
    json,
    listAnnotations,
    type Me,
    type ProjectSummary,
    request,
    Segmented,
} from "./api.ts";
import { RowMenu, Section, usePageTitle } from "./Layout.tsx";
import { generateSecret, providerGuide, SetupChecklist } from "./PluginHelp.tsx";
import { GuestNotice, RoleNote, whoIs } from "./Role.tsx";
import { WorkflowRules } from "./WorkflowRules.tsx";
import { WorkflowScope } from "./WorkflowScope.tsx";

interface Info {
    configured: boolean;
    manager: boolean;
    githubInstallUrl: string | null;
    catalog: { id: Provider; name: string; description: string; oauth?: boolean }[];
    connections: Omit<Connection, "encrypted">[];
    actions: Action[];
    workflows: Workflow[];
    history: Job[];
    limits: { workflows: number; actions: number };
    used: number;
}
const initial = {
    repository: "",
    organization: "",
    project: "",
    workItemType: "Bug",
    channel: "",
    team: "",
    labels: "",
    assignee: "",
    area: "",
};
const labels = (value: string) =>
    value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

const workflowTriggers: Record<Workflow["trigger"], string> = {
    created: "An annotation arrives or starts matching the conditions",
    resolved: "A matching annotation is resolved",
    awaiting_response: "The agent asks a question on a matching annotation",
    unanswered: "A question on a matching annotation remains unanswered",
    daily_digest: "Daily digest of matching annotations",
};

function destinationFields(value: Destination) {
    const fields = { ...initial };
    for (const [key, part] of Object.entries(value))
        if (key in fields)
            fields[key as keyof typeof fields] = Array.isArray(part)
                ? part.join(", ")
                : String(part);
    return fields;
}

function destinationLabel(action: Action | undefined, connections: Info["connections"]) {
    if (!action) return undefined;
    const destination = action.destination;
    const connection = connections.find((c) => c.id === action.connectionId)?.name ?? action.name;
    switch (destination.provider) {
        case "github":
            return `GitHub · ${destination.repository}`;
        case "azure":
            return `Azure DevOps · ${destination.organization}/${destination.project}`;
        case "slack":
            return `Slack · ${connection} · ${destination.channel}`;
        case "gitlab":
            return `GitLab · ${destination.project}`;
        case "linear":
            return `Linear · ${connection} · ${destination.team}`;
        case "teams":
            return `Teams · ${connection}`;
        case "webhook":
            return `Webhook · ${connection}`;
    }
}

export function Plugins({
    me,
    projects,
    initialNote = "",
}: {
    me: Me;
    projects: ProjectSummary[] | null;
    initialNote?: string;
}) {
    usePageTitle("Integrations");
    const setupConnection = initialNote.startsWith("setup/") ? initialNote.slice(6) : "";
    const reconnected = initialNote.startsWith("reconnected/");
    const selectedNote =
        setupConnection || reconnected || initialNote === "authorization-canceled"
            ? ""
            : initialNote;
    const [info, setInfo] = useState<Info | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [tab, setTab] = useState("actions");
    const [provider, setProvider] = useState<Provider>("github");
    const [name, setName] = useState("");
    const [credential, setCredential] = useState("");
    const [installation, setInstallation] = useState("");
    const [signing, setSigning] = useState("");
    const [connectionId, setConnectionId] = useState("");
    const [reconnecting, setReconnecting] = useState("");
    const [chosen, setChosen] = useState(false);
    const [secretShown, setSecretShown] = useState(false);
    const alertRef = useRef<HTMLParagraphElement>(null);
    const connectionForm = useRef<HTMLElement>(null);
    useEffect(() => {
        if (reconnecting) connectionForm.current?.scrollIntoView({ block: "start" });
    }, [reconnecting]);
    useEffect(() => {
        if (setupConnection) {
            setConnectionId(setupConnection);
            setTab("actions");
            setNotice(
                "Connection saved. Choose a Notato project and destination below, then save your action."
            );
        }
        if (initialNote === "authorization-canceled") {
            setTab("connections");
            setNotice("Authorization was canceled. Your existing connections are unchanged.");
        }
        if (reconnected) {
            setTab("connections");
            setNotice(
                "Connection reconnected. Review and re-enable any personal annotation routing; it was switched off because the destination may have changed."
            );
        }
    }, [setupConnection, initialNote, reconnected]);
    const [actionName, setActionName] = useState("");
    const [editingAction, setEditingAction] = useState<Action | null>(null);
    const actionForm = useRef<HTMLElement>(null);
    const [project, setProject] = useState("");
    const [destination, setDestination] = useState(initial);
    const [choices, setChoices] = useState<{ id: string; name: string }[]>([]);
    const [workItemTypes, setWorkItemTypes] = useState<{ id: string; name: string }[]>([]);
    const [lookupError, setLookupError] = useState("");
    const [actionId, setActionId] = useState("");
    const [notes, setNotes] = useState<Annotation[]>([]);
    const [noteId, setNoteId] = useState("");
    const [existingLink, setExistingLink] = useState("");
    const [pinnedNote, setPinnedNote] = useState<Annotation | null>(null);
    useEffect(() => {
        let stopped = false;
        if (selectedNote)
            void getAnnotation(selectedNote).then(
                (n) => {
                    if (!stopped) setPinnedNote(n);
                },
                (e) => {
                    if (!stopped) setError(e.message);
                }
            );
        return () => {
            stopped = true;
        };
    }, [selectedNote]);
    const preferredAction = info?.actions.find(
        (a) => !a.archived && a.projectId === pinnedNote?.projectId
    )?.id;
    useEffect(() => {
        if (preferredAction) setActionId((current) => current || preferredAction);
    }, [preferredAction]);
    const [preview, setPreview] = useState<{
        payload: Payload;
        hash: string;
        requestId: string;
    } | null>(null);
    const [workflowName, setWorkflowName] = useState("");
    const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null);
    const [workflowActionId, setWorkflowActionId] = useState("");
    const [workflowEnabled, setWorkflowEnabled] = useState(true);
    const [conditions, setConditions] = useState<WorkflowConditions>({
        match: "all",
        rules: [{ field: "visibility", value: "shared" }],
    });
    const [includePersonal, setIncludePersonal] = useState(false);
    const workflowForm = useRef<HTMLElement>(null);
    const [trigger, setTrigger] = useState<Workflow["trigger"]>("created");
    const [hour, setHour] = useState(9);
    const [delay, setDelay] = useState(24);
    useEffect(() => {
        if (editingAction) {
            actionForm.current?.scrollIntoView({ block: "start" });
            actionForm.current?.querySelector("input")?.focus();
        }
    }, [editingAction]);
    useEffect(() => {
        if (editingWorkflow) {
            workflowForm.current?.scrollIntoView({ block: "start" });
            workflowForm.current?.querySelector("input")?.focus();
        }
    }, [editingWorkflow]);
    const resetAction = () => {
        setEditingAction(null);
        setActionName("");
        setConnectionId("");
        setProject("");
        setDestination(initial);
    };
    const resetWorkflow = () => {
        setEditingWorkflow(null);
        setWorkflowName("");
        setWorkflowActionId("");
        setWorkflowEnabled(true);
        setConditions({ match: "all", rules: [{ field: "visibility", value: "shared" }] });
        setIncludePersonal(false);
        setTrigger("created");
        setHour(9);
        setDelay(24);
    };
    const load = useCallback(async () => {
        setInfo(await request<Info>("/plugins"));
    }, []);
    useEffect(() => {
        let stopped = false;
        const refresh = () => {
            if (!stopped && document.visibilityState === "visible")
                void load().catch((e) => setError(e.message));
        };
        void load().catch((e) => setError(e.message));
        const timer = setInterval(refresh, 15_000);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [load]);
    // Open on the page that moves a new workspace forward, unless the address asked for something specific.
    useEffect(() => {
        if (!info || chosen) return;
        setChosen(true);
        if (
            setupConnection ||
            reconnected ||
            selectedNote ||
            initialNote === "authorization-canceled"
        )
            return;
        if (info.manager && !info.connections.some((c) => !c.revoked)) setTab("connections");
        else if (info.manager && !info.actions.some((a) => !a.archived)) setTab("actions");
    }, [info, chosen, setupConnection, reconnected, selectedNote, initialNote]);
    // A failure is shown where the person is looking, not only at the top of a long page.
    useEffect(() => {
        if (error && tab !== "connections") alertRef.current?.scrollIntoView({ block: "nearest" });
    }, [error, tab]);
    const perform = async (work: () => Promise<unknown>, success: string) => {
        if (busy) return;
        setBusy(true);
        setError("");
        setNotice("");
        try {
            await work();
            await load();
            setNotice(success);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not complete this action.");
        } finally {
            setBusy(false);
        }
    };
    const selected = info?.actions.find((a) => a.id === actionId);
    const selectedProject = selected?.projectId;
    useEffect(() => {
        let stopped = false;
        setNoteId("");
        setPreview(null);
        setNotes([]);
        if (selectedProject && actionId)
            void listAnnotations(selectedProject, true).then(
                (items) => {
                    if (!stopped) {
                        setNotes(items);
                        if (selectedNote && items.some((n) => n.id === selectedNote))
                            setNoteId(selectedNote);
                    }
                },
                (e) => {
                    if (!stopped) setError(e.message);
                }
            );
        return () => {
            stopped = true;
        };
    }, [selectedProject, actionId, selectedNote]);
    const connection = info?.connections.find((c) => c.id === connectionId);
    const selectedProvider = connection?.provider;
    useEffect(() => {
        let stopped = false;
        setChoices([]);
        setWorkItemTypes([]);
        setLookupError("");
        if (
            connectionId &&
            selectedProvider &&
            !["azure", "teams", "webhook"].includes(selectedProvider)
        )
            void request<{ items: { id: string; name: string }[] }>(
                `/plugins/connections/${connectionId}/destinations`
            ).then(
                (v) => {
                    if (!stopped) setChoices(v.items);
                },
                () => {
                    if (!stopped)
                        setLookupError(
                            "Destinations could not be listed. You can enter the destination directly below."
                        );
                }
            );
        return () => {
            stopped = true;
        };
    }, [connectionId, selectedProvider]);
    const field = (key: keyof typeof initial, label: string, required = false) => (
        <label>
            {label}
            <input
                value={destination[key]}
                required={required}
                maxLength={200}
                disabled={busy}
                list={
                    ["repository", "channel", "team", "project"].includes(key) && choices.length
                        ? `plugin-${key}`
                        : key === "workItemType" && workItemTypes.length
                          ? "plugin-workItemType"
                          : undefined
                }
                onChange={(e) => setDestination({ ...destination, [key]: e.target.value })}
            />
            {["repository", "channel", "team", "project"].includes(key) && choices.length > 0 && (
                <datalist id={`plugin-${key}`}>
                    {choices.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.name}
                        </option>
                    ))}
                </datalist>
            )}
            {key === "workItemType" && workItemTypes.length > 0 && (
                <datalist id="plugin-workItemType">
                    {workItemTypes.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.name}
                        </option>
                    ))}
                </datalist>
            )}
        </label>
    );
    const buildDestination = (): Destination => {
        switch (connection?.provider) {
            case "github":
                return {
                    provider: "github",
                    repository: destination.repository,
                    labels: labels(destination.labels),
                    ...(destination.assignee ? { assignee: destination.assignee } : {}),
                };
            case "azure":
                return {
                    provider: "azure",
                    organization: destination.organization,
                    project: destination.project,
                    workItemType: destination.workItemType,
                    ...(destination.area ? { area: destination.area } : {}),
                    ...(destination.assignee ? { assignee: destination.assignee } : {}),
                };
            case "slack":
                return { provider: "slack", channel: destination.channel };
            case "linear":
                return {
                    provider: "linear",
                    team: destination.team,
                    labels: labels(destination.labels),
                    ...(destination.assignee ? { assignee: destination.assignee } : {}),
                };
            case "gitlab":
                return {
                    provider: "gitlab",
                    project: destination.project,
                    labels: labels(destination.labels),
                    ...(destination.assignee ? { assignee: Number(destination.assignee) } : {}),
                };
            case "teams":
                return { provider: "teams" };
            default:
                return { provider: "webhook" };
        }
    };
    if (!me.workspace) return <p className="center muted">Select a workspace to use plugins.</p>;
    if (whoIs(me).guest) return <GuestNotice what="Integrations" />;
    if (!info) return <p role={error ? "alert" : "status"}>{error || "Loading plugins…"}</p>;
    const ready = info.configured && !me.workspace.recoveryRequired;
    const steps = [
        {
            id: "connect",
            title: "Connect a tool",
            hint: "Add your account on GitHub, Slack, Linear or another tool.",
            done: info.connections.some((c) => !c.revoked),
            tab: "connections",
        },
        {
            id: "action",
            title: "Choose where feedback goes",
            hint: "Save an action: pick a Notato project and a destination such as a repository.",
            done: info.actions.some((a) => !a.archived),
            tab: "actions",
        },
        {
            id: "send",
            title: "Send your first note",
            hint: "Pick a note, preview exactly what will be shared, then send it.",
            done: info.history.length > 0,
            tab: "actions",
        },
    ];
    return (
        <div className="sheet">
            <div className="sheet-inner settings cloud-page">
                <header className="sheet-head">
                    <div>
                        <h1>Integrations</h1>
                        <p>
                            Send feedback to the tools your team already uses, such as GitHub issues
                            or a Slack channel. Send by hand or do it automatically.
                        </p>
                    </div>
                </header>
                <RoleNote me={me} can="connect tools, save actions and set up workflows">
                    You can send feedback with the actions your admins have saved, and see what was
                    sent. Owners and admins connect tools and set up actions and workflows.
                </RoleNote>
                {error && (
                    <div className="banner bad" role="alert" ref={alertRef}>
                        <span>{error}</span>
                    </div>
                )}
                {notice && (
                    <div className="banner ok" role="status">
                        <span>{notice}</span>
                    </div>
                )}
                {!ready && (
                    <Section
                        title={
                            info.configured
                                ? "This workspace needs attention first"
                                : "Integrations aren't switched on yet"
                        }
                    >
                        <p>
                            {info.configured
                                ? "Put the workspace's plan right (see Workspace) and this page will work again. Nothing you saved here has been lost."
                                : "This service has not been set up to connect other tools yet, so nothing here can be saved. Your workspace is fine."}
                        </p>
                        {!info.configured && (
                            <p className="muted">
                                Operator: set <code>NOTATO_PLUGIN_KEY</code> to a random
                                64-character hexadecimal key (and keep a recovery copy somewhere
                                else), then restart the service. See the plugin guide in the docs.
                            </p>
                        )}
                    </Section>
                )}
                {ready && info.manager && !steps.every((x) => x.done) && (
                    <SetupChecklist
                        steps={steps}
                        current={tab}
                        onGo={(t) => {
                            setTab(t);
                            setPreview(null);
                        }}
                    />
                )}
                {ready && (
                    <Segmented
                        label="Integration pages"
                        value={tab}
                        options={[
                            { id: "connections", label: "Connections" },
                            { id: "actions", label: "Actions" },
                            { id: "workflows", label: "Workflows" },
                            { id: "history", label: "History" },
                        ]}
                        onChange={(t) => {
                            setTab(t);
                            setPreview(null);
                        }}
                    />
                )}
                {ready && tab === "actions" && (
                    <>
                        {(info.actions.some((a) => !a.archived) || !info.manager) && (
                            <Section
                                title="Run an action"
                                about="Select feedback, review what will be shared, then send it. Images and private replies stay in Notato."
                            >
                                {!info.actions.length && (
                                    <p className="muted">
                                        {info.manager
                                            ? "Add a connection, then save your first action below."
                                            : "Ask a workspace owner or admin to add an action."}
                                    </p>
                                )}
                                <label>
                                    Saved action
                                    <select
                                        value={actionId}
                                        disabled={busy || !ready}
                                        onChange={(e) => {
                                            setActionId(e.target.value);
                                            setPreview(null);
                                        }}
                                    >
                                        <option value="">Choose an action</option>
                                        {info.actions
                                            .filter((a) => !a.archived)
                                            .map((a) => (
                                                <option value={a.id} key={a.id}>
                                                    {a.name}
                                                </option>
                                            ))}
                                    </select>
                                </label>
                                {selected && (
                                    <>
                                        <label>
                                            Feedback
                                            <select
                                                value={noteId}
                                                disabled={busy}
                                                onChange={(e) => {
                                                    setNoteId(e.target.value);
                                                    setPreview(null);
                                                }}
                                            >
                                                <option value="">Choose feedback</option>
                                                {notes.map((n) => (
                                                    <option key={n.id} value={n.id}>
                                                        {n.peopleOnly ? "Hidden from agent · " : ""}
                                                        {n.comment.slice(0, 100) || n.route}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        <button
                                            type="button"
                                            disabled={busy || !noteId}
                                            onClick={() =>
                                                void perform(async () => {
                                                    const p = await request<{
                                                        payload: Payload;
                                                        hash: string;
                                                    }>(
                                                        "/plugins/preview",
                                                        json("POST", { actionId, noteId })
                                                    );
                                                    setPreview({
                                                        ...p,
                                                        requestId: crypto.randomUUID(),
                                                    });
                                                }, "")
                                            }
                                        >
                                            Preview action
                                        </button>
                                        {preview && (
                                            <div className="plugin-preview">
                                                <h3>{preview.payload.title}</h3>
                                                <p className="muted">
                                                    This text will be shared with the selected
                                                    destination.
                                                </p>
                                                {preview.payload.visibility && (
                                                    <p role="alert">
                                                        This feedback is hidden from agents.
                                                        Confirming will share the text with the
                                                        selected external destination.
                                                    </p>
                                                )}
                                                {preview.payload.personal && (
                                                    <p>
                                                        This sends the content to the selected tool.
                                                        The annotation stays personal in Notato.
                                                    </p>
                                                )}
                                                <pre>{preview.payload.text}</pre>
                                                <button
                                                    type="button"
                                                    className="primary"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        void perform(async () => {
                                                            await request(
                                                                "/plugins/run",
                                                                json("POST", {
                                                                    actionId,
                                                                    noteId,
                                                                    hash: preview.hash,
                                                                    requestId: preview.requestId,
                                                                })
                                                            );
                                                            setPreview(null);
                                                        }, "Action queued. Follow its progress in History.")
                                                    }
                                                >
                                                    Confirm and send
                                                </button>
                                            </div>
                                        )}
                                        {["github", "azure", "linear", "gitlab"].includes(
                                            selected.destination.provider
                                        ) && (
                                            <form
                                                className="plugin-existing"
                                                onSubmit={(e) => {
                                                    e.preventDefault();
                                                    void perform(async () => {
                                                        await request(
                                                            "/plugins/link",
                                                            json("POST", {
                                                                actionId,
                                                                noteId,
                                                                url: existingLink,
                                                            })
                                                        );
                                                        setExistingLink("");
                                                    }, "Existing issue linked to this feedback.");
                                                }}
                                            >
                                                <label>
                                                    Or link an existing issue
                                                    <input
                                                        type="url"
                                                        required
                                                        maxLength={2000}
                                                        value={existingLink}
                                                        disabled={busy || !noteId}
                                                        onChange={(e) =>
                                                            setExistingLink(e.target.value)
                                                        }
                                                    />
                                                </label>
                                                <button type="submit" disabled={busy || !noteId}>
                                                    Link existing issue
                                                </button>
                                            </form>
                                        )}
                                    </>
                                )}
                            </Section>
                        )}
                        {info.manager && (
                            <>
                                {info.actions.some((a) => !a.archived) && (
                                    <Section
                                        title="Saved actions"
                                        about="Edit where each project's feedback goes, or archive an action to stop it being used."
                                    >
                                        {info.actions
                                            .filter((a) => !a.archived)
                                            .map((a) => (
                                                <div className="plugin-row" key={a.id}>
                                                    <span>
                                                        <strong>{a.name}</strong>
                                                        <br />
                                                        <small className="muted">
                                                            {projects?.find(
                                                                (p) => p.id === a.projectId
                                                            )?.name ?? a.projectId}
                                                            {" · "}
                                                            {
                                                                info.catalog.find(
                                                                    (p) =>
                                                                        p.id ===
                                                                        a.destination.provider
                                                                )?.name
                                                            }
                                                        </small>
                                                    </span>
                                                    <div className="row-actions">
                                                        <button
                                                            type="button"
                                                            disabled={busy}
                                                            aria-label={`Edit action ${a.name}`}
                                                            onClick={() => {
                                                                setEditingAction(a);
                                                                setActionName(a.name);
                                                                setConnectionId(a.connectionId);
                                                                setProject(a.projectId);
                                                                setDestination(
                                                                    destinationFields(a.destination)
                                                                );
                                                                setPreview(null);
                                                                setError("");
                                                                setNotice("");
                                                            }}
                                                        >
                                                            Edit
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={busy}
                                                            onClick={() => {
                                                                if (
                                                                    window.confirm(
                                                                        `Archive ${a.name}? Its workflows and queued deliveries will stop. Existing issue links stay on the feedback.`
                                                                    )
                                                                )
                                                                    void perform(
                                                                        () =>
                                                                            request(
                                                                                `/plugins/actions/${a.id}`,
                                                                                {
                                                                                    method: "DELETE",
                                                                                }
                                                                            ),
                                                                        "Action archived."
                                                                    );
                                                            }}
                                                        >
                                                            Archive
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                    </Section>
                                )}
                                <Section
                                    sectionRef={actionForm}
                                    title={
                                        editingAction
                                            ? "Edit action"
                                            : info.actions.some((a) => !a.archived)
                                              ? "Save another action"
                                              : "Save your first action"
                                    }
                                    about={
                                        <>
                                            Choose a connection, one Notato project and where its
                                            feedback should go. Feedback from other projects cannot
                                            use this action.
                                            {!info.connections.some((c) => !c.revoked) && (
                                                <>
                                                    {" "}
                                                    You need a connection first:{" "}
                                                    <button
                                                        type="button"
                                                        onClick={() => setTab("connections")}
                                                    >
                                                        add one
                                                    </button>
                                                    .
                                                </>
                                            )}
                                        </>
                                    }
                                >
                                    <form
                                        onSubmit={(e) => {
                                            e.preventDefault();
                                            void perform(
                                                async () => {
                                                    await request(
                                                        editingAction
                                                            ? `/plugins/actions/${editingAction.id}`
                                                            : "/plugins/actions",
                                                        json(editingAction ? "PATCH" : "POST", {
                                                            name: actionName,
                                                            connectionId,
                                                            projectId: project,
                                                            destination: buildDestination(),
                                                            ...(editingAction
                                                                ? {
                                                                      expectedUpdatedAt:
                                                                          editingAction.updatedAt,
                                                                  }
                                                                : {}),
                                                        })
                                                    );
                                                    resetAction();
                                                    setPreview(null);
                                                },
                                                editingAction
                                                    ? "Action updated. Queued deliveries were canceled. If the destination changed, review and re-enable personal annotation routing."
                                                    : "Action saved. You can run it manually or attach a workflow."
                                            );
                                        }}
                                    >
                                        <label>
                                            Action name
                                            <input
                                                required
                                                maxLength={120}
                                                value={actionName}
                                                disabled={busy || !ready}
                                                onChange={(e) => setActionName(e.target.value)}
                                            />
                                        </label>
                                        <label>
                                            Connection
                                            <select
                                                required
                                                value={connectionId}
                                                disabled={busy || !ready}
                                                onChange={(e) => {
                                                    setConnectionId(e.target.value);
                                                    setDestination(initial);
                                                }}
                                            >
                                                <option value="">Choose a connection</option>
                                                {info.connections
                                                    .filter((c) => !c.revoked)
                                                    .map((c) => (
                                                        <option key={c.id} value={c.id}>
                                                            {c.name}
                                                        </option>
                                                    ))}
                                            </select>
                                        </label>
                                        <label>
                                            Notato project
                                            <select
                                                required
                                                value={project}
                                                disabled={busy || !ready}
                                                onChange={(e) => setProject(e.target.value)}
                                            >
                                                <option value="">Choose a project</option>
                                                {projects?.map((p) => (
                                                    <option value={p.id} key={p.id}>
                                                        {p.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        {connection?.provider === "github" && (
                                            <>
                                                {field(
                                                    "repository",
                                                    "Repository (owner/name)",
                                                    true
                                                )}
                                                {field("labels", "Labels, separated by commas")}
                                                {field("assignee", "Assignee username")}
                                            </>
                                        )}
                                        {lookupError && <p className="muted">{lookupError}</p>}
                                        {connection?.provider === "azure" && (
                                            <>
                                                {field(
                                                    "organization",
                                                    "Azure DevOps organization",
                                                    true
                                                )}
                                                <button
                                                    type="button"
                                                    disabled={busy || !destination.organization}
                                                    onClick={() =>
                                                        void perform(async () => {
                                                            const r = await request<{
                                                                items: {
                                                                    id: string;
                                                                    name: string;
                                                                }[];
                                                            }>(
                                                                `/plugins/connections/${connectionId}/destinations?organization=${encodeURIComponent(destination.organization)}`
                                                            );
                                                            setChoices(r.items);
                                                        }, "Projects loaded. Choose a project below.")
                                                    }
                                                >
                                                    Find projects
                                                </button>
                                                {field("project", "Azure DevOps project", true)}
                                                <button
                                                    type="button"
                                                    disabled={
                                                        busy ||
                                                        !destination.organization ||
                                                        !destination.project
                                                    }
                                                    onClick={() =>
                                                        void perform(async () => {
                                                            const r = await request<{
                                                                items: {
                                                                    id: string;
                                                                    name: string;
                                                                }[];
                                                            }>(
                                                                `/plugins/connections/${connectionId}/destinations?organization=${encodeURIComponent(destination.organization)}&project=${encodeURIComponent(destination.project)}`
                                                            );
                                                            setWorkItemTypes(r.items);
                                                        }, "Work item types loaded.")
                                                    }
                                                >
                                                    Find work item types
                                                </button>
                                                {field("workItemType", "Work item type", true)}
                                                {field("area", "Area path")}
                                                {field("assignee", "Assignee email")}
                                            </>
                                        )}
                                        {connection?.provider === "slack" &&
                                            field("channel", "Channel ID", true)}
                                        {connection?.provider === "linear" && (
                                            <>
                                                {field("team", "Linear team ID", true)}
                                                {field("labels", "Label IDs, separated by commas")}
                                                {field("assignee", "Assignee ID")}
                                            </>
                                        )}
                                        {connection?.provider === "gitlab" && (
                                            <>
                                                {field(
                                                    "project",
                                                    "GitLab project ID or namespace/project",
                                                    true
                                                )}
                                                {field("labels", "Labels, separated by commas")}
                                                {field("assignee", "Assignee numeric user ID")}
                                            </>
                                        )}
                                        {editingAction && (
                                            <p className="muted">
                                                Saving cancels queued deliveries for this action.
                                                Its workflows, history and existing issue links are
                                                kept.
                                            </p>
                                        )}
                                        <div className="row-actions">
                                            {connection && (
                                                <button
                                                    type="submit"
                                                    className="primary"
                                                    disabled={busy || !ready}
                                                >
                                                    {editingAction ? "Save changes" : "Save action"}
                                                </button>
                                            )}
                                            {editingAction && (
                                                <button
                                                    type="button"
                                                    disabled={busy}
                                                    onClick={resetAction}
                                                >
                                                    Cancel
                                                </button>
                                            )}
                                        </div>
                                    </form>
                                </Section>
                            </>
                        )}
                    </>
                )}
                {ready && tab === "connections" && (
                    <>
                        <Section
                            title="Connections"
                            about="Your accounts on other tools, connected once for this workspace. Owners and admins manage them. Credentials are encrypted and never shown again."
                        >
                            {!info.connections.length && (
                                <p className="muted">
                                    {info.manager
                                        ? "Nothing connected yet. Add your first connection below."
                                        : "Nothing connected yet. Ask a workspace owner or admin to add one."}
                                </p>
                            )}
                            {info.connections.map((c) => {
                                const providerName = info.catalog.find(
                                    (p) => p.id === c.provider
                                )?.name;
                                const oauth = info.catalog.find((p) => p.id === c.provider)?.oauth;
                                return (
                                    <div className="plugin-row" key={c.id}>
                                        <span className="conn-info">
                                            <strong>{c.name}</strong>
                                            <small className="muted">
                                                {providerName}
                                                {c.revoked ? " · Revoked" : ""}
                                            </small>
                                            {!c.revoked && (
                                                <small
                                                    className={`conn-health ${c.health?.status ?? "unchecked"}`}
                                                >
                                                    {c.health
                                                        ? `${c.health.status}: ${c.health.message} · checked ${new Date(c.health.checkedAt).toLocaleString()}`
                                                        : "Not checked yet"}
                                                </small>
                                            )}
                                        </span>
                                        {info.manager && (
                                            <div className="row-actions">
                                                {!c.revoked && (
                                                    <button
                                                        type="button"
                                                        disabled={busy || !ready}
                                                        onClick={() =>
                                                            void perform(
                                                                () =>
                                                                    request(
                                                                        `/plugins/connections/${c.id}/check`,
                                                                        json("POST", {})
                                                                    ),
                                                                "Connection check completed."
                                                            )
                                                        }
                                                    >
                                                        Check
                                                    </button>
                                                )}
                                                <RowMenu>
                                                    {oauth && ready && !c.revoked && (
                                                        <a
                                                            href={`/plugins/oauth/${c.provider}/start?connection=${encodeURIComponent(c.id)}`}
                                                        >
                                                            Reconnect with {providerName}
                                                        </a>
                                                    )}
                                                    <button
                                                        type="button"
                                                        disabled={busy || !ready}
                                                        onClick={() => {
                                                            setReconnecting(c.id);
                                                            setProvider(c.provider);
                                                            setName(c.name);
                                                            setCredential("");
                                                            setSigning("");
                                                            setInstallation("");
                                                        }}
                                                    >
                                                        Replace credential
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={busy}
                                                        onClick={() => {
                                                            const name = window.prompt(
                                                                "Connection name",
                                                                c.name
                                                            );
                                                            if (name?.trim())
                                                                void perform(
                                                                    () =>
                                                                        request(
                                                                            `/plugins/connections/${c.id}`,
                                                                            json("PATCH", {
                                                                                name: name.trim(),
                                                                            })
                                                                        ),
                                                                    "Connection renamed."
                                                                );
                                                        }}
                                                    >
                                                        Rename
                                                    </button>
                                                    {!c.revoked && (
                                                        <button
                                                            type="button"
                                                            className="danger"
                                                            disabled={busy}
                                                            onClick={() => {
                                                                if (
                                                                    window.confirm(
                                                                        `Revoke ${c.name}? Queued actions using it will stop.`
                                                                    )
                                                                )
                                                                    void perform(
                                                                        () =>
                                                                            request(
                                                                                `/plugins/connections/${c.id}`,
                                                                                { method: "DELETE" }
                                                                            ),
                                                                        "Connection revoked."
                                                                    );
                                                            }}
                                                        >
                                                            Revoke
                                                        </button>
                                                    )}
                                                </RowMenu>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </Section>
                        {info.manager && (
                            <Section
                                sectionRef={connectionForm}
                                title={
                                    reconnecting
                                        ? "Reconnect an existing connection"
                                        : "Add a connection"
                                }
                                about="Choose the tool, follow the short steps, then paste what it gives you."
                            >
                                {reconnecting && (
                                    <p>
                                        Reconnecting preserves this connection's saved actions and
                                        workflows. Use the intended provider account.{" "}
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setReconnecting("");
                                                setCredential("");
                                                setName("");
                                            }}
                                        >
                                            Cancel reconnect
                                        </button>
                                    </p>
                                )}
                                <form
                                    onSubmit={(e) => {
                                        e.preventDefault();
                                        void perform(
                                            async () => {
                                                const saved = await request<{ id: string }>(
                                                    reconnecting
                                                        ? `/plugins/connections/${reconnecting}/reconnect`
                                                        : "/plugins/connections",
                                                    json("POST", {
                                                        name,
                                                        provider,
                                                        credential,
                                                        ...(installation && provider === "github"
                                                            ? { installationId: installation }
                                                            : {}),
                                                        ...(provider === "webhook"
                                                            ? { signingSecret: signing }
                                                            : {}),
                                                    })
                                                );
                                                setName("");
                                                setCredential("");
                                                setInstallation("");
                                                setSigning("");
                                                setReconnecting("");
                                                setConnectionId(saved.id);
                                                setTab(reconnecting ? "connections" : "actions");
                                            },
                                            reconnecting
                                                ? "Connection reconnected. Review and re-enable any personal annotation routing; it was switched off because the destination may have changed."
                                                : "Connection saved. Choose a project and destination for your action."
                                        );
                                    }}
                                >
                                    <label>
                                        Plugin
                                        <select
                                            value={provider}
                                            disabled={busy || !ready || Boolean(reconnecting)}
                                            onChange={(e) => {
                                                setProvider(e.target.value as Provider);
                                                setCredential("");
                                                setSigning("");
                                            }}
                                        >
                                            {info.catalog.map((p) => (
                                                <option key={p.id} value={p.id}>
                                                    {p.name}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <p className="muted">
                                        {info.catalog.find((p) => p.id === provider)?.description}
                                    </p>
                                    <ol className="plugin-setup">
                                        {providerGuide(
                                            provider,
                                            Boolean(info.githubInstallUrl)
                                        ).steps.map((step, index) => (
                                            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of steps
                                            <li key={index}>{step}</li>
                                        ))}
                                    </ol>
                                    {info.catalog.find((p) => p.id === provider)?.oauth && (
                                        <p>
                                            <a
                                                className="button"
                                                href={`/plugins/oauth/${provider}/start${reconnecting ? `?connection=${encodeURIComponent(reconnecting)}` : ""}`}
                                            >
                                                {reconnecting ? "Reconnect" : "Connect"} with{" "}
                                                {info.catalog.find((p) => p.id === provider)?.name}
                                            </a>
                                            <span className="muted">
                                                {" "}
                                                — or use an existing credential below.
                                            </span>
                                        </p>
                                    )}
                                    <label>
                                        Connection name
                                        <input
                                            required
                                            maxLength={120}
                                            value={name}
                                            disabled={busy || !ready}
                                            onChange={(e) => setName(e.target.value)}
                                        />
                                    </label>
                                    <label>
                                        {providerGuide(provider, false).credential}
                                        <input
                                            type="password"
                                            required
                                            maxLength={16000}
                                            autoComplete="off"
                                            value={credential}
                                            disabled={busy || !ready}
                                            onChange={(e) => setCredential(e.target.value)}
                                        />
                                    </label>
                                    {provider === "github" && info.githubInstallUrl && (
                                        <details>
                                            <summary>
                                                Use the Notato GitHub App instead (advanced)
                                            </summary>
                                            <p className="muted">
                                                <a
                                                    href={info.githubInstallUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    Install the GitHub App
                                                </a>{" "}
                                                on only the repositories you want, then paste the
                                                installation ID from the page's address and your
                                                token above. Notato then uses the App for each
                                                delivery.
                                            </p>
                                            <label>
                                                GitHub App installation ID
                                                <input
                                                    value={installation}
                                                    inputMode="numeric"
                                                    disabled={busy}
                                                    onChange={(e) =>
                                                        setInstallation(e.target.value)
                                                    }
                                                />
                                            </label>
                                        </details>
                                    )}
                                    {provider === "webhook" && (
                                        <label>
                                            Webhook signing secret
                                            <input
                                                type={secretShown ? "text" : "password"}
                                                required
                                                minLength={32}
                                                maxLength={200}
                                                value={signing}
                                                disabled={busy}
                                                autoComplete="off"
                                                onChange={(e) => setSigning(e.target.value)}
                                            />
                                            <small>
                                                Use the same secret in the receiving service to
                                                verify signatures.{" "}
                                                <button
                                                    type="button"
                                                    disabled={busy}
                                                    onClick={() => {
                                                        setSigning(generateSecret());
                                                        setSecretShown(true);
                                                    }}
                                                >
                                                    Generate one
                                                </button>
                                            </small>
                                        </label>
                                    )}
                                    {error && <p className="error">{error}</p>}
                                    <button
                                        type="submit"
                                        className="primary"
                                        disabled={busy || !ready}
                                    >
                                        {reconnecting
                                            ? "Save replacement credential"
                                            : "Add connection"}
                                    </button>
                                </form>
                            </Section>
                        )}
                    </>
                )}
                {ready && tab === "workflows" && (
                    <>
                        <Section
                            title="Workflows"
                            about={`Run a saved action for you when something happens. ${info.used.toLocaleString()} of ${info.limits.actions.toLocaleString()} automatic actions used this month; retries do not count twice.`}
                        >
                            <div className="workflow-audience" role="note">
                                <strong>Combine conditions with AND or OR</strong>
                                <p>
                                    Use “Any condition (OR)” for Shared OR tagged #xyz. Use “All
                                    conditions (AND)” for Shared AND tagged #xyz. Personal
                                    annotations need your opt-in and a matching tag, and stay
                                    personal in Notato.
                                </p>
                            </div>
                            {!info.limits.workflows && (
                                <p>Run actions manually or configure workflows to automate them.</p>
                            )}
                            {info.workflows.map((w) => (
                                <div className="plugin-row" key={w.id}>
                                    <div className="workflow-configuration">
                                        <strong>{w.name}</strong> ·{" "}
                                        {w.enabled ? "Enabled" : "Paused"}
                                        <p className="muted small">
                                            {workflowTriggers[w.trigger]}
                                            {w.trigger === "daily_digest" &&
                                                ` · ${String(w.hourUtc).padStart(2, "0")}:00 UTC`}
                                            {w.trigger === "unanswered" &&
                                                ` · After ${w.delayHours} hours`}
                                        </p>
                                        <WorkflowScope
                                            destination={destinationLabel(
                                                info.actions.find((a) => a.id === w.actionId),
                                                info.connections
                                            )}
                                            project={
                                                projects?.find(
                                                    (p) =>
                                                        p.id ===
                                                        info.actions.find(
                                                            (a) => a.id === w.actionId
                                                        )?.projectId
                                                )?.name ?? "Saved action’s project"
                                            }
                                            severity={w.severity}
                                            intent={w.intent}
                                            tag={w.tag}
                                            conditions={w.conditions}
                                            includePersonal={w.includePersonal}
                                            own={w.creator === me.username}
                                        />
                                    </div>
                                    {info.manager && (
                                        <div className="row-actions">
                                            <button
                                                type="button"
                                                disabled={
                                                    busy ||
                                                    Boolean(
                                                        w.includePersonal &&
                                                            w.creator !== me.username
                                                    )
                                                }
                                                aria-label={`Edit workflow ${w.name}`}
                                                title={
                                                    w.includePersonal && w.creator !== me.username
                                                        ? "Only the creator can edit personal annotation routing"
                                                        : undefined
                                                }
                                                onClick={() => {
                                                    setEditingWorkflow(w);
                                                    setWorkflowName(w.name);
                                                    setWorkflowActionId(w.actionId);
                                                    setWorkflowEnabled(w.enabled);
                                                    setConditions(workflowConditions(w));
                                                    setIncludePersonal(w.includePersonal ?? false);
                                                    setTrigger(w.trigger);
                                                    setHour(w.hourUtc);
                                                    setDelay(w.delayHours);
                                                    setError("");
                                                    setNotice("");
                                                }}
                                            >
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                disabled={
                                                    busy ||
                                                    (!w.enabled &&
                                                        (!info.limits.workflows ||
                                                            Boolean(
                                                                w.includePersonal &&
                                                                    w.creator !== me.username
                                                            )))
                                                }
                                                onClick={() =>
                                                    void perform(
                                                        () =>
                                                            request(
                                                                `/plugins/workflows/${w.id}`,
                                                                json("POST", {
                                                                    name: w.name,
                                                                    actionId: w.actionId,
                                                                    enabled: !w.enabled,
                                                                    trigger: w.trigger,
                                                                    hourUtc: w.hourUtc,
                                                                    delayHours: w.delayHours,
                                                                    ...(w.tag
                                                                        ? { tag: w.tag }
                                                                        : {}),
                                                                    includePersonal:
                                                                        w.includePersonal ?? false,
                                                                    ...(w.conditions
                                                                        ? {
                                                                              conditions:
                                                                                  w.conditions,
                                                                          }
                                                                        : {}),
                                                                    expectedUpdatedAt:
                                                                        w.updatedAt ?? w.createdAt,
                                                                    ...(w.severity
                                                                        ? { severity: w.severity }
                                                                        : {}),
                                                                    ...(w.intent
                                                                        ? { intent: w.intent }
                                                                        : {}),
                                                                })
                                                            ),
                                                        w.enabled
                                                            ? "Workflow paused."
                                                            : "Workflow enabled."
                                                    )
                                                }
                                            >
                                                {w.enabled ? "Pause" : "Enable"}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </Section>
                        {info.manager && (info.limits.workflows > 0 || editingWorkflow) && (
                            <Section
                                sectionRef={workflowForm}
                                title={
                                    editingWorkflow ? "Edit workflow" : "Automate a saved action"
                                }
                                about="Choose when to check, combine conditions with AND or OR, then run a saved action."
                            >
                                <form
                                    onSubmit={(e) => {
                                        e.preventDefault();
                                        void perform(
                                            async () => {
                                                await request(
                                                    editingWorkflow
                                                        ? `/plugins/workflows/${editingWorkflow.id}`
                                                        : "/plugins/workflows",
                                                    json("POST", {
                                                        name: workflowName,
                                                        actionId: workflowActionId,
                                                        enabled: workflowEnabled,
                                                        conditions,
                                                        includePersonal,
                                                        ...(editingWorkflow
                                                            ? {
                                                                  expectedUpdatedAt:
                                                                      editingWorkflow.updatedAt ??
                                                                      editingWorkflow.createdAt,
                                                              }
                                                            : {}),
                                                        trigger,
                                                        hourUtc: hour,
                                                        delayHours: delay,
                                                    })
                                                );
                                                resetWorkflow();
                                            },
                                            editingWorkflow
                                                ? "Workflow updated. Previously queued deliveries were canceled."
                                                : "Workflow enabled for annotations matching its audience, project and conditions."
                                        );
                                    }}
                                >
                                    <label>
                                        Workflow name
                                        <input
                                            required
                                            value={workflowName}
                                            maxLength={120}
                                            disabled={busy}
                                            onChange={(e) => setWorkflowName(e.target.value)}
                                        />
                                    </label>
                                    {editingWorkflow && (
                                        <label className="check">
                                            <input
                                                type="checkbox"
                                                checked={workflowEnabled}
                                                disabled={
                                                    busy ||
                                                    (!workflowEnabled && !info.limits.workflows)
                                                }
                                                onChange={(e) =>
                                                    setWorkflowEnabled(e.target.checked)
                                                }
                                            />
                                            Run automatically
                                        </label>
                                    )}
                                    <label>
                                        When
                                        <select
                                            value={trigger}
                                            disabled={busy}
                                            onChange={(e) =>
                                                setTrigger(e.target.value as Workflow["trigger"])
                                            }
                                        >
                                            {Object.entries(workflowTriggers).map(
                                                ([value, label]) => (
                                                    <option key={value} value={value}>
                                                        {label}
                                                    </option>
                                                )
                                            )}
                                        </select>
                                    </label>
                                    {trigger === "daily_digest" && (
                                        <label>
                                            Hour of day (UTC)
                                            <input
                                                type="number"
                                                min={0}
                                                max={23}
                                                required
                                                value={hour}
                                                onChange={(e) => setHour(Number(e.target.value))}
                                            />
                                        </label>
                                    )}
                                    {trigger === "unanswered" && (
                                        <label>
                                            Wait (hours)
                                            <input
                                                type="number"
                                                min={1}
                                                max={168}
                                                required
                                                value={delay}
                                                onChange={(e) => setDelay(Number(e.target.value))}
                                            />
                                        </label>
                                    )}
                                    <WorkflowRules
                                        value={conditions}
                                        onChange={setConditions}
                                        busy={busy}
                                    />
                                    <label className="check">
                                        <input
                                            type="checkbox"
                                            checked={includePersonal}
                                            disabled={
                                                busy ||
                                                (!includePersonal &&
                                                    !workflowTags({ conditions }).length) ||
                                                Boolean(
                                                    editingWorkflow &&
                                                        editingWorkflow.creator !== me.username
                                                )
                                            }
                                            onChange={(e) => setIncludePersonal(e.target.checked)}
                                        />
                                        Include my personal annotations with a matching tag
                                    </label>
                                    <p className="muted small">
                                        Personal annotations require a tag condition and your
                                        opt-in, even with OR. Other people’s personal annotations
                                        are excluded.
                                    </p>
                                    {includePersonal && (
                                        <div className="workflow-audience" role="note">
                                            <strong>
                                                Send my tagged personal annotations automatically
                                            </strong>
                                            <p>
                                                This sends matching annotations you created to the
                                                saved action’s destination. They stay personal
                                                inside Notato. Other people’s personal annotations
                                                are excluded. Changing the destination or
                                                reconnecting the tool switches this opt-in off.
                                            </p>
                                        </div>
                                    )}
                                    {editingWorkflow && editingWorkflow.creator !== me.username && (
                                        <p className="muted small">
                                            Only this workflow’s creator can opt in to personal
                                            annotations.
                                        </p>
                                    )}
                                    <label>
                                        Then run saved action
                                        <select
                                            required
                                            value={workflowActionId}
                                            disabled={busy}
                                            onChange={(e) => setWorkflowActionId(e.target.value)}
                                        >
                                            <option value="">Choose an action</option>
                                            {info.actions
                                                .filter((a) => !a.archived)
                                                .map((a) => (
                                                    <option key={a.id} value={a.id}>
                                                        {a.name}
                                                    </option>
                                                ))}
                                        </select>
                                    </label>
                                    <WorkflowScope
                                        destination={destinationLabel(
                                            info.actions.find((a) => a.id === workflowActionId),
                                            info.connections
                                        )}
                                        project={
                                            projects?.find(
                                                (p) =>
                                                    p.id ===
                                                    info.actions.find(
                                                        (a) => a.id === workflowActionId
                                                    )?.projectId
                                            )?.name
                                        }
                                        conditions={conditions}
                                        includePersonal={includePersonal}
                                    />
                                    <p className="muted small">
                                        Drafts and feedback hidden from agents are also excluded.
                                        Digests and reminders use Teams, Slack or a webhook action.
                                    </p>
                                    {editingWorkflow && (
                                        <p className="muted">
                                            Saving cancels this workflow's queued deliveries. Its
                                            history is kept.
                                        </p>
                                    )}
                                    <div className="row-actions">
                                        <button
                                            type="submit"
                                            className="primary"
                                            disabled={busy || !ready}
                                        >
                                            {editingWorkflow ? "Save changes" : "Enable workflow"}
                                        </button>
                                        {editingWorkflow && (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={resetWorkflow}
                                            >
                                                Cancel
                                            </button>
                                        )}
                                    </div>
                                </form>
                            </Section>
                        )}
                    </>
                )}
                {ready && tab === "history" && (
                    <Section
                        title="History"
                        about="Everything Notato has sent. An uncertain delivery needs a destination check before it can be retried."
                    >
                        {!info.history.length && (
                            <p>
                                No deliveries have been queued yet. For automatic actions, check
                                that the workflow is enabled and the annotation matches its
                                audience, project and conditions.
                            </p>
                        )}
                        {info.history.map((j) => (
                            <article className="plugin-execution" key={j.id}>
                                <strong>
                                    {info.actions.find((a) => a.id === j.actionId)?.name ??
                                        "Action"}
                                </strong>
                                <span>
                                    {j.status} · {j.workflowId ? "Automatic" : "Manual"} ·{" "}
                                    {j.personalActor ? "Personal · " : ""}
                                    {new Date(j.createdAt).toLocaleString()}
                                </span>
                                {j.error && <p>{j.error}</p>}
                                {j.result?.url && (
                                    <a href={j.result.url} target="_blank" rel="noreferrer">
                                        Open result
                                    </a>
                                )}
                                {["queued", "paused"].includes(j.status) &&
                                    (info.manager || j.actor === me.username) && (
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() =>
                                                void perform(
                                                    () =>
                                                        request(
                                                            `/plugins/jobs/${j.id}/cancel`,
                                                            json("POST", {})
                                                        ),
                                                    "Queued delivery canceled."
                                                )
                                            }
                                        >
                                            Cancel delivery
                                        </button>
                                    )}
                                {j.status === "review" && info.manager && (
                                    <ReviewDelivery
                                        job={j}
                                        issue={["github", "azure", "linear", "gitlab"].includes(
                                            info.actions.find((a) => a.id === j.actionId)
                                                ?.destination.provider ?? ""
                                        )}
                                        busy={busy}
                                        onReview={(delivered, url) =>
                                            perform(
                                                () =>
                                                    request(
                                                        `/plugins/jobs/${j.id}/review`,
                                                        json("POST", {
                                                            delivered,
                                                            confirmed: true,
                                                            ...(url ? { url } : {}),
                                                        })
                                                    ),
                                                delivered
                                                    ? "Delivery recorded."
                                                    : "Delivery queued for a confirmed retry."
                                            )
                                        }
                                    />
                                )}
                            </article>
                        ))}
                    </Section>
                )}
            </div>
        </div>
    );
}

function ReviewDelivery({
    job,
    issue,
    busy,
    onReview,
}: {
    job: Job;
    issue: boolean;
    busy: boolean;
    onReview: (delivered: boolean, url?: string) => Promise<void>;
}) {
    const [confirmed, setConfirmed] = useState(false);
    const [url, setUrl] = useState("");
    return (
        <div>
            <label>
                <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                />
                I checked the destination for this delivery.
            </label>
            {issue && (
                <label>
                    Existing issue link (if it was created)
                    <input
                        type="url"
                        value={url}
                        maxLength={2000}
                        disabled={busy}
                        onChange={(e) => setUrl(e.target.value)}
                    />
                </label>
            )}
            <div className="plugin-tabs">
                <button
                    type="button"
                    disabled={busy || !confirmed || (issue && !url)}
                    onClick={() => void onReview(true, url)}
                >
                    It was delivered
                </button>
                <button
                    type="button"
                    disabled={busy || !confirmed}
                    onClick={() => void onReview(false)}
                >
                    Confirmed not delivered — retry
                </button>
            </div>
            <small>Delivery reference: {job.id}</small>
        </div>
    );
}
