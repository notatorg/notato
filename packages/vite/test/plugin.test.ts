import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "vite";
import { build as build7 } from "vite7";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notatoSource } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "notato-vite-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
    return dir;
}

type Hooks = {
    configResolved(config: { root: string; env: Record<string, unknown> }): void;
    transform(
        this: { warn(message: string): void },
        code: string,
        id: string
    ): { code: string } | null;
};

/** The plugin, configured the way Vite would, with a stand-in for its warn function. */
function plugin(
    root: string,
    env: Record<string, unknown>,
    options: Parameters<typeof notatoSource>[0] = {}
) {
    const hooks = notatoSource(options) as unknown as Hooks;
    hooks.configResolved({ root, env });
    const warn = vi.fn();
    return { warn, run: (code: string, id: string) => hooks.transform.call({ warn }, code, id) };
}
const JSX = "export const A = () => <div>hi</div>\n";

describe("when it is on", () => {
    it("does nothing unless VITE_NOTATO is true, or enabled is set", () => {
        const root = tree({ ".git/HEAD": "" });
        expect(plugin(root, {}).run(JSX, join(root, "a.tsx"))).toBeNull();
        expect(plugin(root, { VITE_NOTATO: "false" }).run(JSX, join(root, "a.tsx"))).toBeNull();
        expect(plugin(root, { VITE_NOTATO: "true" }).run(JSX, join(root, "a.tsx"))).not.toBeNull();
        expect(plugin(root, {}, { enabled: true }).run(JSX, join(root, "a.tsx"))).not.toBeNull();
        expect(
            plugin(root, { VITE_NOTATO: "true" }, { enabled: false }).run(JSX, join(root, "a.tsx"))
        ).toBeNull();
    });

    it("runs before the JSX is compiled", () => {
        expect((notatoSource() as { enforce?: string }).enforce).toBe("pre");
    });
});

describe("which files", () => {
    const on = (root: string) => plugin(root, { VITE_NOTATO: "true" });

    it("takes .tsx and .jsx, and ignores everything else", () => {
        const root = tree({ ".git/HEAD": "" });
        const { run } = on(root);
        expect(run(JSX, join(root, "a.tsx"))).not.toBeNull();
        expect(run(JSX, join(root, "a.jsx"))).not.toBeNull();
        expect(run(JSX, join(root, "a.ts"))).toBeNull();
        expect(run(JSX, join(root, "a.js"))).toBeNull();
        expect(run(JSX, join(root, "a.css"))).toBeNull();
        expect(run(JSX, "\0virtual:thing.tsx")).toBeNull();
    });

    it("skips dependencies", () => {
        const root = tree({ ".git/HEAD": "" });
        expect(on(root).run(JSX, join(root, "node_modules/lib/index.tsx"))).toBeNull();
    });

    it("understands the query Vite adds to a module id", () => {
        const root = tree({ ".git/HEAD": "" });
        const out = on(root).run(JSX, `${join(root, "src/a.tsx")}?t=1760000000`);
        expect(out?.code).toContain('data-notato-src="src/a.tsx:1:24"');
    });
});

describe("the path it records", () => {
    it("is from the repository root, so in a repo of several apps it starts with the app's folder", () => {
        const repo = tree({ ".git/HEAD": "", "public/package.json": "{}" });
        const out = plugin(join(repo, "public"), { VITE_NOTATO: "true" }).run(
            JSX,
            join(repo, "public/src/Invite.tsx")
        );
        expect(out?.code).toContain('data-notato-src="public/src/Invite.tsx:1:24"');
    });

    it("includes shared packages that live outside the app but inside the repo", () => {
        const repo = tree({ ".git/HEAD": "" });
        const out = plugin(join(repo, "app"), { VITE_NOTATO: "true" }).run(
            JSX,
            join(repo, "packages/ui/src/Modal.tsx")
        );
        expect(out?.code).toContain('data-notato-src="packages/ui/src/Modal.tsx:1:24"');
    });

    it("looks past a submodule's .git file to the repository above it", () => {
        // `.git` is a file in a submodule, pointing at the real one; the checkout above is what people work in.
        const repo = tree({ ".git/HEAD": "", "public/.git": "gitdir: ../.git/modules/public\n" });
        const out = plugin(join(repo, "public"), { VITE_NOTATO: "true" }).run(
            JSX,
            join(repo, "public/src/Invite.tsx")
        );
        expect(out?.code).toContain('data-notato-src="public/src/Invite.tsx:1:24"');
    });

    it("stops at a worktree's .git file: a worktree inside the main checkout is a checkout of its own", () => {
        // How `git worktree add .claude/worktrees/feature` (and Claude Code's worktrees) lay it out.
        const repo = tree({
            ".git/HEAD": "",
            ".git/worktrees/feature/commondir": "../..\n",
            ".claude/worktrees/feature/.git": "gitdir: ../../../.git/worktrees/feature\n",
        });
        const worktree = join(repo, ".claude/worktrees/feature");
        const out = plugin(join(worktree, "web"), { VITE_NOTATO: "true" }).run(
            JSX,
            join(worktree, "web/src/Invite.tsx")
        );
        expect(out?.code).toContain('data-notato-src="web/src/Invite.tsx:1:24"');
        // An absolute gitdir, as git writes it, works the same.
        const absolute = tree({ ".git/HEAD": "", ".git/worktrees/wt/commondir": "../..\n" });
        mkdirSync(join(absolute, "trees/wt"), { recursive: true });
        writeFileSync(
            join(absolute, "trees/wt/.git"),
            `gitdir: ${join(absolute, ".git/worktrees/wt")}\n`
        );
        const out2 = plugin(join(absolute, "trees/wt"), { VITE_NOTATO: "true" }).run(
            JSX,
            join(absolute, "trees/wt/src/a.tsx")
        );
        expect(out2?.code).toContain('data-notato-src="src/a.tsx:1:24"');
    });

    it("uses a lone .git file (a worktree, or a submodule built on its own) when nothing is above it", () => {
        const root = tree({ ".git": "gitdir: /elsewhere\n" });
        const out = plugin(root, { VITE_NOTATO: "true" }).run(JSX, join(root, "src/a.tsx"));
        expect(out?.code).toContain('data-notato-src="src/a.tsx:1:24"');
    });

    it("falls back to the Vite root when there is no repository", () => {
        const root = tree({ "src/a.tsx": "" });
        const out = plugin(root, { VITE_NOTATO: "true" }).run(JSX, join(root, "src/a.tsx"));
        expect(out?.code).toContain('data-notato-src="src/a.tsx:1:24"');
    });

    it("can be told where to measure from", () => {
        const repo = tree({ ".git/HEAD": "" });
        const out = plugin(repo, { VITE_NOTATO: "true" }, { root: join(repo, "web") }).run(
            JSX,
            join(repo, "web/src/a.tsx")
        );
        expect(out?.code).toContain('data-notato-src="src/a.tsx:1:24"');
    });
});

describe("a file it cannot read", () => {
    it("is left alone and reported, so one odd file never fails a build", () => {
        const root = tree({ ".git/HEAD": "" });
        const { run, warn } = plugin(root, { VITE_NOTATO: "true" });
        expect(run("const x = <div a=>", join(root, "src/bad.tsx"))).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("src/bad.tsx");
    });
});

describe("in a real Vite build", () => {
    // Classic JSX with a local factory, so the build needs no React; what matters is the order the plugins run in.
    const MAIN = `const h = (tag: string, props: Record<string, unknown> | null, ...kids: unknown[]) => ({ tag, props, kids })
export const view = (
  <main>
    <h1>Pay now</h1>
  </main>
)
`;
    async function built(env: Record<string, string>, pluginOptions = {}) {
        const root = tree({ ".git/HEAD": "", "web/src/main.tsx": MAIN });
        const appRoot = join(root, "web");
        const result = (await build({
            root: appRoot,
            configFile: false,
            logLevel: "silent",
            envPrefix: "VITE_",
            define: Object.fromEntries(
                Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)])
            ),
            oxc: { jsx: { runtime: "classic", pragma: "h", pragmaFrag: "Fragment" } },
            plugins: [notatoSource({ enabled: env.VITE_NOTATO === "true", ...pluginOptions })],
            build: {
                write: false,
                minify: false,
                lib: { entry: join(appRoot, "src/main.tsx"), formats: ["es"], fileName: "out" },
            },
        })) as unknown as
            | Array<{ output: Array<{ code?: string }> }>
            | { output: Array<{ code?: string }> };
        const outputs = Array.isArray(result) ? result.flatMap((r) => r.output) : result.output;
        return outputs.map((o) => o.code ?? "").join("\n");
    }

    it("puts the position of each element into what runs, though the JSX was compiled afterwards", async () => {
        const code = await built({ VITE_NOTATO: "true" });
        expect(code).toContain("web/src/main.tsx:3:3"); // <main>
        expect(code).toContain("web/src/main.tsx:4:5"); // <h1>
        expect(code).toContain("Pay now");
    }, 30_000);

    it("leaves the build exactly as it was when it is off", async () => {
        const code = await built({});
        expect(code).not.toContain("data-notato-src");
        expect(code).not.toContain("main.tsx:3:3");
    }, 30_000);
});

// The apps this is for run Vite 7, which compiles JSX with esbuild rather than Oxc: the plugin must come first there too.
describe("in a real Vite 7 build", () => {
    it("records positions the same way", async () => {
        const root = tree({
            ".git/HEAD": "",
            "web/src/main.tsx": `const h = (tag: string, props: Record<string, unknown> | null, ...kids: unknown[]) => ({ tag, props, kids })
export const view = (
  <main>
    <h1>Pay now</h1>
  </main>
)
`,
        });
        const appRoot = join(root, "web");
        const result = (await build7({
            root: appRoot,
            configFile: false,
            logLevel: "silent",
            esbuild: { jsx: "transform", jsxFactory: "h", jsxFragment: "Fragment" },
            define: { "import.meta.env.VITE_NOTATO": '"true"' },
            plugins: [notatoSource({ enabled: true }) as never],
            build: {
                write: false,
                minify: false,
                lib: { entry: join(appRoot, "src/main.tsx"), formats: ["es"], fileName: "out" },
            },
        })) as unknown as
            | Array<{ output: Array<{ code?: string }> }>
            | { output: Array<{ code?: string }> };
        const code = (Array.isArray(result) ? result.flatMap((r) => r.output) : result.output)
            .map((o) => o.code ?? "")
            .join("\n");
        expect(code).toContain("web/src/main.tsx:3:3");
        expect(code).toContain("web/src/main.tsx:4:5");
    }, 30_000);
});
