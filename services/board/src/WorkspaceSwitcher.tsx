import { Icon, Modal, ProjectMark } from "@notato/board";
import { useState } from "react";
import { type BillingInfo, createWorkspace, getBilling, type Me } from "./api.ts";
import { whoIs } from "./Role.tsx";

/** Workspaces contain projects; creation belongs to the account's switcher. */
export function WorkspaceSwitcher({
    me,
    onChange,
    disabled = false,
}: {
    me: Me;
    onChange(id: string): unknown;
    disabled?: boolean;
}) {
    const [dialog, setDialog] = useState<"switch" | "create" | null>(null);
    const [query, setQuery] = useState("");
    const [name, setName] = useState("");
    const [plan, setPlan] = useState<"free" | "plus" | "pro" | "team">("pro");
    const [billing, setBilling] = useState<BillingInfo | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    if (!me.workspace) return null;
    const close = () => {
        if (!busy) {
            setDialog(null);
            setError(null);
        }
    };
    const create = () => {
        setError(null);
        setName("");
        setBilling(null);
        setDialog("create");
        getBilling().then(
            (b) => {
                setBilling(b);
                setPlan(b.selfServicePlans || (b.workspacePlans && b.enabled) ? "pro" : "free");
            },
            (e: Error) => setError(e.message)
        );
    };
    const shown = (me.workspaces ?? [me.workspace]).filter((w) =>
        w.name.toLowerCase().includes(query.trim().toLowerCase())
    );
    return (
        <>
            <div className="project-context workspace-context">
                <button
                    type="button"
                    className="project-current"
                    aria-label="Switch workspace"
                    aria-haspopup="dialog"
                    disabled={disabled}
                    onClick={() => {
                        setQuery("");
                        setError(null);
                        setDialog("switch");
                    }}
                >
                    <ProjectMark name={me.workspace.name} active />
                    <span className="project-current-text">
                        <span className="project-current-meta">
                            {whoIs(me).solo && whoIs(me).owner
                                ? "Personal workspace"
                                : `Workspace · ${whoIs(me).label}`}
                        </span>
                        <span className="side-name">{me.workspace.name}</span>
                    </span>
                    <Icon name="chevrons" size={14} />
                </button>
            </div>
            {dialog === "switch" ? (
                <Modal title="Switch workspace" onClose={close}>
                    <div className="modal-body">
                        {(me.workspaces?.length ?? 0) >= 8 ? (
                            <input
                                type="search"
                                aria-label="Find a workspace"
                                placeholder="Find a workspace"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                        ) : null}
                        <ul className="project-choices">
                            {shown.map((w) => (
                                <li key={w.id}>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        className={`side-project workspace-choice${w.id === me.workspace?.id ? " active" : ""}`}
                                        onClick={async () => {
                                            setBusy(true);
                                            setError(null);
                                            try {
                                                await onChange(w.id);
                                                setDialog(null);
                                            } catch (e) {
                                                setError(
                                                    e instanceof Error
                                                        ? e.message
                                                        : "Could not switch workspace"
                                                );
                                            } finally {
                                                setBusy(false);
                                            }
                                        }}
                                    >
                                        <ProjectMark
                                            name={w.name}
                                            active={w.id === me.workspace?.id}
                                        />
                                        <span className="project-choice-text">
                                            <span className="side-name">{w.name}</span>
                                            <span className="project-current-meta">
                                                {w.role}
                                                {w.id === me.workspace?.id
                                                    ? " · Current workspace"
                                                    : ""}
                                            </span>
                                        </span>
                                        {w.id === me.workspace?.id ? (
                                            <Icon name="check" size={16} />
                                        ) : null}
                                    </button>
                                </li>
                            ))}
                            {!shown.length ? (
                                <li className="muted">No matching workspaces</li>
                            ) : null}
                        </ul>
                        {error ? (
                            <p className="error" role="alert">
                                {error}
                            </p>
                        ) : null}
                        {me.workspace.recoveryRequired ? (
                            <p className="muted small">
                                Restore or clean up this workspace before creating another.
                            </p>
                        ) : null}
                    </div>
                    <footer className="modal-foot">
                        <button type="button" disabled={busy} onClick={close}>
                            Cancel
                        </button>
                        <span className="grow" />
                        {me.identity ? (
                            <button
                                type="button"
                                className="primary"
                                disabled={busy || me.workspace.recoveryRequired}
                                onClick={create}
                            >
                                <Icon name="plus" size={15} />
                                New workspace
                            </button>
                        ) : null}
                    </footer>
                </Modal>
            ) : null}
            {dialog === "create" ? (
                <Modal
                    title="New workspace"
                    onClose={close}
                    onSubmit={async (e) => {
                        e.preventDefault();
                        if (
                            busy ||
                            !billing ||
                            !name.trim() ||
                            (plan === "free" && me.ownedFreeWorkspace)
                        )
                            return;
                        setBusy(true);
                        setError(null);
                        try {
                            await createWorkspace(
                                name.trim(),
                                billing.selfServicePlans || billing.workspacePlans
                                    ? plan
                                    : undefined
                            );
                            window.location.hash = plan === "free" ? "#/" : "#/x/workspace";
                            window.location.reload();
                        } catch (e) {
                            setError(e instanceof Error ? e.message : "Could not create workspace");
                            setBusy(false);
                        }
                    }}
                >
                    <div className="modal-body">
                        <p className="muted">
                            Each workspace has its own projects, people and settings.
                        </p>
                        {me.ownedFreeWorkspace ? (
                            <p className="muted small">
                                Your Free workspace is {me.ownedFreeWorkspace.name}. Each account
                                can own one Free workspace, even when it also owns paid workspaces.
                            </p>
                        ) : null}
                        <label className="field">
                            Workspace name
                            <input
                                value={name}
                                maxLength={200}
                                required
                                disabled={busy}
                                onChange={(e) => setName(e.target.value)}
                                autoComplete="off"
                            />
                        </label>
                        {billing?.selfServicePlans ||
                        (billing?.workspacePlans && billing.enabled) ? (
                            <label className="field">
                                Workspace plan
                                <select
                                    aria-label="Workspace plan"
                                    value={plan}
                                    disabled={busy}
                                    onChange={(e) => setPlan(e.target.value as typeof plan)}
                                >
                                    <option value="free" disabled={Boolean(me.ownedFreeWorkspace)}>
                                        Free — private, 1 project
                                    </option>
                                    <option value="plus">
                                        Plus — private, 5 projects, 1 person
                                    </option>
                                    <option value="pro">
                                        Pro — 10 projects, 3 people included
                                    </option>
                                    <option value="team">
                                        Team — 50 projects, 10 people included
                                    </option>
                                </select>
                            </label>
                        ) : null}
                        {billing?.selfServicePlans ? (
                            <p className="muted small">Test plans: no payment is taken.</p>
                        ) : billing?.workspacePlans && plan !== "free" ? (
                            <p className="muted small">
                                Choose and pay for this workspace's subscription after creation.
                                Access starts after payment.
                            </p>
                        ) : null}
                        {!billing && !error ? <p role="status">Loading available plans…</p> : null}
                        {error ? (
                            <p className="error" role="alert">
                                {error}
                            </p>
                        ) : null}
                    </div>
                    <footer className="modal-foot">
                        <button type="button" disabled={busy} onClick={close}>
                            Cancel
                        </button>
                        <span className="grow" />
                        <button
                            type="submit"
                            className="primary"
                            disabled={
                                busy ||
                                !billing ||
                                !name.trim() ||
                                (plan === "free" && Boolean(me.ownedFreeWorkspace))
                            }
                        >
                            {busy ? "Creating…" : "Create workspace"}
                        </button>
                    </footer>
                </Modal>
            ) : null}
        </>
    );
}
