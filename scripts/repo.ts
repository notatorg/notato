// Facts about the repository that scripts, the release and the conventions test share. No side effects: importing it
// builds nothing.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where the source is. npm metadata takes it from here; SwiftPM (the URL itself), Maven (sdks/android/gradle.properties),
 * NuGet (sdks/dotnet/Directory.Build.props), the Docker image and the site say the same, which scripts/repo.test.ts
 * checks.
 */
export const REPO_URL = "https://github.com/notatorg/notato";

export interface Library {
    name: string;
    dir: string;
    pkg: {
        description?: string;
        keywords?: string[];
        files?: string[];
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
        /** In the workspace: each entry point's TypeScript source (`".": "./src/index.ts"`). */
        exports?: Record<string, string>;
    };
}

/** A library's entry points: `.` and any subpath, each with the source file it is built from. */
export function entryPoints(lib: Library): Array<{ key: string; source: string; name: string }> {
    const exports = lib.pkg.exports ?? { ".": "./src/index.ts" };
    return Object.entries(exports)
        .filter(([, source]) => typeof source === "string" && source.endsWith(".ts"))
        .map(([key, source]) => ({
            key,
            source: source.replace(/^\.\//, ""),
            name:
                source
                    .split("/")
                    .pop()
                    ?.replace(/\.tsx?$/, "") ?? "index",
        }));
}

/** Libraries that run in Node (inside a bundler), not in a browser. */
export const NODE_LIBRARIES = new Set(["@notato/vite"]);

/** The public workspace packages, each after the workspace packages it depends on. */
export function libraries(): Library[] {
    const found = ["packages", "sdks"].flatMap((parent) =>
        readdirSync(join(ROOT, parent), { withFileTypes: true })
            .filter(
                (d) => d.isDirectory() && existsSync(join(ROOT, parent, d.name, "package.json"))
            )
            .map((d) => {
                const dir = `${parent}/${d.name}`;
                const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
                return { name: pkg.name as string, dir, pkg, private: pkg.private === true };
            })
            .filter((l) => !l.private)
    );
    const byName = new Map(found.map((l) => [l.name, l]));
    const ordered: Library[] = [];
    const visit = (lib: (typeof found)[number], path: string[] = []) => {
        if (ordered.some((l) => l.name === lib.name)) return;
        if (path.includes(lib.name))
            throw new Error(`a dependency cycle: ${[...path, lib.name].join(" → ")}`);
        for (const dep of Object.keys(lib.pkg.dependencies ?? {})) {
            const inner = byName.get(dep);
            if (inner) visit(inner, [...path, lib.name]);
        }
        ordered.push({ name: lib.name, dir: lib.dir, pkg: lib.pkg });
    };
    for (const lib of found) visit(lib);
    return ordered;
}
