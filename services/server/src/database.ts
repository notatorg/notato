import { readFileSync } from "node:fs";
import { Pool, type PoolConfig } from "pg";

/** TLS can be disabled explicitly for a private Docker network. Remote connections verify certificates by default. */
export function databaseOptions(
    url: string,
    env: Record<string, string | undefined> = process.env
): PoolConfig {
    const parsed = new URL(url);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol))
        throw new Error("NOTATO_DATABASE_URL must be a Postgres connection URL");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    const mode = env.NOTATO_DATABASE_SSL ?? (local ? "disable" : "verify-full");
    if (!["disable", "verify-full"].includes(mode))
        throw new Error("NOTATO_DATABASE_SSL must be disable or verify-full");
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
        parsed.searchParams.delete(key);
    return {
        connectionString: parsed.toString(),
        max: 5,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        ssl:
            mode === "disable"
                ? false
                : {
                      rejectUnauthorized: true,
                      ...(env.NOTATO_DATABASE_CA_FILE
                          ? { ca: readFileSync(env.NOTATO_DATABASE_CA_FILE, "utf8") }
                          : {}),
                  },
    };
}
export const databasePool = (url: string) => new Pool(databaseOptions(url));
