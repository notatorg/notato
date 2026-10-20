import { createHash, timingSafeEqual } from "node:crypto";
import { json } from "@notato/server";
import { isAdmin, type Principal } from "../auth.ts";
import type { CloudRoutes } from "../context.ts";

/**
 * What the service's operators and its container ask of it: `/ready` (the database answers), and `/metrics` for the
 * operator or a monitoring credential. `/health`, `/status`, `/config` and the webhooks are the open server's.
 */
export const monitoringRoutes: CloudRoutes<Principal | null> = async (
    { req, path, method, principal },
    { backend, options, metrics }
) => {
    if (method !== "GET") return null;
    if (path === "/metrics") {
        const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const allowed =
            options.monitoringToken &&
            !req.headers.has("origin") &&
            bearer.length <= 512 &&
            timingSafeEqual(
                createHash("sha256").update(bearer).digest(),
                createHash("sha256").update(options.monitoringToken).digest()
            );
        if (!allowed && (!principal || !isAdmin(principal)))
            return json(
                { error: "operator or monitoring credential required" },
                principal ? 403 : 401
            );
        await metrics?.refresh();
        return new Response(metrics?.render() ?? "", {
            headers: {
                "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
                "Cache-Control": "no-store",
            },
        });
    }
    if (path !== "/ready") return null;
    try {
        await backend.store.getWorkspace("default");
        return json({ ok: true, service: "notato" });
    } catch {
        return json({ ok: false, service: "notato" }, 503);
    }
};
