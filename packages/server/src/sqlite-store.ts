import { Database } from "bun:sqlite";
import { awaitsAgent, lastWord } from "@notato/core";
import { Annotation, type Status } from "@notato/schema";
import type {
    AnnotationFilter,
    AuthStore,
    BundleRecord,
    HandedEntry,
    ProjectRecord,
    ProjectSummary,
    SessionRecord,
    Store,
    StoredAnnotation,
    TokenRecord,
    UserRecord,
} from "./storage.ts";

const SCHEMA_VERSION = 5;

/** The statuses a project's `open` count includes: work still waiting for someone. */
const WAITING = new Set<Status>(["open", "variant_chosen", "revert_requested"]);

interface Row {
    seq: number;
    json: string;
}

/**
 * What the filters and the project list ask of a note, kept in columns beside its JSON so they are read from an index
 * rather than by parsing every note: whether the last word waits on the agent (`awaitsAgent`, which an agent's watch
 * polls), People only, a diagnostic note, its intent and author, and when it last saw activity (made, or replied to).
 */
function derived(a: Annotation) {
    let last = a.createdAt;
    for (const r of a.thread) if (Date.parse(r.createdAt) > Date.parse(last)) last = r.createdAt;
    return {
        awaits_agent: awaitsAgent(a) ? 1 : 0,
        people_only: a.peopleOnly ? 1 : 0,
        diagnostic: (a.context as { notatoDiagnostic?: unknown } | undefined)?.notatoDiagnostic
            ? 1
            : 0,
        intent: a.intent ?? null,
        author_name: a.author.name ?? null,
        last_activity_at: last,
        last_word_id: lastWord(a)?.id ?? null,
    };
}

const DERIVED_COLUMNS: Array<[string, string]> = [
    ["awaits_agent", "INTEGER NOT NULL DEFAULT 0"],
    ["people_only", "INTEGER NOT NULL DEFAULT 0"],
    ["diagnostic", "INTEGER NOT NULL DEFAULT 0"],
    ["intent", "TEXT"],
    ["author_name", "TEXT"],
    ["last_activity_at", "TEXT"],
    ["last_word_id", "TEXT"],
];

/**
 * Records in SQLite. The annotation lives as JSON in one column; the columns beside it exist only so
 * the filters in `AnnotationFilter` stay indexed.
 */
export class SqliteStore implements Store, AuthStore {
    private db: Database;

    constructor(path: string) {
        this.db = new Database(path, { create: true });
        this.db.run("PRAGMA journal_mode = WAL");
        this.db.run("PRAGMA busy_timeout = 5000");
        this.db.run("PRAGMA foreign_keys = ON");
        this.migrate();
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
        // Which notes show a screenshot: asked on every asset request, so it stays indexed.
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_full_shot ON annotations (json_extract(json, '$.screenshots.full.id'))"
        );
        this.db.run(
            "CREATE INDEX IF NOT EXISTS idx_annotations_crop_shot ON annotations (json_extract(json, '$.screenshots.crop.id'))"
        );
        this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [
            String(SCHEMA_VERSION),
        ]);
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
        const update = this.db.query(
            `UPDATE annotations SET awaits_agent = ?, people_only = ?, diagnostic = ?, intent = ?, author_name = ?,
             last_activity_at = ?, last_word_id = ? WHERE seq = ?`
        );
        this.db.transaction(() => {
            for (const row of this.db.query("SELECT seq, json FROM annotations").all() as Row[]) {
                const d = derived(JSON.parse(row.json) as Annotation);
                update.run(
                    d.awaits_agent,
                    d.people_only,
                    d.diagnostic,
                    d.intent,
                    d.author_name,
                    d.last_activity_at,
                    d.last_word_id,
                    row.seq
                );
            }
        })();
    }

    private parse(row: Row): StoredAnnotation {
        return { seq: row.seq, annotation: Annotation.parse(JSON.parse(row.json)) };
    }

    async insertAnnotation(a: Annotation): Promise<StoredAnnotation> {
        const d = derived(a);
        const result = this.db
            .query(
                `INSERT INTO annotations (id, project_id, bundle_id, status, severity, route, author_kind, created_at, json,
           awaits_agent, people_only, diagnostic, intent, author_name, last_activity_at, last_word_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
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
                d.awaits_agent,
                d.people_only,
                d.diagnostic,
                d.intent,
                d.author_name,
                d.last_activity_at,
                d.last_word_id
            );
        return { seq: Number(result.lastInsertRowid), annotation: a };
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
        if (filter.diagnostic === false) where.push("diagnostic = 0");
        if (filter.unhanded) where.push("handed_reply_id IS NOT last_word_id");
        if (filter.excludeIds?.length) {
            where.push(`id NOT IN (${filter.excludeIds.map(() => "?").join(", ")})`);
            params.push(...filter.excludeIds);
        }
        const sql = `SELECT seq, json FROM annotations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ASC${
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
            const next = Annotation.parse(mutate(Annotation.parse(JSON.parse(row.json))));
            const d = derived(next);
            this.db
                .query(
                    `UPDATE annotations SET status = ?, severity = ?, route = ?, json = ?, awaits_agent = ?,
                     people_only = ?, diagnostic = ?, intent = ?, author_name = ?, last_activity_at = ?, last_word_id = ?
                     WHERE id = ?`
                )
                .run(
                    next.status,
                    next.severity ?? null,
                    next.route,
                    JSON.stringify(next),
                    d.awaits_agent,
                    d.people_only,
                    d.diagnostic,
                    d.intent,
                    d.author_name,
                    d.last_activity_at,
                    d.last_word_id,
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

    async projectsWithAsset(assetId: string): Promise<string[]> {
        return (
            this.db
                .query(
                    `SELECT DISTINCT project_id AS id FROM annotations
         WHERE json_extract(json, '$.screenshots.full.id') = ?1 OR json_extract(json, '$.screenshots.crop.id') = ?1`
                )
                .all(assetId) as Array<{ id: string }>
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

    async listBundles(projectId?: string): Promise<BundleRecord[]> {
        const rows = (
            projectId === undefined
                ? this.db.query("SELECT json FROM bundles ORDER BY imported_at DESC").all()
                : this.db
                      .query(
                          "SELECT json FROM bundles WHERE project_id = ? ORDER BY imported_at DESC"
                      )
                      .all(projectId)
        ) as Array<{ json: string }>;
        return rows.map((r) => JSON.parse(r.json) as BundleRecord);
    }

    // ---- AuthStore -----------------------------------------------------------------------------------

    async getUser(username: string): Promise<UserRecord | null> {
        const row = this.db
            .query("SELECT username, password_hash, created_at FROM users WHERE username = ?")
            .get(username) as {
            username: string;
            password_hash: string;
            created_at: string;
        } | null;
        return row
            ? { username: row.username, passwordHash: row.password_hash, createdAt: row.created_at }
            : null;
    }

    async upsertUser(user: UserRecord): Promise<void> {
        this.db
            .query(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash"
            )
            .run(user.username, user.passwordHash, user.createdAt);
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
        };
    }

    async createToken(token: TokenRecord): Promise<void> {
        this.db
            .query(
                "INSERT INTO tokens (id, project_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)"
            )
            .run(token.id, token.projectId, token.name, token.tokenHash, token.createdAt);
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
