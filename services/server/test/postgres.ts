import { PGlite } from "@electric-sql/pglite";
import { SQL } from "bun";
import { type PgDatabase, PostgresStore } from "../src/postgres-store.ts";

/**
 * A fresh database on a real Postgres server, for running the suite against the engine the service runs on:
 * `NOTATO_TEST_DATABASE_URL=postgres://admin:…@127.0.0.1:5432/postgres bun test cloud`. Each call makes its own
 * database and drops it when the store is closed.
 */
async function serverPostgres(adminUrl: string) {
    const admin = new SQL(adminUrl, { max: 1, tls: false, prepare: false });
    const name = `t_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF; END $$"
    );
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const sql = new SQL(url.toString(), { max: 5, tls: false, prepare: false });
    let closed = false;
    const database: PgDatabase = {
        async query<T>(statement: string, params: unknown[] = []) {
            return (await sql.unsafe(statement, params)) as T[];
        },
        async transaction<T>(work: Parameters<PgDatabase["transaction"]>[0]) {
            return (await sql.begin((tx) =>
                work({
                    async query<R>(statement: string, params: unknown[] = []) {
                        return (await tx.unsafe(statement, params)) as R[];
                    },
                })
            )) as T;
        },
        async close() {
            if (closed) return;
            closed = true;
            await sql.close();
            await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
            await admin.close();
        },
    };
    // The few tests that look at the database's own catalog speak PGlite's dialect: this answers in it.
    const pg = {
        exec: (statement: string) => sql.unsafe(statement),
        query: async <T>(statement: string, params: unknown[] = []) => ({
            rows: (await sql.unsafe(statement, params)) as T[],
        }),
        get closed() {
            return closed;
        },
    };
    return { database, pg: pg as unknown as PGlite, store: await PostgresStore.open(database) };
}

/** A Postgres that lives in this process: the cloud's records, as a test needs them, with nothing to install. */
export async function embeddedPostgres() {
    if (process.env.NOTATO_TEST_DATABASE_URL)
        return serverPostgres(process.env.NOTATO_TEST_DATABASE_URL);
    const pg = new PGlite();
    await pg.exec("CREATE ROLE anon; CREATE ROLE authenticated");
    const database: PgDatabase = {
        async query<T>(sql: string, params: unknown[] = []) {
            return (await pg.query<T>(sql, params)).rows;
        },
        async transaction<T>(work: Parameters<PgDatabase["transaction"]>[0]) {
            return (await pg.transaction((tx) =>
                work({
                    async query<R>(sql: string, params: unknown[] = []) {
                        return (await tx.query<R>(sql, params)).rows;
                    },
                })
            )) as T;
        },
        async close() {
            // A store may be shared by two servers in a test: closing it twice is not an error.
            if (!pg.closed) await pg.close();
        },
    };
    return { database, pg, store: await PostgresStore.open(database) };
}
