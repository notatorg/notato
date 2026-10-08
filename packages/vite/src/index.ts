import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Plugin } from "vite";
import { tagJsx } from "./transform.ts";

export { SOURCE_ATTRIBUTE, tagJsx } from "./transform.ts";

export interface NotatoSourceOptions {
    /**
     * Whether to tag elements. By default only when `VITE_NOTATO=true` is set (in the environment or a `.env` file),
     * so a build without it is exactly what it was, and nothing changes in tests that load this config.
     */
    enabled?: boolean;
    /**
     * The folder recorded paths are relative to. Default: the repository root above the Vite root (the folder with a
     * `.git` folder, or a worktree's `.git` file, looking past the `.git` file of a submodule), so in a repo of several
     * apps a path starts with the app's own folder; otherwise the Vite root.
     */
    root?: string;
}

/**
 * The repository people work in. A `.git` that is a file rather than a folder belongs to a worktree or a submodule. A
 * worktree is a whole checkout of its own (often inside the main one, as `.claude/worktrees/<name>`), so it is the
 * root. For a submodule the checkout above it, if there is one, is the repository, so a path starts with the
 * module's own folder.
 */
function findRepoRoot(from: string): string | null {
    let fallback: string | null = null;
    for (let dir = from; ; dir = dirname(dir)) {
        const git = join(dir, ".git");
        if (existsSync(git)) {
            if (statSync(git).isDirectory() || isWorktree(dir, git)) return dir;
            fallback ??= dir;
        }
        if (dirname(dir) === dir) return fallback;
    }
}

/**
 * A worktree's `.git` file points at `<repository>/.git/worktrees/<name>`, which has a `commondir` file; a
 * submodule's points at `<superproject>/.git/modules/<name>`, which has none.
 */
function isWorktree(dir: string, gitFile: string): boolean {
    try {
        const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitFile, "utf8"))?.[1];
        if (!gitdir) return false;
        const target = resolve(dir, gitdir);
        return (
            existsSync(join(target, "commondir")) ||
            /[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(target)
        );
    } catch {
        return false;
    }
}

/**
 * Records where each element is written in your source, as a `data-notato-src` attribute, so Notato can tell your
 * coding agent the exact file, line and column even in a built app, where React no longer knows. Add it next to the
 * React plugin; it only does anything when `VITE_NOTATO=true`.
 */
export function notatoSource(options: NotatoSourceOptions = {}): Plugin {
    let active = false;
    let base = "";

    return {
        name: "notato:source",
        // Before esbuild or Babel rewrite the JSX, so the positions are those of the file as it is written.
        enforce: "pre",
        configResolved(config) {
            active =
                options.enabled ?? (config.env as Record<string, unknown>).VITE_NOTATO === "true";
            base = resolve(options.root ?? findRepoRoot(config.root) ?? config.root);
        },
        transform(code, id) {
            if (!active) return null;
            const file = id.split("?")[0] ?? id;
            if (
                file.startsWith("\0") ||
                !/\.[jt]sx$/.test(file) ||
                /[\\/]node_modules[\\/]/.test(file)
            )
                return null;
            try {
                return tagJsx(code, {
                    label: relative(base, file).split("\\").join("/"),
                    id: file,
                    typescript: file.endsWith(".tsx"),
                });
            } catch (error) {
                // A file that cannot be parsed here is left alone; the build will report it properly.
                this.warn(
                    `notato: could not record source positions in ${file}: ${error instanceof Error ? error.message : error}`
                );
                return null;
            }
        },
    };
}

export default notatoSource;
