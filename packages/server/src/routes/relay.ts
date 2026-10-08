import { z } from "zod";
import { RequestError } from "../backend.ts";
import { RelayArgs, RelayError } from "../relay.ts";
import { PROJECT_ID } from "../storage.ts";
import { assertAccess, json, type Routes, readJson, tokenProject } from "./common.ts";

const RelayBody = RelayArgs.extend({
    projectId: z.string().regex(PROJECT_ID).optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).default(60_000),
});

/** A long error (a stack trace) is cut, not refused: refusing it would leave the agent waiting for a timeout instead. */
const RelayResultBody = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), annotationId: z.string().min(1).max(128) }),
    z.object({
        ok: z.literal(false),
        error: z
            .string()
            .max(100_000)
            .transform((e) => e.slice(0, 2000)),
    }),
]);

/**
 * The agent relay over HTTP: an agent attached from another process asks a page to annotate an element
 * (`POST /relay/annotate`), and the page reports what came of it (`POST /relay/:requestId/result`).
 */
export const relayRoutes: Routes = async ({ req, path, method, principal, match }, { backend }) => {
    if (path === "/relay/annotate" && method === "POST") {
        const { projectId, timeoutMs, ...args } = await readJson(req, RelayBody);
        // A project token can only ever reach a page of its own project: naming another one is refused, and leaving
        // it out means its own.
        if (projectId) assertAccess(principal, projectId);
        try {
            return json(
                await backend.requestAnnotation(
                    tokenProject(principal) ?? projectId,
                    args,
                    timeoutMs
                )
            );
        } catch (error) {
            if (error instanceof RelayError) throw new RequestError(error.message, error.status);
            throw error;
        }
    }

    const result = match(/^\/relay\/([^/]+)\/result$/);
    if (result && method === "POST") {
        const requestId = result[0] ?? "";
        const owner = backend.relay.projectOf(requestId);
        if (owner) assertAccess(principal, owner);
        const outcome = await readJson(req, RelayResultBody);
        return backend.relay.complete(requestId, outcome)
            ? json({ ok: true })
            : json({ error: "unknown or already settled request" }, 404);
    }

    return null;
};
