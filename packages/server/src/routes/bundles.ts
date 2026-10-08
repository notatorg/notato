import type { Principal } from "../auth.ts";
import { RequestError } from "../backend.ts";
import { filterFromQuery } from "../query.ts";
import {
    type AppContext,
    assertAccess,
    json,
    notFound,
    projectIdFrom,
    type Routes,
    tokenProject,
    zip,
} from "./common.ts";

/**
 * `POST /projects/:id/bundles` or `POST /bundles`: a tester's zip, sent as the body or as the `bundle` file of a form.
 * A project token can only ever import into its own project, whatever the URL says.
 */
async function importBundle(
    req: Request,
    principal: Principal,
    projectId: string | undefined,
    app: AppContext
): Promise<Response> {
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
    const result = await app.backend.importBundle(bytes, {
        projectId: tokenProject(principal) ?? projectId,
    });
    return json(result, result.imported > 0 ? 201 : 200);
}

/** Feedback bundles: importing a tester's zip, the bundles a project has, and exporting notes as a zip. */
export const bundleRoutes: Routes = async ({ req, url, path, method, principal, match }, app) => {
    const { backend } = app;

    const inProject = match(/^\/projects\/([^/]+)\/bundles$/);
    if (inProject) {
        const projectId = projectIdFrom(inProject[0]);
        assertAccess(principal, projectId);
        if (method === "POST") return importBundle(req, principal, projectId, app);
        if (method === "GET") return json({ items: await backend.listBundles(projectId) });
    }
    if (path === "/bundles" && method === "POST")
        return importBundle(req, principal, undefined, app);

    const exportOne = match(/^\/bundles\/([^/]+)\/export$/);
    if (exportOne && method === "GET") {
        const record = await backend.getBundle(exportOne[0] ?? "");
        if (record) assertAccess(principal, record.projectId);
        const exported = record ? await backend.exportBundle({ bundleId: record.id }) : null;
        return exported ? zip(exported) : notFound();
    }

    const one = match(/^\/bundles\/([^/]+)$/);
    if (one && method === "GET") {
        const record = await backend.getBundle(one[0] ?? "");
        if (!record) return notFound();
        assertAccess(principal, record.projectId);
        return json({ bundle: record, annotations: await backend.list({ bundleId: record.id }) });
    }

    const exportProject = match(/^\/projects\/([^/]+)\/export$/);
    if (exportProject && method === "GET") {
        const projectId = projectIdFrom(exportProject[0]);
        assertAccess(principal, projectId);
        const exported = await backend.exportBundle({
            projectId,
            filter: filterFromQuery(url.searchParams, projectId, { whole: true }),
        });
        return exported ? zip(exported) : notFound();
    }

    return null;
};
