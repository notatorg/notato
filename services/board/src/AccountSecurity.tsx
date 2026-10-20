import { useCallback, useEffect, useState } from "react";
import {
    type AccountSession,
    type AuditEntry,
    canManageProjects,
    listAccountSessions,
    listAudit,
    type Me,
    revokeAccountSession,
    signedOut,
} from "./api.ts";
import { signOutOtherDevices } from "./HostedLogin.tsx";
import { Section } from "./Layout.tsx";

/** `sessions` is the person's own sign-ins (Account); `activity` is the workspace's management log (Workspace). */
type SecurityProps = { me: Me; show: "sessions" | "activity" };
export function AccountSecurity(props: SecurityProps) {
    return (
        <AccountSecurityContent
            key={props.show === "activity" ? props.me.workspace?.id : "sessions"}
            {...props}
        />
    );
}
function AccountSecurityContent({ me, show }: SecurityProps) {
    const [sessions, setSessions] = useState<AccountSession[]>([]);
    const [audit, setAudit] = useState<AuditEntry[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const manager = canManageProjects(me);
    const sessionsShown = show === "sessions";
    const activityShown = show === "activity" && manager;
    const load = useCallback(() => {
        if (sessionsShown)
            listAccountSessions().then(setSessions, (reason: Error) => setError(reason.message));
        if (activityShown) listAudit().then(setAudit, (reason: Error) => setError(reason.message));
    }, [sessionsShown, activityShown]);
    useEffect(load, [load]);
    const run = async (action: () => Promise<unknown>) => {
        setBusy(true);
        setError(null);
        try {
            await action();
            load();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Could not update sessions");
        } finally {
            setBusy(false);
        }
    };
    return (
        <>
            {sessionsShown && (
                <Section
                    title="Sign-in sessions"
                    about="Revoke a session to stop that device accessing Notato, including exchanging its existing provider tokens. A fresh sign-in is required."
                >
                    {error && (
                        <div className="banner bad" role="alert">
                            <span>{error}</span>
                        </div>
                    )}
                    <div className="session-list">
                        {sessions.map((s) => (
                            <div className="setting-row" key={s.id}>
                                <div className="setting-text">
                                    <strong>
                                        Started {new Date(s.createdAt).toLocaleString()}
                                        {s.current ? (
                                            <span className="role-pill">this device</span>
                                        ) : null}
                                    </strong>
                                    <p className="muted small">
                                        Expires {new Date(s.expiresAt).toLocaleString()}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    className="link danger"
                                    disabled={busy}
                                    onClick={() =>
                                        void run(async () => {
                                            await revokeAccountSession(s.id);
                                            if (s.current) signedOut();
                                        })
                                    }
                                >
                                    Revoke
                                </button>
                            </div>
                        ))}
                    </div>
                    <div className="data-actions">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void run(signOutOtherDevices)}
                        >
                            Sign out other sessions
                        </button>
                    </div>
                </Section>
            )}
            {activityShown && (
                <Section
                    title="Security activity"
                    about="Recent management attempts and changes in this workspace. Request contents and credentials are excluded. A pending attempt may have committed: inspect the affected resource."
                >
                    {error && (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    )}
                    <AuditLog key={me.workspace?.id} entries={audit} />
                </Section>
            )}
        </>
    );
}

const AUDIT_PAGE_SIZE = 10;
export function AuditLog({ entries }: { entries: AuditEntry[] }) {
    const [page, setPage] = useState(0);
    const current = Math.min(page, Math.max(0, Math.ceil(entries.length / AUDIT_PAGE_SIZE) - 1));
    const start = current * AUDIT_PAGE_SIZE;
    const visible = entries.slice(start, start + AUDIT_PAGE_SIZE);
    if (!entries.length) return <p className="muted">No security activity yet.</p>;
    return (
        <>
            <div className="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>When / actor</th>
                            <th>Action</th>
                            <th>Result</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((a) => (
                            <tr key={a.id}>
                                <td>
                                    {new Date(a.createdAt).toLocaleString()}
                                    <br />
                                    <span className="small">{a.actor}</span>
                                </td>
                                <td>{a.action}</td>
                                <td>{a.outcome || "Pending"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <nav className="audit-pages" aria-label="Security activity pages">
                <span className="muted small">
                    {start + 1}–{start + visible.length} of {entries.length} recent events
                </span>
                {entries.length > AUDIT_PAGE_SIZE && (
                    <div className="row-actions">
                        <button
                            type="button"
                            disabled={current === 0}
                            onClick={() => setPage(current - 1)}
                        >
                            Previous
                        </button>
                        <button
                            type="button"
                            disabled={start + AUDIT_PAGE_SIZE >= entries.length}
                            onClick={() => setPage(current + 1)}
                        >
                            Next
                        </button>
                    </div>
                )}
            </nav>
        </>
    );
}
