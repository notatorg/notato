import { type FormEvent, useCallback, useEffect, useState } from "react";
import { AccountSecurity } from "./AccountSecurity.tsx";
import {
    Avatar,
    acceptInvitation,
    canManageProjects,
    getInvitation,
    getWorkspace,
    inviteMember,
    listInvitations,
    type Me,
    removeMember,
    renameWorkspace,
    revokeInvitation,
    setMemberRole,
    type WorkspaceInfo,
    type WorkspaceInvite,
    type WorkspaceRole,
} from "./api.ts";
import { Billing } from "./Billing.tsx";
import { DataControls } from "./DataControls.tsx";
import { Section, usePageTitle } from "./Layout.tsx";
import { GuestNotice, RoleNote, whoIs } from "./Role.tsx";

export function Workspace({ me, onChanged }: { me: Me; onChanged(): void }) {
    usePageTitle("Workspace");
    const [info, setInfo] = useState<WorkspaceInfo | null>(null);
    const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
    const [name, setName] = useState(me.workspace?.name ?? "");
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<WorkspaceRole>("member");
    const [link, setLink] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const manager = canManageProjects(me);
    const load = useCallback(() => {
        getWorkspace().then(setInfo, (reason: Error) => setError(reason.message));
        if (manager)
            listInvitations().then(setInvites, (reason: Error) => setError(reason.message));
    }, [manager]);
    useEffect(load, [load]);
    const run = (action: () => Promise<unknown>) => {
        setBusy(true);
        setError(null);
        action()
            .then(
                () => {
                    load();
                    onChanged();
                },
                (reason: Error) => setError(reason.message)
            )
            .finally(() => setBusy(false));
    };
    const submitName = (event: FormEvent) => {
        event.preventDefault();
        run(() => renameWorkspace(name.trim()));
    };
    const who = whoIs(me);
    const owner = who.owner;
    if (who.guest) return <GuestNotice what="Workspace" />;
    const pending = invites.filter(
        (invite) =>
            !invite.acceptedAt && !invite.revokedAt && Date.parse(invite.expiresAt) > Date.now()
    );
    return (
        <div className="sheet">
            <div className="sheet-inner settings cloud-page">
                <header className="sheet-head">
                    <div>
                        <h1>{info?.workspace.name ?? "Workspace"}</h1>
                        <p>
                            The people and data of this workspace. Your own sign-in and email
                            choices are under Settings → Account.
                        </p>
                    </div>
                </header>
                <RoleNote me={me} can="rename the workspace and invite or remove people" />
                {error ? (
                    <div className="banner bad" role="alert">
                        <span>{error}</span>
                    </div>
                ) : null}
                <Section title="Name" about="Shown in the workspace switcher and in invitations.">
                    {manager ? (
                        <form onSubmit={submitName}>
                            <label>
                                Workspace name
                                <input
                                    value={name}
                                    onChange={(event) => setName(event.target.value)}
                                    maxLength={200}
                                    required
                                />
                            </label>
                            <button type="submit" disabled={busy || !name.trim()}>
                                Save name
                            </button>
                        </form>
                    ) : (
                        <p>{info?.workspace.name ?? me.workspace?.name}</p>
                    )}
                </Section>
                <Section
                    title={who.solo ? "People" : "Team members"}
                    about={
                        who.solo
                            ? "It is just you here, which is a fine way to use Notato. Invite teammates whenever you are ready."
                            : who.manager
                              ? "Owners manage everything. Admins manage projects and members. Members work in the projects they can open."
                              : "Everyone who belongs to this workspace. Only owners and admins can add or remove people."
                    }
                >
                    <div className="member-list">
                        {info?.members.map((member) => (
                            <div className="member-row" key={member.username}>
                                <Avatar author={{ kind: "human", name: member.name }} size={32} />
                                <div className="member-text">
                                    <strong>
                                        {member.name}
                                        {member.username === me.username ? (
                                            <span className="muted"> (you)</span>
                                        ) : null}
                                    </strong>
                                    {member.email ? (
                                        <span className="muted small">{member.email}</span>
                                    ) : null}
                                </div>
                                <div className="member-actions">
                                    {owner && member.username !== me.username ? (
                                        <select
                                            aria-label={`Role for ${member.name}`}
                                            value={member.role}
                                            disabled={busy}
                                            onChange={(event) =>
                                                run(() =>
                                                    setMemberRole(
                                                        member.username,
                                                        event.target.value as WorkspaceRole
                                                    )
                                                )
                                            }
                                        >
                                            <option value="member">Member</option>
                                            <option value="admin">Admin</option>
                                            <option value="owner">Owner</option>
                                        </select>
                                    ) : (
                                        <span className="role-pill">{member.role}</span>
                                    )}
                                    {manager &&
                                    member.username !== me.username &&
                                    (owner || member.role === "member") ? (
                                        <button
                                            type="button"
                                            className="link danger"
                                            disabled={busy}
                                            onClick={() => {
                                                if (
                                                    window.confirm(
                                                        `Remove ${member.name} from this workspace?`
                                                    )
                                                )
                                                    run(() => removeMember(member.username));
                                            }}
                                        >
                                            Remove
                                        </button>
                                    ) : null}
                                </div>
                            </div>
                        ))}
                    </div>
                </Section>
                {manager && me.identity ? (
                    <Section
                        title="Invite someone"
                        about={
                            info?.private
                                ? undefined
                                : "The link works for seven days and can be accepted only by the verified email you enter."
                        }
                    >
                        {info?.private ? (
                            <p className="muted">
                                Free workspaces are private. Choose Pro or Team under Plan below to
                                invite people.
                            </p>
                        ) : (
                            <>
                                <form
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        run(async () => {
                                            const result = await inviteMember(email.trim(), role);
                                            setLink(result.url);
                                            setEmail("");
                                        });
                                    }}
                                >
                                    <label>
                                        Email
                                        <input
                                            type="email"
                                            value={email}
                                            onChange={(event) => setEmail(event.target.value)}
                                            maxLength={254}
                                            required
                                        />
                                    </label>
                                    <label>
                                        Role
                                        <select
                                            value={role}
                                            onChange={(event) =>
                                                setRole(event.target.value as WorkspaceRole)
                                            }
                                        >
                                            <option value="member">Member</option>
                                            {owner ? (
                                                <>
                                                    <option value="admin">Admin</option>
                                                    <option value="owner">Owner</option>
                                                </>
                                            ) : null}
                                        </select>
                                    </label>
                                    <button type="submit" disabled={busy}>
                                        Create invitation link
                                    </button>
                                </form>
                                {link ? (
                                    <div className="invite-link">
                                        <label>
                                            Share this invitation
                                            <input
                                                readOnly
                                                value={link}
                                                onFocus={(event) => event.target.select()}
                                            />
                                        </label>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void navigator.clipboard
                                                    .writeText(link)
                                                    .catch(() =>
                                                        setError("Select the link and copy it.")
                                                    )
                                            }
                                        >
                                            Copy link
                                        </button>
                                    </div>
                                ) : null}
                                {pending.length ? (
                                    <div className="member-list">
                                        <p className="muted small">Waiting to be accepted</p>
                                        {pending.map((invite) => (
                                            <div className="member-row" key={invite.id}>
                                                <div className="member-text">
                                                    <strong>{invite.email}</strong>
                                                    <span className="muted small">
                                                        {invite.role}
                                                    </span>
                                                </div>
                                                <div className="member-actions">
                                                    <button
                                                        type="button"
                                                        className="link danger"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            run(() => revokeInvitation(invite.id))
                                                        }
                                                    >
                                                        Revoke
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </>
                        )}
                    </Section>
                ) : null}
                <Billing onChanged={load} />
                <DataControls me={me} scope="workspace" />
                <AccountSecurity me={me} show="activity" />
            </div>
        </div>
    );
}

export function JoinWorkspace({
    token,
    me,
    onSignOut,
}: {
    token: string;
    me: Me;
    onSignOut(): void;
}) {
    const [invite, setInvite] = useState<Awaited<ReturnType<typeof getInvitation>> | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        getInvitation(token).then(setInvite, (reason: Error) => setError(reason.message));
    }, [token]);
    return (
        <div className="login">
            <h1>Join {invite?.workspace.name ?? "a workspace"}</h1>
            {invite ? (
                <p>
                    This invitation is for {invite.email}. You are signed in as{" "}
                    {me.email ?? me.name ?? me.username}.
                </p>
            ) : null}
            {error ? (
                <p className="error" role="alert">
                    {error}
                </p>
            ) : null}
            <button
                type="button"
                className="primary"
                disabled={busy || !invite}
                onClick={() => {
                    setBusy(true);
                    acceptInvitation(token).then(
                        () => window.location.assign("/"),
                        (reason: Error) => {
                            setError(reason.message);
                            setBusy(false);
                        }
                    );
                }}
            >
                Join workspace
            </button>
            <button type="button" className="link" onClick={onSignOut}>
                Sign in with a different account
            </button>
            <a href="/">Continue to your workspace</a>
        </div>
    );
}
