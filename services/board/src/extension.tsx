import { type BoardExtension, Login, useRoute } from "@notato/board";
import { type ReactNode, useEffect, useState } from "react";
import { AccountPage } from "./AccountPage.tsx";
import {
    canManageProjects,
    getMe,
    logout,
    type Me,
    markProjectRead,
    selectWorkspace,
    setRecoveryHandler,
} from "./api.ts";
import {
    BetaAdminMoved,
    BetaInvitation,
    type BetaStatus,
    BetaWaitlist,
    betaStatus,
} from "./Beta.tsx";
import { Billing } from "./Billing.tsx";
import { BrowserOrigins } from "./BrowserOrigins.tsx";
import { EmailWelcome, useEmailPreferences } from "./EmailPreferences.tsx";
import { GetStarted } from "./GetStarted.tsx";
import { forgetIdentitySession, HostedLogin } from "./HostedLogin.tsx";
import { InstanceAdmin } from "./InstanceAdmin.tsx";
import { BootstrapPasswordNotice } from "./PasswordSettings.tsx";
import { Plugins } from "./Plugins.tsx";
import { AccountRefreshContext } from "./ProfileSettings.tsx";
import { ProjectCollaboration } from "./ProjectCollaboration.tsx";
import { PullRequestReviews } from "./PullRequestReviews.tsx";
import { whoIs } from "./Role.tsx";
import { JoinWorkspace, Workspace } from "./Workspace.tsx";
import { WorkspaceRecovery } from "./WorkspaceRecovery.tsx";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";

/**
 * Before anyone is signed in: the identity provider's form (with its multi-factor and password-recovery steps) when the
 * service has one, and the open board's own operator login otherwise.
 */
function CloudLogin({ onDone }: { onDone(): void }) {
    const route = useRoute();
    const publicBeta = route.page === "ext" && route.name === "beta";
    const [beta, setBeta] = useState<BetaStatus | null>(null);
    const [me, setMe] = useState<Me | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        getMe().then(setMe, (reason: Error) => setError(reason.message));
    }, []);
    useEffect(() => {
        if (me?.betaEnabled)
            betaStatus().then(setBeta, (reason: Error) => setError(reason.message));
    }, [me?.betaEnabled]);
    if (error) return <p className="center error">Could not reach the service: {error}</p>;
    if (!me) return <p className="center muted">Loading…</p>;
    if (publicBeta && me.betaEnabled)
        return route.rest.startsWith("invite/") ? (
            <BetaInvitation token={route.rest.slice(7)} />
        ) : (
            <BetaWaitlist />
        );
    if (me.betaEnabled && !publicBeta && !beta)
        return <p className="center muted">Loading access…</p>;
    return me.identity ? (
        <HostedLogin
            onDone={onDone}
            signupMode={me.identity.signupMode}
            invitedEmail={beta?.invitedEmail}
        />
    ) : (
        <Login onDone={onDone} />
    );
}

async function signOut() {
    await logout();
    await forgetIdentitySession();
}

/**
 * Around the signed-in board: an invitation to join a workspace, preparing the operator's identity, and the recovery
 * wizard in place of the board while a workspace's plan is waiting for payment to be put right.
 */
function CloudFrame({ me, refresh, children }: { me: Me; refresh(): void; children: ReactNode }) {
    const route = useRoute();
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        // A request the service refuses because the workspace needs recovery brings the wizard up at once.
        setRecoveryHandler(() => refresh());
    }, [refresh]);
    // The board is kept up to date with the account while it is open: a plan, a role or a membership can change.
    useEffect(() => {
        if (!me.authenticated || !me.workspace) return;
        const check = () => {
            if (document.visibilityState === "visible") refresh();
        };
        const timer = setInterval(check, 15_000);
        window.addEventListener("focus", check);
        document.addEventListener("visibilitychange", check);
        return () => {
            clearInterval(timer);
            window.removeEventListener("focus", check);
            document.removeEventListener("visibilitychange", check);
        };
    }, [me.authenticated, me.workspace, refresh]);

    const [welcomed, setWelcomed] = useState(false);
    const offered = Boolean(me.emailPreferencesEnabled && me.authenticated && me.workspace);
    const emailPrefs = useEmailPreferences(offered);

    const leave = () => void signOut().then(refresh, (reason: Error) => setError(reason.message));
    const here = new URL(window.location.href);
    // Public landing pages use the same layout for signed-in and anonymous visitors.
    if (me.betaEnabled && route.page === "ext" && route.name === "beta")
        return route.rest.startsWith("invite/") ? (
            <BetaInvitation token={route.rest.slice(7)} />
        ) : (
            <BetaWaitlist signedIn />
        );
    if (
        me.workspace &&
        (me.workspace.recoveryRequired || (route.page === "ext" && route.name === "downgrade"))
    )
        return (
            <WorkspaceRecovery
                key={me.workspace.id}
                me={me}
                onChanged={refresh}
                onSignOut={leave}
            />
        );
    if (here.searchParams.has("reset"))
        return <HostedLogin onDone={refresh} signupMode={me.identity?.signupMode} />;
    const invitation = here.searchParams.get("invite");
    if (invitation && me.authRequired)
        return <JoinWorkspace token={invitation} me={me} onSignOut={leave} />;
    if (offered && !emailPrefs.loaded) return <p className="center muted">Loading…</p>;
    if (offered && emailPrefs.prefs && !emailPrefs.prefs.marketing.decided && !welcomed)
        return <EmailWelcome prefs={emailPrefs.prefs} onDone={() => setWelcomed(true)} />;
    return (
        <>
            {error ? (
                <p className="error small" role="alert">
                    {error}
                </p>
            ) : null}
            {me.bootstrapPasswordInUse && <BootstrapPasswordNotice />}
            <AccountRefreshContext.Provider value={refresh}>
                {children}
            </AccountRefreshContext.Provider>
            {route.page === "project" && route.selected && (
                <a
                    className="plugin-shortcut"
                    href={`#/x/plugins/${encodeURIComponent(route.selected)}`}
                >
                    Send feedback to tools
                </a>
            )}
        </>
    );
}

/** Notato Cloud's additions to the open board: accounts, workspaces, billing and recovery. */
export const cloudExtension: BoardExtension = {
    name: "notato-server",
    Login: CloudLogin,
    Frame: CloudFrame,
    signOut,
    requireTokenExpiry: true,
    automaticProjectIds: true,
    accountScope: (me) => (me as Me).workspace?.id,
    accountName: (me) =>
        (me as Me).workspace ? ((me as Me).name ?? me.username ?? "") : undefined,
    readState: { markRead: (project, at) => markProjectRead(project, at) },
    // Making projects and changing their settings is for owners and admins (the server refuses anyone else), so the
    // board does not offer it to a member. Tokens are different: every member makes their own.
    canManage: (me) => Boolean(me.authenticated && whoIs(me as Me).manager),
    canManageTokens: (me) =>
        Boolean(me.authenticated && ((me as Me).workspace || (me as Me).isAdmin)),
    tokens: {
        allowAllProjects: false,
        canCreateAgent: (me) => Boolean((me as Me).authenticated && (me as Me).workspace),
        choices: (me, purpose) =>
            purpose === "agent"
                ? [
                      {
                          id: "user",
                          label: "My account",
                          description:
                              "Personal agent credential. It sees your Mine feedback by default and stops working if your account loses access to this workspace.",
                          options: { ownership: "user" },
                      },
                      ...(canManageProjects(me as Me)
                          ? [
                                {
                                    id: "project",
                                    label: "This project",
                                    description:
                                        "Shared project credential for an agent. It uses the project creator's identity and is managed by workspace owners and admins.",
                                    options: { ownership: "project" },
                                },
                            ]
                          : []),
                  ]
                : [
                      {
                          id: "user",
                          label: "My account",
                          description:
                              "Personal credential for your SDK or testing. It stops working if your account loses access to this workspace.",
                          options: { ownership: "user" },
                      },
                      ...(canManageProjects(me as Me)
                          ? [
                                {
                                    id: "service",
                                    label: "Application / service",
                                    description:
                                        "Shared app credential for an embedded integration. It belongs to this project and is managed by workspace owners and admins.",
                                    options: { ownership: "service" },
                                },
                            ]
                          : []),
                  ],
        describe: (token) => {
            const record = token as typeof token & { ownership?: string; ownerUsername?: string };
            return record.ownership === "user"
                ? "Personal · your account"
                : record.ownership === "service"
                  ? "Service · this project"
                  : "Agent · this project";
        },
    },
    // Home's guide: three steps for the basics, then optional ones that fit a solo builder or a team.
    HomeTop: ({ me, projects, onNewProject }) => (
        <GetStarted me={me as Me} projects={projects} onNewProject={onNewProject} />
    ),
    // Settings → Account: the signed-in person's sessions, email choices and account deletion.
    settingsTabs: [
        { id: "account", label: "Account", Page: ({ me }) => <AccountPage me={me as Me} /> },
    ],
    // Server-wide settings (webhooks, the agents switch) are the operator's, not a workspace owner's.
    canAdminServer: (me) => Boolean((me as Me).isAdmin),
    SidebarTop: ({ me }) =>
        (me as Me).workspace ? (
            <WorkspaceSwitcher
                me={me as Me}
                onChange={async (id) => {
                    await selectWorkspace(id);
                    window.location.hash = "#/";
                    window.location.reload();
                }}
            />
        ) : null,
    ProjectSettingsExtra: ({ projectId }) => (
        <>
            <ProjectCollaboration project={projectId} />
            <BrowserOrigins project={projectId} />
        </>
    ),
    nav: [
        {
            label: "Admissions",
            page: "beta-admin",
            icon: "grid",
            show: (me) => (me as Me).betaAdmin === true,
        },
        {
            label: "Instance",
            page: "instance",
            icon: "grid",
            show: (me) => (me as Me).instanceAdmin === true,
        },
        // A guest of one project has no workspace pages, so they are not offered.
        {
            label: "Pull request reviews",
            page: "pr-reviews",
            icon: "file",
            show: (me) => !whoIs(me as Me).guest,
        },
        {
            label: "Integrations",
            page: "plugins",
            icon: "plug",
            show: (me) => !whoIs(me as Me).guest,
        },
        {
            label: "Workspace",
            page: "workspace",
            icon: "grid",
            show: (me) => !whoIs(me as Me).guest,
        },
    ],
    pages: {
        instance: ({ me }) => <InstanceAdmin me={me as Me} />,
        "pr-reviews": ({ me, rest }) => <PullRequestReviews me={me as Me} selected={rest} />,
        plugins: ({ me, projects, rest }) => (
            <Plugins
                key={(me as Me).workspace?.id}
                me={me as Me}
                projects={projects}
                initialNote={rest}
            />
        ),
        beta: ({ rest }) =>
            rest.startsWith("invite/") ? (
                <BetaInvitation token={rest.slice(7)} />
            ) : (
                <BetaWaitlist signedIn />
            ),
        "beta-admin": ({ me }) =>
            (me as Me).betaAdmin ? (
                <BetaAdminMoved />
            ) : (
                <p className="center error">Beta administrator access required.</p>
            ),
        workspace: ({ me }) =>
            (me as Me).workspace ? (
                <Workspace me={me as Me} onChanged={() => window.location.reload()} />
            ) : (
                <p className="center muted">There is no workspace for this account.</p>
            ),
        billing: () => <Billing />,
    },
};
