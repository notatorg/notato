import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
    ApiError,
    type CreatedProject,
    createProject,
    type Me,
    type ProjectSummary,
} from "./api.ts";
import { projectIdProblem, suggestProjectId } from "./model.ts";
import { markMadeHere } from "./storage.ts";
import { Modal } from "./ui.tsx";

interface Props {
    me: Me;
    projects: ProjectSummary[];
    /** An id to start from (a link to a project this server does not have). */
    initialId?: string;
    onClose(): void;
    onCreated(made: CreatedProject): void;
    /** The server already has the id, which the list here did not: it is out of date. */
    onTaken?: () => void;
}

/** Name a project and choose its id, which apps send to. The id follows the name until it is edited. */
export function NewProject({ me, projects, initialId, onClose, onCreated, onTaken }: Props) {
    const id = useId();
    const [name, setName] = useState("");
    const [projectId, setProjectId] = useState(initialId ?? "");
    /** The id was typed (or given), so the name no longer suggests one. */
    const [ownId, setOwnId] = useState(Boolean(initialId));
    const [tried, setTried] = useState(false);
    const [busy, setBusy] = useState(false);
    /** The server's refusal of this id (it is taken), kept until the id changes. */
    const [taken, setTaken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const first = useRef<HTMLInputElement>(null);
    useEffect(() => first.current?.focus(), []);

    const exists = projects.some((p) => p.id === projectId);
    const problem =
        projectIdProblem(projectId) ??
        (exists || taken === projectId ? `There is already a project “${projectId}”.` : null);
    // A wrong character is worth saying at once; an empty box only once they try to go on.
    const shownProblem = problem && (tried || projectId) ? problem : null;

    const submit = async (ev: FormEvent) => {
        ev.preventDefault();
        setTried(true);
        if (problem) return;
        setBusy(true);
        setError(null);
        try {
            const made = await createProject(projectId, name.trim() || undefined);
            markMadeHere(made.project.id);
            onCreated(made);
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
                setTaken(projectId);
                onTaken?.();
            } else setError(e instanceof Error ? e.message : "Could not create the project.");
            setBusy(false);
        }
    };

    return (
        <Modal title="New project" size="narrow" onClose={onClose} onSubmit={submit} noValidate>
            <div className="modal-body">
                <p className="muted small">
                    {me.mode === "serve"
                        ? "Apps can only send notes to a project that exists here. It comes with a token for its first app, shown once."
                        : "On this computer a project is also made by the first note sent to it. Making it here lets you name it and see how to connect an app."}
                </p>
                <div className="field">
                    <label htmlFor={`${id}-name`}>Name</label>
                    <input
                        ref={first}
                        id={`${id}-name`}
                        value={name}
                        onChange={(e) => {
                            setName(e.target.value);
                            if (!ownId) setProjectId(suggestProjectId(e.target.value));
                        }}
                        placeholder="Checkout web"
                        maxLength={200}
                        autoComplete="off"
                    />
                    <span className="field-hint">What people call it on this board.</span>
                </div>
                <div className="field">
                    <label htmlFor={`${id}-id`}>Id</label>
                    <input
                        id={`${id}-id`}
                        value={projectId}
                        onChange={(e) => {
                            setProjectId(e.target.value);
                            // Emptied, it follows the name again from the next change to that.
                            setOwnId(e.target.value !== "");
                        }}
                        placeholder="checkout-web"
                        maxLength={128}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        className="mono"
                        aria-invalid={shownProblem ? true : undefined}
                        aria-describedby={`${id}-id-hint`}
                    />
                    <span
                        id={`${id}-id-hint`}
                        className={shownProblem ? "field-hint bad" : "field-hint"}
                        role={shownProblem ? "alert" : undefined}
                    >
                        {shownProblem ??
                            "What apps send to, as their project setting. Letters, digits and _ . @ -. It cannot be changed later."}
                    </span>
                </div>
            </div>
            {error ? (
                <div className="modal-status">
                    <p className="error small" role="alert">
                        {error}
                    </p>
                </div>
            ) : null}
            <footer className="modal-foot">
                <span className="grow" />
                <button type="button" onClick={onClose}>
                    Cancel
                </button>
                <button type="submit" className="primary" disabled={busy}>
                    Create project
                </button>
            </footer>
        </Modal>
    );
}
