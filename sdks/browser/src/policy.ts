import { authHeaders } from "./auth.ts";
import { net } from "./net.ts";

export interface Policy {
    /** Whether a screenshot may be taken right now. Asks the server again when its answer is older than a few seconds. */
    screenshots(): Promise<boolean>;
    /** The last answer, without asking. For labels, where waiting would be wrong. */
    screenshotsNow(): boolean;
    /** Asks the server now. Never throws. */
    refresh(): Promise<void>;
}

const FRESH_MS = 5_000;
const WAIT_MS = 1_500;

/**
 * What the Notato server allows (`notato config`). Allowed until the server says otherwise: an unreachable server
 * cannot be asked, and it enforces its own settings on whatever it is sent anyway, so this only saves taking a
 * screenshot that would be thrown away.
 */
export function createPolicy(options: { baseUrl: string | undefined; token?: string }): Policy {
    let allowed = true;
    let askedAt = 0;
    let pending: Promise<void> | undefined;

    const refresh = (): Promise<void> => {
        if (!options.baseUrl) return Promise.resolve();
        pending ??= (async () => {
            try {
                const res = await net.fetch(`${options.baseUrl}/config`, {
                    headers: authHeaders(options.token),
                });
                if (res.ok) {
                    const body = (await res.json()) as { screenshots?: unknown };
                    if (typeof body.screenshots === "boolean") allowed = body.screenshots;
                }
            } catch {
                // keep the last answer
            } finally {
                askedAt = Date.now();
                pending = undefined;
            }
        })();
        return pending;
    };

    return {
        refresh,
        screenshotsNow: () => allowed,
        async screenshots() {
            if (Date.now() - askedAt > FRESH_MS) {
                // A slow server must not hold up the annotation: stop waiting and go with what is known.
                await Promise.race([
                    refresh(),
                    new Promise<void>((resolve) => setTimeout(resolve, WAIT_MS)),
                ]);
            }
            return allowed;
        },
    };
}
