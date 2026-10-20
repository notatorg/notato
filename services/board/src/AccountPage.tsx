import { AccountSecurity } from "./AccountSecurity.tsx";
import type { Me } from "./api.ts";
import { DataControls } from "./DataControls.tsx";
import { EmailPreferences } from "./EmailPreferences.tsx";
import { usePageTitle } from "./Layout.tsx";
import { MfaSettings } from "./Mfa.tsx";
import { PasswordSettings } from "./PasswordSettings.tsx";
import { ProfileSettings } from "./ProfileSettings.tsx";

/**
 * Account menu → Account: what belongs to the person, whichever workspace is open. The personal settings page supplies the title and tabs around
 * it, so this is only its sections.
 */
export function AccountPage({ me }: { me: Me }) {
    usePageTitle("Account settings");
    return (
        <div className="cloud-page cloud-tab">
            <p className="muted settings-intro">
                Your sign-in and email choices{me.email ? ` for ${me.email}` : ""}. These follow you
                across every workspace you belong to.
            </p>
            <ProfileSettings me={me} />
            <PasswordSettings />
            <MfaSettings />
            <AccountSecurity me={me} show="sessions" />
            <EmailPreferences enabled={Boolean(me.emailPreferencesEnabled)} />
            <DataControls me={me} scope="account" />
        </div>
    );
}
