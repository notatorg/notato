import {
    type BlobStore,
    LocalBackend,
    type LocalBackendOptions,
    type StoredAnnotation,
} from "@notato/server";
import { DEFAULT_WORKSPACE_ID, type ProjectRecord, type Store } from "./storage.ts";

/**
 * The open server's backend, plus what a hosted service does with it: projects that belong to a workspace, and
 * the deletions, expiry and clean-up that follow a workspace or an account going away. Everything it adds takes the
 * same turn as uploads, so a screenshot a new note reuses is never removed from under it.
 */
export class CloudBackend extends LocalBackend {
    declare readonly store: Store;
    declare readonly blobs: BlobStore;

    constructor(store: Store, blobs: BlobStore, options: LocalBackendOptions = {}) {
        super(store, blobs, options);
    }

    /** Null when a project with that id already exists. */
    async createWorkspaceProject(
        id: string,
        name: string | undefined,
        workspaceId = DEFAULT_WORKSPACE_ID
    ): Promise<ProjectRecord | null> {
        return super.createProject(id, name, { workspaceId });
    }

    async deleteWorkspace(id: string, actor: string): Promise<boolean> {
        return this.serialAssets(async () => {
            const gone = await this.store.deleteWorkspace(id, actor);
            if (!gone) return false;
            await this.cleanupDeleted(gone);
            return true;
        });
    }

    async cleanupDeleted(gone: StoredAnnotation[]): Promise<void> {
        for (const stored of gone) this.emit("deleted", stored, undefined, true);
        await this.forgetScreenshots(gone.map((stored) => stored.annotation));
    }

    async deleteAccount(
        username: string,
        at: string,
        deletePrivateWorkspaces: boolean
    ): Promise<boolean> {
        return this.serialAssets(async () => {
            const gone = await this.store.deleteAccount(username, at, deletePrivateWorkspaces);
            if (!gone) return false;
            await this.cleanupDeleted(gone);
            return true;
        });
    }

    private orphanCursor: string | undefined;

    /** Removes screenshots no note shows (a day after they were stored, so one still being uploaded is safe). */
    async collectOrphanAssets(now: number): Promise<number> {
        return this.serialAssets(async () => {
            if (!this.blobs.list) return 0;
            const page = await this.blobs.list(this.orphanCursor, 100);
            let removed = 0;
            for (const item of page.items)
                if (
                    Date.parse(item.createdAt) <= now - 24 * 3600_000 &&
                    !(await this.store.projectsWithAsset(item.id)).length
                ) {
                    if (await this.blobs.delete(item.id)) removed++;
                }
            this.orphanCursor = page.cursor;
            return removed;
        });
    }

    async expireAnnotations(now: string): Promise<number> {
        return this.serialAssets(async () => {
            let count = 0;
            for (const candidate of await this.store.expiredAnnotations(now)) {
                const gone = await this.store.deleteExpiredAnnotation(candidate.annotation.id, now);
                if (gone) {
                    await this.cleanupDeleted([gone]);
                    count++;
                }
            }
            return count;
        });
    }
}
