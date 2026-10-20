import { createHash, randomBytes } from "node:crypto";
import type { Provider } from "./model.ts";
import { PluginError } from "./model.ts";
import type { Credential } from "./providers.ts";
import { type Http, publicFetch } from "./transport.ts";

const CONFIG = {
    github: {
        authorize: "https://github.com/login/oauth/authorize",
        token: "https://github.com/login/oauth/access_token",
        scope: "offline_access",
    },
    azure: {
        authorize: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
        token: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
        scope: "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access",
    },
    slack: {
        authorize: "https://slack.com/oauth/v2/authorize",
        token: "https://slack.com/api/oauth.v2.access",
        scope: "chat:write,channels:read,groups:read",
    },
    linear: {
        authorize: "https://linear.app/oauth/authorize",
        token: "https://api.linear.app/oauth/token",
        scope: "read,write",
    },
    gitlab: {
        authorize: "https://gitlab.com/oauth/authorize",
        token: "https://gitlab.com/oauth/token",
        scope: "api",
    },
} as const;
export function oauthConfig(provider: Provider) {
    if (!(provider in CONFIG)) return null;
    const id = process.env[`NOTATO_${provider.toUpperCase()}_CLIENT_ID`],
        secret = process.env[`NOTATO_${provider.toUpperCase()}_CLIENT_SECRET`];
    return id && secret ? { ...CONFIG[provider as keyof typeof CONFIG], id, secret } : null;
}
export function githubInstallUrl(value = process.env.NOTATO_GITHUB_APP_SLUG) {
    return value && /^[a-z0-9][a-z0-9-]{0,99}$/i.test(value)
        ? `https://github.com/apps/${value}/installations/new`
        : null;
}
export function oauthAuthorize(provider: Provider, redirect: string, state: string) {
    const config = oauthConfig(provider);
    if (!config) throw new PluginError("This provider's sign-in is not configured.");
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(config.authorize);
    url.search = new URLSearchParams({
        client_id: config.id,
        redirect_uri: redirect,
        state,
        response_type: "code",
        ...(config.scope ? { scope: config.scope } : {}),
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
    }).toString();
    return { url: url.href, verifier };
}
export async function oauthToken(
    provider: Provider,
    fields: Record<string, string>,
    http: Http = publicFetch
): Promise<Credential> {
    const config = oauthConfig(provider);
    if (!config) throw new PluginError("This provider's sign-in is not configured.");
    const response = await http(config.token, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: new URLSearchParams({
            client_id: config.id,
            client_secret: config.secret,
            ...fields,
        }).toString(),
    });
    if (!response.ok)
        throw new PluginError(
            "The provider could not authorize this connection. Reconnect and try again."
        );
    const token = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: unknown;
        ok?: boolean;
    };
    if (
        token.error ||
        token.ok === false ||
        typeof token.access_token !== "string" ||
        token.access_token.length > 16000
    )
        throw new PluginError("The provider did not authorize this connection.");
    return {
        token: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : undefined,
        oauth: true,
    };
}
