/**
 * Exit 0 if a Notato server answers /health on this machine, 1 otherwise. For container health checks,
 * where the image has no curl.
 */
export async function runHealthcheck(): Promise<number> {
    const port = process.env.NOTATO_PORT ?? "4747";
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(3000),
        });
        const body = (await res.json()) as { service?: string };
        return res.ok && body.service === "notato" ? 0 : 1;
    } catch {
        return 1;
    }
}
