import type { Author, Status } from "@notato/schema";
import type { AssetBytes, Backend, ImportResult, VariantOffer } from "./backend.ts";
import { RequestError } from "./backend.ts";
import type { RelayArgs, RelayResult } from "./relay.ts";
import {
    type AnnotationFilter,
    type HandedEntry,
    inProjects,
    type StoredAnnotation,
} from "./storage.ts";

/**
 * A view of the backend for a token issued to one project: it cannot list, read, change or wait on
 * anything outside that project, whatever the caller asks for.
 */
export class ScopedBackend implements Backend {
    constructor(
        private inner: Backend,
        private projectId: string
    ) {}

    private mine = (stored: StoredAnnotation | null) =>
        stored?.annotation.projectId === this.projectId ? stored : null;

    list(filter: AnnotationFilter = {}) {
        if (!inProjects(filter.projectId, this.projectId)) return Promise.resolve([]);
        return this.inner.list({ ...filter, projectId: this.projectId });
    }

    async get(id: string) {
        return this.mine(await this.inner.get(id));
    }

    async markHanded(entries: HandedEntry[]) {
        const mine: HandedEntry[] = [];
        for (const e of entries) if (await this.get(e.id)) mine.push(e);
        return this.inner.markHanded(mine);
    }

    asset(id: string): Promise<AssetBytes | null> {
        return this.inner.asset(id);
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

    waitForNew(filter: AnnotationFilter, timeoutMs: number, signal?: AbortSignal) {
        if (!inProjects(filter.projectId, this.projectId)) return Promise.resolve(false);
        return this.inner.waitForNew({ ...filter, projectId: this.projectId }, timeoutMs, signal);
    }

    importBundle(_zip: Uint8Array): Promise<ImportResult> {
        return Promise.reject(
            new RequestError(
                "upload bundles through POST /projects/<id>/bundles with this token",
                403
            )
        );
    }

    requestAnnotation(
        projectId: string | undefined,
        args: RelayArgs,
        timeoutMs: number
    ): Promise<RelayResult> {
        if (projectId !== undefined && projectId !== this.projectId) {
            return Promise.reject(
                new RequestError(`this token cannot use project "${projectId}"`, 403)
            );
        }
        return this.inner.requestAnnotation(this.projectId, args, timeoutMs);
    }
}
