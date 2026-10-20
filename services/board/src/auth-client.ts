import { adminClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
    plugins: [adminClient(), twoFactorClient()],
    fetchOptions: { headers: { "X-Notato-Board": "1" } },
});
export function authError(error: { message?: string } | null | undefined) {
    if (error) throw new Error(error.message ?? "Could not complete authentication");
}
