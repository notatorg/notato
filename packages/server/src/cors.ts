import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

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
 * Which browser origins a server trusts without their being listed in `NOTATO_CORS_ORIGINS`:
 * - `machine`: pages this machine serves (loopback, `*.localhost` and its own network addresses), and the extension.
 *   For a server without logins (`notato dev`), where a page it trusts can read every note and write ones the agent
 *   acts on, so a page from another device on the network must be listed.
 * - `network`: also any private network (RFC 1918, link-local, CGNAT/Tailscale, unique-local IPv6). For a server
 *   with logins, where every request needs a credential anyway.
 * - `listed`: none. A hosted service has no "this machine" or "this network" to trust.
 */
export type OriginTrust = "machine" | "network" | "listed";

/** Whether `hostname` is one of this machine's own addresses, on the networks it is on now (they change as it moves). */
export function isOwnAddress(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    // Only an IP literal can be one of them; a name is not looked up.
    if (isIP(host) === 0) return false;
    return Object.values(networkInterfaces()).some((addresses) =>
        addresses?.some((a) => a.address.toLowerCase() === host)
    );
}

/** Anything not trusted by default must be listed. CORS is a browser courtesy, not authentication. */
export function originAllowed(
    origin: string,
    extra: string[],
    trust: OriginTrust = "machine"
): boolean {
    if (trust === "listed") return extra.includes(origin);
    if (extra.includes("*") || extra.includes(origin) || origin === EXTENSION_ORIGIN) return true;
    try {
        const { hostname } = new URL(origin);
        if (trust === "network") return isPrivateHost(hostname);
        return isLoopbackName(hostname) || isOwnAddress(hostname);
    } catch {
        return false;
    }
}

export function corsHeaders(
    req: Request,
    extra: string[],
    trust: OriginTrust = "machine"
): Record<string, string> {
    const origin = req.headers.get("origin");
    // Nothing at all for an origin that is not allowed, `Allow-Private-Network` included.
    if (!origin || !originAllowed(origin, extra, trust)) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
            "Content-Type, Authorization, Last-Event-ID, X-Notato-Work-Permit",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
    };
}

/**
 * A multipart POST is a "simple" cross-origin request: browsers send it without a preflight, so CORS
 * headers alone would not stop any web page from writing to a loopback server. Reject the request
 * itself when its Origin is not allowed.
 */
export function writeOriginRejected(
    req: Request,
    extra: string[],
    trust: OriginTrust = "machine"
): boolean {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
    const origin = req.headers.get("origin");
    if (origin === null) return false;
    return !originAllowed(origin, extra, trust) && !sameOrigin(req, origin);
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
