import { z } from "zod";

export interface BetaPolicy {
    admins: ReadonlySet<string>;
}
export function betaFromEnv(
    env: Record<string, string | undefined> = process.env
): BetaPolicy | undefined {
    if (env.NOTATO_BETA_ENABLED && !["0", "1"].includes(env.NOTATO_BETA_ENABLED))
        throw new Error("NOTATO_BETA_ENABLED must be 0 or 1");
    if (env.NOTATO_BETA_ENABLED !== "1") return undefined;
    const admins = (env.NOTATO_BETA_ADMIN_EMAILS ?? env.NOTATO_ADMIN_EMAIL ?? "")
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    if (!admins.length || admins.length > 20 || admins.some((v) => !z.email().safeParse(v).success))
        throw new Error(
            "Set NOTATO_BETA_ADMIN_EMAILS to the verified emails that may manage beta access"
        );
    return { admins: new Set(admins) };
}
export const betaAdmin = (policy: BetaPolicy | undefined, email?: string) =>
    Boolean(email && policy?.admins.has(email.toLowerCase()));
export const BETA_TOKEN = /^nbeta_[A-Za-z0-9_-]{43}$/;
export function betaCookie(req: Request, secure: boolean): string | undefined {
    const name = secure ? "__Host-notato_beta=" : "notato_beta=";
    return req.headers
        .get("cookie")
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith(name))
        ?.slice(name.length);
}
export function invitationCookie(token: string, secure: boolean, seconds: number): string {
    return `${secure ? "__Host-notato_beta" : "notato_beta"}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}${secure ? "; Secure" : ""}`;
}
/** A bounded, single-instance limiter. IPs stay in memory only and are never part of waitlist records. */
export class BetaLimiter {
    private clients = new Map<string, { time: number; n: number }>();
    private total = { time: 0, n: 0 };
    allow(ip: string, now = Date.now()): boolean {
        if (now - this.total.time >= 60_000) this.total = { time: now, n: 0 };
        if (++this.total.n > 60) return false;
        if (this.clients.size >= 10_000) {
            for (const [key, item] of this.clients)
                if (now - item.time >= 60_000) this.clients.delete(key);
            if (this.clients.size >= 10_000) return false;
        }
        let item = this.clients.get(ip);
        if (!item || now - item.time >= 60_000) {
            item = { time: now, n: 0 };
            this.clients.set(ip, item);
        }
        return ++item.n <= 5;
    }
}
