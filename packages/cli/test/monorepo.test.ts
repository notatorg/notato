import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { findHostAbove } from "../src/discover.ts";
import { AmbiguousAppError } from "../src/init/choose-app.ts";
import { runInit } from "../src/init/init.ts";
import { formatReport } from "../src/init/report.ts";
import { addToViteEntry } from "../src/init/transforms.ts";
import {
    federatedRepo,
    HOST_CONFIG,
    HOST_MAIN,
    INDEX,
    REMOTE_CONFIG,
    reactPkg,
} from "./federated-repo.ts";
import { fakeCommands, read, removeTempDirs, tempDir, writeFiles } from "./helpers.ts";

// Init sets up the agents it finds on this machine; these tests are about Claude Code unless they say otherwise.
process.env.NOTATO_AGENTS = "claude";

afterEach(removeTempDirs);

describe("the build-and-preview guard", () => {
    const style = { semi: true, indent: "    ", quote: '"', printWidth: 100 } as const;

    it("also renders in a build made with VITE_NOTATO=true, and tells the component it is on", () => {
        const edit = addToViteEntry(
            HOST_MAIN,
            { project: "acme-storefront", server: "http://localhost:4747", guard: "env" },
            style
        );
        expect(edit.source).toContain(`        <>
            <App />
            {(import.meta.env.DEV || import.meta.env.VITE_NOTATO === "true") && (
                <Notato
                    mode="dev"
                    enabled
                    project="acme-storefront"
                    server="http://localhost:4747"
                />
            )}
        </>
`);
    });

    const BUILT_AND_PREVIEWED = JSON.stringify({
        name: "app-shell",
        scripts: {
            dev: "vite --port 5000 --strictPort",
            "dev:built":
                'vite build && concurrently "vite build --watch" "vite preview --strictPort"',
        },
        dependencies: { react: "^19" },
        devDependencies: { vite: "^7" },
    });

    it("is chosen automatically for an app that is built in watch mode and previewed", async () => {
        const root = federatedRepo({ "app-shell/package.json": BUILT_AND_PREVIEWED });
        const report = await runInit({ cwd: root, mcp: false });
        expect(read(root, "app-shell/src/main.tsx")).toContain(
            'import.meta.env.VITE_NOTATO === "true"'
        );
        const note = report.notes.join("\n");
        expect(note).toContain('the "dev:built" script');
        expect(note).toContain("VITE_NOTATO=true");
        expect(note).toContain("ships nothing");
    });

    it("--guard dev keeps it to `vite dev`, and an ordinary app never gets the env guard", async () => {
        const root = federatedRepo({ "app-shell/package.json": BUILT_AND_PREVIEWED });
        await runInit({ cwd: root, guard: "dev", mcp: false });
        expect(read(root, "app-shell/src/main.tsx")).not.toContain("VITE_NOTATO");
        expect(read(federatedRepo(), "app-shell/src/main.tsx")).not.toContain("VITE_NOTATO");
        const plain = federatedRepo();
        const report = await runInit({ cwd: plain, mcp: false });
        expect(read(plain, "app-shell/src/main.tsx")).not.toContain("VITE_NOTATO");
        expect(report.notes.join()).not.toContain("VITE_NOTATO");
    });

    it("a plain `vite build` script without --watch does not count", async () => {
        const root = federatedRepo({
            "app-shell/package.json": JSON.stringify({
                name: "x",
                scripts: { build: "vite build", preview: "vite preview" },
                dependencies: { react: "^19" },
                devDependencies: { vite: "^7" },
            }),
        });
        await runInit({ cwd: root, mcp: false });
        expect(read(root, "app-shell/src/main.tsx")).not.toContain("VITE_NOTATO");
    });
});

describe("init in a repo of several apps", () => {
    it("run from the repo root, picks the federation host and explains why", async () => {
        const root = federatedRepo();
        const { calls, opts } = fakeCommands();
        const report = await runInit({ cwd: root, ...opts });
        expect(report.app).toMatchObject({ dir: "app-shell", role: "host" });
        expect(report.app?.reason).toContain("federation host");
        expect(report.app?.reason).toContain("order-history");
        expect(report.app?.reason).toContain("inherit");
        // Only the host changed; the module and the standalone app were left alone.
        expect(read(root, "app-shell/src/main.tsx")).toContain("import.meta.env.DEV && (");
        expect(read(root, "order-history/src/main.tsx")).toBe(HOST_MAIN);
        expect(read(root, "developer-portal/src/main.tsx")).toBe(HOST_MAIN);
        // The project is the product (the repo), not the module.
        expect(report.project).toBe(basename(root).replace(/[^\w.@-]/g, "-"));
        expect(read(root, ".gitignore")).toContain(".notato/");
        expect(report.changes.map((c) => [c.file, c.action])).toEqual([
            ["app-shell/src/main.tsx", "edited"],
            [".gitignore", "edited"],
            [".claude/skills/notato/SKILL.md", "created"],
            [".claude/skills/notato-critique/SKILL.md", "created"],
        ]);
        // Registered from the root, pointing at the binary, since npx cannot find notato from there.
        expect(calls).toHaveLength(1);
        expect(calls[0]?.cwd).toBe(root);
        expect(calls[0]?.command).toEqual([
            "claude",
            "mcp",
            "add",
            "notato",
            "--",
            join(root, "app-shell/node_modules/.bin/notato"),
            "dev",
            "--project",
            report.project,
        ]);
        expect(formatReport(report, false)).toContain("federation host");
    });

    it("run inside the host, can register Claude Code for the repo root with --agent-dir", async () => {
        const root = federatedRepo();
        const { calls, opts } = fakeCommands();
        const report = await runInit({
            cwd: join(root, "app-shell"),
            agentDir: "..",
            ...opts,
        });
        expect(report.agentDir).toBe("..");
        expect(calls[0]?.cwd).toBe(root);
        expect(calls[0]?.command.slice(-4)).toEqual([
            join(root, "app-shell/node_modules/.bin/notato"),
            "dev",
            "--project",
            report.project,
        ]);
        // .notato/ is ignored where the server will run.
        expect(read(root, ".gitignore")).toContain(".notato/");
        expect(formatReport(report, false)).toContain(
            "registered the MCP server with Claude Code for .."
        );
    });

    it("uses a relative binary path for a project-scoped (.mcp.json) registration", async () => {
        const root = federatedRepo();
        const { calls, opts } = fakeCommands();
        const report = await runInit({ cwd: root, mcpScope: "project", ...opts });
        expect(calls[0]?.command).toEqual([
            "claude",
            "mcp",
            "add",
            "--scope",
            "project",
            "notato",
            "--",
            "./app-shell/node_modules/.bin/notato",
            "dev",
            "--project",
            report.project,
        ]);
    });

    it("writes the project-scoped path so cmd.exe can run it on Windows", async () => {
        const root = federatedRepo({}, { hostBin: false });
        writeFiles(root, { "app-shell/node_modules/.bin/notato.cmd": "@echo off\n" });
        const { calls, opts } = fakeCommands();
        const report = await runInit({
            cwd: root,
            mcpScope: "project",
            platform: "win32",
            ...opts,
        });
        expect(calls[0]?.command.slice(-6)).toEqual([
            "cmd",
            "/c",
            ".\\app-shell\\node_modules\\.bin\\notato.cmd",
            "dev",
            "--project",
            report.project,
        ]);
    });

    it("hints at --agent-dir when run inside one app of a larger repo", async () => {
        const root = federatedRepo();
        const report = await runInit({ cwd: join(root, "app-shell"), mcp: false });
        expect(report.notes.join()).toContain("--agent-dir");
        expect(report.agentDir).toBeUndefined();
    });

    it("warns when the app has no notato installed for Claude Code to start from elsewhere", async () => {
        const root = federatedRepo({}, { hostBin: false });
        const { calls, opts } = fakeCommands();
        const report = await runInit({ cwd: root, ...opts });
        expect(report.warnings.join()).toContain("notato is not installed in app-shell");
        expect(calls[0]?.command.slice(-5)).toEqual([
            "npx",
            "notato",
            "dev",
            "--project",
            report.project,
        ]);
    });

    it("--app chooses a specific app, and rejects something that is not one", async () => {
        const root = federatedRepo();
        const report = await runInit({ cwd: root, app: "developer-portal", mcp: false });
        expect(report.app).toMatchObject({ dir: "developer-portal", reason: "chosen with --app" });
        expect(read(root, "developer-portal/src/main.tsx")).toContain("<Notato");
        await expect(runInit({ cwd: root, app: "terraform", mcp: false })).rejects.toThrow(
            "not a React app"
        );
    });

    it("--dry-run changes nothing anywhere in the repo", async () => {
        const root = federatedRepo();
        const report = await runInit({ cwd: root, dryRun: true });
        expect(report.changes[0]?.action).toBe("edited");
        expect(read(root, "app-shell/src/main.tsx")).toBe(HOST_MAIN);
        expect(read(root, ".gitignore")).toBe("node_modules\n");
    });
});

describe("init when it cannot tell which app", () => {
    const twoStandalone = () =>
        federatedRepo({
            "app-shell/vite.config.ts": "export default {}\n",
            "order-history/vite.config.ts": "export default {}\n",
        });

    it("stops and lists the choices when there is nobody to ask", async () => {
        const root = twoStandalone();
        const error = await runInit({ cwd: root, mcp: false }).catch((e) => e);
        expect(error).toBeInstanceOf(AmbiguousAppError);
        expect(error.message).toContain("3 React apps");
        for (const dir of ["app-shell", "developer-portal", "order-history"])
            expect(error.message).toContain(dir);
        expect(error.message).toContain("--app <dir>");
        expect(read(root, "app-shell/src/main.tsx")).toBe(HOST_MAIN);
    });

    it("asks when it can, and uses the answer", async () => {
        const root = twoStandalone();
        const asked: string[][] = [];
        const report = await runInit({
            cwd: root,
            mcp: false,
            prompt: async (_q, choices) => {
                asked.push(choices);
                return choices.findIndex((c) => c.startsWith("order-history"));
            },
        });
        expect(asked[0]).toHaveLength(3);
        expect(report.app).toMatchObject({ dir: "order-history", reason: "chosen by you" });
        expect(read(root, "order-history/src/main.tsx")).toContain("<Notato");
        expect(read(root, "developer-portal/src/main.tsx")).toBe(HOST_MAIN);
    });

    it("--yes takes the first without asking", async () => {
        const root = twoStandalone();
        const report = await runInit({ cwd: root, yes: true, mcp: false });
        expect(report.app?.dir).toBe("app-shell");
        expect(report.app?.reason).toContain("--yes");
    });

    it("uses the only app when there is just one, and errors clearly when there is none", async () => {
        const solo = tempDir("notato-solo-", {
            "web/package.json": reactPkg("web"),
            "web/index.html": INDEX,
            "web/src/main.tsx": HOST_MAIN,
        });
        expect((await runInit({ cwd: solo, mcp: false })).app).toMatchObject({
            dir: "web",
            reason: "the only React app here",
        });
        const empty = tempDir("notato-empty-");
        await expect(runInit({ cwd: empty, mcp: false })).rejects.toThrow("no React app found");
    });
});

describe("init aimed at a federated module", () => {
    it("does nothing when the host already has the toolbar: modules inherit it", async () => {
        const root = federatedRepo({
            "app-shell/src/main.tsx": `${HOST_MAIN}\n// uses @notato/react\n`,
        });
        const { calls, opts } = fakeCommands();
        const report = await runInit({ cwd: join(root, "order-history"), ...opts });
        expect(report.changes).toEqual([]);
        expect(report.notes.join()).toContain("already renders <Notato />");
        expect(report.notes.join()).toContain("inherit the toolbar");
        expect(calls).toEqual([]);
        expect(read(root, "order-history/src/main.tsx")).toBe(HOST_MAIN);
        expect(formatReport(report, false)).not.toContain("registered the MCP server");
    });

    it("refuses by default when the host is not set up yet, and says where to run init instead", async () => {
        const root = federatedRepo();
        const error = await runInit({ cwd: join(root, "order-history"), mcp: false }).catch(
            (e) => e
        );
        expect(error.message).toContain("federated module loaded into ../app-shell");
        expect(error.message).toContain("--force");
        expect(read(root, "order-history/src/main.tsx")).toBe(HOST_MAIN);
    });

    it("--force, or naming it with --app, sets the module up anyway", async () => {
        const root = federatedRepo();
        const forced = await runInit({ cwd: join(root, "order-history"), force: true, mcp: false });
        expect(forced.app?.reason).toContain("installing here anyway");
        expect(read(root, "order-history/src/main.tsx")).toContain("<Notato");
        const explicit = await runInit({ cwd: root, app: "order-history", mcp: false });
        expect(explicit.app?.reason).toContain("chosen with --app");
    });

    it("offers the choice when it can ask, and cancelling changes nothing", async () => {
        const root = federatedRepo();
        const cancelled = runInit({
            cwd: join(root, "order-history"),
            mcp: false,
            prompt: async () => 0,
        });
        await expect(cancelled).rejects.toThrow("stopped: run `npx notato init` from ../app-shell");
        expect(read(root, "order-history/src/main.tsx")).toBe(HOST_MAIN);
        const anyway = await runInit({
            cwd: join(root, "order-history"),
            mcp: false,
            prompt: async () => 1,
        });
        expect(anyway.changes[0]?.action).toBe("edited");
    });

    it("--force sets a module up even when its host already has the toolbar", async () => {
        const root = federatedRepo({
            "app-shell/src/main.tsx": `${HOST_MAIN}\n// uses @notato/react\n`,
        });
        const forced = await runInit({ cwd: join(root, "order-history"), force: true, mcp: false });
        expect(forced.app?.reason).toContain("installing here anyway (--force)");
        expect(read(root, "order-history/src/main.tsx")).toContain("<Notato");
        const plain = await runInit({ cwd: join(root, "developer-portal"), mcp: false });
        expect(plain.notes.join()).not.toContain("--force");
    });

    it("does not look for its host in another repository next to its own", async () => {
        const base = tempDir("notato-repos-");
        mkdirSync(join(base, "host-repo/.git"), { recursive: true });
        mkdirSync(join(base, "module-repo/.git"), { recursive: true });
        writeFiles(base, {
            "host-repo/app-shell/package.json": reactPkg("app-shell"),
            "host-repo/app-shell/index.html": INDEX,
            "host-repo/app-shell/vite.config.ts": HOST_CONFIG,
            "host-repo/app-shell/src/main.tsx": `${HOST_MAIN}\n// uses @notato/react\n`,
            "module-repo/order-history/package.json": reactPkg("order-history"),
            "module-repo/order-history/index.html": INDEX,
            "module-repo/order-history/vite.config.ts": REMOTE_CONFIG,
            "module-repo/order-history/src/main.tsx": HOST_MAIN,
        });
        const moduleDir = join(base, "module-repo/order-history");
        expect(findHostAbove(moduleDir)).toBeNull();
        const report = await runInit({ cwd: moduleDir, mcp: false });
        expect(report.notes.join()).not.toContain("inherit the toolbar");
        expect(read(moduleDir, "src/main.tsx")).toContain("<Notato");
    });

    it("a standalone app next to a host is not treated as a module", async () => {
        const root = federatedRepo();
        const report = await runInit({ cwd: join(root, "developer-portal"), mcp: false });
        expect(report.app?.role).toBe("standalone");
        expect(report.changes[0]?.action).toBe("edited");
    });
});
