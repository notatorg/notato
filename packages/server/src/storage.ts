import type { Annotation, Intent, Severity, Status } from "@notato/schema";

export interface AnnotationFilter {
    /** One project, or any of several (an agent that works on more than one); an empty list matches nothing. */
    projectId?: string | string[];
    status?: Status | Status[];
    route?: string;
    severity?: Severity;
    /** What the person wants done: fix, change, question, approve. */
    intent?: Intent | Intent[];
    /** `undefined` matches any; `null` matches only live (non-bundle) annotations. */
    bundleId?: string | null;
    authorKind?: "human" | "agent";
    /**
     * Only what this person wrote, by the name on it (several people can annotate one project); `null` for notes with no
     * name on them.
     */
    authorName?: string | null;
    /** Only annotations inserted after this sequence number. */
    afterSeq?: number;
    /** Not these annotations: what a watcher has already been handed. */
    excludeIds?: string[];
    /**
     * Only annotations whose latest word (the newest reply that is not an aside) is the person's for the agent to take
     * up: something they said, or People only being turned off, not the automatic record of something they did (a pick
     * without a note). How a watcher finds answers and follow-ups without reading every annotation. See `awaitsAgent`.
     */
    lastReplyBy?: "human";
    /** `false` leaves out notes marked People only, which are between people and never reach the agent. */
    peopleOnly?: false;
    /**
     * Only notes whose latest word has not been handed to an agent yet (`markHanded`): a follow-up is delivered once,
     * not again to every new agent session.
     */
    unhanded?: true;
    /** `false` leaves out `notato doctor`'s test note (marked `context.notatoDiagnostic`), which is nobody's work. */
    diagnostic?: false;
    limit?: number;
}

/** Whether a project is one a filter's `projectId` asks for (anything, when it asks for none). */
export function inProjects(wanted: AnnotationFilter["projectId"], projectId: string): boolean {
    if (wanted === undefined) return true;
    return Array.isArray(wanted) ? wanted.includes(projectId) : wanted === projectId;
}

/** A note, and the id of its latest word as an agent was handed it. */
export interface HandedEntry {
    id: string;
    replyId: string;
}

/** `seq` orders insertion across the whole store and is what watchers use as a cursor. */
export interface StoredAnnotation {
    seq: number;
    annotation: Annotation;
}

export interface BundleRecord {
    id: string;
    projectId: string;
    /** When the tester packaged it. */
    createdAt: string;
    author: { name?: string };
    appName?: string;
    appVersion?: string;
    annotationCount: number;
    importedAt: string;
}

/** A project a server knows about. Apps send notes to it; tokens are issued for it. */
export interface ProjectRecord {
    id: string;
    /** What people call it; the id until someone names it. */
    name: string;
    createdAt: string;
}

export interface ProjectSummary {
    id: string;
    name: string;
    createdAt: string;
    annotations: number;
    /** Still waiting for someone: new annotations, and requests to undo a change. */
    open: number;
    /** How many annotations are in each status; a status with none is left out. */
    statuses: Partial<Record<Status, number>>;
    /** The newest annotation or reply in the project (ISO 8601), so a list can show where something happened last. */
    lastActivityAt: string;
}

/**
 * Record storage. Everything is async so a Postgres implementation can slot in later; the SQLite one
 * resolves synchronously underneath.
 */
export interface Store {
    insertAnnotation(annotation: Annotation): Promise<StoredAnnotation>;
    getAnnotation(id: string): Promise<StoredAnnotation | null>;
    listAnnotations(filter?: AnnotationFilter): Promise<StoredAnnotation[]>;
    /** Applies `mutate` to the stored annotation atomically. Returns null when the id is unknown. */
    updateAnnotation(
        id: string,
        mutate: (current: Annotation) => Annotation
    ): Promise<StoredAnnotation | null>;
    deleteAnnotation(id: string): Promise<boolean>;
    /** Records that an agent was handed each note's latest word (the reply with that id). Not part of the note. */
    markHanded(entries: HandedEntry[]): Promise<void>;
    /** Every project, with its counts; a project with no notes yet is listed too. */
    listProjects(): Promise<ProjectSummary[]>;
    getProject(id: string): Promise<ProjectRecord | null>;
    /** Returns false when a project with that id already exists. */
    createProject(project: ProjectRecord): Promise<boolean>;
    renameProject(id: string, name: string): Promise<ProjectRecord | null>;
    /** Removes the project with its annotations and bundles. Returns the annotations that were removed, or null for an unknown id. */
    deleteProject(id: string): Promise<StoredAnnotation[] | null>;
    /** The projects with an annotation that shows this screenshot (none once every such note is deleted). */
    projectsWithAsset(assetId: string): Promise<string[]>;
    /** Returns false when a bundle with that id was already recorded. */
    insertBundle(bundle: BundleRecord): Promise<boolean>;
    getBundle(id: string): Promise<BundleRecord | null>;
    listBundles(projectId?: string): Promise<BundleRecord[]>;
    close(): void;
}

export interface UserRecord {
    username: string;
    /** An argon2id hash; the password itself is never stored. */
    passwordHash: string;
    createdAt: string;
}

export interface SessionRecord {
    /** sha-256 of the cookie value, so a copy of the database cannot be replayed as a login. */
    id: string;
    username: string;
    createdAt: string;
    expiresAt: string;
}

export interface TokenRecord {
    id: string;
    /** The one project this token may use, or `*` for all of them (agents and MCP). */
    projectId: string;
    name: string;
    /** sha-256 of the token. The token is shown once, at creation, and never stored. */
    tokenHash: string;
    createdAt: string;
    lastUsedAt?: string;
    revokedAt?: string;
}

/** Accounts, sessions and API tokens for serve mode. Kept apart from `Store` so each can move independently. */
export interface AuthStore {
    getUser(username: string): Promise<UserRecord | null>;
    upsertUser(user: UserRecord): Promise<void>;
    createSession(session: SessionRecord): Promise<void>;
    getSession(id: string): Promise<SessionRecord | null>;
    deleteSession(id: string): Promise<void>;
    purgeSessions(now: string): Promise<void>;
    createToken(token: TokenRecord): Promise<void>;
    findToken(tokenHash: string): Promise<TokenRecord | null>;
    listTokens(): Promise<TokenRecord[]>;
    /** Returns false when the id is unknown or already revoked. */
    revokeToken(id: string, at: string): Promise<boolean>;
    touchToken(id: string, at: string): Promise<void>;
    /** Stops every token for this project working (the project is being deleted). */
    revokeProjectTokens(projectId: string, at: string): Promise<void>;
    /** Sessions die with a password change, so a stolen cookie stops working. */
    deleteSessionsFor(username: string): Promise<void>;
    getProject(id: string): Promise<ProjectRecord | null>;
}

/** Content-addressed binary storage for screenshots. Ids are the sha-256 of the bytes. */
export interface BlobStore {
    put(bytes: Uint8Array): Promise<{ id: string; size: number }>;
    get(id: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
    /** Forgets the bytes; false when there were none. */
    delete(id: string): Promise<boolean>;
}

/** A screenshot's id: the sha-256 of its bytes, in hex. */
export const ASSET_ID = /^[0-9a-f]{64}$/;

/**
 * A project id: letters, digits and `_ . @ -`, at most 128 of them, but never only dots, so it can never name a parent
 * folder wherever a client keeps a project's notes.
 */
export const PROJECT_ID = /^(?!\.+$)[\w.@-]{1,128}$/;

/** Only formats the SDK produces are accepted, so the server never stores or serves arbitrary content. */
export function sniffImageMime(bytes: Uint8Array): "image/png" | "image/webp" | null {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((b, i) => bytes[i] === b)) return "image/png";
    const riff = [0x52, 0x49, 0x46, 0x46];
    const webp = [0x57, 0x45, 0x42, 0x50];
    if (riff.every((b, i) => bytes[i] === b) && webp.every((b, i) => bytes[8 + i] === b))
        return "image/webp";
    return null;
}
