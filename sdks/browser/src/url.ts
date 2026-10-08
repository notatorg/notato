/**
 * What of a URL may be recorded. Query strings and fragments routinely carry secrets: an OAuth `?code=` and `&state=`,
 * a password reset token, an implicit-flow `#access_token=`. A note's URL reaches the agent, webhooks and bundles.
 */

/** Strips query and fragment entirely: for requests the page makes, where only the endpoint matters. */
export function safeUrl(
    input: string,
    base = typeof location === "undefined" ? "http://localhost" : location.href
): string {
    try {
        const u = new URL(input, base);
        return `${u.origin}${u.pathname}`;
    } catch {
        return input.split(/[?#]/)[0] ?? input;
    }
}

const REDACTED = "redacted";

/** Parameter names (or the words in them) that name a credential or a one-time secret more often than not. */
const SECRET_WORDS = new Set([
    "code",
    "state",
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "pass",
    "passcode",
    "auth",
    "authorization",
    "bearer",
    "key",
    "apikey",
    "sig",
    "signature",
    "hmac",
    "session",
    "sessionid",
    "sid",
    "jwt",
    "otp",
    "nonce",
    "ticket",
    "credential",
    "credentials",
    "assertion",
    "verifier",
    "csrf",
    "xsrf",
]);
/** Run-together names: `accesstoken`, `clientsecret`, `xamzsignature`. */
const SECRET_ENDINGS =
    /(token|secret|password|passwd|passcode|signature|credentials?|apikey|sessionid)$/;

function secretName(name: string): boolean {
    const words = name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w.toLowerCase());
    return words.some((w) => SECRET_WORDS.has(w) || SECRET_ENDINGS.test(w) || w.startsWith("saml"));
}

/** A JWT, or a long run of letters and digits with no spaces: what tokens look like, whatever they are called. */
function secretValue(value: string): boolean {
    if (/^eyJ[\w-]+\.[\w-]+(\.[\w-]*)?$/.test(value)) return true;
    return (
        value.length >= 32 &&
        /^[A-Za-z0-9._~+/=-]+$/.test(value) &&
        /[A-Za-z]/.test(value) &&
        /\d/.test(value)
    );
}

const decode = (s: string) => {
    try {
        return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
        return s;
    }
};

/** `a=1&code=xyz`: each secret value replaced, everything else left exactly as it was written. */
function redactParams(raw: string): string {
    return raw
        .split("&")
        .map((part) => {
            const eq = part.indexOf("=");
            if (eq < 0) return secretValue(decode(part)) ? REDACTED : part;
            const name = part.slice(0, eq);
            return secretName(decode(name)) || secretValue(decode(part.slice(eq + 1)))
                ? `${name}=${REDACTED}`
                : part;
        })
        .join("&");
}

/**
 * `#section` stays; `#access_token=…` and a hash route's `#/reset?token=…` lose their secrets. Takes the fragment
 * without its `#`.
 */
export function redactFragment(hash: string): string {
    const q = hash.indexOf("?");
    if (q >= 0) return `${hash.slice(0, q)}?${redactParams(hash.slice(q + 1))}`;
    if (hash.includes("=")) return redactParams(hash);
    return secretValue(decode(hash)) ? REDACTED : hash;
}

/**
 * A URL fit to record: the same URL, with the values of secret-looking query parameters and fragments replaced by
 * `redacted` and any `user:password@` dropped. Harmless parameters (`?tab=settings`) and anchors stay as they were.
 */
export function redactUrl(input: string): string {
    const withoutLogin = input.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, "$1");
    const hashAt = withoutLogin.indexOf("#");
    const beforeHash = hashAt < 0 ? withoutLogin : withoutLogin.slice(0, hashAt);
    const queryAt = beforeHash.indexOf("?");
    let out = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
    if (queryAt >= 0) out += `?${redactParams(beforeHash.slice(queryAt + 1))}`;
    if (hashAt >= 0) out += `#${redactFragment(withoutLogin.slice(hashAt + 1))}`;
    return out;
}
