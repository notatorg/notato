import { sampleAnnotation } from "@notato/schema";
import { z } from "zod";
import { canAccessProject, isAdmin, type Principal } from "../auth.ts";
import { buildDelivery, secretOf, sendDelivery } from "../webhooks.ts";
import { json, type Routes, readJson } from "./common.ts";

/** What answers `/health`: how a second `notato dev` (and `notato doctor`) knows the port is a Notato server. */
const HEALTH = { ok: true, service: "notato" } as const;

/** `GET /health`, which anyone may ask. */
export const healthRoute: Routes<Principal | null> = async ({ path, method }) =>
    path === "/health" && method === "GET" ? json(HEALTH) : null;

const WebhookTestBody = z.object({ index: z.number().int().min(0) }).strict();

/**
 * What the server is and how it is set up: `/config` for a page about to capture, `/status` for the board, and the
 * webhooks for an admin (what and how, never where or with what secret).
 */
export const statusRoutes: Routes = async ({ req, url, path, method, principal }, app) => {
    const { backend, options } = app;

    if (path === "/config" && method === "GET") {
        // What a page needs to know before it captures anything (the server enforces it either way), and whether an
        // agent is connected, for the page to say so.
        return json({
            screenshots: backend.config().screenshots,
            agent: backend.agents.stateFor(url.searchParams.get("project") ?? undefined),
            mentions: backend.mentions.list(),
        });
    }

    if (path === "/status" && method === "GET") {
        const projects = await backend.store.listProjects();
        const config = backend.config();
        return json({
            ...HEALTH,
            version: options.version,
            mode: options.mode,
            mcpUrl: options.mcpUrl,
            uptimeSec: Math.round((Date.now() - app.startedAt) / 1000),
            watchers: backend.bus.size,
            pages: app.streams.open,
            agents: backend.agents.state,
            mentions: backend.mentions.list(),
            agentProjects: backend.relay.projects().filter((p) => canAccessProject(principal, p)),
            projects: projects.filter((p) => canAccessProject(principal, p.id)),
            config: {
                screenshots: config.screenshots ? "on" : "off",
                source: config.source.screenshots,
                mcp: config.mcp ? "on" : "off",
                mcpSource: config.source.mcp,
                file: config.file,
                error: config.error,
                webhooks: config.webhooks.length,
            },
        });
    }

    if (path === "/webhooks" && method === "GET") {
        if (!isAdmin(principal)) return json({ error: "only an admin can see the webhooks" }, 403);
        const config = backend.config();
        return json({
            items: config.webhooks.map((w, index) => ({
                index,
                name: w.name ?? new URL(w.url).host,
                // The URL itself is a secret for many services (a Slack webhook is one), so only the host is shown.
                host: new URL(w.url).host,
                format: w.format,
                events: w.events ?? null,
                project: w.project ?? null,
                signed: w.secret !== undefined,
            })),
            error: config.error ?? null,
        });
    }

    if (path === "/webhooks/test" && method === "POST") {
        if (!isAdmin(principal)) return json({ error: "only an admin can send a test" }, 403);
        const { index } = await readJson(req, WebhookTestBody);
        const hook = backend.config().webhooks[index];
        if (!hook) return json({ error: "no such webhook" }, 404);
        const secret = secretOf(hook);
        if (secret === null) {
            return json(
                {
                    error: `${hook.secret} is not set where the server runs, so a signed test cannot be sent`,
                },
                409
            );
        }
        const sample = {
            ...sampleAnnotation,
            comment: "This is a test event from Notato. Nothing is wrong.",
        };
        const log: string[] = [];
        // Tried once: whoever pressed the button is waiting for the answer.
        const ok = await sendDelivery(
            hook,
            buildDelivery(hook, "annotation.created", sample, secret),
            { retryDelaysMs: [], log: (m) => log.push(m) }
        );
        return json({
            ok,
            detail: ok
                ? "The other end answered with success."
                : (log[0] ?? "It did not get through."),
        });
    }

    return null;
};
