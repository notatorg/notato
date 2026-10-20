import {
    assertBoard,
    json,
    notFound,
    PROJECT_ID,
    RequestError,
    readJson,
    tokenPurpose,
} from "@notato/server";
import { z } from "zod";
import type { CloudRoutes } from "../context.ts";
import { FREE_PLAN, planLimits } from "../plans.ts";
import { DEFAULT_WORKSPACE_ID } from "../storage.ts";

/** The only workspace-data surface available during recovery. Every cleanup mutation is owner-only and scoped. */
export const recoveryRoutes: CloudRoutes = async (
    { req, path, method, principal, url },
    { auth, backend, options }
) => {
    if (!path.startsWith("/billing/recovery")) return null;
    if (!auth || principal.kind !== "member")
        throw new RequestError("workspace sign-in required", 403);
    if (!options.workspacePlans && !options.testPlans)
        throw new RequestError("workspace plans are disabled", 403);
    const workspaceId = principal.workspaceId;
    const owner =
        (await auth.store.getMembership(workspaceId, principal.username))?.role === "owner";
    const archive = /^\/billing\/recovery\/projects\/([^/]+)\/(notes|export)$/.exec(path);
    if (archive && method === "GET") {
        if (!owner) throw new RequestError("workspace owner required", 403);
        const projectId = decodeURIComponent(archive[1] ?? "");
        if ((await backend.store.getProject(projectId))?.workspaceId !== workspaceId)
            return notFound();
        if (archive[2] === "export") {
            const exported = await backend.exportBundle({
                projectId,
                filter: { feedbackScope: "all", feedbackActorId: principal.username },
            });
            return exported
                ? new Response(exported.zip, {
                      headers: {
                          "Content-Type": "application/zip",
                          "Content-Disposition": `attachment; filename="${exported.filename}"`,
                          "Cache-Control": "private, no-store",
                      },
                  })
                : notFound();
        }
        const checked = z.coerce
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .safeParse(url.searchParams.get("after") ?? 0);
        if (!checked.success) throw new RequestError("Invalid archive cursor.", 400);
        const after = checked.data;
        const items = await backend.store.listAnnotations({
            projectId,
            feedbackScope: "all",
            feedbackActorId: principal.username,
            afterSeq: after,
            limit: 50,
        });
        return json({ items, next: items.length === 50 ? items.at(-1)?.seq : undefined });
    }
    const archiveAsset = /^\/billing\/recovery\/assets\/([a-f0-9]{64})$/.exec(path);
    if (archiveAsset && method === "GET") {
        if (!owner) throw new RequestError("workspace owner required", 403);
        const project = url.searchParams.get("project") ?? "",
            asset = archiveAsset[1] ?? "";
        if (
            (await backend.store.getProject(project))?.workspaceId !== workspaceId ||
            !(
                await backend.store.projectsWithAsset(asset, {
                    feedbackScope: "all",
                    feedbackActorId: principal.username,
                })
            ).includes(project)
        )
            return notFound();
        const file = await backend.blobs.get(asset);
        return file
            ? new Response(new Uint8Array(file.bytes), {
                  headers: {
                      "Content-Type": file.mime,
                      "Cache-Control": "private, no-store",
                      "X-Content-Type-Options": "nosniff",
                  },
              })
            : notFound();
    }
    if (path === "/billing/recovery" && method === "GET") {
        const state = await backend.store.getBilling(workspaceId);
        const locked =
            options.workspacePlans &&
            (await backend.store.getWorkspaceEntitlement(workspaceId)).locked;
        const basic = {
            owner,
            locked: Boolean(locked),
            workspace: await auth.store.getWorkspace(workspaceId),
            freeLimits: planLimits(FREE_PLAN),
            testPlans: Boolean(options.testPlans),
            billingEnabled: Boolean(options.billing),
            hasCustomer: Boolean(state),
            status: options.testPlans ? "test" : (state?.status ?? "free"),
            periodEnd: state?.periodEnd,
        };
        if (!owner) return json(basic);
        const checked = z
            .object({
                project: z.string().regex(PROJECT_ID).optional(),
                before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
            })
            .safeParse(Object.fromEntries(url.searchParams));
        if (!checked.success) throw new RequestError("invalid cleanup pagination or project");
        const query = checked.data;
        const inventory = await backend.store.workspaceCleanup(
            workspaceId,
            principal.username,
            query.project,
            query.before
        );
        const tokens = (await auth.store.listTokens(workspaceId)).filter(
            (t) =>
                t.workspaceId === workspaceId &&
                !t.revokedAt &&
                (!t.expiresAt || t.expiresAt > new Date().toISOString())
        );
        const members = await Promise.all(
            (await auth.store.listWorkspaceMembers(workspaceId)).map(async (member) => ({
                username: member.username,
                role: member.role,
                name: (await auth.store.getUser(member.username))?.displayName ?? member.username,
            }))
        );
        const usage = await backend.store.workspaceUsage(workspaceId),
            limits = planLimits(FREE_PLAN);
        const requirements = [
            {
                id: "subscription",
                step: 0,
                label: "Subscription",
                met: Boolean(
                    options.testPlans ||
                        !state?.subscriptionId ||
                        ["free", "canceled", "incomplete_expired"].includes(state.status)
                ),
                message: "Cancel the subscription in Manage subscription before activating Free.",
            },
            {
                id: "workspace",
                step: 0,
                label: "One Free workspace",
                met: !inventory.otherFreeWorkspace,
                message: `Your Free allowance is used by ${inventory.otherFreeWorkspace?.name ?? "another workspace"}. Delete or upgrade that workspace, or keep this workspace paid.`,
            },
            {
                id: "projects",
                step: 1,
                label: "Projects",
                current: usage.projects,
                limit: limits.projects,
                met: usage.projects <= limits.projects,
                message: `Keep at most one project (${usage.projects} currently).`,
            },
            {
                id: "storage",
                step: 1,
                label: "Storage",
                current: usage.bytes,
                limit: limits.bytes,
                met: usage.bytes <= limits.bytes,
                message: "Remove notes or projects until stored data is at most 250 MB.",
            },
            {
                id: "members",
                step: 2,
                label: "People",
                current: members.length,
                limit: 1,
                met: members.length === 1 && members[0]?.username === principal.username,
                message: "Remove everyone else: Free workspaces are private.",
            },
            {
                id: "tokens",
                step: 3,
                label: "Active keys",
                current: tokens.length,
                limit: limits.tokens,
                met: tokens.length <= limits.tokens,
                message: `Keep at most ${limits.tokens} active app/tester and agent keys combined (${tokens.length} currently).`,
            },
        ];
        const blockers = requirements.filter((r) => !r.met).map((r) => r.message);
        const deletionChoices = await Promise.all(
            [basic.workspace, inventory.otherFreeWorkspace]
                .filter((w) => w !== null)
                .map(async (w) => {
                    const billing = await backend.store.getBilling(w.id);
                    const reason =
                        w.id === DEFAULT_WORKSPACE_ID
                            ? "The server's default workspace cannot be deleted. You can delete its projects and notes instead."
                            : billing?.subscriptionId &&
                                !["free", "canceled", "incomplete_expired"].includes(billing.status)
                              ? "Cancel this workspace's subscription before deleting it."
                              : undefined;
                    return { id: w.id, name: w.name, canDelete: !reason, reason };
                })
        );
        return json({
            ...basic,
            ...inventory,
            usage,
            members,
            tokens: tokens.map((t) => ({
                id: t.id,
                name: t.name,
                projectId: t.projectId,
                permission: t.permission ?? "full",
                purpose: tokenPurpose(t),
            })),
            monthlyNotes: await backend.store.monthlyNoteUsage(workspaceId),
            blockers,
            requirements,
            deletionChoices,
            canConvert: blockers.length === 0,
        });
    }
    if (method !== "POST") return null;
    assertBoard(req, "workspace recovery");
    if (!owner) throw new RequestError("workspace owner required", 403);
    if (path === "/billing/recovery/delete-workspace") {
        const body = await readJson(
            req,
            z
                .object({
                    workspaceId: z.string().regex(PROJECT_ID),
                    confirm: z.string().min(1).max(200),
                    password: z.string().max(1000).optional(),
                    accessToken: z.string().max(20_000).optional(),
                })
                .strict()
        );
        // Only the selected workspace or the owner's conflicting Free workspace is in scope.
        const inventory = await backend.store.workspaceCleanup(workspaceId, principal.username);
        if (
            body.workspaceId !== workspaceId &&
            body.workspaceId !== inventory.otherFreeWorkspace?.id
        )
            return notFound();
        const target = await auth.store.getWorkspace(body.workspaceId);
        if (
            !target ||
            (await auth.store.getMembership(target.id, principal.username))?.role !== "owner"
        )
            return notFound();
        if (body.confirm !== target.name)
            throw new RequestError("type the workspace name to confirm deletion");
        if (!(await auth.reauthenticate(principal, body.password, body.accessToken)))
            throw new RequestError(
                "verify your current password or sign in again before deleting this workspace",
                403
            );
        // The store transaction rechecks ownership and cancellation, and preserves account usage receipts.
        if (!(await backend.deleteWorkspace(target.id, principal.username))) return notFound();
        return json({ ok: true, currentDeleted: target.id === workspaceId });
    }
    if (path === "/billing/recovery/complete") {
        const { confirm } = await readJson(
            req,
            z.object({ confirm: z.string().min(1).max(200) }).strict()
        );
        const workspace = await auth.store.getWorkspace(workspaceId);
        if (!workspace || confirm !== workspace.name)
            throw new RequestError("type the workspace name to confirm conversion");
        // The store transaction rechecks ownership, subscription state, the account's Free slot, and all capacity.
        return json(
            await backend.store.selectWorkspacePlan(workspaceId, principal.username, "free", 0)
        );
    }
    if (path === "/billing/recovery/cleanup") {
        const body = await readJson(
            req,
            z
                .object({
                    kind: z.enum(["project", "note", "token", "member"]),
                    id: z.string().min(1).max(200).optional(),
                    ids: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
                    confirm: z.literal("DELETE"),
                })
                .strict()
                .refine((b) => Boolean(b.id) !== Boolean(b.ids), "provide either id or ids")
                .refine((b) => !b.ids || new Set(b.ids).size === b.ids.length, "duplicate item ids")
        );
        const ids = body.ids ?? [body.id as string];
        // Validate the entire batch before touching any item. No cross-workspace or self-removal partial writes.
        for (const id of ids) {
            if (body.kind === "project") {
                const project = await auth.store.getProject(id);
                if (!project || project.workspaceId !== workspaceId) return notFound();
            } else if (body.kind === "note") {
                const note = await backend.store.getAnnotation(id);
                if (
                    !note ||
                    (await auth.store.getProject(note.annotation.projectId))?.workspaceId !==
                        workspaceId
                )
                    return notFound();
            } else if (body.kind === "token") {
                const token = (await auth.store.listTokens(workspaceId)).find(
                    (t) => t.id === id && t.workspaceId === workspaceId
                );
                if (!token) return notFound();
            } else {
                if (id === principal.username)
                    throw new RequestError("keep yourself as the workspace owner");
                if (!(await auth.store.getMembership(workspaceId, id))) return notFound();
            }
        }
        const completed: string[] = [],
            failed: string[] = [];
        for (const id of ids) {
            try {
                if (
                    (await auth.store.getMembership(workspaceId, principal.username))?.role !==
                    "owner"
                )
                    throw new RequestError("workspace owner required", 403);
                let removed: unknown;
                if (body.kind === "project") {
                    removed = await backend.deleteProject(id);
                    await auth.store.revokeProjectTokens(id, new Date().toISOString());
                } else if (body.kind === "note") removed = await backend.remove(id);
                else if (body.kind === "token")
                    removed = await auth.store.revokeToken(id, new Date().toISOString());
                else removed = await auth.store.removeMembership(workspaceId, id);
                if (!removed) throw new Error("item no longer available");
                completed.push(id);
            } catch {
                // Storage cleanup may fail independently. Report partial results instead of claiming all succeeded.
                failed.push(id);
            }
        }
        return json({ ok: failed.length === 0, completed, failed }, failed.length ? 207 : 200);
    }
    return null;
};
