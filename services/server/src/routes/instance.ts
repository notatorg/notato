import { assertBoard, json, RequestError, readJson } from "@notato/server";
import { z } from "zod";
import { InstanceAuth } from "../better-auth.ts";
import type { CloudRoutes } from "../context.ts";

/** Instance administration is independent of workspace ownership. */
export const instanceRoutes: CloudRoutes = async ({ req, path, method, principal }, { auth }) => {
    if (!path.startsWith("/instance/")) return null;
    const managed = auth.managed;
    if (
        principal.kind !== "member" ||
        !principal.instanceAdmin ||
        !(managed instanceof InstanceAuth)
    )
        throw new RequestError("Instance administrator access required", 403);
    if (path === "/instance/invitations" && method === "POST") {
        assertBoard(req, "instance invitations");
        const { email } = await readJson(req, z.object({ email: z.email().max(254) }).strict());
        await managed.invite(email);
        return json({ sent: true }, 201);
    }
    if (path === "/instance/users" && method === "GET") {
        const result = await managed.auth.api.listUsers({
            headers: req.headers,
            query: { limit: 100 },
        });
        return json({
            items: await Promise.all(
                result.users.map(async ({ id, email, name, role, banned }) => ({
                    id,
                    email,
                    name,
                    role,
                    banned,
                    protected: await managed.isProtectedUser(id),
                }))
            ),
        });
    }
    return null;
};
