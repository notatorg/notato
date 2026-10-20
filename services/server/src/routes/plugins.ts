import { createHash, randomBytes } from "node:crypto";
import { assertBoard, json, RequestError, readJson } from "@notato/server";
import { z } from "zod";
import type { CloudRoutes } from "../context.ts";
import {
    ActionEditInput,
    ActionInput,
    CATALOG,
    ConnectionInput,
    decrypt,
    encrypt,
    PluginError,
    Provider,
    WorkflowEditInput,
} from "../plugins/model.ts";
import { githubInstallUrl, oauthAuthorize, oauthConfig, oauthToken } from "../plugins/oauth.ts";
import { ProviderError } from "../plugins/providers.ts";
import { type PluginOptions, PluginService } from "../plugins/service.ts";

const services = new WeakMap<object, PluginService>();
export function pluginsFor(
    backend: Parameters<CloudRoutes>[1]["backend"],
    origin: string,
    options?: PluginOptions
) {
    let value = services.get(backend);
    if (!value) {
        value = new PluginService(
            backend,
            origin,
            options?.key,
            options?.providers,
            options?.oauthHttp
        );
        services.set(backend, value);
    }
    return value;
}
export const pluginRoutes: CloudRoutes = async (
    { req, path, method, principal, match, url },
    { backend, options }
) => {
    if (!path.startsWith("/plugins")) return null;
    if (principal.kind !== "member") throw new RequestError("Workspace sign-in required.", 403);
    const workspace = principal.workspaceId;
    const service = pluginsFor(
        backend,
        options.publicOrigin ?? new URL(req.url).origin,
        options.plugins
    );
    const repository = backend.store.plugins;
    if (!repository) throw new RequestError("Plugins are unavailable.", 503);
    const membership = await repository.membership(workspace, principal.username);
    if (!membership) throw new RequestError("Workspace access is no longer available.", 403);
    const manager = membership.role !== "member";
    if (method !== "GET") assertBoard(req, "plugins");
    if (path === "/plugins" && method === "GET") {
        const connections = await repository.connections(workspace);
        return json({
            configured: Boolean(service.key),
            catalog: CATALOG.map((p) => ({ ...p, oauth: Boolean(oauthConfig(p.id)) })),
            manager,
            githubInstallUrl: githubInstallUrl(),
            connections: connections.map(({ encrypted: _secret, ...c }) => c),
            actions: await repository.actions(workspace),
            workflows: await repository.workflows(workspace),
            history: (await repository.history(workspace, principal.username)).map(
                ({ payload: _payload, ...j }) => j
            ),
            limits: await service.allowance(workspace),
            used: await repository.usage(workspace, new Date().toISOString().slice(0, 7)),
        });
    }
    try {
        service.ready();
        const oauth = match(/^\/plugins\/oauth\/([a-z]+)\/start$/);
        if (oauth && method === "GET") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            const provider = Provider.parse(oauth[0]);
            const reconnect = url.searchParams.get("connection");
            const replacing = reconnect
                ? await repository.connection(workspace, z.uuid().parse(reconnect))
                : null;
            if (reconnect && (!replacing || replacing.provider !== provider))
                throw new RequestError("Connection unavailable.", 404);
            const state = randomBytes(32).toString("base64url");
            const redirect = `${service.origin}/plugins/oauth/callback`;
            const started = oauthAuthorize(provider, redirect, state);
            const { key } = service.ready();
            const hash = createHash("sha256").update(state).digest("hex");
            await repository.oauthState(
                hash,
                workspace,
                principal.username,
                provider,
                encrypt(
                    JSON.stringify({
                        verifier: started.verifier,
                        ...(replacing
                            ? { replacing: { id: replacing.id, revision: replacing.revision } }
                            : {}),
                    }),
                    key,
                    `oauth:${workspace}:${principal.username}:${provider}`
                )
            );
            return new Response(null, {
                status: 303,
                headers: {
                    Location: started.url,
                    "Cache-Control": "no-store",
                    "Referrer-Policy": "no-referrer",
                },
            });
        }
        if (path === "/plugins/oauth/callback" && method === "GET") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            const state = url.searchParams.get("state") ?? "",
                code = url.searchParams.get("code") ?? "";
            if (
                !/^[\w-]{43}$/.test(state) ||
                (!code && !url.searchParams.has("error")) ||
                code.length > 4096
            )
                throw new RequestError("The connection was not authorized. Start again.");
            const pending = await repository.consumeOAuth(
                createHash("sha256").update(state).digest("hex"),
                workspace,
                principal.username
            );
            if (!pending)
                throw new RequestError(
                    "The connection request expired or belongs to another session."
                );
            const provider = Provider.parse(pending.provider);
            const { key } = service.ready();
            if (url.searchParams.has("error"))
                return new Response(null, {
                    status: 303,
                    headers: {
                        Location: `${service.origin}/#/x/plugins/authorization-canceled`,
                        "Cache-Control": "no-store",
                        "Referrer-Policy": "no-referrer",
                    },
                });
            const decoded = decrypt(
                pending.verifier,
                key,
                `oauth:${workspace}:${principal.username}:${provider}`
            );
            const authorization = decoded.startsWith("{")
                ? z
                      .object({
                          verifier: z.string().min(1),
                          replacing: z
                              .object({ id: z.uuid(), revision: z.string().optional() })
                              .optional(),
                      })
                      .parse(JSON.parse(decoded))
                : { verifier: decoded };
            const token = await oauthToken(
                provider,
                {
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: `${service.origin}/plugins/oauth/callback`,
                    code_verifier: authorization.verifier,
                },
                service.oauthHttp
            );
            const id = await service.connectOAuth(
                workspace,
                provider,
                token,
                principal.username,
                authorization.replacing
            );
            return new Response(null, {
                status: 303,
                headers: {
                    Location: `${service.origin}/#/x/plugins/${authorization.replacing ? "reconnected" : "setup"}/${id}`,
                    "Cache-Control": "no-store",
                    "Referrer-Policy": "no-referrer",
                },
            });
        }
        if (path === "/plugins/connections" && method === "POST") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            const input = await readJson(req, ConnectionInput);
            return json({ id: await service.connect(workspace, input, principal.username) }, 201);
        }
        const connection = match(/^\/plugins\/connections\/([\w-]+)$/);
        const reconnect = match(/^\/plugins\/connections\/([\w-]+)\/reconnect$/);
        const check = match(/^\/plugins\/connections\/([\w-]+)\/check$/);
        if ((reconnect || check) && method === "POST") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            const id = (reconnect ?? check)?.[0] ?? "";
            const c = await repository.connection(workspace, id);
            if (!c) throw new RequestError("Connection unavailable.", 404);
            if (check) return json(await service.checkConnection(workspace, id));
            const input = await readJson(req, ConnectionInput);
            if (input.provider !== c.provider)
                throw new RequestError("Reconnect using the same provider.");
            await service.connect(workspace, { ...input, name: c.name }, principal.username, {
                id: c.id,
                revision: c.revision,
            });
            return json({ id: c.id });
        }
        const destinations = match(/^\/plugins\/connections\/([\w-]+)\/destinations$/);
        if (destinations && method === "GET") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            const query = z
                .object({
                    organization: z
                        .string()
                        .regex(/^[\w-]{1,100}$/)
                        .optional(),
                    project: z.string().min(1).max(200).optional(),
                })
                .strict()
                .parse(Object.fromEntries(url.searchParams));
            const c = await repository.connection(workspace, destinations[0] ?? "");
            if (!c || c.revoked) throw new RequestError("Connection unavailable.", 404);
            return json({
                items: await service.providers.destinations(
                    c.provider,
                    await service.secret(c),
                    query.organization,
                    query.project
                ),
            });
        }
        if (connection && method === "PATCH") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            const input = await readJson(
                req,
                z.object({ name: z.string().trim().min(1).max(120) }).strict()
            );
            const c = await repository.connection(workspace, connection[0] ?? "");
            if (!c) throw new RequestError("Connection not found.", 404);
            await repository.renameConnection(workspace, c.id, input.name, principal.username);
            return json({ ok: true });
        }
        if (connection && method === "DELETE") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            const c = await repository.connection(workspace, connection[0] ?? "");
            if (!c) throw new RequestError("Connection not found.", 404);
            await repository.saveConnection(
                { ...c, revoked: true, encrypted: "", revision: crypto.randomUUID() },
                principal.username
            );
            return json({ ok: true });
        }
        if (path === "/plugins/actions" && method === "POST") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            const input = await readJson(req, ActionInput);
            const id = crypto.randomUUID();
            await service.saveAction({
                ...input,
                id,
                workspaceId: workspace,
                creator: principal.username,
                updatedAt: new Date().toISOString(),
            });
            return json({ id }, 201);
        }
        const archived = match(/^\/plugins\/actions\/([\w-]+)$/);
        if (archived && method === "PATCH") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            await service.editAction(
                workspace,
                archived[0] ?? "",
                await readJson(req, ActionEditInput),
                principal.username
            );
            return json({ ok: true });
        }
        if (archived && method === "DELETE") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            if (!(await repository.action(workspace, archived[0] ?? "")))
                throw new RequestError("Action not found.", 404);
            await repository.archiveAction(workspace, archived[0] ?? "", principal.username);
            return json({ ok: true });
        }
        const cancel = match(/^\/plugins\/jobs\/([\w-]+)\/cancel$/);
        if (cancel && method === "POST") {
            const j = await repository.job(workspace, cancel[0] ?? "", principal.username);
            if (!j) throw new RequestError("Delivery not found.", 404);
            if (!manager && j.actor !== principal.username)
                throw new RequestError(
                    "Only the sender or a workspace manager may cancel this delivery.",
                    403
                );
            if (!(await repository.cancel(workspace, j.id, principal.username)))
                throw new RequestError("This delivery has already started or finished.", 409);
            return json({ ok: true });
        }
        if (["/plugins/preview", "/plugins/run"].includes(path) && method === "POST") {
            const input = await readJson(
                req,
                z
                    .object({
                        actionId: z.uuid(),
                        noteId: z.string().min(1).max(200),
                        hash: z
                            .string()
                            .regex(/^[0-9a-f]{64}$/)
                            .optional(),
                        requestId: z.uuid().optional(),
                    })
                    .strict()
            );
            if (path === "/plugins/preview")
                return json(
                    await service.preview(
                        workspace,
                        input.actionId,
                        input.noteId,
                        principal.username
                    )
                );
            if (!input.hash || !input.requestId)
                throw new RequestError("Preview this action before sending.");
            const id = await service.enqueue(
                workspace,
                principal.username,
                input.actionId,
                input.noteId,
                input.hash,
                input.requestId
            );
            return json({ id }, 202);
        }
        if (path === "/plugins/link" && method === "POST") {
            const input = await readJson(
                req,
                z
                    .object({
                        actionId: z.uuid(),
                        noteId: z.string().min(1).max(200),
                        url: z.url().max(2000),
                    })
                    .strict()
            );
            return json(
                await service.link(
                    workspace,
                    input.actionId,
                    input.noteId,
                    input.url,
                    principal.username
                )
            );
        }
        const review = match(/^\/plugins\/jobs\/([\w-]+)\/review$/);
        if (review && method === "POST") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            const input = await readJson(
                req,
                z
                    .object({
                        delivered: z.boolean(),
                        confirmed: z.literal(true),
                        url: z.url().max(2000).optional(),
                    })
                    .strict()
            );
            await service.review(
                workspace,
                review[0] ?? "",
                input.delivered,
                input.url,
                principal.username
            );
            return json({ ok: true });
        }
        const workflow = match(/^\/plugins\/workflows\/([\w-]+)$/);
        if ((path === "/plugins/workflows" || workflow) && method === "POST") {
            if (!manager) throw new RequestError("Workspace owner or admin required.", 403);
            const { expectedUpdatedAt, ...input } = await readJson(req, WorkflowEditInput);
            const known = workflow
                ? (await repository.workflows(workspace)).find((w) => w.id === workflow[0])
                : undefined;
            if (workflow && !known) throw new RequestError("Workflow not found.", 404);
            const id = known?.id ?? crypto.randomUUID();
            await service.saveWorkflow(
                {
                    ...input,
                    id,
                    workspaceId: workspace,
                    creator: known?.creator ?? principal.username,
                    createdAt: known?.createdAt ?? new Date().toISOString(),
                },
                expectedUpdatedAt,
                principal.username
            );
            return json({ id }, known ? 200 : 201);
        }
        return null;
    } catch (error) {
        if (error instanceof RequestError) throw error;
        if (error instanceof PluginError) throw new RequestError(error.message, error.status);
        if (error instanceof ProviderError)
            throw new RequestError(error.message, error.disposition === "retry" ? 503 : 400);
        if (error instanceof z.ZodError)
            throw new RequestError("Check the plugin settings and try again.", 400);
        throw new RequestError(
            "The plugin action could not be completed. Please try again shortly.",
            500
        );
    }
};
