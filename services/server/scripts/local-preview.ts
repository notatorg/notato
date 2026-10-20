// A local Notato Cloud for looking at the board: an in-process Postgres, a test identity, and a proxy that supplies the
// signed-in session, so the browser opens straight onto the board. Nothing here talks to a real provider.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledUi, FileBlobStore } from "@notato/server";
import { runCloud } from "../src/index.ts";
import { fakeManagedAuth } from "../test/hosted-helpers.ts";
import { embeddedPostgres } from "../test/postgres.ts";
import { previewPlugins, seedPreviewPlugins } from "./preview-plugins.ts";
import { seedPreviewTeams } from "./preview-teams.ts";

const teamPreview = process.argv.includes("--teams");
const pluginPreview = process.argv.includes("--plugins") || teamPreview;
// Plugins switched on but nothing set up, as a new workspace sees them (providers are the real ones: no network is
// needed to see a connection fail).
const emptyPlugins = process.argv.includes("--empty-plugins");
// Look at the board as someone else in alice's workspace: --as=admin, --as=member or --as=guest (one project only).
// Without --teams the workspace is just alice, which is how a solo builder sees it.
const persona = process.argv.find((a) => a.startsWith("--as="))?.slice(5);
const previewPort = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 4801);
if (
    !Number.isInteger(previewPort) ||
    previewPort < 1024 ||
    previewPort > 65534 ||
    [4746, 4747].includes(previewPort)
)
    throw new Error(
        "Choose an available preview port between 1024 and 65534, apart from 4746/4747."
    );
if (pluginPreview) {
    process.env.NOTATO_GITHUB_APP_SLUG = "";
    for (const name of ["GITHUB", "AZURE", "SLACK", "LINEAR", "GITLAB"]) {
        process.env[`NOTATO_${name}_CLIENT_ID`] = "";
        process.env[`NOTATO_${name}_CLIENT_SECRET`] = "";
    }
}

process.env.NOTATO_WEB_DIST = process.argv[2] ?? "";
const dir = mkdtempSync(join(tmpdir(), "notato-preview-"));
const store = (await embeddedPostgres()).store;
const rt = await runCloud({
    host: "127.0.0.1",
    port: previewPort,
    plugins: pluginPreview ? previewPlugins : { key: emptyPlugins ? Buffer.alloc(32, 9) : null },
    blobs: new FileBlobStore(join(dir, "assets")),
    dir,
    version: "preview",
    managedAuth: fakeManagedAuth(),
    beta: process.argv.includes("--beta") ? { admins: new Set(["alice@example.com"]) } : null,
    billing: null,
    testPlans: true,
    hosted: false,
    store,
    ui: bundledUi(),
    adminPassword: "correct horse battery staple 123",
    log: () => {},
});
const base = `http://127.0.0.1:${previewPort}`;
const session = await fetch(`${base}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken: "alice" }),
});
const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const board = { cookie, "content-type": "application/json", "x-notato-board": "1" };
// Pick the plan so the workspace can hold several projects, then make a few.
const me = (await (await fetch(`${base}/auth/me`, { headers: board })).json()) as {
    workspace: { id: string };
    username: string;
};
await rt.store.selectWorkspacePlan(me.workspace.id, me.username, pluginPreview ? "plus" : "pro", 0);
for (const name of ["Checkout web", "Marketing site", "Mobile app"])
    await fetch(`${base}/projects`, {
        method: "POST",
        headers: board,
        body: JSON.stringify({ name, agent: name === "Checkout web" }),
    });
if (pluginPreview) await seedPreviewPlugins(rt, me.workspace.id, me.username, base);
if (teamPreview) await seedPreviewTeams(rt, me.workspace.id, me.username);
let viewerCookie = cookie;
if (persona) {
    const other = await fetch(`${base}/auth/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: "bob" }),
    });
    const otherCookie = (other.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const otherMe = (await (
        await fetch(`${base}/auth/me`, { headers: { cookie: otherCookie } })
    ).json()) as { username: string };
    await rt.store.setMembership({
        workspaceId: me.workspace.id,
        username: otherMe.username,
        role: persona === "admin" ? "admin" : "member",
        createdAt: new Date().toISOString(),
    });
    if (persona === "guest")
        await (
            rt.store as unknown as {
                db: { query(sql: string, params: unknown[]): Promise<unknown> };
            }
        ).db.query(
            "UPDATE notato.memberships SET project_only=TRUE WHERE workspace_id=$1 AND username=$2",
            [me.workspace.id, otherMe.username]
        );
    const chosen = await fetch(`${base}/auth/workspace`, {
        method: "POST",
        headers: { cookie: otherCookie, "content-type": "application/json", "x-notato-board": "1" },
        body: JSON.stringify({ workspaceId: me.workspace.id }),
    });
    viewerCookie = (chosen.headers.get("set-cookie") ?? otherCookie).split(";")[0] ?? otherCookie;
}
Bun.serve({
    hostname: "127.0.0.1",
    port: previewPort + 1,
    idleTimeout: 255,
    async fetch(req) {
        const url = new URL(req.url);
        const headers = new Headers(req.headers);
        headers.set("cookie", viewerCookie);
        headers.set("host", `127.0.0.1:${previewPort}`);
        if (headers.has("origin")) headers.set("origin", base);
        return fetch(`${base}${url.pathname}${url.search}`, {
            method: req.method,
            headers,
            body: req.body,
            redirect: "manual",
            // biome-ignore lint/suspicious/noExplicitAny: Bun's fetch takes a duplex hint for streamed bodies
            ...({ duplex: "half" } as any),
        });
    },
});
console.log(`ready: http://localhost:${previewPort + 1}${pluginPreview ? "/#/x/plugins" : ""}`);
await new Promise(() => {});
