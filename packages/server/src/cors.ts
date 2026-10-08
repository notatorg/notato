/** True for loopback, RFC 1918, link-local, CGNAT (Tailscale) and unique-local IPv6 addresses, and `localhost`. */
export function isPrivateHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host === "::1" || host === "::ffff:127.0.0.1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!v4) return false;
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return a === 100 && b >= 64 && b <= 127;
}

/**
 * The Notato browser extension, as an unpacked build knows itself (the id follows from the public key in its manifest).
 * It makes its requests from its background worker, so this is the origin the server sees. A build from a store has
 * its own id, which has to be listed in `NOTATO_CORS_ORIGINS` like any other.
 */
export const EXTENSION_ORIGIN = "chrome-extension://djdcdahjkmfgehlpecoiknfdomfojmdc";

export function parseExtraOrigins(value: string | undefined): string[] {
    return (value ?? "")
        .split(",")
        .map((s) => s.trim().replace(/\/$/, ""))
        .filter(Boolean);
}

/**
 * Loopback and private-network origins are allowed by default; anything else must be listed in
 * `NOTATO_CORS_ORIGINS`. CORS is a browser courtesy, not authentication: in serve mode every write
 * still needs a project token.
 */
export function originAllowed(origin: string, extra: string[]): boolean {
    if (extra.includes("*") || extra.includes(origin) || origin === EXTENSION_ORIGIN) return true;
    try {
        return isPrivateHost(new URL(origin).hostname);
    } catch {
        return false;
    }
}

export function corsHeaders(req: Request, extra: string[]): Record<string, string> {
    const origin = req.headers.get("origin");
    if (!origin || !originAllowed(origin, extra)) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
    };
}

/**
 * A multipart POST is a "simple" cross-origin request: browsers send it without a preflight, so CORS
 * headers alone would not stop any web page from writing to a loopback server. Reject the request
 * itself when its Origin is not allowed.
 */
export function writeOriginRejected(req: Request, extra: string[]): boolean {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
    const origin = req.headers.get("origin");
    if (origin === null) return false;
    return !originAllowed(origin, extra) && !sameOrigin(req, origin);
}

/** The page that sent the request was served by this very server, like the board UI. */
export function sameOrigin(req: Request, origin: string): boolean {
    const host = req.headers.get("host");
    if (!host) return false;
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

/** Guards against DNS rebinding: a loopback-only server should only answer to loopback host names. */
export function hostAllowed(req: Request, allowed: "loopback" | "any" | string[]): boolean {
    if (allowed === "any") return true;
    const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
    if (!host) return false;
    if (Array.isArray(allowed)) return allowed.includes(host) || isLoopbackName(host);
    return isLoopbackName(host);
}

export function isLoopbackName(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    return (
        h === "localhost" ||
        h.endsWith(".localhost") ||
        h === "::1" ||
        /^127\.\d+\.\d+\.\d+$/.test(h)
    );
}
