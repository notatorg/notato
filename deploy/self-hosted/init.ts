import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { "admin-email": { type: "string" }, output: { type: "string" } },
});
const email = values["admin-email"];
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Pass --admin-email you@example.com");
const secret = () => randomBytes(32).toString("hex");
const path = values.output ?? join(import.meta.dir, ".env");
writeFileSync(
    path,
    [
        "# Bundled Postgres, S3-compatible storage and mock inbox. To use your own, remove its profile (db, storage, mail)",
        "# and set its NOTATO_* settings: see README.md.",
        "COMPOSE_PROFILES=db,storage,mail",
        "NOTATO_PUBLIC_URL=http://localhost:4799",
        "NOTATO_HTTP_PORT=4799",
        "NOTATO_MAIL_PORT=8026",
        `NOTATO_ADMIN_EMAIL=${email}`,
        `NOTATO_ADMIN_PASSWORD=${secret()}`,
        `NOTATO_AUTH_SECRET=${secret()}`,
        `NOTATO_PLUGIN_KEY=${secret()}`,
        `NOTATO_POSTGRES_PASSWORD=${secret()}`,
        `NOTATO_S3_ACCESS_KEY_ID=${randomBytes(12).toString("hex")}`,
        `NOTATO_S3_SECRET_ACCESS_KEY=${secret()}`,
        "NOTATO_DATABASE_SSL=disable",
        "NOTATO_S3_ENDPOINT=http://objects:8333",
        "NOTATO_S3_FORCE_PATH_STYLE=true",
        "NOTATO_SMTP_HOST=mailpit",
        "NOTATO_SMTP_PORT=1025",
        "NOTATO_EMAIL_FROM=notato@example.test",
        "NOTATO_SIGNUP_MODE=closed",
        "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" }
);
console.log(
    `Created private settings in ${path}. The administrator password is stored there. No secrets were printed.`
);
