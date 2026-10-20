import { BrowserPreferences, Segmented, type SettingsPageProps } from "@notato/board";
import { AccountPage } from "./AccountPage.tsx";
import type { Me } from "./api.ts";
import { PageRedirect, usePageTitle } from "./Layout.tsx";

export function PersonalSettings({ me, tab, accountName }: SettingsPageProps) {
    const current = tab === "appearance" || !tab || tab === "general" ? "appearance" : "account";
    usePageTitle(current === "appearance" ? "Appearance" : "Account");
    if (tab === "tokens")
        return (
            <PageRedirect
                to={
                    me.isAdmin && !(me as Me).workspace
                        ? "#/x/administration/tokens"
                        : "#/x/workspace/tokens"
                }
            />
        );
    return (
        <div className="sheet">
            <div className="sheet-inner settings">
                <header className="sheet-head">
                    <div>
                        <h1>{current === "appearance" ? "Appearance" : "Account"}</h1>
                        <p>
                            {current === "appearance"
                                ? "Preferences for this browser."
                                : "Your profile, sign-in and personal data."}
                        </p>
                    </div>
                </header>
                <Segmented
                    className="settings-tabs"
                    label="Personal settings"
                    value={current}
                    options={[
                        { id: "account", label: "Account" },
                        { id: "appearance", label: "Appearance" },
                    ]}
                    onChange={(id) => {
                        window.location.hash = `#/settings/${id}`;
                    }}
                />
                {current === "account" ? (
                    <AccountPage me={me as Me} />
                ) : (
                    <BrowserPreferences accountName={accountName} />
                )}
            </div>
        </div>
    );
}
