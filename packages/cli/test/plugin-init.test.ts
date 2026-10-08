import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInit } from "../src/init/init.ts";
import { formatReport } from "../src/init/report.ts";
import { runRevert } from "../src/init/revert.ts";
import { read, removeTempDirs, tempDir } from "./helpers.ts";

// Init sets up the agents it finds on this machine; these tests are about Claude Code unless they say otherwise.
process.env.NOTATO_AGENTS = "claude";

afterEach(removeTempDirs);

const MAIN = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
`;
const INDEX = '<div id="root"></div><script type="module" src="/src/main.tsx"></script>';
const HOST_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";

export default defineConfig(() => {
    const remotes = Object.fromEntries([]);
    return {
        plugins: [
            react(),
            federation({ name: "host", remotes, shared: ["react"] }),
        ],
    };
});
`;
const MODULE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";


export default defineConfig(() => {
    return {
        plugins: [
            react(),
            federation({
                name: "orderHistory",
                remotes: { appShell: "http://localhost:5000/assets/remoteEntry.js" },
                exposes: { "./routes": "./src/routes.tsx" },
                shared: ["react"],
            }),
        ],
    };
});
`;
const pkg = (
    name: string,
    extra: Record<string, unknown> = {},
    scripts: Record<string, string> = {}
) =>
    JSON.stringify({
        name,
        scripts,
        dependencies: { react: "^19" },
        devDependencies: { vite: "^7", ...extra },
    });

const FILES: Record<string, string> = {
    ".gitignore": "node_modules\n",
    "app-shell/package.json": pkg(
        "app-shell",
        { "@notato/react": "^0.1.0" },
        { "dev:built": 'vite build && concurrently "vite build --watch" "vite preview"' }
    ),
    "app-shell/index.html": INDEX,
    "app-shell/vite.config.ts": HOST_CONFIG,
    "app-shell/src/main.tsx": MAIN,
    "order-history/package.json": pkg("order-history"),
    "order-history/index.html": INDEX,
    "order-history/vite.config.ts": MODULE_CONFIG,
    "order-history/src/main.tsx": MAIN,
};

const repo = (over: Record<string, string> = {}) =>
    tempDir("notato-plugin-", { ".git/HEAD": "ref: refs/heads/main\n", ...FILES, ...over });
const snapshot = (root: string) =>
    Object.fromEntries(Object.keys(FILES).map((path) => [path, read(root, path)]));

describe("init --plugin", () => {
    it("wires every Vite app in the repo, host and modules alike, since each is built on its own", async () => {
        const root = repo();
        const report = await runInit({ cwd: root, plugin: true, mcp: false });
        for (const app of ["app-shell", "order-history"]) {
            const config = read(root, `${app}/vite.config.ts`);
            expect(config).toContain('import { notatoSource } from "@notato/vite";');
            expect(config).toContain(
                "plugins: [\n            notatoSource(),\n            react(),"
            );
        }
        const rows = report.changes.map((c) => [c.file, c.action]);
        expect(rows).toContainEqual(["app-shell/vite.config.ts", "edited"]);
        expect(rows).toContainEqual(["order-history/vite.config.ts", "edited"]);
        // The toolbar still went into the host only.
        expect(read(root, "app-shell/src/main.tsx")).toContain("<Notato");
        expect(read(root, "order-history/src/main.tsx")).toBe(MAIN);
    });

    it("says where @notato/vite still has to be installed", async () => {
        const root = repo();
        const report = await runInit({ cwd: root, plugin: true, mcp: false });
        const warnings = report.warnings.join("\n");
        expect(warnings).toContain("@notato/vite is not in app-shell/package.json");
        expect(warnings).toContain("@notato/vite is not in order-history/package.json");
        expect(warnings).toContain("npm i -D @notato/vite");
    });

    it("does not warn about a package that is already there", async () => {
        const root = repo({
            "order-history/package.json": pkg("order-history", { "@notato/vite": "^0.1.0" }),
        });
        const report = await runInit({ cwd: root, plugin: true, mcp: false });
        expect(report.warnings.join("\n")).not.toContain("not in order-history/package.json");
    });

    it("is idempotent", async () => {
        const root = repo();
        await runInit({ cwd: root, plugin: true, mcp: false });
        const after = snapshot(root);
        const again = await runInit({ cwd: root, plugin: true, mcp: false });
        expect(snapshot(root)).toEqual(after);
        expect(
            again.changes
                .filter((c) => c.file.endsWith("vite.config.ts"))
                .every((c) => c.action === "unchanged")
        ).toBe(true);
    });

    it("--dry-run writes nothing", async () => {
        const root = repo();
        const before = snapshot(root);
        const report = await runInit({ cwd: root, plugin: true, dryRun: true, mcp: false });
        expect(snapshot(root)).toEqual(before);
        expect(
            report.changes.some(
                (c) => c.file === "order-history/vite.config.ts" && c.action === "edited"
            )
        ).toBe(true);
    });

    it("a config it cannot edit is a warning, and the others are still done", async () => {
        const root = repo({
            "order-history/vite.config.ts":
                'import x from "y"\nconst plugins = [x()]\nexport default { plugins }\n',
        });
        const report = await runInit({ cwd: root, plugin: true, mcp: false });
        expect(read(root, "app-shell/vite.config.ts")).toContain("notatoSource()");
        expect(read(root, "order-history/vite.config.ts")).not.toContain("notatoSource");
        expect(report.warnings.join("\n")).toContain(
            "order-history/vite.config.ts: could not find a literal `plugins: [`"
        );
    });

    it("wires only the one app when run inside it", async () => {
        const root = repo();
        await runInit({ cwd: join(root, "order-history"), plugin: true, force: true, mcp: false });
        expect(read(root, "order-history/vite.config.ts")).toContain("notatoSource()");
        expect(read(root, "app-shell/vite.config.ts")).toBe(HOST_CONFIG);
    });
});

describe("init --plugin-only", () => {
    it("wires the plugin and nothing else", async () => {
        const root = repo();
        const before = snapshot(root);
        const report = await runInit({ cwd: root, pluginOnly: true, mcp: false });
        expect(report.pluginOnly).toBe(true);
        expect(read(root, "app-shell/vite.config.ts")).toContain("notatoSource()");
        expect(read(root, "order-history/vite.config.ts")).toContain("notatoSource()");
        expect(read(root, "app-shell/src/main.tsx")).toBe(
            before["app-shell/src/main.tsx"] as string
        );
        expect(read(root, ".gitignore")).toBe("node_modules\n");
        expect(existsSync(join(root, ".claude"))).toBe(false);
        expect(report.changes.map((c) => c.file).sort()).toEqual([
            "app-shell/vite.config.ts",
            "order-history/vite.config.ts",
        ]);
    });

    it("--app picks one module, which is what to run for a module that gets its toolbar from its host", async () => {
        const root = repo();
        await runInit({ cwd: root, pluginOnly: true, app: "order-history", mcp: false });
        expect(read(root, "order-history/vite.config.ts")).toContain("notatoSource()");
        expect(read(root, "app-shell/vite.config.ts")).toBe(HOST_CONFIG);
    });

    it("is reported as the plugin, not as a whole setup", async () => {
        const root = repo();
        const report = await runInit({ cwd: root, pluginOnly: true, mcp: false });
        const text = formatReport(report, false);
        expect(text).toContain("wired its Vite plugin");
        expect(text).not.toContain("Next: start your app");
        expect(text).toContain("VITE_NOTATO=true");
    });
});

describe("the hint to wire the plugin", () => {
    it("is given for an app that is built and previewed, which has no React dev build to learn the file from", async () => {
        const root = repo();
        const report = await runInit({ cwd: root, mcp: false });
        expect(report.notes.join("\n")).toContain("npx notato init --plugin");
    });

    it("is not given once it has been asked for", async () => {
        const root = repo();
        const report = await runInit({ cwd: root, plugin: true, mcp: false });
        expect(report.notes.join("\n")).not.toContain("npx notato init --plugin");
    });
});

describe("init --revert and the plugin", () => {
    it("leaves every file in the repo exactly as it was", async () => {
        const root = repo();
        const before = snapshot(root);
        await runInit({ cwd: root, plugin: true, mcp: false });
        expect(read(root, "order-history/vite.config.ts")).not.toBe(
            before["order-history/vite.config.ts"] as string
        );
        const report = await runRevert({ cwd: root, mcp: false });
        expect(snapshot(root)).toEqual(before);
        expect(report.changes.map((c) => c.file)).toContain("order-history/vite.config.ts");
        expect(existsSync(join(root, ".claude"))).toBe(false);
    });

    it("also cleans a module that only ever got the plugin", async () => {
        const root = repo();
        const before = snapshot(root);
        await runInit({ cwd: root, pluginOnly: true, mcp: false });
        await runRevert({ cwd: root, mcp: false });
        expect(snapshot(root)).toEqual(before);
    });

    it("--app limits it to that app, and --dry-run removes nothing", async () => {
        const root = repo();
        await runInit({ cwd: root, plugin: true, mcp: false });
        await runRevert({ cwd: root, dryRun: true, mcp: false });
        expect(read(root, "order-history/vite.config.ts")).toContain("notatoSource()");
        await runRevert({ cwd: root, app: "order-history", mcp: false });
        expect(read(root, "order-history/vite.config.ts")).toBe(MODULE_CONFIG);
        expect(read(root, "app-shell/vite.config.ts")).toContain("notatoSource()");
    });

    it("says what is still installed, and leaves a hand-written use of the plugin alone", async () => {
        const root = repo({
            "order-history/package.json": pkg("order-history", { "@notato/vite": "^0.1.0" }),
        });
        await runInit({ cwd: root, pluginOnly: true, app: "order-history", mcp: false });
        const report = await runRevert({ cwd: root, app: "order-history", mcp: false });
        expect(report.notes.join("\n")).toContain("npm rm @notato/vite");

        const custom =
            'import { notatoSource } from "@notato/vite"\nconst p = notatoSource({ enabled: true })\nexport default { plugins: [p] }\n';
        writeFileSync(join(root, "order-history/vite.config.ts"), custom);
        const again = await runRevert({ cwd: root, app: "order-history", mcp: false });
        expect(read(root, "order-history/vite.config.ts")).toBe(custom);
        expect(again.warnings.join("\n")).toContain("could not safely remove");
    });
});
