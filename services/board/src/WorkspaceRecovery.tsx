import { go, Logo, Modal } from "@notato/board";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    cleanupRecovery,
    completeRecovery,
    deleteRecoveryWorkspace,
    getRecovery,
    type Me,
    portalBilling,
    type RecoveryInfo,
    selectWorkspace,
    tokenLabel,
    tokenPurpose,
} from "./api.ts";
import { Billing } from "./Billing.tsx";
import { RecoveryArchive } from "./RecoveryArchive.tsx";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";

const size = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const STEPS = ["Workspace", "Projects and storage", "People", "Tokens", "Activate Free"];
type Kind = "project" | "note" | "token" | "member";
type Item = { id: string; name: string; detail: string };
type Removal = { kind: Kind; items: Item[] } | { kind: "workspace"; id: string; name: string };
const consequences: Record<Kind, string> = {
    project:
        "Permanently delete these projects and all their notes, remove unreferenced screenshots and revoke their tokens.",
    note: "Permanently delete these notes and remove unreferenced screenshots. This does not reset the monthly note allowance.",
    member: "Remove these people's access to this workspace. Their accounts and other workspaces are kept.",
    token: "Revoke these tokens immediately. Any apps and agents using them will be disconnected.",
};

/** A restricted workspace never mounts the regular shell, note lists or event streams. */
export function WorkspaceRecovery({
    me,
    onChanged,
    onSignOut,
}: {
    me: Me;
    onChanged(): void;
    onSignOut(): void;
}) {
    const [info, setInfo] = useState<RecoveryInfo | null>(null);
    const [step, setStep] = useState(0),
        [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [project, setProject] = useState("");
    const [before, setBefore] = useState<number>();
    const [removal, setRemoval] = useState<Removal | null>(null);
    const [confirmation, setConfirmation] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [selected, setSelected] = useState<Partial<Record<Kind, string[]>>>({});
    const [progress, setProgress] = useState("");
    const loads = useRef(0);
    const load = useCallback(async () => {
        const current = ++loads.current;
        const next = await getRecovery(project || undefined, before);
        if (current === loads.current) setInfo(next);
    }, [project, before]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: payment recovery changes session access and must refresh this inventory.
    useEffect(() => {
        load().catch((e: Error) => setError(e.message));
    }, [load, me.workspace?.recoveryRequired]);
    const run = async (action: () => Promise<unknown>, reload = true) => {
        setBusy(true);
        loads.current += 1;
        setError(null);
        try {
            await action();
            if (reload) await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not update workspace");
        } finally {
            setBusy(false);
            setProgress("");
        }
    };
    const switchTo = async (id: string) => {
        await selectWorkspace(id);
        go("#/", true);
        onChanged();
    };
    const openRemoval = (item: Removal) => {
        setRemoval(item);
        setConfirmation("");
        setPassword("");
        setError(null);
    };
    const changePage = (nextProject: string, nextBefore?: number) => {
        setProject(nextProject);
        setBefore(nextBefore);
        setSelected((s) => ({ ...s, note: [] }));
    };
    const locked = Boolean(me.workspace?.recoveryRequired || info?.locked);
    const requirements = info?.requirements ?? [];
    const countText = (r: (typeof requirements)[number]) =>
        r.current === undefined
            ? null
            : r.id === "storage"
              ? `${size(r.current)} / ${size(r.limit ?? 0)}`
              : `${r.current} / ${r.limit}`;
    const status = (index: number) => {
        const list = index === 4 ? requirements : requirements.filter((r) => r.step === index);
        const count = list.filter((r) => !r.met).length;
        return { count, text: count ? `${count} to resolve` : "Ready" };
    };
    const list = (kind: Kind, items: Item[], group?: string) => (
        <CleanupList
            kind={kind}
            items={items}
            group={group}
            selected={selected[kind] ?? []}
            busy={busy}
            onSelect={(ids) => setSelected((s) => ({ ...s, [kind]: ids }))}
            onRemove={(chosen) => openRemoval({ kind, items: chosen })}
        />
    );
    const deleteWorkspaceButton = (id: string) => {
        const choice = info?.deletionChoices?.find((w) => w.id === id);
        return choice ? (
            <div className="recovery-delete-option">
                <button
                    type="button"
                    className="danger-button"
                    disabled={busy || !choice.canDelete}
                    onClick={() =>
                        openRemoval({ kind: "workspace", id: choice.id, name: choice.name })
                    }
                >
                    Delete {choice.name}
                </button>
                {choice.reason ? <p className="muted small">{choice.reason}</p> : null}
            </div>
        ) : null;
    };
    return (
        <main className="recovery-page">
            <header className="recovery-header">
                <div className="brand">
                    <Logo size={36} />
                    <span className="wordmark">notato</span>
                </div>
                <div className="data-actions">
                    <WorkspaceSwitcher me={me} onChange={switchTo} disabled={busy} />
                    <button type="button" disabled={busy} onClick={onSignOut}>
                        Sign out
                    </button>
                </div>
            </header>
            <div className="recovery-card">
                <h1>
                    {locked ? "Restore access to your workspace" : "Convert your workspace to Free"}
                </h1>
                <p>
                    <strong>{me.workspace?.name}</strong>
                </p>
                <p>
                    {locked
                        ? "Notes, screenshots and integrations are paused. Restore a paid plan or use this guide to bring the workspace within the Free allowance."
                        : "Choose what to keep, then activate Free. Nothing is removed automatically."}
                </p>
                {error && !removal ? (
                    <p role="alert" className="error">
                        {error}
                    </p>
                ) : null}
                {!info ? (
                    <p role="status">Loading workspace requirements…</p>
                ) : !info.owner ? (
                    <>
                        <p>
                            Only a workspace owner can restore payment or complete this cleanup.
                            Contact an owner, switch workspace or sign out.
                        </p>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                                void run(async () => {
                                    await load();
                                    onChanged();
                                }, false)
                            }
                        >
                            Check access again
                        </button>
                    </>
                ) : (
                    <>
                        <RecoveryArchive projects={info.projects ?? []} />
                        <ol className="recovery-steps" aria-label="Downgrade steps">
                            {STEPS.map((label, index) => (
                                <li key={label} aria-current={step === index ? "step" : undefined}>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => setStep(index)}
                                    >
                                        <strong>
                                            {index + 1}. {label}
                                        </strong>
                                        <span
                                            className={`recovery-state ${status(index).count ? "over" : "ready"}`}
                                        >
                                            {status(index).text}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ol>
                        <section aria-label={`${STEPS[step]} requirements`}>
                            <h2>{STEPS[step]}</h2>
                            <ul className="recovery-requirements">
                                {requirements
                                    .filter((r) => step === 4 || r.step === step)
                                    .map((r) => (
                                        <li key={r.id} className={r.met ? "ready" : "over"}>
                                            <div>
                                                <strong>
                                                    {r.label}
                                                    {countText(r) ? ` · ${countText(r)}` : ""}
                                                </strong>
                                                <p>
                                                    {r.met
                                                        ? "Within the Free allowance"
                                                        : r.message}
                                                </p>
                                            </div>
                                            <span className="recovery-state">
                                                {r.met ? "Ready" : "Action needed"}
                                            </span>
                                            {step === 4 && !r.met ? (
                                                <button
                                                    type="button"
                                                    disabled={busy}
                                                    onClick={() => setStep(r.step)}
                                                >
                                                    Fix {r.label.toLowerCase()}
                                                </button>
                                            ) : null}
                                        </li>
                                    ))}
                            </ul>
                            {step === 0 ? (
                                <>
                                    <p>
                                        Free includes one private workspace per account, one
                                        project, 250 MB stored data, 100 new notes per month, and
                                        six active app/tester and agent keys combined. Pending
                                        invitations are revoked when you activate Free.
                                    </p>
                                    {info.otherFreeWorkspace ? (
                                        <div className="recovery-callout over" role="status">
                                            <h3>Which workspace do you want to keep?</h3>
                                            <p>
                                                To keep <strong>{info.workspace.name}</strong> on
                                                Free, delete{" "}
                                                <strong>{info.otherFreeWorkspace.name}</strong>{" "}
                                                here, or switch to it and upgrade its plan.
                                            </p>
                                            {deleteWorkspaceButton(info.otherFreeWorkspace.id)}
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() =>
                                                    void run(
                                                        () =>
                                                            switchTo(
                                                                info.otherFreeWorkspace?.id ?? ""
                                                            ),
                                                        false
                                                    )
                                                }
                                            >
                                                Switch to {info.otherFreeWorkspace.name}
                                            </button>
                                        </div>
                                    ) : null}
                                    {info.hasCustomer && info.billingEnabled ? (
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() =>
                                                void run(async () =>
                                                    window.location.assign(
                                                        (await portalBilling()).url
                                                    )
                                                )
                                            }
                                        >
                                            Manage subscription
                                        </button>
                                    ) : null}
                                    {locked && (info.billingEnabled || info.testPlans) ? (
                                        <details>
                                            <summary>Restore a paid plan</summary>
                                            <Billing onChanged={onChanged} />
                                        </details>
                                    ) : null}
                                    <div className="recovery-callout">
                                        <h3>Delete this workspace instead</h3>
                                        <p>
                                            You can also delete{" "}
                                            <strong>{info.workspace.name}</strong> and keep your
                                            other workspace. This permanently removes its projects,
                                            notes, screenshots and tokens for everyone.
                                        </p>
                                        {deleteWorkspaceButton(info.workspace.id)}
                                    </div>
                                    <p className="muted small">
                                        Cleanup deletions are permanent. Service backups are for
                                        disaster recovery; individual notes and workspaces cannot be
                                        restored on request.
                                    </p>
                                </>
                            ) : null}
                            {step === 1 ? (
                                <>
                                    <p>
                                        Keep at most one project. Deleting a project deletes all its
                                        notes and revokes its tokens. To reduce storage, you can
                                        delete individual notes below.
                                    </p>
                                    <h3>Projects</h3>
                                    {list(
                                        "project",
                                        (info.projects ?? []).map((p) => ({
                                            id: p.id,
                                            name: p.name,
                                            detail: `${p.notes.toLocaleString()} notes · ${size(p.bytes)}`,
                                        }))
                                    )}
                                    <h3>Notes to clean up</h3>
                                    <p className="muted small">
                                        This inventory shows page paths, identifiers and sizes for
                                        cleanup. Normal note browsing is unavailable while the
                                        workspace is inactive. Selection applies to this page only.
                                    </p>
                                    <label>
                                        Filter notes by project
                                        <select
                                            aria-label="Filter notes by project"
                                            disabled={busy}
                                            value={project}
                                            onChange={(e) => changePage(e.target.value)}
                                        >
                                            <option value="">All projects</option>
                                            {info.projects?.map((p) => (
                                                <option key={p.id} value={p.id}>
                                                    {p.name}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    {list(
                                        "note",
                                        (info.notes ?? []).map((n) => ({
                                            id: n.id,
                                            name: n.route || "/",
                                            detail: `${n.id} · ${size(n.bytes)} · ${new Date(n.createdAt).toLocaleDateString()}`,
                                        }))
                                    )}
                                    <div className="data-actions">
                                        {before ? (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => changePage(project)}
                                            >
                                                Newest notes
                                            </button>
                                        ) : null}
                                        {info.next ? (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => changePage(project, info.next)}
                                            >
                                                Older notes
                                            </button>
                                        ) : null}
                                    </div>
                                </>
                            ) : null}
                            {step === 2 ? (
                                <>
                                    <p>
                                        Free is private. Keep yourself as the only member. Removing
                                        someone disconnects their access to this workspace and keeps
                                        their account and other workspaces.
                                    </p>
                                    <p className="recovery-callout">
                                        <strong>{me.name ?? me.username} (you)</strong> · Owner ·
                                        Kept
                                    </p>
                                    {list(
                                        "member",
                                        (info.members ?? [])
                                            .filter((m) => m.username !== me.username)
                                            .map((m) => ({
                                                id: m.username,
                                                name: m.name,
                                                detail: m.role,
                                            }))
                                    )}
                                </>
                            ) : null}
                            {step === 3 ? (
                                <>
                                    <p>
                                        Keep at most six app/tester and agent keys combined.
                                        Revoking a token immediately disconnects anything using it.
                                    </p>
                                    {(info.tokens?.length ?? 0) > info.freeLimits.tokens ? (
                                        <p className="recovery-callout over" role="status">
                                            Revoke{" "}
                                            {(info.tokens?.length ?? 0) - info.freeLimits.tokens}{" "}
                                            keys across either group to meet the Free allowance.
                                        </p>
                                    ) : null}
                                    {(["app", "agent"] as const).map((purpose) => {
                                        const tokens = (info.tokens ?? []).filter(
                                            (t) => tokenPurpose(t) === purpose
                                        );
                                        const label = purpose === "app" ? "App/tester" : "Agent";
                                        return (
                                            <section key={purpose} aria-label={`${label} tokens`}>
                                                <h3>
                                                    {label} keys · {tokens.length}
                                                </h3>
                                                {list(
                                                    "token",
                                                    tokens.map((t) => ({
                                                        id: t.id,
                                                        name: t.name,
                                                        detail: `${tokenLabel(t)} · ${t.projectId === "*" ? "All projects" : t.projectId}`,
                                                    })),
                                                    label
                                                )}
                                            </section>
                                        );
                                    })}
                                </>
                            ) : null}
                            {step === 4 ? (
                                <>
                                    <p
                                        className={`recovery-callout ${info.canConvert ? "ready" : "over"}`}
                                        role="status"
                                    >
                                        {info.canConvert
                                            ? "Everything is within the Free allowance. Confirm the workspace name to activate Free."
                                            : "Resolve the items marked Action needed before activating Free. Use the Fix buttons above to jump to each step."}
                                    </p>
                                    <p>
                                        {info.monthlyNotes?.notes ?? 0} notes accepted this month.{" "}
                                        {Math.max(
                                            0,
                                            info.freeLimits.notesPerMonth -
                                                (info.monthlyNotes?.notes ?? 0)
                                        )}{" "}
                                        new notes remain on Free. Deletion does not reset this
                                        allowance.
                                    </p>
                                    {info.canConvert ? (
                                        <form
                                            className="recovery-activate"
                                            onSubmit={(e) => {
                                                e.preventDefault();
                                                if (busy || name !== info.workspace.name) return;
                                                void run(async () => {
                                                    await completeRecovery(name);
                                                    go("#/", true);
                                                    onChanged();
                                                }, false);
                                            }}
                                        >
                                            <label>
                                                Type {info.workspace.name} to activate Free
                                                <input
                                                    value={name}
                                                    onChange={(e) => setName(e.target.value)}
                                                    autoComplete="off"
                                                    disabled={busy}
                                                />
                                            </label>
                                            <button
                                                type="submit"
                                                className="primary"
                                                disabled={busy || name !== info.workspace.name}
                                            >
                                                Activate Free
                                            </button>
                                        </form>
                                    ) : null}
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void run(load, false)}
                                    >
                                        Check requirements again
                                    </button>
                                </>
                            ) : null}
                        </section>
                        <footer className="recovery-navigation">
                            <button
                                type="button"
                                disabled={busy || step === 0}
                                onClick={() => setStep((s) => s - 1)}
                            >
                                Back
                            </button>
                            {step < STEPS.length - 1 ? (
                                <button
                                    type="button"
                                    className="primary"
                                    disabled={busy}
                                    onClick={() => {
                                        setStep((s) => s + 1);
                                        void run(load, false);
                                    }}
                                >
                                    {status(step).count ? "Review next step" : "Continue"}
                                </button>
                            ) : null}
                            {!locked ? (
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => go("#/x/workspace")}
                                >
                                    Return to workspace
                                </button>
                            ) : null}
                        </footer>
                    </>
                )}
            </div>
            {removal ? (
                <Modal
                    title={
                        removal.kind === "workspace"
                            ? `Delete workspace: ${removal.name}`
                            : `Confirm removal: ${removal.items.length} ${removal.kind}${removal.items.length === 1 ? "" : "s"}`
                    }
                    onClose={() => {
                        if (!busy) setRemoval(null);
                    }}
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (
                            busy ||
                            confirmation !==
                                (removal.kind === "workspace" ? removal.name : "DELETE")
                        )
                            return;
                        const item = removal;
                        void run(async () => {
                            if (item.kind === "workspace") {
                                const result = await deleteRecoveryWorkspace(
                                    item.id,
                                    confirmation,
                                    { password }
                                );
                                if (result.currentDeleted) {
                                    go("#/", true);
                                    onChanged();
                                    return;
                                }
                                await load();
                                setRemoval(null);
                                onChanged();
                                return;
                            }
                            const ids = item.items.map((i) => i.id);
                            let completed = 0,
                                failed = 0;
                            try {
                                for (let start = 0; start < ids.length; start += 50) {
                                    setProgress(
                                        `Removing ${start + 1}–${Math.min(start + 50, ids.length)} of ${ids.length}…`
                                    );
                                    const result = await cleanupRecovery(
                                        item.kind,
                                        ids.slice(start, start + 50)
                                    );
                                    completed += result.completed.length;
                                    failed += result.failed.length;
                                    if (result.failed.length) break;
                                }
                            } finally {
                                const nextProject =
                                    item.kind === "project" && ids.includes(project) ? "" : project;
                                setInfo(await getRecovery(nextProject || undefined));
                                setProject(nextProject);
                                setBefore(undefined);
                                setSelected({});
                                setRemoval(null);
                            }
                            if (failed)
                                throw new Error(
                                    `${completed} removed. ${ids.length - completed} could not be removed or were not attempted. Review the refreshed list and try again.`
                                );
                        }, false);
                    }}
                >
                    <div className="modal-body">
                        {removal.kind === "workspace" ? (
                            <>
                                <p>
                                    Permanently delete <strong>{removal.name}</strong>, including
                                    all its projects, notes, screenshots and tokens. Everyone loses
                                    access to this workspace. Their accounts and other workspaces
                                    are kept.
                                </p>
                                <p>
                                    This cannot be undone.{" "}
                                    {removal.id === info?.workspace.id
                                        ? "You will be moved to a remaining workspace, or an empty personal workspace if needed."
                                        : `You will stay in ${info?.workspace.name}.`}
                                </p>
                            </>
                        ) : (
                            <>
                                <p>{consequences[removal.kind]}</p>
                                <ul className="recovery-confirm-items">
                                    {removal.items.map((i) => (
                                        <li key={i.id}>
                                            <strong>{i.name}</strong>
                                            <span>{i.detail}</span>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                        <label className="field">
                            Type {removal.kind === "workspace" ? removal.name : "DELETE"} to confirm
                            <input
                                value={confirmation}
                                disabled={busy}
                                onChange={(e) => setConfirmation(e.target.value)}
                                autoComplete="off"
                            />
                        </label>
                        {removal.kind === "workspace" && (
                            <label className="field">
                                Current password
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    disabled={busy}
                                    autoComplete="current-password"
                                    required
                                />
                            </label>
                        )}
                        {error ? (
                            <p className="error" role="alert">
                                {error}
                            </p>
                        ) : null}
                        {progress ? <p role="status">{progress}</p> : null}
                    </div>
                    <footer className="modal-foot">
                        <button type="button" disabled={busy} onClick={() => setRemoval(null)}>
                            Cancel
                        </button>
                        <span className="grow" />
                        <button
                            type="submit"
                            className="danger-button"
                            disabled={
                                busy ||
                                confirmation !==
                                    (removal.kind === "workspace" ? removal.name : "DELETE")
                            }
                        >
                            {busy
                                ? "Removing…"
                                : removal.kind === "workspace"
                                  ? "Delete workspace permanently"
                                  : "Confirm removal"}
                        </button>
                    </footer>
                </Modal>
            ) : null}
        </main>
    );
}

function CleanupList({
    kind,
    items,
    group,
    selected,
    busy,
    onSelect,
    onRemove,
}: {
    kind: Kind;
    items: Item[];
    group?: string;
    selected: string[];
    busy: boolean;
    onSelect(ids: string[]): void;
    onRemove(items: Item[]): void;
}) {
    const chosen = items.filter((i) => selected.includes(i.id));
    const all = chosen.length === items.length;
    const action = kind === "token" ? "Revoke" : kind === "member" ? "Remove" : "Delete";
    return (
        <div className="recovery-list">
            {items.length ? (
                <div className="recovery-bulk">
                    <label className="recovery-check">
                        <input
                            type="checkbox"
                            disabled={busy}
                            checked={all}
                            onChange={() =>
                                onSelect(
                                    all
                                        ? selected.filter((id) => !items.some((i) => i.id === id))
                                        : [...new Set([...selected, ...items.map((i) => i.id)])]
                                )
                            }
                        />
                        Select all {group ? `${group.toLowerCase()} ` : ""}
                        {kind === "member" ? "people" : `${kind}s`} shown
                    </label>
                    <span className="muted small">{chosen.length} selected</span>
                    <button
                        type="button"
                        className={chosen.length ? "danger-button" : undefined}
                        disabled={busy || !chosen.length}
                        onClick={() => onRemove(chosen)}
                    >
                        {action} selected ({chosen.length})
                    </button>
                </div>
            ) : (
                <p className="muted small">
                    No {group ? `${group.toLowerCase()} ` : ""}
                    {kind === "member" ? "other people" : `${kind}s`} to remove.
                </p>
            )}
            <ul className="recovery-items">
                {items.map((i) => (
                    <li key={i.id}>
                        <label className="recovery-check">
                            <input
                                type="checkbox"
                                aria-label={`Select ${i.name}`}
                                disabled={busy}
                                checked={selected.includes(i.id)}
                                onChange={(e) =>
                                    onSelect(
                                        e.target.checked
                                            ? [...selected, i.id]
                                            : selected.filter((id) => id !== i.id)
                                    )
                                }
                            />
                            <span className="recovery-item-text">
                                <strong>{i.name}</strong>
                                <span>{i.detail}</span>
                            </span>
                        </label>
                        <button type="button" disabled={busy} onClick={() => onRemove([i])}>
                            {action} {kind === "member" ? "person" : kind}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}
