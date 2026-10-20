import type { Annotation, Author, Reply } from "@notato/schema";
import { RequestError } from "./backend.ts";
import type { CoordinationStore } from "./team.ts";

export interface ProjectAccess {
    recordKind: "project";
    id: string;
    projectId: string;
    owner: { kind: "user" | "workspace"; id: string };
    /** Existing workspace-wide projects keep that behavior until explicitly restricted. */
    access: "members" | "workspace";
    members: Record<string, "owner" | "admin" | "member">;
    updatedAt: string;
}

export interface ReviewSession {
    recordKind: "review-session";
    id: string;
    projectId: string;
    createdBy: string;
    name: string;
    description?: string;
    visibility: "personal" | "shared";
    branch?: string;
    environment?: string;
    createdAt: string;
    updatedAt: string;
    closed: boolean;
    thread: Reply[];
    /** Additional links for manual groups. Never exposed as a list of private annotation ids. */
    annotationIds?: string[];
}

export const accessId = (project: string) => "project-access:" + project;
export async function projectAccess(records: CoordinationStore, project: string) {
    const record = await records.get(accessId(project));
    return record && "recordKind" in record && record.recordKind === "project" ? record : null;
}

export async function projectAccessible(
    records: CoordinationStore | undefined,
    project: string,
    username: string,
    workspaceManager = false,
    explicitOnly = false
) {
    if (!records) return !explicitOnly;
    const access = await projectAccess(records, project);
    return (
        (!access && !explicitOnly) ||
        (access?.access === "workspace" && !explicitOnly) ||
        workspaceManager ||
        Boolean(access && Object.hasOwn(access.members, username)) ||
        (access?.owner.kind === "user" && access.owner.id === username)
    );
}

export async function ownsProject(records: CoordinationStore, project: string, username: string) {
    const access = await projectAccess(records, project);
    return Boolean(
        access &&
            (access.members[username] === "owner" ||
                access.members[username] === "admin" ||
                (access.owner.kind === "user" && access.owner.id === username))
    );
}

export async function initializeProject(
    records: CoordinationStore,
    project: string,
    owner: string
) {
    return records.change<ProjectAccess>(
        accessId(project),
        project,
        "project",
        (current) =>
            current ?? {
                recordKind: "project",
                id: accessId(project),
                projectId: project,
                owner: { kind: "user", id: owner },
                access: "members",
                members: { [owner]: "owner" },
                updatedAt: new Date().toISOString(),
            }
    );
}

export const reviewSessionView = ({
    annotationIds: _ids,
    ...session
}: ReviewSession): ReviewSession => session;

export const canReadSession = (session: ReviewSession, actor: string) =>
    session.visibility === "shared" || session.createdBy === actor;

export class ReviewSessions {
    constructor(readonly records: CoordinationStore) {}

    async get(id: string): Promise<ReviewSession | null> {
        const record = await this.records.get(id);
        return record && "recordKind" in record && record.recordKind === "review-session"
            ? record
            : null;
    }

    async list(project: string, actor: string) {
        return ((await this.records.list(project, "review-session")) as ReviewSession[])
            .filter((session) => canReadSession(session, actor))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    async create(
        project: string,
        actor: string,
        input: {
            id?: string;
            name: string;
            description?: string;
            visibility?: "personal" | "shared";
            branch?: string;
            environment?: string;
        }
    ) {
        const id = input.id ?? "review_" + crypto.randomUUID();
        return this.records.change<ReviewSession>(id, project, "review-session", (current) => {
            if (current)
                throw new RequestError("A review session with this id already exists.", 409);
            const now = new Date().toISOString();
            return {
                recordKind: "review-session",
                id,
                projectId: project,
                createdBy: actor,
                name: input.name,
                description: input.description,
                visibility: input.visibility ?? "personal",
                branch: input.branch,
                environment: input.environment,
                createdAt: now,
                updatedAt: now,
                closed: false,
                thread: [],
            };
        });
    }

    async change(
        id: string,
        actor: string,
        change: Partial<
            Pick<
                ReviewSession,
                "name" | "description" | "visibility" | "closed" | "branch" | "environment"
            >
        >
    ) {
        const session = await this.get(id);
        if (!session || session.createdBy !== actor)
            throw new RequestError("Review session not found.", 404);
        return this.records.change<ReviewSession>(
            id,
            session.projectId,
            "review-session",
            (current) => {
                if (!current || current.createdBy !== actor)
                    throw new RequestError("Review session not found.", 404);
                return { ...current, ...change, updatedAt: new Date().toISOString() };
            }
        );
    }

    async reply(id: string, actor: string, body: string, author: Author) {
        const session = await this.get(id);
        if (!session || !canReadSession(session, actor))
            throw new RequestError("Review session not found.", 404);
        return this.records.change<ReviewSession>(
            id,
            session.projectId,
            "review-session",
            (current) => {
                if (!current || !canReadSession(current, actor))
                    throw new RequestError("Review session not found.", 404);
                if (current.thread.length >= 500)
                    throw new RequestError(
                        "This conversation is full. Start another session.",
                        409
                    );
                const now = new Date().toISOString();
                return {
                    ...current,
                    updatedAt: now,
                    thread: [
                        ...current.thread,
                        {
                            id: "reply_" + crypto.randomUUID(),
                            author,
                            body,
                            createdAt: now,
                        },
                    ],
                };
            }
        );
    }

    async group(id: string, actor: string, ids: string[]) {
        const session = await this.get(id);
        if (!session || session.createdBy !== actor)
            throw new RequestError("Review session not found.", 404);
        return this.records.change<ReviewSession>(
            id,
            session.projectId,
            "review-session",
            (current) => {
                if (!current || current.createdBy !== actor)
                    throw new RequestError("Review session not found.", 404);
                const annotationIds = [...new Set([...(current.annotationIds ?? []), ...ids])];
                if (annotationIds.length > 1000)
                    throw new RequestError("Split this review into smaller sessions.", 409);
                return { ...current, annotationIds, updatedAt: new Date().toISOString() };
            }
        );
    }

    /** A client-generated id groups a Test run immediately, before any export or packaging. */
    async capture(annotation: Annotation, actor: string) {
        if (!annotation.sessionId) return;
        let session = await this.get(annotation.sessionId);
        if (!session && annotation.mode === "test") {
            try {
                session = await this.create(annotation.projectId, actor, {
                    id: annotation.sessionId,
                    name: "Test session · " + new Date().toLocaleDateString("en-GB"),
                    visibility: "shared",
                    environment: (annotation.appVersion ?? annotation.environment.platform)?.slice(
                        0,
                        200
                    ),
                });
            } catch (error) {
                session = await this.get(annotation.sessionId);
                if (!session) throw error;
            }
        }
        if (
            !session ||
            session.projectId !== annotation.projectId ||
            !canReadSession(session, actor)
        )
            throw new RequestError("Review session not found.", 404);
        if (session.closed)
            throw new RequestError("This review session is closed. Start a new session.", 409);
    }
}
