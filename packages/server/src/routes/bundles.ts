import { accessibleProjects, type Principal } from "../auth.ts";
import { BUNDLE_LIST_MAX, RequestError } from "../backend.ts";
import { captureScope } from "../capture-receipt.ts";
import { filterFromQuery } from "../query.ts";
import { tokenPurpose } from "../storage.ts";
import {
    type AppContext,
    assertAccess,
    forReader,
    json,
    notFound,
    projectIdFrom,
    type Routes,
    zip,
} from "./common.ts";

/**
 * `POST /projects/:id/bundles` or `POST /bundles`: a tester's zip, sent as the body or as the `bundle` file of a form.
 * A project token can only ever import into its own project, whatever the URL says. An app's token or a member brings
 * notes in as people's, as when they send one: only the admin and agents may bring back what an agent did.
 */
async function importBundle(
    req: Request,
    principal: Principal,
    projectId: string | undefined,
    app: AppContext
): Promise<Response> {
    if (principal.developmentContextId || principal.captureWorkId)
        throw new RequestError(
            "Use live capture for checkout and PR reviews; this credential cannot import offline bundles.",
            403
        );
    const max = app.limits.bundle;
    if (Number(req.headers.get("content-length") ?? 0) > max)
        throw new RequestError(`bundle exceeds ${max} bytes`, 413);
    let bytes: Uint8Array;
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
        const file = (await req.formData()).get("bundle") as unknown as string | File | null;
        if (!file || typeof file === "string") throw new RequestError('missing "bundle" file');
        bytes = new Uint8Array(await file.arrayBuffer());
    } else {
        bytes = new Uint8Array(await req.arrayBuffer());
    }
    if (bytes.byteLength > max) throw new RequestError(`bundle exceeds ${max} bytes`, 413);
    if (bytes.byteLength === 0) throw new RequestError("empty body: send the bundle zip");
    // A credential that reaches only some projects imports into the one it names; a token for one project into its own.
    const own =
        principal.kind === "token" && principal.projectId !== "*" ? principal.projectId : undefined;
    const target = own ?? projectId;
    if (accessibleProjects(principal) !== undefined && !target)
        throw new RequestError("import a bundle with POST /projects/<id>/bundles", 403);
    if (target) assertAccess(principal, target);
    const asPerson =
        principal.kind === "member" ||
        (principal.kind === "token" && tokenPurpose(principal) === "app")
            ? { name: principal.kind === "token" ? principal.authorName : undefined }
            : undefined;
    const scope =
        principal.kind === "token" && principal.permission === "capture" && target
            ? await captureScope(principal.tokenId, target, principal.scope)
            : undefined;
    const result = await app.backend.importBundle(bytes, {
        projectId: target,
        asPerson,
        captureScope: scope,
    });
    return json(result, result.imported > 0 ? 201 : 200);
}

/** Feedback bundles: importing a tester's zip, the bundles a project has, and exporting notes as a zip. */
export const bundleRoutes: Routes = async ({ req, url, path, method, principal, match }, app) => {
    const { backend } = app;
    if (
        principal.developmentContextId &&
        method === "GET" &&
        !/\/projects\/[^/]+\/export$/.test(path)
    )
        throw new RequestError("Use the checkout feedback list or project export.", 403);

    const inProject = match(/^\/projects\/([^/]+)\/bundles$/);
    if (inProject) {
        const projectId = projectIdFrom(inProject[0]);
        assertAccess(principal, projectId);
        if (method === "POST") return importBundle(req, principal, projectId, app);
        if (method === "GET") {
            // The newest, as many as asked for up to BUNDLE_LIST_MAX.
            const asked = Number(url.searchParams.get("limit") ?? BUNDLE_LIST_MAX);
            const limit = Number.isFinite(asked) ? asked : BUNDLE_LIST_MAX;
            return json({ items: await backend.listBundles(projectId, limit) });
        }
    }
    if (path === "/bundles" && method === "POST")
        return importBundle(req, principal, undefined, app);

    const exportOne = match(/^\/bundles\/([^/]+)\/export$/);
    if (exportOne && method === "GET") {
        const record = await backend.getBundle(exportOne[0] ?? "");
        if (record) assertAccess(principal, record.projectId);
        const exported = record
            ? await backend.exportBundle({ bundleId: record.id, filter: forReader(principal) })
            : null;
        return exported ? zip(exported) : notFound();
    }

    const one = match(/^\/bundles\/([^/]+)$/);
    if (one && method === "GET") {
        const record = await backend.getBundle(one[0] ?? "");
        if (!record) return notFound();
        assertAccess(principal, record.projectId);
        // Only its own project's notes: another project may have notes carrying the same bundle id.
        const annotations = await backend.list(
            forReader(principal, {
                bundleId: record.id,
                projectId: record.projectId,
            })
        );
        return json({ bundle: record, annotations });
    }

    const exportProject = match(/^\/projects\/([^/]+)\/export$/);
    if (exportProject && method === "GET") {
        const projectId = projectIdFrom(exportProject[0]);
        assertAccess(principal, projectId);
        const exported = await backend.exportBundle({
            projectId,
            filter: forReader(
                principal,
                filterFromQuery(url.searchParams, projectId, { whole: true })
            ),
        });
        return exported ? zip(exported) : notFound();
    }

    return null;
};
