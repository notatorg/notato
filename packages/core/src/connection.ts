/** Portable checkout connection. Agent credentials must never be passed to a browser. */
export interface CheckoutConnection {
    version: 1;
    name: string;
    mode: "local" | "remote";
    server: string;
    project?: string;
    context?: { id: string; name: string; branch?: string };
    appToken?: string;
    agentToken?: string;
}
export interface BrowserConnection {
    name: string;
    mode: "local" | "remote";
    server: string;
    project?: string;
    context?: CheckoutConnection["context"];
    token?: string;
}
export function connectionOrigin(raw: string, local = false): string {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error("Invalid connection server origin.");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (
        u.port === "0" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== "/" ||
        (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) ||
        (local && (!loopback || u.protocol !== "http:"))
    )
        throw new Error("Use an HTTPS server origin, or loopback HTTP for local development.");
    return u.origin;
}
export function parseCheckoutConnection(value: unknown): CheckoutConnection {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid connection profile.");
    const c = value as Record<string, unknown>;
    const string = (v: unknown, max: number) =>
        typeof v === "string" &&
        v.length > 0 &&
        v.length <= max &&
        !Array.from(v).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
    if (
        c.version !== 1 ||
        !string(c.name, 120) ||
        !["local", "remote"].includes(String(c.mode)) ||
        typeof c.server !== "string"
    )
        throw new Error("Invalid connection profile version, name or destination.");
    if (
        c.project !== undefined &&
        (typeof c.project !== "string" || !/^(?!\.+$)[\w.@-]{1,200}$/.test(c.project))
    )
        throw new Error("Invalid connection project.");
    const context = c.context as CheckoutConnection["context"];
    if (
        c.mode === "remote" &&
        (!c.project ||
            !context ||
            !string(context.id, 200) ||
            !string(context.name, 120) ||
            (context.branch !== undefined && !string(context.branch, 200)) ||
            !string(c.appToken, 4096) ||
            !string(c.agentToken, 4096) ||
            c.appToken === c.agentToken)
    )
        throw new Error(
            "A remote profile needs a project, checkout and separate app and agent keys."
        );
    if (c.mode === "local" && (c.appToken || c.agentToken || c.context))
        throw new Error("Local profiles cannot contain remote credentials.");
    return {
        version: 1,
        name: c.name as string,
        mode: c.mode as CheckoutConnection["mode"],
        server: connectionOrigin(c.server, c.mode === "local"),
        ...(c.project ? { project: c.project as string } : {}),
        ...(c.mode === "remote"
            ? {
                  context: {
                      id: context!.id,
                      name: context!.name,
                      ...(context!.branch ? { branch: context!.branch } : {}),
                  },
                  appToken: c.appToken as string,
                  agentToken: c.agentToken as string,
              }
            : {}),
    };
}
export function browserConnection(c: CheckoutConnection): BrowserConnection {
    return {
        name: c.name,
        mode: c.mode,
        server: c.server,
        ...(c.project ? { project: c.project } : {}),
        ...(c.context ? { context: c.context } : {}),
        ...(c.appToken ? { token: c.appToken } : {}),
    };
}
