import { Modal } from "@notato/board";
import { useEffect, useState } from "react";
import {
    deleteAccount,
    deleteWorkspace,
    getWorkspacePolicy,
    type Me,
    setWorkspacePolicy,
} from "./api.ts";
import { forgetIdentitySession } from "./HostedLogin.tsx";
import { Section } from "./Layout.tsx";

/** `workspace`: how long feedback is kept and deleting the workspace. `account`: deleting your own account. */
export function DataControls({ me, scope }: { me: Me; scope: "workspace" | "account" }) {
    const [days, setDays] = useState<number | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<"workspace" | "account" | null>(null);
    const [confirm, setConfirm] = useState("");
    const [password, setPassword] = useState("");
    const [privateWorkspaces, setPrivateWorkspaces] = useState(false);
    useEffect(() => {
        getWorkspacePolicy().then(
            (p) => {
                setDays(p.retentionDays);
                setLoaded(true);
            },
            (e: Error) => setError(e.message)
        );
    }, []);
    const owner = me.workspace?.role === "owner";
    const change = async (next: number | null) => {
        if (
            next !== null &&
            !window.confirm(
                `Permanently remove feedback after ${next} days without updates, including open notes? This applies to everyone in this workspace.`
            )
        )
            return;
        setBusy(true);
        setError(null);
        try {
            const p = await setWorkspacePolicy(next);
            setDays(p.retentionDays);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save retention");
        } finally {
            setBusy(false);
        }
    };
    const destroy = async () => {
        setBusy(true);
        setError(null);
        try {
            if (dialog === "workspace") {
                await deleteWorkspace(confirm, { password });
                window.location.assign("/#/x/workspace");
            } else {
                await deleteAccount({
                    confirm: me.username ?? "",
                    deletePrivateWorkspaces: privateWorkspaces,
                    ...{ password },
                });
                await forgetIdentitySession();
                window.location.assign("/");
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not delete");
        } finally {
            setBusy(false);
        }
    };
    const modal = (
        <>
            {dialog ? (
                <Modal
                    title={dialog === "workspace" ? "Delete workspace" : "Delete your account"}
                    onClose={() => {
                        if (!busy) setDialog(null);
                    }}
                    onSubmit={(e) => {
                        e.preventDefault();
                        void destroy();
                    }}
                >
                    <div className="modal-body">
                        <p>
                            {dialog === "workspace"
                                ? "Permanently delete this workspace's projects, notes, screenshots and tokens for everyone. Members retain an empty personal workspace if this was their last workspace."
                                : "Remove your account and revoke your sessions and issued credentials. Shared company feedback remains with its workspace. Transfer ownership of shared workspaces first."}
                        </p>
                        <label>
                            Type {dialog === "workspace" ? me.workspace?.name : "DELETE"} to confirm
                            <input
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                                required
                                autoComplete="off"
                            />
                        </label>
                        <label>
                            Current password
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                autoComplete="current-password"
                            />
                        </label>
                        {dialog === "account" ? (
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={privateWorkspaces}
                                    onChange={(e) => setPrivateWorkspaces(e.target.checked)}
                                />
                                Also delete workspaces where I am the only member
                            </label>
                        ) : null}
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
                            onClick={() => setDialog(null)}
                        >
                            Cancel
                        </button>
                        <span className="grow" />
                        <button
                            type="submit"
                            className="danger-button"
                            disabled={
                                busy ||
                                confirm !== (dialog === "workspace" ? me.workspace?.name : "DELETE")
                            }
                        >
                            {busy ? "Deleting…" : "Delete permanently"}
                        </button>
                    </footer>
                </Modal>
            ) : null}
        </>
    );
    if (scope === "account")
        return (
            <>
                <Section
                    className="danger-zone"
                    title="Delete account"
                    about="Remove your account and revoke your sessions and issued credentials. Shared company feedback remains with its workspace."
                >
                    <div className="data-actions">
                        <button
                            type="button"
                            className="link danger"
                            disabled={!me.accountDeletionAvailable}
                            onClick={() => {
                                setConfirm("");
                                setPassword("");
                                setError(null);
                                setPrivateWorkspaces(false);
                                setDialog("account");
                            }}
                        >
                            Delete my account
                        </button>
                    </div>
                    {!me.accountDeletionAvailable ? (
                        <p className="muted small">
                            Contact the service administrator for account deletion.
                        </p>
                    ) : null}
                    {error && !dialog ? (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </Section>
                {modal}
            </>
        );
    return (
        <>
            <Section
                title="Data and retention"
                about="Feedback is kept until you delete it, unless an owner turns on automatic retention. Downloads you already exported and encrypted backups follow their own retention."
            >
                <label>
                    Remove feedback without updates
                    <select
                        aria-label="Feedback retention"
                        value={days ?? 0}
                        disabled={!owner || !loaded || busy}
                        onChange={(e) => void change(Number(e.target.value) || null)}
                    >
                        <option value={0}>Keep until deleted</option>
                        {[7, 30, 90, 180, 365].map((n) => (
                            <option key={n} value={n}>
                                {n} days
                            </option>
                        ))}
                        {days && ![7, 30, 90, 180, 365].includes(days) ? (
                            <option value={days}>{days} days</option>
                        ) : null}
                    </select>
                </label>
                {!owner ? <p className="muted small">A workspace owner can change this.</p> : null}
            </Section>
            {owner && me.workspace?.id !== "default" ? (
                <Section
                    className="danger-zone"
                    title="Delete workspace"
                    about="Permanently delete this workspace's projects, notes, screenshots and tokens for everyone."
                >
                    <div className="data-actions">
                        <button
                            type="button"
                            className="link danger"
                            onClick={() => {
                                setConfirm("");
                                setPassword("");
                                setError(null);
                                setDialog("workspace");
                            }}
                        >
                            Delete workspace
                        </button>
                    </div>
                    {error && !dialog ? (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </Section>
            ) : null}
            {modal}
        </>
    );
}
