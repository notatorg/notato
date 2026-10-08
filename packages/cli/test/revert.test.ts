import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AmbiguousAppError, type InitOptions, runInit } from "../src/commands/init.ts";
import { formatRevertReport, runRevert } from "../src/commands/revert.ts";
import {
    addToGitignore,
    addToNextLayout,
    addToNextPagesApp,
    addToViteEntry,
    isGeneratedNotatoComponent,
    nextClientComponent,
    removeFromGitignore,
    removeFromNextLayout,
    removeFromNextPagesApp,
    removeFromViteEntry,
} from "../src/init-transforms.ts";

// Init sets up the agents it finds on this machine; these tests are about Claude Code unless they say otherwise.
process.env.NOTATO_AGENTS = "claude";

const setup = { project: "shop", server: "http://localhost:4747" };

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---- the transforms: what init writes, revert takes back out, exactly ------------------------------------

const TWO_SPACE = `import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`;
const FOUR_SPACE_SEMI = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n/config";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
`;
const BARE = `import { App } from "./App"\ncreateRoot(el).render(<App />)\n`;
const WITH_PROPS = `import { App } from "./App"\nrender(<App theme="dark" />)\n`;
const ONE_LINE = `import { App } from "./App"\n\ncreateRoot(el).render(<StrictMode><App /></StrictMode>)\n`;
const NO_IMPORTS = `createRoot(el).render(<App />)\n`;

describe("removeFromViteEntry", () => {
    for (const [name, source] of Object.entries({
        "2-space, no semicolons": TWO_SPACE,
        "4-space with semicolons": FOUR_SPACE_SEMI,
        "a bare render": BARE,
        "an <App> with props": WITH_PROPS,
        "everything on one line": ONE_LINE,
        "a file with no imports": NO_IMPORTS,
    })) {
        for (const guard of ["dev", "env"] as const) {
            it(`gives back ${name} exactly (${guard} guard)`, () => {
                const added = addToViteEntry(source, { ...setup, guard });
                expect(added.changed).toBe(true);
                const removed = removeFromViteEntry(added.source);
                expect(removed.changed).toBe(true);
                expect(removed.source).toBe(source);
            });
        }
    }

    it("keeps a fragment that holds more than <App />", () => {
        const source = `import { App } from "./App"\nrender(<><Analytics /><App /></>)\n`;
        expect(removeFromViteEntry(addToViteEntry(source, setup).source).source).toBe(source);
    });

    it("removes an element with props of its own, including JSX inside a prop", () => {
        const edited = `import { App } from "./App"
import { Notato } from "@notato/react"
render(
  <>
    <App />
    {import.meta.env.DEV && (
      <Notato mode="dev" project="shop" plugins={[extra()]} onThing={() => <b />} server="http://x/y" />
    )}
  </>,
)
`;
        const out = removeFromViteEntry(edited);
        expect(out.changed).toBe(true);
        expect(out.source).toBe(`import { App } from "./App"\nrender(\n  <App />,\n)\n`);
    });

    it("removes a bare <Notato /> that someone wrote without a guard", () => {
        const edited = `import { Notato } from "@notato/react"\nrender(\n  <>\n    <App />\n    <Notato mode="test" project="x" />\n  </>,\n)\n`;
        expect(removeFromViteEntry(edited).source).toBe(`render(\n  <App />,\n)\n`);
    });

    it("does nothing when there is nothing to remove, and says so", () => {
        expect(removeFromViteEntry(TWO_SPACE)).toMatchObject({
            changed: false,
            reason: "not set up",
        });
        const once = removeFromViteEntry(addToViteEntry(TWO_SPACE, setup).source).source;
        expect(removeFromViteEntry(once)).toMatchObject({ changed: false, reason: "not set up" });
    });

    it("will not break an expression it does not recognise", () => {
        const edited = `import { Notato } from "@notato/react"\nrender(<>{isDev({ a: 1 }) && <Notato mode="dev" />}<App /></>)\n`;
        const out = removeFromViteEntry(edited);
        expect(out).toMatchObject({ changed: false, source: edited });
        expect(out.reason).toContain("by hand");
    });

    it("leaves an import that has other names in it, and says so", () => {
        const edited = `import { Notato, consolePlugin } from "@notato/react"\nrender(\n  <>\n    <App />\n    <Notato mode="dev" />\n  </>,\n)\n`;
        const out = removeFromViteEntry(edited);
        expect(out.source).toContain('import { Notato, consolePlugin } from "@notato/react"');
        expect(out.source).not.toContain("<Notato");
        expect(out.note).toContain("other names");
    });
});

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
const PAGES_APP = `import type { AppProps } from "next/app"\n\nexport default function App({ Component, pageProps }: AppProps) {\n  return <Component {...pageProps} />\n}\n`;

describe("removeFromNextLayout and removeFromNextPagesApp", () => {
    it("gives back the root layout exactly", () => {
        const added = addToNextLayout(LAYOUT, "./notato-dev").source;
        expect(removeFromNextLayout(added).source).toBe(LAYOUT);
    });
    it("gives back _app exactly, unwrapping the fragment", () => {
        const added = addToNextPagesApp(PAGES_APP, "../components/notato-dev").source;
        expect(removeFromNextPagesApp(added).source).toBe(PAGES_APP);
    });
    it("takes the toolbar out of a one-line <body> and leaves it open, which is still valid", () => {
        const layout = `import "./globals.css"\n\nexport default function L({ children }) {\n  return (\n    <html>\n      <body className={inter.className}>{children}</body>\n    </html>\n  )\n}\n`;
        const out = removeFromNextLayout(addToNextLayout(layout, "./notato-dev").source);
        expect(out.source).not.toContain("NotatoDev");
        expect(out.source).toContain(
            "<body className={inter.className}>\n        {children}\n      </body>"
        );
    });
    it("says when there is nothing to remove", () => {
        expect(removeFromNextLayout(LAYOUT)).toMatchObject({
            changed: false,
            reason: "not set up",
        });
    });
    it("recognises only the component file init writes", () => {
        expect(isGeneratedNotatoComponent(nextClientComponent(setup))).toBe(true);
        expect(isGeneratedNotatoComponent("export function NotatoDev() { return <Mine /> }")).toBe(
            false
        );
    });
});

describe("removeFromGitignore", () => {
    for (const source of ["node_modules\n", "node_modules\ndist\n", ""]) {
        it(`gives back ${JSON.stringify(source)} exactly`, () => {
            expect(removeFromGitignore(addToGitignore(source).source).source).toBe(source);
        });
    }
    it("leaves a .notato entry that someone else wrote", () => {
        const out = removeFromGitignore("node_modules\n.notato/\n");
        expect(out).toMatchObject({ changed: false, source: "node_modules\n.notato/\n" });
        expect(out.reason).toContain("did not add");
    });
    it("says when there is nothing to remove", () => {
        expect(removeFromGitignore("node_modules\n")).toMatchObject({
            changed: false,
            reason: "not set up",
        });
    });
});

// ---- whole runs: init, then revert, and the project is as it was --------------------------------------------

function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "notato-revert-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
    return dir;
}
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const write = (dir: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
};

const pkg = (extra: Record<string, unknown> = {}, scripts: Record<string, string> = {}) =>
    JSON.stringify({
        name: "@acme/shop",
        scripts,
        dependencies: { react: "^19" },
        devDependencies: { vite: "^8", "@notato/react": "^0.1.0" },
        ...extra,
    });
const INDEX =
    '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>';

/** Stands in for the `claude` command and records what it was asked to run. */
function claude(result: { code: number; output: string } = { code: 0, output: "ok" }) {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    const opts: Pick<InitOptions, "run" | "which"> = {
        which: () => "/usr/local/bin/claude",
        run: async (command, cwd) => {
            calls.push({ command, cwd });
            return result;
        },
    };
    return { calls, opts };
}

const VITE_APP = {
    "package.json": pkg(),
    "index.html": INDEX,
    "src/main.tsx": TWO_SPACE,
    ".gitignore": "node_modules\n",
};

describe("runRevert on a Vite app", () => {
    it("undoes init: the files are as they were, and the registration is removed", async () => {
        const dir = tree(VITE_APP);
        await runInit({ cwd: dir, ...claude().opts });
        expect(read(dir, "src/main.tsx")).not.toBe(TWO_SPACE);

        const c = claude();
        const report = await runRevert({ cwd: dir, ...c.opts });
        expect(read(dir, "src/main.tsx")).toBe(TWO_SPACE);
        expect(read(dir, ".gitignore")).toBe("node_modules\n");
        expect(report.mcp).toBe("removed");
        expect(report.warnings).toEqual([]);
        expect(c.calls).toEqual([{ command: ["claude", "mcp", "remove", "notato"], cwd: dir }]);
        expect(report.changes.map((x) => [x.file, x.action])).toEqual([
            ["src/main.tsx", "edited"],
            [".gitignore", "edited"],
            [".claude/skills/notato/SKILL.md", "deleted"],
            [".claude/skills/notato-critique/SKILL.md", "deleted"],
        ]);
    });

    it("undoes the build-and-preview guard too", async () => {
        const dir = tree({
            ...VITE_APP,
            "package.json": pkg(
                {},
                { aspire: 'vite build && concurrently "vite build --watch" "vite preview"' }
            ),
        });
        await runInit({ cwd: dir, mcp: false });
        expect(read(dir, "src/main.tsx")).toContain("VITE_NOTATO");
        await runRevert({ cwd: dir, mcp: false });
        expect(read(dir, "src/main.tsx")).toBe(TWO_SPACE);
    });

    it("can be run twice: the second time changes nothing and is not an error", async () => {
        const dir = tree(VITE_APP);
        await runInit({ cwd: dir, mcp: false });
        await runRevert({ cwd: dir, mcp: false });
        const c = claude({ code: 1, output: "No MCP server found with name: notato" });
        const again = await runRevert({ cwd: dir, ...c.opts });
        expect(again.changes.every((x) => x.action === "unchanged")).toBe(true);
        expect(again.warnings).toEqual([]);
        expect(again.mcp).toBe("already");
        expect(read(dir, "src/main.tsx")).toBe(TWO_SPACE);
    });

    it("--dry-run writes nothing and does not touch Claude Code", async () => {
        const dir = tree(VITE_APP);
        await runInit({ cwd: dir, mcp: false });
        const after = read(dir, "src/main.tsx");
        const c = claude();
        const report = await runRevert({ cwd: dir, dryRun: true, ...c.opts });
        expect(read(dir, "src/main.tsx")).toBe(after);
        expect(c.calls).toEqual([]);
        expect(report.mcp).toBe("skipped");
        expect(report.changes.some((x) => x.action === "edited")).toBe(true);
        expect(formatRevertReport(report, true)).toContain("would be removed");
    });

    it("passes the scope through, and --no-mcp skips Claude Code", async () => {
        const dir = tree(VITE_APP);
        await runInit({ cwd: dir, mcp: false });
        const scoped = claude();
        await runRevert({ cwd: dir, mcpScope: "project", ...scoped.opts });
        expect(scoped.calls[0]?.command).toEqual([
            "claude",
            "mcp",
            "remove",
            "--scope",
            "project",
            "notato",
        ]);
        const skipped = claude();
        expect((await runRevert({ cwd: dir, mcp: false, ...skipped.opts })).mcp).toBe("skipped");
        expect(skipped.calls).toEqual([]);
    });

    it("reports a failed removal as a failure, not as already gone", async () => {
        const dir = tree(VITE_APP);
        const report = await runRevert({ cwd: dir, ...claude({ code: 1, output: "boom" }).opts });
        expect(report.mcp).toBe("failed");
        expect(report.warnings.join()).toContain("boom");
    });

    it("keeps the recorded annotations, and says where they are", async () => {
        const dir = tree({ ...VITE_APP, ".notato/notato.db": "data" });
        const report = await runRevert({ cwd: dir, mcp: false });
        expect(existsSync(join(dir, ".notato/notato.db"))).toBe(true);
        expect(report.notes.join("\n")).toContain("left in place");
    });

    it("keeps .notato/ ignored while the folder is there, so its database and tokens cannot be committed", async () => {
        const dir = tree(VITE_APP);
        await runInit({ cwd: dir, mcp: false });
        write(dir, { ".notato/device.json": '{"token":"secret"}', ".notato/notato.db": "data" });
        const report = await runRevert({ cwd: dir, mcp: false });
        expect(read(dir, ".gitignore")).toContain(".notato/");
        expect(report.changes.find((c) => c.file === ".gitignore")).toMatchObject({
            action: "unchanged",
            note: expect.stringContaining("kept .notato/"),
        });
        expect(report.warnings).toEqual([]);
        expect(report.notes.join("\n")).toContain("run `npx notato init --revert` again");

        // A data folder further down (a server started in one app of a repo) counts too.
        rmSync(join(dir, ".notato"), { recursive: true });
        write(dir, { "tools/.notato/notato.db": "data" });
        await runRevert({ cwd: dir, mcp: false });
        expect(read(dir, ".gitignore")).toContain(".notato/");

        rmSync(join(dir, "tools"), { recursive: true });
        await runRevert({ cwd: dir, mcp: false });
        expect(read(dir, ".gitignore")).toBe("node_modules\n");
    });

    it("mentions what it does not touch: VITE_NOTATO in .env.local and the installed packages", async () => {
        const dir = tree({ ...VITE_APP, ".env.local": "VITE_NOTATO=true\n" });
        await runInit({ cwd: dir, mcp: false });
        const report = await runRevert({ cwd: dir, mcp: false });
        const notes = report.notes.join("\n");
        expect(notes).toContain("VITE_NOTATO");
        expect(notes).toContain("npm rm notato @notato/react");
        expect(read(dir, ".env.local")).toBe("VITE_NOTATO=true\n");
    });

    it("refuses to guess about code changed by hand, and exits non-zero through its warnings", async () => {
        const edited = `import { Notato } from "@notato/react"\nrender(<>{isDev({ a: 1 }) && <Notato mode="dev" />}<App /></>)\n`;
        const dir = tree({ ...VITE_APP, "src/main.tsx": edited });
        const report = await runRevert({ cwd: dir, mcp: false });
        expect(read(dir, "src/main.tsx")).toBe(edited);
        expect(report.warnings.join()).toContain("by hand");
    });

    it("has nothing to do in an app that never had it, and says so", async () => {
        const dir = tree({ ...VITE_APP, "package.json": pkg({ devDependencies: { vite: "^8" } }) });
        const report = await runRevert({ cwd: dir, mcp: false });
        expect(report.app).toBeUndefined();
        expect(report.notes.join()).toContain("does not render <Notato />");
        expect(report.changes).toEqual([]);
    });
});

describe("runRevert on Next.js", () => {
    const NEXT_APP = {
        "package.json": JSON.stringify({
            name: "web",
            dependencies: { next: "^15", react: "^19" },
        }),
        "app/layout.tsx": LAYOUT,
        ".gitignore": "node_modules\n",
    };
    it("restores the layout and deletes the component file init wrote", async () => {
        const dir = tree(NEXT_APP);
        await runInit({ cwd: dir, mcp: false });
        expect(existsSync(join(dir, "app/notato-dev.tsx"))).toBe(true);
        const report = await runRevert({ cwd: dir, mcp: false });
        expect(read(dir, "app/layout.tsx")).toBe(LAYOUT);
        expect(existsSync(join(dir, "app/notato-dev.tsx"))).toBe(false);
        expect(report.changes.map((x) => x.action)).toContain("deleted");
    });
    it("leaves a component file that is not the one init wrote", async () => {
        const dir = tree(NEXT_APP);
        await runInit({ cwd: dir, mcp: false });
        const mine =
            'import { Notato } from "@notato/react"\nexport const Mine = () => <Notato mode="test" />\n';
        writeFileSync(join(dir, "app/notato-dev.tsx"), mine);
        const report = await runRevert({ cwd: dir, mcp: false });
        expect(read(dir, "app/notato-dev.tsx")).toBe(mine);
        expect(report.warnings.join()).toContain("not the file init wrote");
    });
    it("restores a pages-router _app", async () => {
        const dir = tree({
            "package.json": JSON.stringify({
                name: "web",
                dependencies: { next: "^15", react: "^19" },
            }),
            "pages/_app.tsx": PAGES_APP,
            ".gitignore": "node_modules\n",
        });
        await runInit({ cwd: dir, mcp: false });
        await runRevert({ cwd: dir, mcp: false });
        expect(read(dir, "pages/_app.tsx")).toBe(PAGES_APP);
        expect(existsSync(join(dir, "components/notato-dev.tsx"))).toBe(false);
    });
});

describe("runRevert in a repo of several apps", () => {
    const HOST_CONFIG = `import federation from "@originjs/vite-plugin-federation"\nconst remotes = Object.fromEntries([])\nexport default { plugins: [federation({ name: "host", remotes, shared: ["react"] })] }\n`;
    const MODULE_CONFIG = `import federation from "@originjs/vite-plugin-federation"\nexport default { plugins: [federation({ name: "mod", exposes: { "./routes": "./src/routes.tsx" } })] }\n`;
    const reactPkg = (name: string, withNotato = false) =>
        JSON.stringify({
            name,
            dependencies: { react: "^19" },
            devDependencies: { vite: "^7", ...(withNotato ? { "@notato/react": "^0.1.0" } : {}) },
        });
    const repo = () =>
        tree({
            ".git/HEAD": "ref: refs/heads/main\n",
            ".gitignore": "node_modules\n",
            "app-shell/package.json": reactPkg("app-shell", true),
            "app-shell/index.html": INDEX,
            "app-shell/vite.config.ts": HOST_CONFIG,
            "app-shell/src/main.tsx": FOUR_SPACE_SEMI,
            "order-history/package.json": reactPkg("order-history"),
            "order-history/index.html": INDEX,
            "order-history/vite.config.ts": MODULE_CONFIG,
            "order-history/src/main.tsx": FOUR_SPACE_SEMI,
        });

    /** The module first, while its host has no toolbar yet and --force is still allowed; then the host. */
    const twoApps = async (dir: string) => {
        await runInit({ cwd: dir, app: "order-history", force: true, mcp: false });
        await runInit({ cwd: dir, app: "app-shell", mcp: false });
    };

    it("finds the app that has the toolbar from the repo root and restores it", async () => {
        const dir = repo();
        await runInit({ cwd: dir, mcp: false });
        expect(read(dir, "app-shell/src/main.tsx")).not.toBe(FOUR_SPACE_SEMI);
        const report = await runRevert({ cwd: dir, mcp: false });
        expect(report.app?.dir).toBe("app-shell");
        expect(read(dir, "app-shell/src/main.tsx")).toBe(FOUR_SPACE_SEMI);
        expect(read(dir, "order-history/src/main.tsx")).toBe(FOUR_SPACE_SEMI);
        expect(read(dir, ".gitignore")).toBe("node_modules\n");
    });

    it("registers and removes for the repo root: the .gitignore and Claude Code follow --claude-dir", async () => {
        const dir = repo();
        await runInit({ cwd: dir, claudeDir: ".", mcp: false });
        const c = claude();
        await runRevert({ cwd: dir, claudeDir: ".", ...c.opts });
        expect(c.calls[0]?.cwd).toBe(dir);
        expect(read(dir, ".gitignore")).toBe("node_modules\n");
    });

    it("run inside a module whose host has the toolbar, it points at the host and changes nothing", async () => {
        const dir = repo();
        await runInit({ cwd: dir, mcp: false });
        const hostMain = read(dir, "app-shell/src/main.tsx");
        const report = await runRevert({ cwd: join(dir, "order-history"), mcp: false });
        expect(report.app).toBeUndefined();
        expect(report.notes.join()).toContain("federation host");
        expect(read(dir, "app-shell/src/main.tsx")).toBe(hostMain);
    });

    it("asks which when two apps have it, and stops without a terminal", async () => {
        const dir = repo();
        await twoApps(dir);
        await expect(runRevert({ cwd: dir, mcp: false })).rejects.toBeInstanceOf(AmbiguousAppError);
        const asked: string[][] = [];
        const report = await runRevert({
            cwd: dir,
            mcp: false,
            prompt: async (_q, choices) => {
                asked.push(choices);
                return choices.findIndex((c) => c.startsWith("order-history"));
            },
        });
        expect(report.app?.dir).toBe("order-history");
        expect(read(dir, "order-history/src/main.tsx")).toBe(FOUR_SPACE_SEMI);
        expect(read(dir, "app-shell/src/main.tsx")).not.toBe(FOUR_SPACE_SEMI);
        expect(asked[0]).toHaveLength(2);
    });

    it("--app picks one explicitly", async () => {
        const dir = repo();
        await twoApps(dir);
        const report = await runRevert({ cwd: dir, app: "app-shell", mcp: false });
        expect(report.app?.dir).toBe("app-shell");
        expect(read(dir, "app-shell/src/main.tsx")).toBe(FOUR_SPACE_SEMI);
    });
});
