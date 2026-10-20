import { afterEach, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Env, heartbeat, type KV } from "../src/worker.ts";

const script = new URL("../../../deploy/self-hosted/backup_heartbeat.py", import.meta.url).pathname;
const python = Bun.which("python3");
const TOKEN = "t".repeat(40);
const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

function privateFile(path: string, content: string) {
    writeFileSync(path, content);
    chmodSync(path, 0o600);
}

async function send(config: string, url: string, token: string) {
    const proc = Bun.spawn(
        [python as string, "-I", script, "--config", config, "--url", url, "--token-file", token],
        { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { code, output: stdout + stderr };
}

// CI has Python, as the backup tooling does; a machine without it cannot run the backup host's script either.
it.skipIf(!python)(
    "sends the backup host's last verified backup to the monitor, and nothing else",
    async () => {
        const dir = mkdtempSync(join(tmpdir(), "notato-heartbeat-"));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const config = join(dir, "config.json");
        const status = join(dir, "status.json");
        const token = join(dir, "heartbeat-token");
        privateFile(
            config,
            JSON.stringify({
                root: dir,
                instance: "notato-server-test",
                alert_key: "re_never_sent",
                aws_secret_access_key: "never-sent",
            })
        );
        // As backupctl writes it after a verified local and offsite restore.
        privateFile(
            status,
            JSON.stringify({
                format: 1,
                instance: "notato-server-test",
                state: "running",
                attempt_at: "2026-10-16T03:17:00.000001+00:00",
                last_success: {
                    verified_at: "2026-10-15T03:41:07.123456+00:00",
                    local_snapshot: "a".repeat(64),
                    remote_snapshot: "b".repeat(64),
                    key_sha256: "c".repeat(64),
                    images: 3,
                    bytes: 456789,
                },
            })
        );
        privateFile(token, `${TOKEN}\n`);

        const values = new Map<string, string>();
        const kv: KV = {
            get: async (key) => values.get(key) ?? null,
            put: async (key, value) => {
                values.set(key, value);
            },
        };
        const env = {
            MONITOR: kv,
            NOTATO_MONITOR_INSTANCE: "notato-server-test",
            NOTATO_BACKUP_HEARTBEAT_TOKEN: TOKEN,
        } as Env;
        const bodies: string[] = [];
        const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch: async (req) => {
                bodies.push(await req.clone().text());
                return heartbeat(req, env, Date.parse("2026-10-16T04:00:00Z"));
            },
        });
        cleanups.push(() => server.stop(true));
        const url = `http://127.0.0.1:${server.port}/backup-heartbeat`;

        const sent = await send(config, url, token);
        expect(sent).toEqual({
            code: 0,
            output: "Notato backup heartbeat accepted: last verified 2026-10-15T03:41:07Z.\n",
        });
        expect(JSON.parse(bodies[0] ?? "{}")).toEqual({
            instance: "notato-server-test",
            verified_at: "2026-10-15T03:41:07Z",
            bytes: 456789,
            images: 3,
        });
        expect(JSON.parse(values.get("backup") ?? "{}")).toMatchObject({
            verifiedAt: Date.parse("2026-10-15T03:41:07Z"),
            bytes: 456789,
            images: 3,
        });

        const wrong = join(dir, "wrong-token");
        privateFile(wrong, "w".repeat(40));
        expect(await send(config, url, wrong)).toEqual({
            code: 1,
            output: "Notato backup heartbeat: heartbeat_not_accepted\n",
        });
        expect(await send(config, "http://monitor.example/backup-heartbeat", token)).toEqual({
            code: 1,
            output: "Notato backup heartbeat: monitor_url_must_be_https\n",
        });
        chmodSync(status, 0o644);
        expect(await send(config, url, token)).toEqual({
            code: 1,
            output: "Notato backup heartbeat: unsafe_or_missing_status_file\n",
        });
        expect(bodies).toHaveLength(2);
    }
);
