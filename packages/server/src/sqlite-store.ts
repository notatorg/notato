import { Database } from "bun:sqlite";
import { Annotation, type Status } from "@notato/schema";
import { RequestError } from "./backend.ts";
import {
    type AnnotationFilter,
    type AuthStore,
    annotationColumns,
    type BundleRecord,
    type CaptureReceipt,
    type HandedEntry,
    type ProjectRecord,
    type ProjectSummary,
    type SessionRecord,
    type Store,
    type StoredAnnotation,
    type TokenRecord,
    type UserRecord,
} from "./storage.ts";
import {
    assertWorkPermit,
    type CoordinationStore,
    currentWorkPermit,
    type DevelopmentContext,
    type WorkRecord,
    workId,
} from "./team.ts";

const SCHEMA_VERSION = 8;

/** The statuses a project's `open` count includes: work still waiting for someone. */
const WAITING = new Set<Status>([
    "open",
    "awaiting_response",
    "variant_chosen",
    "revert_requested",
]);

interface Row {
    seq: number;
    json: string;
}

type Derived = ReturnType<typeof annotationColumns>;

/** The derived columns, each with its type, in the order they are written. */
const DERIVED_COLUMNS: Array<[keyof Derived, string]> = [
    ["awaits_agent", "INTEGER NOT NULL DEFAULT 0"],
    ["people_only", "INTEGER NOT NULL DEFAULT 0"],
    ["diagnostic", "INTEGER NOT NULL DEFAULT 0"],
    ["intent", "TEXT"],
    ["author_name", "TEXT"],
    ["last_activity_at", "TEXT"],
    ["last_word_id", "TEXT"],
];
const DERIVED_NAMES = DERIVED_COLUMNS.map(([name]) => name);

/** A note's derived values, in the order of `DERIVED_COLUMNS`. */
const derivedValues = (a: Annotation) => {
    const d = annotationColumns(a);
    return DERIVED_NAMES.map((name) => d[name]);
};

/** `a = ?, b = ?` for the derived columns, for an UPDATE. */
const SET_DERIVED = DERIVED_NAMES.map((name) => `${name} = ?`).join(", ");

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

const INSERT_ANNOTATION = `INSERT INTO annotations
    (id, project_id, bundle_id, status, severity, route, author_kind, created_at, json, ${DERIVED_NAMES.join(", ")}, capture_scope, capture_fingerprint)
    VALUES (${placeholders(11 + DERIVED_NAMES.length)})`;

const UPDATE_ANNOTATION = `UPDATE annotations SET status = ?, severity = ?, route = ?, json = ?, ${SET_DERIVED}
    WHERE id = ?`;

/**
 * Records in SQLite. The annotation lives as JSON in one column; the columns beside it exist only so
 * the filters in `AnnotationFilter` stay indexed.
 */
export class SqliteStore implements Store, AuthStore {
    private db: Database;
    readonly coordination: CoordinationStore = {
        get: async (id) => {
            const row = this.db.query("SELECT json FROM team_records WHERE id=?").get(id) as {
                json: string;
            } | null;
            return row ? JSON.parse(row.json) : null;
        },
        list: async (project, kind) =>
            (
                this.db
                    .query(
                        "SELECT json FROM team_records WHERE project_id=? AND kind=? ORDER BY id"
                    )
                    .all(project, kind) as Array<{ json: string }>
            ).map((r) => JSON.parse(r.json)),
        change: async (id, project, kind, mutate) =>
            this.db.transaction(() => {
                const row = this.db
                    .query("SELECT json,project_id,kind FROM team_records WHERE id=?")
                    .get(id) as { json: string; project_id: string; kind: string } | null;
                if (row && (row.project_id !== project || row.kind !== kind))
                    throw new Error("Coordination scope conflict");
                this.validatePermitCredential();
                const permit = currentWorkPermit();
                if (permit && kind === "work") {
                    const contextRow = this.db
                        .query("SELECT json FROM team_records WHERE id=?")
                        .get(permit.contextId) as { json: string } | null;
                    assertWorkPermit(
                        { projectId: project },
                        row ? JSON.parse(row.json) : null,
                        contextRow ? JSON.parse(contextRow.json) : null,
                        permit
                    );
                }
                const next = mutate(row ? JSON.parse(row.json) : null);
                if (kind === "work" && "contextId" in next && next.contextId) {
                    const c = this.db
                        .query("SELECT json FROM team_records WHERE id=?")
                        .get(next.contextId) as { json: string } | null;
                    const context = c ? (JSON.parse(c.json) as DevelopmentContext) : null;
                    if (!context || context.archived || context.projectId !== project)
                        throw new RequestError("Checkout connection revoked.", 403);
                }
                this.db
                    .query(
                        "INSERT INTO team_records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json"
                    )
                    .run(id, project, kind, JSON.stringify(next));
                return next;
            })(),
    };

    constructor(path: string) {
        this.db = new Database(path, { create: true });
        this.db.run("PRAGMA journal_mode = WAL");
        this.db.run("PRAGMA busy_timeout = 5000");
        this.db.run("PRAGMA foreign_keys = ON");
        this.migrate();
    }

    private validatePermitCredential() {
        const permit = currentWorkPermit();
        if (!permit?.credentialId) return;
        const token = this.db
            .query("SELECT revoked_at,expires_at FROM tokens WHERE id=?")
            .get(permit.credentialId) as {
            revoked_at: string | null;
            expires_at: string | null;
        } | null;
        if (
            !token ||
            token.revoked_at ||
            (token.expires_at && Date.parse(token.expires_at) <= Date.now())
        )
            throw new RequestError("Checkout credential revoked or expired.", 403);
    }
    private migrate() {
        this.db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        const row = this.db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
            value: string;
        } | null;
        const current = row ? Number(row.value) : 0;
        if (current > SCHEMA_VERSION) {
            throw new Error(
                `database is schema version ${current}, newer than this build (${SCHEMA_VERSION}); upgrade notato`
            );
        }
        this.db.run(`CREATE TABLE IF NOT EXISTS annotations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      bundle_id TEXT,
      status TEXT NOT NULL,
      severity TEXT,
      route TEXT NOT NULL,
      author_kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      json TEXT NOT NULL
    )`);
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_project_status ON annotations (project_id, status)"
        );
        this.db.run("CREATE INDEX IF NOT EXISTS idx_annotations_bundle ON annotations (bundle_id)");
        if (current < 2) {
            this.db.run(`CREATE TABLE IF NOT EXISTS bundles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        json TEXT NOT NULL
      )`);
            this.db.run("CREATE INDEX IF NOT EXISTS idx_bundles_project ON bundles (project_id)");
        }
        if (current < 3) {
            this.db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
            this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`);
            this.db.run(`CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      )`);
        }
        if (current < 4) {
            // Projects became records of their own; every project a database already mentions is carried over.
            this.db.run(`CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
            this.db.run(`INSERT OR IGNORE INTO projects (id, name, created_at)
        SELECT project_id, project_id, MIN(created_at) FROM annotations GROUP BY project_id`);
            this.db.run(`INSERT OR IGNORE INTO projects (id, name, created_at)
        SELECT project_id, project_id, MIN(imported_at) FROM bundles GROUP BY project_id`);
            this.db.run(`INSERT OR IGNORE INTO projects (id, name, created_at)
        SELECT project_id, project_id, MIN(created_at) FROM tokens WHERE project_id != '*' GROUP BY project_id`);
        }
        if (current < 5) this.addDerivedColumns();
        if (current < 6) this.addTokenPurposes();
        if (current < 7) {
            const have = new Set(
                (
                    this.db.query("PRAGMA table_info(annotations)").all() as Array<{ name: string }>
                ).map((column) => column.name)
            );
            for (const column of ["capture_scope", "capture_fingerprint"])
                if (!have.has(column))
                    this.db.run(`ALTER TABLE annotations ADD COLUMN ${column} TEXT`);
        }
        if (
            !(this.db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).some(
                (column) => column.name === "is_admin"
            )
        )
            this.db.run("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 1");
        this.db.run(
            "CREATE TABLE IF NOT EXISTS team_records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind TEXT NOT NULL, json TEXT NOT NULL)"
        );
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_team_records_project ON team_records(project_id,kind)"
        );
        const tokenColumns = new Set(
            (this.db.query("PRAGMA table_info(tokens)").all() as Array<{ name: string }>).map(
                (c) => c.name
            )
        );
        for (const name of ["development_context_id", "capture_work_id"])
            if (!tokenColumns.has(name)) this.db.run(`ALTER TABLE tokens ADD COLUMN ${name} TEXT`);
        // A project's notes in order, a page at a time: the board, every SDK and every agent page through them.
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_project_seq ON annotations (project_id, seq)"
        );
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_status_seq ON annotations (status, seq)"
        );
        // What an agent's watch asks every few seconds: the notes whose last word waits on it. Few, whatever the history.
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_awaits ON annotations (project_id, seq) WHERE awaits_agent = 1"
        );
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_project_activity ON annotations (project_id, last_activity_at)"
        );
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_review ON annotations (project_id, json_extract(json, '$.review.id'))"
        );
        // Which notes show a screenshot: asked on every asset request, so it stays indexed.
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_full_shot ON annotations (json_extract(json, '$.screenshots.full.id'))"
        );
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_thumbnail_shot ON annotations (json_extract(json, '$.screenshots.thumbnail.id'))"
        );
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_crop_shot ON annotations (json_extract(json, '$.screenshots.crop.id'))"
        );
        this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [
            String(SCHEMA_VERSION),
        ]);
    }

    /** Schema 6: what a token is for, and when it stops working. Earlier tokens keep working as they were. */
    private addTokenPurposes() {
        const have = new Set(
            (this.db.query("PRAGMA table_info(tokens)").all() as Array<{ name: string }>).map(
                (c) => c.name
            )
        );
        for (const name of ["permission", "purpose", "expires_at", "created_by"])
            if (!have.has(name)) this.db.run(`ALTER TABLE tokens ADD COLUMN ${name} TEXT`);
    }

    /** Schema 5: the derived columns, filled in from every note already stored. */
    private addDerivedColumns() {
        const have = new Set(
            (this.db.query("PRAGMA table_info(annotations)").all() as Array<{ name: string }>).map(
                (c) => c.name
            )
        );
        for (const [name, type] of DERIVED_COLUMNS)
            if (!have.has(name)) this.db.run(`ALTER TABLE annotations ADD COLUMN ${name} ${type}`);
        // Which latest word an agent was handed: set by watch, never by the note itself.
        if (!have.has("handed_reply_id"))
            this.db.run("ALTER TABLE annotations ADD COLUMN handed_reply_id TEXT");
        const update = this.db.query(`UPDATE annotations SET ${SET_DERIVED} WHERE seq = ?`);
        this.db.transaction(() => {
            for (const row of this.db.query("SELECT seq, json FROM annotations").all() as Row[])
                update.run(...derivedValues(JSON.parse(row.json) as Annotation), row.seq);
        })();
    }

    private parse(row: Row): StoredAnnotation {
        return { seq: row.seq, annotation: Annotation.parse(JSON.parse(row.json)) };
    }

    async insertAnnotation(
        a: Annotation,
        _assetBytes?: number,
        receipt?: CaptureReceipt
    ): Promise<StoredAnnotation> {
        const result = this.db
            .query(INSERT_ANNOTATION)
            .run(
                a.id,
                a.projectId,
                a.bundleId,
                a.status,
                a.severity ?? null,
                a.route,
                a.author.kind,
                a.createdAt,
                JSON.stringify(a),
                ...derivedValues(a),
                receipt?.scope ?? null,
                receipt?.fingerprint ?? null
            );
        return { seq: Number(result.lastInsertRowid), annotation: a };
    }

    async getCaptureReceipt(id: string): Promise<CaptureReceipt | null> {
        const row = this.db
            .query(
                "SELECT capture_scope AS scope, capture_fingerprint AS fingerprint FROM annotations WHERE id = ?"
            )
            .get(id) as CaptureReceipt | null;
        return row?.scope && row.fingerprint ? row : null;
    }

    async getAnnotation(id: string): Promise<StoredAnnotation | null> {
        const row = this.db
            .query("SELECT seq, json FROM annotations WHERE id = ?")
            .get(id) as Row | null;
        return row ? this.parse(row) : null;
    }

    async listAnnotations(filter: AnnotationFilter = {}): Promise<StoredAnnotation[]> {
        const where: string[] = [];
        const params: Array<string | number> = [];
        if (filter.projectId !== undefined) {
            const projects = Array.isArray(filter.projectId)
                ? filter.projectId
                : [filter.projectId];
            where.push(
                projects.length ? `project_id IN (${projects.map(() => "?").join(", ")})` : "0"
            );
            params.push(...projects);
        }
        const workKey =
            "COALESCE(json_extract(annotations.json, '$.workId'), 'work:' || annotations.project_id || ':' || COALESCE(json_extract(annotations.json, '$.review.id'), annotations.id))";
        if (filter.workId) {
            where.push(`${workKey} = ?`);
            params.push(filter.workId);
        }
        if (filter.workContext) {
            where.push(
                `EXISTS (SELECT 1 FROM team_records t WHERE t.id=${workKey} AND t.kind='work' AND json_extract(t.json,'$.contextId')=?)`
            );
            params.push(filter.workContext);
        }
        if (filter.workSession) {
            where.push(
                `EXISTS (SELECT 1 FROM team_records t WHERE t.id=${workKey} AND (json_extract(t.json,'$.claim.session') IS NULL OR json_extract(t.json,'$.claim.session')=?))`
            );
            params.push(filter.workSession);
        }
        if (filter.legacyOnly)
            where.push(
                `NOT EXISTS (SELECT 1 FROM team_records t WHERE t.id=${workKey} AND t.kind='work' AND json_extract(t.json,'$.contextId') IS NOT NULL)`
            );
        if (filter.reviewId !== undefined) {
            where.push("json_extract(json, '$.review.id') = ?");
            params.push(filter.reviewId);
        }
        if (filter.status !== undefined) {
            const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
            where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
            params.push(...statuses);
        }
        if (filter.intent !== undefined) {
            const intents = Array.isArray(filter.intent) ? filter.intent : [filter.intent];
            where.push(`intent IN (${intents.map(() => "?").join(", ")})`);
            params.push(...intents);
        }
        if (filter.route !== undefined) {
            where.push("route = ?");
            params.push(filter.route);
        }
        if (filter.severity !== undefined) {
            where.push("severity = ?");
            params.push(filter.severity);
        }
        if (filter.bundleId === null) where.push("bundle_id IS NULL");
        else if (filter.bundleId !== undefined) {
            where.push("bundle_id = ?");
            params.push(filter.bundleId);
        }
        if (filter.authorKind !== undefined) {
            where.push("author_kind = ?");
            params.push(filter.authorKind);
        }
        if (filter.authorName === null) {
            where.push("author_name IS NULL");
        } else if (filter.authorName !== undefined) {
            where.push("author_name = ?");
            params.push(filter.authorName);
        }
        if (filter.afterSeq !== undefined) {
            where.push("seq > ?");
            params.push(filter.afterSeq);
        }
        // The newest reply that is not an aside is the person's to answer (`awaitsAgent`), kept in a column on write.
        if (filter.lastReplyBy === "human") where.push("awaits_agent = 1");
        if (filter.peopleOnly === false) where.push("people_only = 0");
        if (filter.sessionId) {
            const ids = filter.sessionAnnotationIds ?? [];
            where.push(
                "(json_extract(json, '$.sessionId') = ?" +
                    (ids.length ? " OR id IN (" + ids.map(() => "?").join(",") + ")" : "") +
                    ")"
            );
            params.push(filter.sessionId, ...ids);
        }
        if (filter.feedbackScope === "mine") {
            where.push("json_extract(json, '$.visibility') = 'personal'");
            where.push("json_extract(json, '$.createdBy') = ?");
            params.push(filter.feedbackActorId ?? "");
        } else if (filter.feedbackScope === "shared") {
            where.push("COALESCE(json_extract(json, '$.visibility'), 'shared') = 'shared'");
        } else if (filter.feedbackScope === "all") {
            where.push(
                "(COALESCE(json_extract(json, '$.visibility'), 'shared') = 'shared' OR (json_extract(json, '$.visibility') = 'personal' AND json_extract(json, '$.createdBy') = ?))"
            );
            params.push(filter.feedbackActorId ?? "");
        }
        if (filter.diagnostic === false) where.push("diagnostic = 0");
        if (filter.unhanded) where.push("handed_reply_id IS NOT last_word_id");
        if (filter.excludeIds?.length) {
            where.push(`id NOT IN (${filter.excludeIds.map(() => "?").join(", ")})`);
            params.push(...filter.excludeIds);
        }
        const json = filter.summary
            ? `json_set(json_remove(json, '$.steps'), '$.context', json(CASE
                WHEN json_extract(json, '$.context.screenshot') IS NULL THEN '{}'
                ELSE json_object('screenshot', json_extract(json, '$.context.screenshot')) END))`
            : "json";
        const sql = `SELECT seq, ${json} AS json FROM annotations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ASC${
            filter.limit ? ` LIMIT ${Math.max(1, Math.floor(filter.limit))}` : ""
        }`;
        return (this.db.query(sql).all(...params) as Row[]).map((row) => this.parse(row));
    }

    async updateAnnotation(
        id: string,
        mutate: (current: Annotation) => Annotation
    ): Promise<StoredAnnotation | null> {
        const run = this.db.transaction((): StoredAnnotation | null => {
            const row = this.db
                .query("SELECT seq, json FROM annotations WHERE id = ?")
                .get(id) as Row | null;
            if (!row) return null;
            const current = Annotation.parse(JSON.parse(row.json));
            const permit = currentWorkPermit();
            this.validatePermitCredential();
            if (permit) {
                const read = (key: string) => {
                    const r = this.db
                        .query("SELECT json FROM team_records WHERE id=?")
                        .get(key) as { json: string } | null;
                    return r ? JSON.parse(r.json) : null;
                };
                assertWorkPermit(
                    current,
                    read(workId(current)) as WorkRecord | null,
                    read(permit.contextId) as DevelopmentContext | null
                );
            }
            const next = Annotation.parse(mutate(current));
            this.db
                .query(UPDATE_ANNOTATION)
                .run(
                    next.status,
                    next.severity ?? null,
                    next.route,
                    JSON.stringify(next),
                    ...derivedValues(next),
                    id
                );
            return { seq: row.seq, annotation: next };
        });
        return run();
    }

    async markHanded(entries: HandedEntry[]): Promise<void> {
        const mark = this.db.query("UPDATE annotations SET handed_reply_id = ? WHERE id = ?");
        this.db.transaction(() => {
            for (const e of entries) mark.run(e.replyId, e.id);
        })();
    }

    async deleteAnnotation(id: string): Promise<boolean> {
        return this.db.query("DELETE FROM annotations WHERE id = ?").run(id).changes > 0;
    }

    async listProjects(): Promise<ProjectSummary[]> {
        const projects = new Map<string, ProjectSummary>();
        for (const p of this.db
            .query("SELECT id, name, created_at FROM projects ORDER BY id")
            .all() as Array<{ id: string; name: string; created_at: string }>) {
            projects.set(p.id, {
                id: p.id,
                name: p.name,
                createdAt: p.created_at,
                annotations: 0,
                open: 0,
                statuses: {},
                lastActivityAt: p.created_at,
            });
        }
        // A reply is activity too: `last_activity_at` is a note's newest moment, made or replied to.
        const rows = this.db
            .query(
                `SELECT project_id AS id, status, COUNT(*) AS n, MIN(created_at) AS first,
           MAX(coalesce(last_activity_at, created_at)) AS last
         FROM annotations GROUP BY project_id, status ORDER BY project_id`
            )
            .all() as Array<{ id: string; status: Status; n: number; first: string; last: string }>;
        const later = (x: string, y: string | null | undefined) =>
            y && Date.parse(y) > Date.parse(x) ? y : x;
        const recorded = new Set(projects.keys());

        for (const row of rows) {
            const n = Number(row.n);
            // Notes for a project with no record (written before projects were recorded, by an older build) still count.
            const p = projects.get(row.id) ?? {
                id: row.id,
                name: row.id,
                createdAt: row.first,
                annotations: 0,
                open: 0,
                statuses: {},
                lastActivityAt: row.last,
            };
            if (!recorded.has(row.id) && Date.parse(row.first) < Date.parse(p.createdAt))
                p.createdAt = row.first;
            p.annotations += n;
            if (WAITING.has(row.status)) p.open += n;
            p.statuses[row.status] = n;
            p.lastActivityAt = later(p.lastActivityAt, row.last);
            projects.set(row.id, p);
        }
        return [...projects.values()];
    }

    async getProject(id: string): Promise<ProjectRecord | null> {
        const row = this.db
            .query("SELECT id, name, created_at FROM projects WHERE id = ?")
            .get(id) as { id: string; name: string; created_at: string } | null;
        return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
    }

    async createProject(project: ProjectRecord): Promise<boolean> {
        return (
            this.db
                .query("INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)")
                .run(project.id, project.name, project.createdAt).changes > 0
        );
    }

    async renameProject(id: string, name: string): Promise<ProjectRecord | null> {
        this.db.query("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
        return this.getProject(id);
    }

    async deleteProject(id: string): Promise<StoredAnnotation[] | null> {
        const run = this.db.transaction((): StoredAnnotation[] | null => {
            const removed = (
                this.db
                    .query("SELECT seq, json FROM annotations WHERE project_id = ? ORDER BY seq")
                    .all(id) as Row[]
            ).map((row) => this.parse(row));
            const known = this.db.query("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
            if (!known && removed.length === 0) return null;
            this.db.query("DELETE FROM annotations WHERE project_id = ?").run(id);
            this.db.query("DELETE FROM bundles WHERE project_id = ?").run(id);
            return removed;
        });
        return run();
    }

    async projectsWithAsset(
        assetId: string,
        filter: Pick<AnnotationFilter, "peopleOnly" | "feedbackScope" | "feedbackActorId"> = {}
    ): Promise<string[]> {
        const clauses: string[] = [];
        const values: string[] = [];
        if (filter.peopleOnly === false) clauses.push("people_only = 0");
        if (filter.feedbackScope === "mine") {
            clauses.push("json_extract(json, '$.visibility') = 'personal'");
            clauses.push("json_extract(json, '$.createdBy') = ?");
            values.push(filter.feedbackActorId ?? "");
        } else if (filter.feedbackScope === "shared") {
            clauses.push("COALESCE(json_extract(json, '$.visibility'), 'shared') = 'shared'");
        } else if (filter.feedbackScope === "all") {
            clauses.push(
                "(COALESCE(json_extract(json, '$.visibility'), 'shared') = 'shared' OR (json_extract(json, '$.visibility') = 'personal' AND json_extract(json, '$.createdBy') = ?))"
            );
            values.push(filter.feedbackActorId ?? "");
        }
        clauses.push(
            "(json_extract(json, '$.screenshots.full.id') = ? OR json_extract(json, '$.screenshots.crop.id') = ? OR json_extract(json, '$.screenshots.thumbnail.id') = ? OR EXISTS (SELECT 1 FROM json_each(annotations.json, '$.references') r WHERE json_extract(r.value, '$.id') = ?))"
        );
        values.push(assetId, assetId, assetId, assetId);
        return (
            this.db
                .query(
                    `SELECT DISTINCT project_id AS id FROM annotations WHERE ${clauses.join(" AND ")}`
                )
                .all(...values) as Array<{ id: string }>
        ).map((r) => r.id);
    }

    async insertBundle(bundle: BundleRecord): Promise<boolean> {
        const result = this.db
            .query(
                "INSERT OR IGNORE INTO bundles (id, project_id, created_at, imported_at, json) VALUES (?, ?, ?, ?, ?)"
            )
            .run(
                bundle.id,
                bundle.projectId,
                bundle.createdAt,
                bundle.importedAt,
                JSON.stringify(bundle)
            );
        return result.changes > 0;
    }

    async getBundle(id: string): Promise<BundleRecord | null> {
        const row = this.db.query("SELECT json FROM bundles WHERE id = ?").get(id) as {
            json: string;
        } | null;
        return row ? (JSON.parse(row.json) as BundleRecord) : null;
    }

    async listBundles(projectId?: string, limit?: number): Promise<BundleRecord[]> {
        // SQLite reads a negative limit as none.
        const most = limit === undefined ? -1 : Math.max(0, Math.floor(limit));
        const rows = (
            projectId === undefined
                ? this.db
                      .query("SELECT json FROM bundles ORDER BY imported_at DESC LIMIT ?")
                      .all(most)
                : this.db
                      .query(
                          "SELECT json FROM bundles WHERE project_id = ? ORDER BY imported_at DESC LIMIT ?"
                      )
                      .all(projectId, most)
        ) as Array<{ json: string }>;
        return rows.map((r) => JSON.parse(r.json) as BundleRecord);
    }

    async accessibleProjectIds(username: string): Promise<string[]> {
        const projects = await this.listProjects();
        const accessible: string[] = [];
        for (const project of projects) {
            const record = await this.coordination.get("project-access:" + project.id);
            if (
                record &&
                "recordKind" in record &&
                record.recordKind === "project" &&
                (Object.hasOwn(record.members, username) ||
                    (record.owner.kind === "user" && record.owner.id === username))
            )
                accessible.push(project.id);
        }
        return accessible;
    }

    async listUsers() {
        return (
            this.db
                .query("SELECT username, created_at, is_admin FROM users ORDER BY username")
                .all() as Array<{ username: string; created_at: string; is_admin: number }>
        ).map((row) => ({
            username: row.username,
            createdAt: row.created_at,
            isAdmin: Boolean(row.is_admin),
        }));
    }

    // ---- AuthStore -----------------------------------------------------------------------------------

    async getUser(username: string): Promise<UserRecord | null> {
        const row = this.db
            .query(
                "SELECT username, password_hash, created_at, is_admin FROM users WHERE username = ?"
            )
            .get(username) as {
            username: string;
            password_hash: string;
            created_at: string;
            is_admin: number;
        } | null;
        return row
            ? {
                  username: row.username,
                  passwordHash: row.password_hash,
                  createdAt: row.created_at,
                  isAdmin: Boolean(row.is_admin),
              }
            : null;
    }

    async upsertUser(user: UserRecord): Promise<void> {
        this.db
            .query(
                "INSERT INTO users (username, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, is_admin = excluded.is_admin"
            )
            .run(user.username, user.passwordHash, user.createdAt, user.isAdmin === false ? 0 : 1);
    }

    async createSession(session: SessionRecord): Promise<void> {
        this.db
            .query(
                "INSERT INTO sessions (id, username, created_at, expires_at) VALUES (?, ?, ?, ?)"
            )
            .run(session.id, session.username, session.createdAt, session.expiresAt);
    }

    async getSession(id: string): Promise<SessionRecord | null> {
        const row = this.db
            .query("SELECT id, username, created_at, expires_at FROM sessions WHERE id = ?")
            .get(id) as {
            id: string;
            username: string;
            created_at: string;
            expires_at: string;
        } | null;
        return row
            ? {
                  id: row.id,
                  username: row.username,
                  createdAt: row.created_at,
                  expiresAt: row.expires_at,
              }
            : null;
    }

    async deleteSession(id: string): Promise<void> {
        this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
    }

    async purgeSessions(now: string): Promise<void> {
        this.db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    }

    async deleteSessionsFor(username: string): Promise<void> {
        this.db.query("DELETE FROM sessions WHERE username = ?").run(username);
    }

    private tokenFrom(row: Record<string, string | null>): TokenRecord {
        return {
            id: row.id as string,
            projectId: row.project_id as string,
            name: row.name as string,
            tokenHash: row.token_hash as string,
            createdAt: row.created_at as string,
            ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
            ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
            ...(row.permission ? { permission: row.permission as "capture" | "full" } : {}),
            ...(row.purpose ? { purpose: row.purpose as "app" | "agent" } : {}),
            ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
            ...(row.created_by ? { createdBy: row.created_by } : {}),
            ...(row.development_context_id
                ? { developmentContextId: row.development_context_id }
                : {}),
            ...(row.capture_work_id ? { captureWorkId: row.capture_work_id } : {}),
        };
    }

    async createToken(token: TokenRecord): Promise<void> {
        this.db
            .query(
                "INSERT INTO tokens (id, project_id, name, token_hash, created_at, permission, purpose, expires_at, created_by, development_context_id, capture_work_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .run(
                token.id,
                token.projectId,
                token.name,
                token.tokenHash,
                token.createdAt,
                token.permission ?? null,
                token.purpose ?? null,
                token.expiresAt ?? null,
                token.createdBy ?? null,
                token.developmentContextId ?? null,
                token.captureWorkId ?? null
            );
    }

    async findToken(tokenHash: string): Promise<TokenRecord | null> {
        const row = this.db
            .query("SELECT * FROM tokens WHERE token_hash = ?")
            .get(tokenHash) as Record<string, string | null> | null;
        return row ? this.tokenFrom(row) : null;
    }

    async listTokens(): Promise<TokenRecord[]> {
        const rows = this.db.query("SELECT * FROM tokens ORDER BY created_at DESC").all() as Array<
            Record<string, string | null>
        >;
        return rows.map((r) => this.tokenFrom(r));
    }

    async revokeToken(id: string, at: string): Promise<boolean> {
        return (
            this.db
                .query("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
                .run(at, id).changes > 0
        );
    }

    async touchToken(id: string, at: string): Promise<void> {
        this.db.query("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(at, id);
    }

    async revokeProjectTokens(projectId: string, at: string): Promise<void> {
        this.db
            .query("UPDATE tokens SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL")
            .run(at, projectId);
    }

    close() {
        this.db.close();
    }
}
