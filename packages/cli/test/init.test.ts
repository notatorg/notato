import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatReport, type InitOptions, runInit } from "../src/commands/init.ts";
import {
    addImport,
    addToGitignore,
    addToNextLayout,
    addToNextPagesApp,
    addToViteEntry,
    nextClientComponent,
    projectIdFromPackage,
} from "../src/init-transforms.ts";

// Init sets up the agents it finds on this machine; these tests are about Claude Code unless they say otherwise.
process.env.NOTATO_AGENTS = "claude";

const setup = { project: "shop", server: "http://localhost:4747" };

describe("projectIdFromPackage", () => {
    it("makes a server-safe id from a package name", () => {
        expect(projectIdFromPackage("@acme/checkout-web")).toBe("checkout-web");
        expect(projectIdFromPackage("my app!")).toBe("my-app");
        expect(projectIdFromPackage(undefined)).toBe("app");
        expect(projectIdFromPackage("@x/")).toBe("app");
        expect(projectIdFromPackage("a".repeat(300)).length).toBe(128);
    });
});

describe("addImport", () => {
    it("goes after the last import, including multi-line ones", () => {
        const source = `import a from "a"\nimport {\n  b,\n  c,\n} from "b"\n\nconst x = 1\n`;
        const out = addImport(source, 'import { Notato } from "@notato/react"');
        expect(out).toBe(
            `import a from "a"\nimport {\n  b,\n  c,\n} from "b"\nimport { Notato } from "@notato/react"\n\nconst x = 1\n`
        );
    });
    it("handles side-effect imports and follows a semicolon style", () => {
        const out = addImport(`import "./styles.css";\nconst x = 1\n`, 'import y from "y"');
        expect(out.startsWith(`import "./styles.css";\nimport y from "y";\n`)).toBe(true);
    });
    it("keeps a 'use client' directive first", () => {
        const out = addImport(`"use client"\n\nconst x = 1\n`, 'import y from "y"');
        expect(out.indexOf("use client")).toBeLessThan(out.indexOf("import y"));
    });
    it("uses the quotes the file already uses", () => {
        const single = addImport(
            "import a from 'a'\nimport b from 'b'\n",
            'import { Notato } from "@notato/react"'
        );
        expect(single).toContain("import { Notato } from '@notato/react'");
        const double = addImport('import a from "a"\n', 'import { Notato } from "@notato/react"');
        expect(double).toContain('import { Notato } from "@notato/react"');
        expect(addImport("const x = 1\n", 'import y from "y"')).toContain('"y"');
    });
    it("prepends when there are no imports", () => {
        expect(addImport("const x = 1\n", 'import y from "y"')).toBe(
            'import y from "y"\nconst x = 1\n'
        );
    });

    // A last import with something after it on its line once made the search run on to the next line that ended in
    // a string, and the import went in there, in the middle of an expression.
    const N = 'import { Notato } from "@notato/react"';
    it("ends the imports at a last import with a comment after it, not inside a Vite config", () => {
        const source = `import { defineConfig } from "vite"\nimport react from "@vitejs/plugin-react" // React\n\nexport default defineConfig({\n    plugins: [react()],\n    base: "/app/"\n})\n`;
        expect(addImport(source, N)).toBe(
            `import { defineConfig } from "vite"\nimport react from "@vitejs/plugin-react" // React\n${N}\n\nexport default defineConfig({\n    plugins: [react()],\n    base: "/app/"\n})\n`
        );
    });
    it("does not put the import inside a ternary", () => {
        const source = `import App from "./App" /* the root */\nconst mode = import.meta.env.PROD ? "production"\n    : "development"\n`;
        expect(addImport(source, N)).toBe(
            `import App from "./App" /* the root */\n${N}\nconst mode = import.meta.env.PROD ? "production"\n    : "development"\n`
        );
    });
    it("does not put the import inside a JSX tag", () => {
        const source = `import App from "./App"; // root\ncreateRoot(el).render(\n    <div className="root"\n        id="main"><App /></div>\n)\n`;
        expect(addImport(source, N)).toBe(
            `import App from "./App"; // root\n${N}\ncreateRoot(el).render(\n    <div className="root"\n        id="main"><App /></div>\n)\n`
        );
    });
    it("reads import attributes, import-equals, CRLF and code after an import on its line", () => {
        expect(
            addImport(`import data from "./d.json" with { type: "json" }\nconst t = "x"\n`, N)
        ).toBe(`import data from "./d.json" with { type: "json" }\n${N}\nconst t = "x"\n`);
        expect(addImport(`import fs = require("fs")\nconst t = "x"\n`, N)).toBe(
            `import fs = require("fs")\n${N}\nconst t = "x"\n`
        );
        expect(addImport(`import a from "a" // x\r\n\r\nconst t = "x"\r\n`, N)).toBe(
            `import a from "a" // x\r\n${N}\r\n\r\nconst t = "x"\r\n`
        );
        expect(addImport(`import a from "a"; const t = "x"\n`, N)).toBe(
            `import a from "a";\n${N}\nconst t = "x"\n`
        );
    });
    it("stops at the first statement that is not an import declaration", () => {
        expect(addImport(`import a from "a"\nimport("./lazy")\nconst b = "c"\n`, N)).toBe(
            `import a from "a"\n${N}\nimport("./lazy")\nconst b = "c"\n`
        );
        expect(addImport(`"use client"\nimport a from "a"\nconst b = "c"\n`, N)).toBe(
            `"use client"\nimport a from "a"\n${N}\nconst b = "c"\n`
        );
    });
});

const VITE_MAIN = `import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`;

describe("addToViteEntry", () => {
    it("puts the toolbar next to <App /> behind import.meta.env.DEV", () => {
        const edit = addToViteEntry(VITE_MAIN, setup);
        expect(edit.changed).toBe(true);
        expect(edit.source).toContain('import { Notato } from "@notato/react"');
        // Too long for one line at prettier's default width, so it is wrapped the way prettier writes it.
        expect(edit.source).toContain('{import.meta.env.DEV && (\n        <Notato mode="dev"');
        expect(edit.source).toContain('project="shop"');
        expect(edit.source).toContain('server="http://localhost:4747"');
        expect(edit.source).toContain("<>");
        // The import comes after the last existing import, before the render call.
        expect(edit.source.indexOf("@notato/react")).toBeGreaterThan(
            edit.source.indexOf('"./index.css"')
        );
        expect(edit.source.indexOf("@notato/react")).toBeLessThan(
            edit.source.indexOf("createRoot(")
        );
    });
    it("is idempotent", () => {
        const once = addToViteEntry(VITE_MAIN, setup).source;
        const twice = addToViteEntry(once, setup);
        expect(twice).toMatchObject({ changed: false, source: once, reason: "already set up" });
    });
    it("handles a bare render and an <App> with props", () => {
        expect(
            addToViteEntry(`import { App } from "./App"\ncreateRoot(el).render(<App />)\n`, setup)
                .changed
        ).toBe(true);
        const withProps = addToViteEntry(
            `import { App } from "./App"\nrender(<App theme="dark" />)\n`,
            setup
        );
        expect(withProps.changed).toBe(true);
        expect(withProps.source).toContain('<App theme="dark" />');
    });
    it("refuses to guess when there is no <App />", () => {
        const source = `import { Root } from "./Root"\nrender(<Root />)\n`;
        expect(addToViteEntry(source, setup)).toMatchObject({ changed: false, source });
        expect(addToViteEntry(source, setup).reason).toContain("<App />");
    });
    it("escapes the project and server into valid JSX strings", () => {
        const out = addToViteEntry(VITE_MAIN, { project: 'a"b', server: "http://x" }).source;
        expect(out).toContain('project="a\\"b"');
    });
});

describe("Next.js transforms", () => {
    const LAYOUT = `import type { Metadata } from "next"
import "./globals.css"


export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  )
}
`;
    it("adds <NotatoDev /> before </body> in the root layout", () => {
        const edit = addToNextLayout(LAYOUT, "./notato-dev");
        expect(edit.changed).toBe(true);
        expect(edit.source).toContain('import { NotatoDev } from "./notato-dev"');
        expect(edit.source).toMatch(/\{children\}\n\s+<NotatoDev \/>\n\s+<\/body>/);
        expect(addToNextLayout(edit.source, "./notato-dev")).toMatchObject({
            changed: false,
            reason: "already set up",
        });
    });
    it("opens up a one-line <body className=…>{children}</body> so the toolbar gets its own line", () => {
        const layout = `import "./globals.css"\n\nexport default function L({ children }) {\n  return (\n    <html>\n      <body className={inter.className}>{children}</body>\n    </html>\n  )\n}\n`;
        const edit = addToNextLayout(layout, "./notato-dev");
        expect(edit.source).toContain(
            "      <body className={inter.className}>\n        {children}\n        <NotatoDev />\n      </body>\n"
        );
    });
    it("explains when there is no </body>", () => {
        expect(
            addToNextLayout("export default function L() { return null }", "./x").reason
        ).toContain("</body>");
    });
    it("wraps <Component {...pageProps} /> in the pages router", () => {
        const app = `import type { AppProps } from "next/app"\n\nexport default function App({ Component, pageProps }: AppProps) {\n  return <Component {...pageProps} />\n}\n`;
        const edit = addToNextPagesApp(app, "../components/notato-dev");
        expect(edit.changed).toBe(true);
        expect(edit.source).toContain("<NotatoDev />");
        expect(edit.source).toContain('import { NotatoDev } from "../components/notato-dev"');
        expect(addToNextPagesApp("export default () => null", "./x").reason).toContain("pageProps");
    });
    it("the client component renders nothing outside development", () => {
        const code = nextClientComponent(setup);
        expect(code.startsWith('"use client"')).toBe(true);
        expect(code).toContain('process.env.NODE_ENV !== "development") return null');
    });
});

describe("addToGitignore", () => {
    it("adds .notato/ once", () => {
        const edit = addToGitignore("node_modules\ndist");
        expect(edit.source).toContain("\n.notato/\n");
        expect(addToGitignore(edit.source)).toMatchObject({
            changed: false,
            reason: "already set up",
        });
        expect(addToGitignore("node_modules\n.notato\n").changed).toBe(false);
        expect(addToGitignore("").source.startsWith("\n# Notato")).toBe(true);
    });
});

// ---- whole-app runs --------------------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function app(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "notato-init-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
    return dir;
}
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

const pkg = (extra: Record<string, unknown> = {}, name = "@acme/shop") =>
    JSON.stringify({
        name,
        dependencies: { react: "^19" },
        devDependencies: { vite: "^8", "@notato/react": "^0.1.0" },
        ...extra,
    });

function claude(result: { code: number; output: string } = { code: 0, output: "Added" }) {
    const calls: string[][] = [];
    const opts: Pick<InitOptions, "run" | "which"> = {
        which: () => "/usr/local/bin/claude",
        run: async (command) => {
            calls.push(command);
            return result;
        },
    };
    return { calls, opts };
}

const VITE_APP = {
    "package.json": pkg(),
    "index.html":
        '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    "src/main.tsx": VITE_MAIN,
    ".gitignore": "node_modules\n",
};

describe("runInit on a Vite app", () => {
    it("edits the entry, ignores .notato/, and registers the MCP server", async () => {
        const dir = app(VITE_APP);
        const { calls, opts } = claude();
        const report = await runInit({ cwd: dir, ...opts });
        expect(report).toMatchObject({
            framework: "vite",
            project: "shop",
            mcp: "added",
            warnings: [],
        });
        expect(read(dir, "src/main.tsx")).toContain("import.meta.env.DEV && (");
        expect(read(dir, ".gitignore")).toContain(".notato/");
        expect(calls).toEqual([
            ["claude", "mcp", "add", "notato", "--", "npx", "notato", "dev", "--project", "shop"],
        ]);
        expect(report.changes.map((c) => [c.file, c.action])).toEqual([
            ["src/main.tsx", "edited"],
            [".gitignore", "edited"],
            [".claude/skills/notato/SKILL.md", "created"],
            [".claude/skills/notato-critique/SKILL.md", "created"],
        ]);
    });

    it("follows the module script in index.html, not a guessed filename", async () => {
        const { "src/main.tsx": _unused, ...rest } = VITE_APP;
        const dir = app({
            ...rest,
            "src/entry.jsx": VITE_MAIN,
            "index.html": '<script type="module" src="/src/entry.jsx"></script>',
        });
        const report = await runInit({ cwd: dir, mcp: false });
        expect(report.changes[0]).toMatchObject({ file: "src/entry.jsx", action: "edited" });
    });

    it("is safe to run twice: nothing changes and the registration is 'already'", async () => {
        const dir = app(VITE_APP);
        await runInit({ cwd: dir, ...claude().opts });
        const before = read(dir, "src/main.tsx");
        const second = await runInit({
            cwd: dir,
            ...claude({ code: 1, output: 'MCP server "notato" already exists in local config' })
                .opts,
        });
        expect(read(dir, "src/main.tsx")).toBe(before);
        expect(second.changes.every((c) => c.action === "unchanged")).toBe(true);
        expect(second.mcp).toBe("already");
    });

    it("says how to keep a Claude Code server registered before to this project, unless it is", async () => {
        const registered = (get: string) => {
            const calls: string[][] = [];
            const opts: Pick<InitOptions, "run" | "which"> = {
                which: () => "/usr/local/bin/claude",
                run: async (command) => {
                    calls.push(command);
                    return command[2] === "get"
                        ? { code: 0, output: get }
                        : { code: 1, output: 'MCP server "notato" already exists in local config' };
                },
            };
            return { calls, opts };
        };
        const older = registered("notato:\n  Scope: Local\n  Command: npx\n  Args: notato dev\n");
        const report = await runInit({ cwd: app(VITE_APP), ...older.opts });
        expect(older.calls[1]).toEqual(["claude", "mcp", "get", "notato"]);
        expect(report.mcp).toBe("already");
        expect(report.notes.join("\n")).toContain(
            "keep this one to shop: claude mcp remove notato, then claude mcp add notato -- npx notato dev --project shop"
        );
        const kept = registered("notato:\n  Args: notato dev --project shop\n");
        const quiet = await runInit({ cwd: app(VITE_APP), ...kept.opts });
        expect(quiet.notes.join("\n")).not.toContain("keep this one");
    });

    it("keeps a user-scoped Claude Code server to no one project, and says so", async () => {
        const { calls, opts } = claude();
        const report = await runInit({ cwd: app(VITE_APP), mcpScope: "user", ...opts });
        expect(calls[0]?.slice(-3)).toEqual(["npx", "notato", "dev"]);
        expect(report.notes.join("\n")).toContain("handed every project's notes, not only shop's");
    });

    it("adds no second toolbar when App.tsx already renders <Notato />", async () => {
        const appTsx = `import { Notato } from "@notato/react"\n\nexport function App() {\n  return <main><Notato project="shop" /></main>\n}\n`;
        const dir = app({ ...VITE_APP, "src/App.tsx": appTsx });
        const report = await runInit({ cwd: dir, mcp: false });
        expect(read(dir, "src/main.tsx")).toBe(VITE_MAIN);
        expect(report.changes[0]).toMatchObject({
            file: "src/App.tsx",
            action: "unchanged",
            note: expect.stringContaining("already renders <Notato />"),
        });
        expect(report.warnings).toEqual([]);
    });

    it("writes nothing and does not touch Claude on a dry run", async () => {
        const dir = app(VITE_APP);
        const { calls, opts } = claude();
        const report = await runInit({ cwd: dir, dryRun: true, ...opts });
        expect(read(dir, "src/main.tsx")).toBe(VITE_MAIN);
        expect(read(dir, ".gitignore")).toBe("node_modules\n");
        expect(report.changes[0]?.action).toBe("edited");
        expect(calls).toEqual([]);
        expect(formatReport(report, true)).toContain("would set up");
    });

    it("honours --server, --project, --mcp-scope and --no-mcp", async () => {
        const dir = app(VITE_APP);
        const { calls, opts } = claude();
        await runInit({
            cwd: dir,
            server: "http://localhost:9999",
            project: "custom",
            mcpScope: "project",
            ...opts,
        });
        expect(read(dir, "src/main.tsx")).toContain('server="http://localhost:9999"');
        expect(read(dir, "src/main.tsx")).toContain('project="custom"');
        expect(calls[0]).toEqual([
            "claude",
            "mcp",
            "add",
            "--scope",
            "project",
            "notato",
            "--",
            "npx",
            "notato",
            "dev",
            "--project",
            "custom",
        ]);
        const skipped = claude();
        expect((await runInit({ cwd: app(VITE_APP), mcp: false, ...skipped.opts })).mcp).toBe(
            "skipped"
        );
        expect(skipped.calls).toEqual([]);
    });

    it("wraps npx in cmd on Windows, where Claude Code cannot start a .cmd shim directly", async () => {
        const { calls, opts } = claude();
        await runInit({ cwd: app(VITE_APP), platform: "win32", ...opts });
        expect(calls[0]).toEqual([
            "claude",
            "mcp",
            "add",
            "notato",
            "--",
            "cmd",
            "/c",
            "npx",
            "notato",
            "dev",
            "--project",
            "shop",
        ]);
    });

    it("says what to run when claude is not installed, and reports a failed registration", async () => {
        const missing = await runInit({ cwd: app(VITE_APP), which: () => null });
        expect(missing.mcp).toBe("unavailable");
        expect(formatReport(missing, false)).toContain("claude mcp add notato -- npx notato dev");
        const failed = await runInit({
            cwd: app(VITE_APP),
            ...claude({ code: 2, output: "boom" }).opts,
        });
        expect(failed.mcp).toBe("failed");
        expect(failed.warnings.join()).toContain("boom");
    });

    it("warns when the packages are not installed, and refuses a non-app directory", async () => {
        const dir = app({
            ...VITE_APP,
            "package.json": JSON.stringify({
                name: "x",
                dependencies: { react: "^19" },
                devDependencies: { vite: "^8" },
            }),
        });
        const report = await runInit({ cwd: dir, mcp: false });
        expect(report.warnings.join()).toContain("npm i -D notato @notato/react");
        await expect(runInit({ cwd: app({}), mcp: false })).rejects.toThrow("no React app found");
    });

    it("leaves the file alone and gives the snippet when it cannot place the component", async () => {
        const dir = app({
            ...VITE_APP,
            "src/main.tsx": `import { Root } from "./Root"\nrender(<Root />)\n`,
        });
        const report = await runInit({ cwd: dir, mcp: false });
        expect(read(dir, "src/main.tsx")).toBe(`import { Root } from "./Root"\nrender(<Root />)\n`);
        expect(report.manual).toContain("<Notato");
        expect(report.manual).toContain("import.meta.env.DEV");
        expect(report.warnings.join()).toContain("<App />");
    });
});

describe("runInit on Next.js", () => {
    const LAYOUT = `import "./globals.css"\n\nexport default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}\n      </body>\n    </html>\n  )\n}\n`;
    const nextPkg = pkg(
        {
            dependencies: { react: "^19", next: "^15" },
            devDependencies: { "@notato/react": "^0.1.0" },
        },
        "storefront"
    );

    it("App Router: creates the client component beside the layout and renders it", async () => {
        const dir = app({ "package.json": nextPkg, "app/layout.tsx": LAYOUT });
        const report = await runInit({ cwd: dir, mcp: false });
        expect(report.framework).toBe("next-app");
        expect(read(dir, "app/notato-dev.tsx")).toContain("export function NotatoDev()");
        expect(read(dir, "app/notato-dev.tsx")).toContain('project="storefront"');
        expect(read(dir, "app/layout.tsx")).toContain('import { NotatoDev } from "./notato-dev"');
        expect(read(dir, "app/layout.tsx")).toContain("<NotatoDev />");
        expect(report.changes.map((c) => [c.file, c.action])).toEqual([
            ["app/notato-dev.tsx", "created"],
            ["app/layout.tsx", "edited"],
            [".claude/skills/notato/SKILL.md", "created"],
            [".claude/skills/notato-critique/SKILL.md", "created"],
        ]);
        const again = await runInit({ cwd: dir, mcp: false });
        expect(again.changes.every((c) => c.action === "unchanged")).toBe(true);
    });

    it("supports a src/ layout and JavaScript", async () => {
        const dir = app({
            "package.json": nextPkg,
            "src/app/layout.js": LAYOUT.replace("{ children }", "{ children }"),
        });
        await runInit({ cwd: dir, mcp: false });
        expect(existsSync(join(dir, "src/app/notato-dev.jsx"))).toBe(true);
    });

    it("Pages Router: puts the component under components/ and imports it relatively", async () => {
        const dir = app({
            "package.json": nextPkg,
            "pages/_app.tsx": `import type { AppProps } from "next/app"\n\nexport default function App({ Component, pageProps }: AppProps) {\n  return <Component {...pageProps} />\n}\n`,
        });
        const report = await runInit({ cwd: dir, mcp: false });
        expect(report.framework).toBe("next-pages");
        expect(read(dir, "components/notato-dev.tsx")).toContain("NotatoDev");
        expect(read(dir, "pages/_app.tsx")).toContain('from "../components/notato-dev"');
    });

    it("adds no second toolbar to an app that renders <Notato /> itself", async () => {
        const providers = `"use client"\nimport { Notato } from "@notato/react"\n\nexport function Providers({ children }) {\n  return <>{children}<Notato project="x" /></>\n}\n`;
        const dir = app({
            "package.json": nextPkg,
            "app/layout.tsx": LAYOUT,
            "app/providers.tsx": providers,
        });
        const report = await runInit({ cwd: dir, mcp: false });
        expect(read(dir, "app/layout.tsx")).toBe(LAYOUT);
        expect(existsSync(join(dir, "app/notato-dev.tsx"))).toBe(false);
        expect(report.changes[0]).toMatchObject({
            file: "app/providers.tsx",
            action: "unchanged",
            note: expect.stringContaining("already renders <Notato />"),
        });
        expect(report.manual).toBeUndefined();
    });

    it("reports a Next app it cannot find a root in, without writing", async () => {
        const dir = app({ "package.json": nextPkg });
        const report = await runInit({ cwd: dir, mcp: false });
        expect(report.manual).toBeDefined();
        expect(report.warnings.join()).toContain("app/layout");
    });
});

describe("runInit on something else", () => {
    it("prints the snippet and changes nothing", async () => {
        const dir = app({
            "package.json": JSON.stringify({ name: "x", dependencies: { react: "^19" } }),
        });
        const report = await runInit({ cwd: dir, mcp: false });
        expect(report.framework).toBe("unknown");
        expect(report.manual).toContain('import { Notato } from "@notato/react"');
        expect(report.changes).toEqual([]);
        expect(formatReport(report, false)).toContain("Add this yourself");
    });
});
