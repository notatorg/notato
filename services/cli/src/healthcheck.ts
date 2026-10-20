import { localServer } from "@notato/cli";

/**
 * Exit 0 if a Notato server is ready on this machine, 1 otherwise. For container health checks,
 * where the image has no curl.
 */
export async function runHealthcheck(): Promise<number> {
    try {
        // A container probe connects to the backend's loopback address, bypassing its TLS proxy.
        // Supply the trusted proxy's scheme only in deployments that explicitly trust that header.
        const res = await fetch(
            `${localServer({ ...process.env, NOTATO_PORT: process.env.NOTATO_PORT ?? "4799" })}/ready`,
            {
                signal: AbortSignal.timeout(3000),
                ...(process.env.NOTATO_TRUST_PROXY === "1"
                    ? { headers: { "X-Forwarded-Proto": "https" } }
                    : {}),
            }
        );
        const body = (await res.json()) as { service?: string };
        return res.ok && body.service === "notato" ? 0 : 1;
    } catch {
        return 1;
    }
}
