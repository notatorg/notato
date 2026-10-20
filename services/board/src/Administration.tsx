import { type ProjectSummary, Segmented, Settings, Tokens } from "@notato/board";
import type { Me } from "./api.ts";
import { BetaAdmin } from "./BetaAdmin.tsx";
import { InstanceAdmin } from "./InstanceAdmin.tsx";
import { usePageTitle } from "./Layout.tsx";

/** Global administration is independent of membership or ownership of any workspace. */
export function administrationTabs(me: Me) {
    return [
        ...(me.instanceAdmin ? [{ id: "accounts", label: "Accounts" }] : []),
        ...(me.betaAdmin ? [{ id: "admissions", label: "Admissions" }] : []),
        ...(me.isAdmin
            ? [
                  { id: "server", label: "Server settings" },
                  { id: "tokens", label: "Access tokens" },
              ]
            : []),
    ];
}

export function Administration({
    me,
    tab = "",
    projects,
}: {
    me: Me;
    tab?: string;
    projects: ProjectSummary[] | null;
}) {
    const title = me.administration?.title ?? "Instance administration";
    usePageTitle(title);
    const tabs = administrationTabs(me);
    const current = tabs.find((item) => item.id === tab)?.id ?? tabs[0]?.id;
    const strip =
        tabs.length > 1 ? (
            <Segmented
                className="settings-tabs"
                label="Administration pages"
                value={current ?? ""}
                options={tabs}
                onChange={(id) => {
                    window.location.hash = `#/x/administration/${id}`;
                }}
            />
        ) : null;
    if (current === "server")
        return (
            <Settings
                projects={projects}
                manageServer
                title={title}
                personal={false}
                tabs={strip}
            />
        );
    return (
        <div className="sheet">
            <div className="sheet-inner settings cloud-page">
                <header className="sheet-head">
                    <div>
                        <h1>{title}</h1>
                        <p>Manage accounts and access across this service.</p>
                    </div>
                </header>
                {strip}
                {current === "accounts" ? (
                    <InstanceAdmin me={me} embedded />
                ) : current === "admissions" ? (
                    <BetaAdmin embedded />
                ) : current === "tokens" ? (
                    <Tokens me={me} projects={projects} embedded />
                ) : (
                    <div className="banner bad" role="alert">
                        <span>Administrator access required.</span>
                    </div>
                )}
            </div>
        </div>
    );
}
