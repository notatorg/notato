/** The header a project token travels in. Empty when no token is configured (dev mode). */
export function authHeaders(token: string | undefined): Record<string, string> {
    return token ? { Authorization: `Bearer ${token}` } : {};
}
