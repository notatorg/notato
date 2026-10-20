import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mailerFromEnv } from "@notato/service-server";
import { check, type Env, heartbeat } from "./worker.ts";

// Run this on an independent host if it should detect the application host going offline.
const dir = resolve(process.env.NOTATO_MONITOR_DIR ?? "/data/monitor");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const mailer = mailerFromEnv();
const env: Env = {
    ...process.env,
    NOTATO_MONITOR_TARGET: process.env.NOTATO_MONITOR_TARGET ?? "",
    NOTATO_MONITOR_INSTANCE: process.env.NOTATO_MONITOR_INSTANCE ?? "notato",
    MONITOR: {
        async get(key) {
            if (!/^[a-z-]+$/.test(key)) throw new Error("Invalid monitor key");
            try {
                return readFileSync(join(dir, `${key}.json`), "utf8");
            } catch (error) {
                if ((error as { code?: string }).code === "ENOENT") return null;
                throw error;
            }
        },
        async put(key, value) {
            if (!/^[a-z-]+$/.test(key)) throw new Error("Invalid monitor key");
            const target = join(dir, `${key}.json`);
            const temporary = `${target}.${crypto.randomUUID()}.tmp`;
            writeFileSync(temporary, value, { mode: 0o600 });
            renameSync(temporary, target);
        },
    },
    async sendMail(notification, to) {
        for (const recipient of to)
            await mailer.send({
                to: recipient,
                subject: notification.subject,
                text: notification.text,
            });
    },
};
let running: Promise<unknown> | undefined;
const run = () =>
    (running ??= check(env, Date.now())
        .catch(() => {
            console.error("Monitor check failed; retrying on the next interval.");
        })
        .finally(() => {
            running = undefined;
        }));
await run();
const interval = setInterval(() => void run(), 5 * 60_000);
const server = Bun.serve({
    hostname: process.env.NOTATO_MONITOR_HOST ?? "127.0.0.1",
    port: Number(process.env.NOTATO_MONITOR_PORT ?? 4803),
    maxRequestBodySize: 2048,
    fetch: (req) =>
        new URL(req.url).pathname === "/backup-heartbeat"
            ? heartbeat(req, env, Date.now())
            : new Response(null, { status: 404 }),
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
        clearInterval(interval);
        server.stop(true);
        void Promise.resolve(running).finally(() => process.exit(0));
    });
