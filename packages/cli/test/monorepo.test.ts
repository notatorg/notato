import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runDoctor } from "../src/commands/doctor.ts";
import { AmbiguousAppError, formatReport, runInit } from "../src/commands/init.ts";
import { describeApp, discoverApps, findGitRoot, findHostAbove } from "../src/discover.ts";
import { addToViteEntry } from "../src/init-transforms.ts";
import { detectStyle, readPrettierConfig, resolveStyle } from "../src/style.ts";

// Init sets up the agents it finds on this machine; these tests are about Claude Code unless they say otherwise.
process.env.NOTATO_AGENTS = "claude";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A typical Vite + React entry file. */
const HOST_MAIN = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./i18n/config";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
`;

const reactPkg = (name: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        name,
        dependencies: { react: "^19" },
        devDependencies: { vite: "^7", ...extra },
    });
const INDEX = '<div id="root"></div><script type="module" src="/src/main.tsx"></script>';
const HOST_CONFIG = `import federation from "@originjs/vite-plugin-federation"
const remotes = Object.fromEntries([])
export default { plugins: [federation({ name: "host", remotes, shared: ["react"] })] }
`;
// Modules reach the shell's shared context through a remote of their own, so they declare `remotes` too.
const REMOTE_CONFIG = `import federation from "@originjs/vite-plugin-federation"
export default {
  plugins: [
    federation({
      name: "orderHistory",
      remotes: {
        // The shell's permissions context.
        appShell: process.env.VITE_APP_SHELL_URL || "http://localhost:5000/assets/remoteEntry.js",
      },
      exposes: { "./routes": "./src/routes.tsx" },
      shared: ["react"],
    }),
  ],
}
`;

function write(root: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

/** A Module Federation monorepo: a federation host, a module, a standalone app, a library, noise. */
function repo(over: Record<string, string> = {}, options: { hostBin?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "notato-repo-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    write(root, {
        ".gitignore": "node_modules\n",
        ".prettierrc.json": JSON.stringify({
            semi: true,
            singleQuote: false,
            tabWidth: 4,
            printWidth: 100,
        }),
        "app-shell/package.json": reactPkg("app-shell", { "@notato/react": "^0.1.0" }),
        "app-shell/index.html": INDEX,
        "app-shell/vite.config.ts": HOST_CONFIG,
        "app-shell/src/main.tsx": HOST_MAIN,
        "order-history/package.json": reactPkg("order-history"),
        "order-history/index.html": INDEX,
        "order-history/vite.config.ts": REMOTE_CONFIG,
        "order-history/src/main.tsx": HOST_MAIN,
        "developer-portal/package.json": reactPkg("developer-portal"),
        "developer-portal/index.html": INDEX,
        "developer-portal/vite.config.ts": "export default {}\n",
        "developer-portal/src/main.tsx": HOST_MAIN,
        "packages/federation/package.json": JSON.stringify({
            name: "fed",
            dependencies: { react: "^19" },
        }),
        "packages/federation/src/index.ts": "export {}\n",
        "node_modules/some-dep/package.json": reactPkg("some-dep"),
        "node_modules/some-dep/index.html": INDEX,
        "terraform/main.tf": "",
        ...over,
    });
    if (options.hostBin !== false)
        write(root, { "app-shell/node_modules/.bin/notato": "#!/bin/sh\n" });
    return root;
}

const claude = (result = { code: 0, output: "Added" }) => {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    return {
        calls,
        opts: {
            which: () => "/usr/local/bin/claude",
            run: async (command: string[], cwd: string) => {
                calls.push({ command, cwd });
                return result;
            },
        },
    };
};
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

describe("discoverApps", () => {
    it("finds React apps and tells a federation host from its modules", () => {
        const root = repo();
        const apps = discoverApps(root);
        expect(apps.map((a) => [a.rel, a.role, a.framework])).toEqual([
            ["app-shell", "host", "vite"],
            ["developer-portal", "standalone", "vite"],
            ["order-history", "remote", "vite"],
        ]);
        expect(apps.find((a) => a.rel === "app-shell")?.hasNotato).toBe(false);
    });

    it("skips libraries without an index.html, node_modules and build output", () => {
        const root = repo({ "dist/index.html": INDEX, "dist/package.json": reactPkg("built") });
        expect(discoverApps(root).map((a) => a.rel)).not.toContain("packages/federation");
        expect(
            discoverApps(root)
                .map((a) => a.rel)
                .join()
        ).not.toContain("node_modules");
        expect(discoverApps(root).map((a) => a.rel)).not.toContain("dist");
    });

    it("finds apps inside workspace-style folders, and does not descend into an app", () => {
        const root = repo({
            "apps/billing/package.json": reactPkg("billing"),
            "apps/billing/index.html": INDEX,
            "app-shell/examples/nested/package.json": reactPkg("nested"),
            "app-shell/examples/nested/index.html": INDEX,
        });
        const rels = discoverApps(root).map((a) => a.rel);
        expect(rels).toContain("apps/billing");
        expect(rels).not.toContain("app-shell/examples/nested");
    });

    it("describes Next.js apps, and ignores a package without react", () => {
        const root = repo({
            "web/package.json": JSON.stringify({
                name: "web",
                dependencies: { react: "^19", next: "^15" },
            }),
            "tool/package.json": JSON.stringify({ name: "tool", devDependencies: { vite: "^7" } }),
            "tool/index.html": INDEX,
        });
        expect(describeApp(join(root, "web"))?.framework).toBe("next");
        expect(describeApp(join(root, "tool"))).toBeNull();
    });

    it("finds the git root and a host above a module", () => {
        const root = repo();
        expect(findGitRoot(join(root, "order-history/src"))).toBe(root);
        expect(findHostAbove(join(root, "order-history"))?.rel).toBe("app-shell");
        expect(findHostAbove(join(root, "developer-portal"))?.rel).toBe("app-shell");
    });
});

describe("matching the project's formatting", () => {
    it("reads semicolons and indentation from the file", () => {
        expect(detectStyle(HOST_MAIN)).toMatchObject({ semi: true, indent: "    ", quote: '"' });
        expect(detectStyle("import a from 'a'\nconst x = () => {\n  return 1\n}\n")).toMatchObject({
            semi: false,
            indent: "  ",
            quote: "'",
        });
        expect(detectStyle("import a from 'a';\nfunction f() {\n\treturn 1\n}\n").indent).toBe(
            "\t"
        );
    });

    it("prefers the prettier config the project enforces, found by walking up", () => {
        const root = repo();
        expect(readPrettierConfig(join(root, "app-shell/src"))).toEqual({
            semi: true,
            quote: '"',
            indent: "    ",
            printWidth: 100,
        });
        expect(resolveStyle("import a from 'a'\n", join(root, "app-shell"))).toMatchObject({
            semi: true,
            quote: '"',
            printWidth: 100,
        });
    });

    it("reads useTabs, singleQuote and the simple YAML form", () => {
        const root = repo({
            ".prettierrc.json": "",
            ".prettierrc": "semi: false\nsingleQuote: true\nuseTabs: true\nprintWidth: 120\n",
        });
        rmSync(join(root, ".prettierrc.json"));
        expect(readPrettierConfig(root)).toEqual({
            semi: false,
            quote: "'",
            indent: "\t",
            printWidth: 120,
        });
    });

    it("produces exactly what prettier would for the real app-shell entry file", () => {
        const edit = addToViteEntry(
            HOST_MAIN,
            { project: "acme-storefront", server: "http://localhost:4747" },
            { semi: true, indent: "    ", quote: '"', printWidth: 100 }
        );
        expect(edit.source).toBe(`import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./i18n/config";
import App from "./App.tsx";
import { Notato } from "@notato/react";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <>
            <App />
            {import.meta.env.DEV && (
                <Notato mode="dev" project="acme-storefront" server="http://localhost:4747" />
            )}
        </>
    </StrictMode>
);
`);
    });

    it("keeps the element on one line when it fits, and breaks attributes when even that is too long", () => {
        const short = addToViteEntry(
            "import a from 'a'\nrender(<App />)\n",
            { project: "x", server: "http://h" },
            { semi: false, indent: "  ", quote: "'", printWidth: 200 }
        );
        expect(short.source).toContain(
            '{import.meta.env.DEV && <Notato mode="dev" project="x" server="http://h" />}'
        );
        const narrow = addToViteEntry(
            "render(<App />)\n",
            { project: "x", server: "http://localhost:4747" },
            { semi: false, indent: "  ", quote: '"', printWidth: 40 }
        );
        expect(narrow.source).toContain('<Notato\n      mode="dev"\n      project="x"\n');
    });

    it("uses the .render( one when there are several <App /> tags, and says so", () => {
        const source = `import { App } from "./App"\nconst unused = <App />\n\ncreateRoot(el).render(\n  <App />\n)\n`;
        const edit = addToViteEntry(
            source,
            { project: "p", server: "http://h" },
            detectStyle(source)
        );
        expect(edit.note).toContain("found 2 <App /> tags");
        expect(edit.source).toContain("const unused = <App />\n");
        expect(edit.source.match(/<Notato/g)).toHaveLength(1);
        expect(edit.source.indexOf("<Notato")).toBeGreaterThan(edit.source.indexOf(".render("));
    });
});

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

    const ASPIRE = JSON.stringify({
        name: "app-shell",
        scripts: {
            dev: "vite --port 5000 --strictPort",
            aspire: 'vite build && concurrently "vite build --watch" "vite preview --strictPort"',
        },
        dependencies: { react: "^19" },
        devDependencies: { vite: "^7" },
    });

    it("is chosen automatically for an app that is built in watch mode and previewed", async () => {
        const root = repo({ "app-shell/package.json": ASPIRE });
        const report = await runInit({ cwd: root, mcp: false });
        expect(read(root, "app-shell/src/main.tsx")).toContain(
            'import.meta.env.VITE_NOTATO === "true"'
        );
        const note = report.notes.join("\n");
        expect(note).toContain('the "aspire" script');
        expect(note).toContain("VITE_NOTATO=true");
        expect(note).toContain("ships nothing");
    });

    it("--guard dev keeps it to `vite dev`, and an ordinary app never gets the env guard", async () => {
        const root = repo({ "app-shell/package.json": ASPIRE });
        await runInit({ cwd: root, guard: "dev", mcp: false });
        expect(read(root, "app-shell/src/main.tsx")).not.toContain("VITE_NOTATO");
        expect(read(repo(), "app-shell/src/main.tsx")).not.toContain("VITE_NOTATO");
        const plain = repo();
        const report = await runInit({ cwd: plain, mcp: false });
        expect(read(plain, "app-shell/src/main.tsx")).not.toContain("VITE_NOTATO");
        expect(report.notes.join()).not.toContain("VITE_NOTATO");
    });

    it("a plain `vite build` script without --watch does not count", async () => {
        const root = repo({
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
        const root = repo();
        const { calls, opts } = claude();
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

    it("run inside the host, can register Claude Code for the repo root with --claude-dir", async () => {
        const root = repo();
        const { calls, opts } = claude();
        const report = await runInit({
            cwd: join(root, "app-shell"),
            claudeDir: "..",
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
        const root = repo();
        const { calls, opts } = claude();
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
        const root = repo({}, { hostBin: false });
        write(root, { "app-shell/node_modules/.bin/notato.cmd": "@echo off\n" });
        const { calls, opts } = claude();
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
        const root = repo();
        const report = await runInit({ cwd: join(root, "app-shell"), mcp: false });
        expect(report.notes.join()).toContain("--agent-dir");
        expect(report.agentDir).toBeUndefined();
    });

    it("warns when the app has no notato installed for Claude Code to start from elsewhere", async () => {
        const root = repo({}, { hostBin: false });
        const { calls, opts } = claude();
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
        const root = repo();
        const report = await runInit({ cwd: root, app: "developer-portal", mcp: false });
        expect(report.app).toMatchObject({ dir: "developer-portal", reason: "chosen with --app" });
        expect(read(root, "developer-portal/src/main.tsx")).toContain("<Notato");
        await expect(runInit({ cwd: root, app: "terraform", mcp: false })).rejects.toThrow(
            "not a React app"
        );
    });

    it("--dry-run changes nothing anywhere in the repo", async () => {
        const root = repo();
        const report = await runInit({ cwd: root, dryRun: true });
        expect(report.changes[0]?.action).toBe("edited");
        expect(read(root, "app-shell/src/main.tsx")).toBe(HOST_MAIN);
        expect(read(root, ".gitignore")).toBe("node_modules\n");
    });
});

describe("init when it cannot tell which app", () => {
    const twoStandalone = () =>
        repo({
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
        const solo = mkdtempSync(join(tmpdir(), "notato-solo-"));
        dirs.push(solo);
        write(solo, {
            "web/package.json": reactPkg("web"),
            "web/index.html": INDEX,
            "web/src/main.tsx": HOST_MAIN,
        });
        expect((await runInit({ cwd: solo, mcp: false })).app).toMatchObject({
            dir: "web",
            reason: "the only React app here",
        });
        const empty = mkdtempSync(join(tmpdir(), "notato-empty-"));
        dirs.push(empty);
        await expect(runInit({ cwd: empty, mcp: false })).rejects.toThrow("no React app found");
    });
});

describe("init aimed at a federated module", () => {
    it("does nothing when the host already has the toolbar: modules inherit it", async () => {
        const root = repo({
            "app-shell/src/main.tsx": `${HOST_MAIN}\n// uses @notato/react\n`,
        });
        const { calls, opts } = claude();
        const report = await runInit({ cwd: join(root, "order-history"), ...opts });
        expect(report.changes).toEqual([]);
        expect(report.notes.join()).toContain("already renders <Notato />");
        expect(report.notes.join()).toContain("inherit the toolbar");
        expect(calls).toEqual([]);
        expect(read(root, "order-history/src/main.tsx")).toBe(HOST_MAIN);
        expect(formatReport(report, false)).not.toContain("registered the MCP server");
    });

    it("refuses by default when the host is not set up yet, and says where to run init instead", async () => {
        const root = repo();
        const error = await runInit({ cwd: join(root, "order-history"), mcp: false }).catch(
            (e) => e
        );
        expect(error.message).toContain("federated module loaded into ../app-shell");
        expect(error.message).toContain("--force");
        expect(read(root, "order-history/src/main.tsx")).toBe(HOST_MAIN);
    });

    it("--force, or naming it with --app, sets the module up anyway", async () => {
        const root = repo();
        const forced = await runInit({ cwd: join(root, "order-history"), force: true, mcp: false });
        expect(forced.app?.reason).toContain("installing here anyway");
        expect(read(root, "order-history/src/main.tsx")).toContain("<Notato");
        const explicit = await runInit({ cwd: root, app: "order-history", mcp: false });
        expect(explicit.app?.reason).toContain("chosen with --app");
    });

    it("offers the choice when it can ask, and cancelling changes nothing", async () => {
        const root = repo();
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
        const root = repo({
            "app-shell/src/main.tsx": `${HOST_MAIN}\n// uses @notato/react\n`,
        });
        const forced = await runInit({ cwd: join(root, "order-history"), force: true, mcp: false });
        expect(forced.app?.reason).toContain("installing here anyway (--force)");
        expect(read(root, "order-history/src/main.tsx")).toContain("<Notato");
        const plain = await runInit({ cwd: join(root, "developer-portal"), mcp: false });
        expect(plain.notes.join()).not.toContain("--force");
    });

    it("does not look for its host in another repository next to its own", async () => {
        const base = mkdtempSync(join(tmpdir(), "notato-repos-"));
        dirs.push(base);
        mkdirSync(join(base, "host-repo/.git"), { recursive: true });
        mkdirSync(join(base, "module-repo/.git"), { recursive: true });
        write(base, {
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
        const root = repo();
        const report = await runInit({ cwd: join(root, "developer-portal"), mcp: false });
        expect(report.app?.role).toBe("standalone");
        expect(report.changes[0]?.action).toBe("edited");
    });
});

describe("init in a Next.js repo with prettier settings", () => {
    it("writes the client component in the project's style", async () => {
        const root = mkdtempSync(join(tmpdir(), "notato-next-"));
        dirs.push(root);
        mkdirSync(join(root, ".git"));
        write(root, {
            ".prettierrc.json": JSON.stringify({ semi: true, tabWidth: 4, printWidth: 100 }),
            "package.json": JSON.stringify({
                name: "storefront",
                dependencies: { react: "^19", next: "^15" },
            }),
            "app/layout.tsx": `import "./globals.css";\n\nexport default function RootLayout({ children }) {\n    return (\n        <html>\n            <body>{children}</body>\n        </html>\n    );\n}\n`,
        });
        await runInit({ cwd: root, mcp: false });
        expect(read(root, "app/notato-dev.tsx")).toBe(`"use client";

import { Notato } from "@notato/react";

/** Mounts the Notato toolbar in development only; renders nothing in production builds. */
export function NotatoDev() {
    if (process.env.NODE_ENV !== "development") return null;
    return <Notato mode="dev" project="storefront" server="http://localhost:4747" />;
}
`);
        expect(read(root, "app/layout.tsx")).toContain('import { NotatoDev } from "./notato-dev";');
        // `<body>{children}</body>` was on one line; it is opened up so the toolbar gets its own, as prettier writes it.
        expect(read(root, "app/layout.tsx")).toContain(
            "            <body>\n                {children}\n                <NotatoDev />\n            </body>\n"
        );
    });
});

describe("doctor in a repo of several apps", () => {
    const appCheck = async (root: string) =>
        (await runDoctor({ server: "http://127.0.0.1:1", cwd: root, claude: false })).find(
            (c) => c.name === "App"
        );

    it("is satisfied when the host renders <Notato />, and names the module that inherits it", async () => {
        const root = repo({ "app-shell/src/main.tsx": `${HOST_MAIN}\n// @notato/react\n` });
        const app = await appCheck(root);
        expect(app?.status).toBe("ok");
        expect(app?.detail).toBe(
            "app-shell renders <Notato />; the 1 federated module it loads inherits it"
        );
    });

    it("warns, and points at the federation host, when nothing is wired", async () => {
        const app = await appCheck(repo());
        expect(app?.status).toBe("warn");
        expect(app?.detail).toBe("no <Notato /> found in any of 3 apps");
        expect(app?.fix).toContain("in app-shell, the federation host");
    });

    it("checks the app itself when run inside one", async () => {
        const root = repo();
        const unwired = (
            await runDoctor({
                server: "http://127.0.0.1:1",
                cwd: join(root, "developer-portal"),
                claude: false,
            })
        ).find((c) => c.name === "App");
        expect(unwired?.detail).toBe("no <Notato /> found in .");
    });
});
