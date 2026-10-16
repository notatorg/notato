import type { Author, Status } from "@notato/schema";
import type { AssetBytes, Backend, ImportResult, VariantOffer } from "./backend.ts";
import { RequestError } from "./backend.ts";
import type { RelayArgs, RelayResult } from "./relay.ts";
import { type AnnotationFilter, type HandedEntry, inProjects } from "./storage.ts";

/** The projects a view reaches: fixed ones, or a function asked on every call so a change applies at once. */
export type ProjectScope = string | string[] | (() => Promise<string[]>);

/**
 * A view of the backend for a credential that reaches only some projects (a token issued to one, a member of a
 * workspace): it cannot list, read, change, wait on or fetch anything outside them, whatever the caller asks for.
 * Give it a function to follow memberships that change while a long call is open.
 */
export class ScopedBackend implements Backend {
    constructor(
        private inner: Backend,
        private scope: ProjectScope
    ) {}

    private projects(): Promise<string[]> {
        if (typeof this.scope === "function") return this.scope();
        return Promise.resolve(typeof this.scope === "string" ? [this.scope] : this.scope);
    }

    /** `filter` narrowed to the projects of this view: naming others only empties it. */
    private async narrow(filter: AnnotationFilter): Promise<AnnotationFilter> {
        const projects = await this.projects();
        return { ...filter, projectId: projects.filter((p) => inProjects(filter.projectId, p)) };
    }

    async list(filter: AnnotationFilter = {}) {
        const narrowed = await this.narrow(filter);
        return (narrowed.projectId as string[]).length ? this.inner.list(narrowed) : [];
    }

    async get(id: string) {
        const stored = await this.inner.get(id);
        return stored && (await this.projects()).includes(stored.annotation.projectId)
            ? stored
            : null;
    }

    async markHanded(entries: HandedEntry[]) {
        const mine: HandedEntry[] = [];
        for (const e of entries) if (await this.get(e.id)) mine.push(e);
        return this.inner.markHanded(mine);
    }

    async asset(id: string): Promise<AssetBytes | null> {
        const inner = this.inner as Backend & {
            projectsWithAsset?(id: string): Promise<string[]>;
        };
        const mine = await this.projects();
        if (inner.projectsWithAsset) {
            if (!(await inner.projectsWithAsset(id)).some((p) => mine.includes(p))) return null;
        } else if (
            !(await this.list()).some(({ annotation }) =>
                Object.values(annotation.screenshots ?? {}).some((ref) => ref?.id === id)
            )
        )
            return null;
        return this.inner.asset(id);
    }

    async screenshot(id: string, view: "crop" | "thumbnail"): Promise<AssetBytes | null> {
        return (await this.get(id)) ? (this.inner.screenshot?.(id, view) ?? null) : null;
    }

    async setStatus(id: string, status: Status, note?: string, author?: Author) {
        return (await this.get(id)) ? this.inner.setStatus(id, status, note, author) : null;
    }

    async reply(id: string, body: string, author?: Author) {
        return (await this.get(id)) ? this.inner.reply(id, body, author) : null;
    }

    async offerVariants(id: string, offer: VariantOffer, author?: Author) {
        return (await this.get(id)) ? this.inner.offerVariants(id, offer, author) : null;
    }

    async chooseVariant(id: string, name: string | null, note?: string, author?: Author) {
        return (await this.get(id)) ? this.inner.chooseVariant(id, name, note, author) : null;
    }

    async waitForNew(filter: AnnotationFilter, timeoutMs: number, signal?: AbortSignal) {
        const narrowed = await this.narrow(filter);
        if (!(narrowed.projectId as string[]).length) {
            // Nothing to wait for, but a caller expects the wait to last: hold it to the timeout, as a quiet one would.
            await new Promise<void>((resolve) => {
                const done = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", done);
                    resolve();
                };
                const timer = setTimeout(done, Math.max(0, timeoutMs));
                signal?.addEventListener("abort", done, { once: true });
                if (signal?.aborted) done();
            });
            return false;
        }
        const ready = await this.inner.waitForNew(narrowed, timeoutMs, signal);
        // A long wait may outlive a membership or a token: ask again before reporting work.
        return ready && (await this.list({ ...filter, limit: 1 })).length > 0;
    }

    importBundle(_zip: Uint8Array): Promise<ImportResult> {
        return Promise.reject(
            new RequestError(
                "upload bundles through POST /projects/<id>/bundles with this token",
                403
            )
        );
    }

    async requestAnnotation(
        projectId: string | undefined,
        args: RelayArgs,
        timeoutMs: number
    ): Promise<RelayResult> {
        const projects = await this.projects();
        const selected = projectId ?? (projects.length === 1 ? projects[0] : undefined);
        if (!selected || !projects.includes(selected)) {
            throw new RequestError(
                projectId === undefined
                    ? "select a project this credential can use"
                    : `this credential cannot use project "${projectId}"`,
                403
            );
        }
        const result = await this.inner.requestAnnotation(selected, args, timeoutMs);
        if (!(await this.projects()).includes(selected))
            throw new RequestError("project access revoked", 403);
        return result;
    }
}
