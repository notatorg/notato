import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sampleAnnotation } from "@notato/schema";

/**
 * Exercises a compiled notato binary the way users will: its version, the shared server with the embedded
 * board UI and real auth, the dev server speaking MCP over stdio with a screenshot returned as an image,
 * `doctor`, and `init`. CI runs this on every platform's binary; locally:
 *
 *   bun run scripts/smoke-binary.ts dist/release/bin/bun-darwin-arm64/notato [--version 0.1.0]
 */

const args = process.argv.slice(2);
const binary = resolve(args.find((a) => !a.startsWith("--")) ?? "");
const expectedVersion = args.includes("--version")
    ? args[args.indexOf("--version") + 1]
    : undefined;
if (!args.length) {
    console.error("usage: bun run scripts/smoke-binary.ts <path-to-binary> [--version x.y.z]");
    process.exit(2);
}

const PNG = Uint8Array.from(
    atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ),
    (c) => c.charCodeAt(0)
);

const cleanups: Array<() => void | Promise<void>> = [];
let failures = 0;
const step = async (name: string, fn: () => Promise<string>) => {
    const started = performance.now();
    try {
        const detail = await fn();
        console.log(
            `  ✓ ${name}${detail ? ` — ${detail}` : ""} (${Math.round(performance.now() - started)} ms)`
        );
    } catch (error) {
        failures += 1;
        console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : error}`);
    }
};
function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "notato-smoke-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

async function freePort(): Promise<number> {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port as number;
    probe.stop(true);
    return port;
}

async function run(cmd: string[], env: Record<string, string> = {}, cwd?: string) {
    const proc = Bun.spawn([binary, ...cmd], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        cwd,
        env: { ...process.env, ...env },
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function waitFor(url: string, ms = 15_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const res = await fetch(url).catch(() => null);
        if (res?.ok) return res;
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`${url} did not come up within ${ms} ms`);
}

const multipart = (id: string, project: string, comment: string) => {
    const form = new FormData();
    form.set(
        "annotation",
        JSON.stringify({
            ...sampleAnnotation,
            id,
            projectId: project,
            bundleId: null,
            comment,
            screenshots: { full: { id: "a".repeat(64), mime: "image/png", w: 1, h: 1 } },
        })
    );
    form.set(
        `asset:${"a".repeat(64)}`,
        new File([PNG as BlobPart], "s.png", { type: "image/png" })
    );
    return form;
};

console.log(`Smoke-testing ${binary}`);

await step("prints its version", async () => {
    const { code, stdout } = await run(["--version"]);
    assert(code === 0, `exit code ${code}`);
    if (expectedVersion)
        assert(stdout === expectedVersion, `printed "${stdout}", expected "${expectedVersion}"`);
    return stdout;
});

await step("notato serve: embedded UI, login, tokens, annotations", async () => {
    const port = await freePort();
    const dir = tmp();
    const proc = Bun.spawn([binary, "serve", "--port", String(port), "--dir", dir], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...process.env, NOTATO_ADMIN_PASSWORD: "smoke-password" },
    });
    cleanups.push(() => proc.kill());
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/health`);

    const page = await fetch(base);
    const html = await page.text();
    assert(
        page.status === 200 && page.headers.get("content-type")?.startsWith("text/html"),
        `GET / answered ${page.status}`
    );
    assert(html.includes('id="root"'), "the page is not the board UI");
    const script = /src="(\/ui\/[^"]+\.js)"/.exec(html)?.[1];
    assert(script, "the page does not reference a script");
    const js = await fetch(`${base}${script}`);
    assert(
        js.status === 200 && (await js.text()).length > 10_000,
        "the embedded script is missing or empty"
    );

    const injectRes = await fetch(`${base}/inject.js`);
    const injectText = await injectRes.text();
    assert(
        injectRes.status === 200 && injectText.length > 20_000 && injectText.includes("__notato"),
        `GET /inject.js answered ${injectRes.status} with ${injectText.length} bytes: the page script is not embedded`
    );
    const bookmark = await fetch(`${base}/bookmarklet?project=smoke`);
    assert(
        bookmark.status === 200 &&
            (await bookmark.text()).includes(`${base}/inject.js?project=smoke`),
        "GET /bookmarklet is wrong"
    );

    assert(
        (await fetch(`${base}/annotations`)).status === 401,
        "an unauthenticated request was not refused"
    );
    const login = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "smoke-password" }),
    });
    assert(
        login.status === 200 && login.headers.get("set-cookie")?.includes("HttpOnly"),
        `login answered ${login.status}`
    );

    // A shared server only takes notes for projects created on it.
    const created = await run(["project", "create", "smoke", "--dir", dir]);
    assert(created.code === 0, `project create failed: ${created.stderr}`);
    const made = await run(["token", "create", "smoke", "--dir", dir]);
    assert(
        made.code === 0 && made.stdout.startsWith("pft_"),
        `token create failed: ${made.stderr}`
    );
    const headers = { Authorization: `Bearer ${made.stdout}` };
    const posted = await fetch(`${base}/projects/smoke/annotations`, {
        method: "POST",
        headers,
        body: multipart("smoke-1", "smoke", "from the smoke test"),
    });
    assert(posted.status === 201, `posting answered ${posted.status}: ${await posted.text()}`);
    const back = (await (await fetch(`${base}/annotations/smoke-1`, { headers })).json()) as {
        annotation: { comment: string };
    };
    assert(back.annotation.comment === "from the smoke test", "annotation did not read back");
    assert(
        (await fetch(`${base}/projects/other/annotations`, { headers })).status === 403,
        "a project token reached another project"
    );
    const exported = await run([
        "export",
        "--server",
        base,
        "--token",
        made.stdout,
        "--project",
        "smoke",
        "--detail",
        "compact",
    ]);
    assert(
        exported.code === 0 && exported.stdout.includes("from the smoke test"),
        `notato export failed:\n${exported.stdout}\n${exported.stderr}`
    );
    proc.kill();
    return `UI shell + ${script.split("/").pop()} (${Math.round(js.headers.get("content-length") ? Number(js.headers.get("content-length")) / 1024 : 0)} kB)`;
});

await step("notato dev: MCP over stdio, screenshots as images, SQLite", async () => {
    const port = await freePort();
    const dir = tmp();
    const transport = new StdioClientTransport({
        command: binary,
        args: ["dev"],
        env: {
            ...(process.env as Record<string, string>),
            NOTATO_PORT: String(port),
            NOTATO_DIR: dir,
        },
        stderr: "pipe",
    });
    const client = new Client({ name: "smoke", version: "0" });
    cleanups.push(() => client.close());
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["notato_watch", "notato_get", "notato_annotate", "notato_import_bundle"])
        assert(tools.includes(name), `missing tool ${name}`);

    const base = `http://127.0.0.1:${port}`;
    const posted = await fetch(`${base}/projects/smoke/annotations`, {
        method: "POST",
        body: multipart("dev-1", "smoke", "pay button hidden"),
    });
    assert(posted.status === 201, `posting answered ${posted.status}`);
    const watched = (await client.callTool({
        name: "notato_watch",
        arguments: { timeoutSeconds: 10, windowMs: 0 },
    })) as { content: Array<{ type: string; text?: string }> };
    assert(
        watched.content.some((c) => c.text?.includes("pay button hidden")),
        "watch did not return the annotation"
    );
    assert(
        watched.content.some((c) => c.type === "image"),
        "the screenshot did not come back as image content"
    );
    await client.callTool({ name: "notato_resolve", arguments: { id: "dev-1", summary: "fixed" } });
    const after = (await (await fetch(`${base}/annotations/dev-1`)).json()) as {
        annotation: { status: string };
    };
    assert(after.annotation.status === "resolved", "resolving over MCP did not reach the server");

    const doctor = await run(["doctor", "--server", base, "--no-claude"]);
    assert(doctor.code === 0, `doctor failed:\n${doctor.stdout}`);
    assert(
        doctor.stdout.includes("screenshot bytes matched"),
        "doctor did not complete the end-to-end check"
    );
    await client.close();
    return `${tools.length} tools; doctor ok`;
});

await step("notato init: edits a Vite app, and --revert undoes it", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "src"));
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
            name: "smoke-app",
            dependencies: { react: "^19" },
            devDependencies: { vite: "^8", "@notato/react": "^0.1.0" },
        })
    );
    writeFileSync(join(dir, "index.html"), '<script type="module" src="/src/main.tsx"></script>');
    const original = 'import { App } from "./App"\ncreateRoot(el).render(<App />)\n';
    writeFileSync(join(dir, "src/main.tsx"), original);
    const result = await run(["init", "--no-mcp"], {}, dir);
    assert(result.code === 0, `init failed:\n${result.stdout}\n${result.stderr}`);
    for (const skill of ["notato", "notato-critique"])
        assert(
            (await Bun.file(join(dir, `.claude/skills/${skill}/SKILL.md`)).text()).startsWith(
                `---\nname: ${skill}\n`
            ),
            `init did not write the ${skill} skill`
        );
    const edited = await Bun.file(join(dir, "src/main.tsx")).text();
    // Written the way prettier would, so a long element is wrapped onto its own lines.
    assert(
        /import\.meta\.env\.DEV && \(?\s*<Notato mode="dev"/.test(edited),
        "the entry was not edited"
    );

    const reverted = await run(["init", "--revert", "--no-mcp"], {}, dir);
    assert(reverted.code === 0, `init --revert failed:\n${reverted.stdout}\n${reverted.stderr}`);
    assert(
        (await Bun.file(join(dir, "src/main.tsx")).text()) === original,
        "--revert did not restore the entry"
    );
    assert(
        !(await Bun.file(join(dir, ".claude/skills/notato/SKILL.md")).exists()),
        "--revert left the skill behind"
    );
    return "entry and both skills written, and all restored by --revert";
});

await step("notato config webhook, in the compiled binary", async () => {
    const dir = tmp();
    const added = await run(
        [
            "config",
            "webhook",
            "add",
            "https://hooks.example.com/in",
            "-n",
            "team",
            "-e",
            "resolved",
        ],
        {},
        dir
    );
    assert(
        added.code === 0 && added.stdout.includes("Added team"),
        `webhook add failed:\n${added.stdout}\n${added.stderr}`
    );
    const config = JSON.parse(await Bun.file(join(dir, "notato.config.json")).text());
    assert(
        config.webhooks?.[0]?.events?.[0] === "annotation.resolved",
        "the webhook was not written as expected"
    );
    const listed = await run(["config", "webhook"], {}, dir);
    assert(
        listed.stdout.includes("team  https://hooks.example.com/in"),
        `webhook list was:\n${listed.stdout}`
    );
    const removed = await run(["config", "webhook", "remove", "team"], {}, dir);
    assert(removed.code === 0, `webhook remove failed:\n${removed.stderr}`);

    return "added, listed and removed";
});

for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => {});
console.log(
    failures ? `\n${failures} step${failures === 1 ? "" : "s"} failed.` : "\nAll steps passed."
);
process.exit(failures ? 1 : 0);
