import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
    analyzeFederation,
    classifyFederation,
    type FederationInfo,
    type FederationRole,
    federationRole,
} from "./federation.ts";
import { isGeneratedNotatoComponent } from "./init/transforms.ts";

// Finding the React apps in a repository, and the files in an app that init edits.

/**
 * A federation host loads other apps (remotes) into its own page at runtime, so one toolbar in the host reaches
 * all of them. A remote is loaded by a host; a standalone app is neither.
 */
export type AppRole = FederationRole;

export interface AppInfo {
    /** Absolute path. */
    dir: string;
    /** Path from the directory the search started in. */
    rel: string;
    name: string;
    framework: "vite" | "next";
    role: AppRole;
    federation: FederationInfo;
    /** The app's source already renders <Notato />. */
    hasNotato: boolean;
}

const SKIP = new Set([
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    "playwright-report",
    "test-results",
]);
const VITE_CONFIGS = [
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
];
const NEXT_LAYOUTS = ["app", "src/app"].flatMap((dir) =>
    ["tsx", "jsx", "js"].map((ext) => `${dir}/layout.${ext}`)
);
const NEXT_PAGES_APPS = ["pages", "src/pages"].flatMap((dir) =>
    ["tsx", "jsx", "js"].map((ext) => `${dir}/_app.${ext}`)
);

const NO_FEDERATION: FederationInfo = {
    present: false,
    dynamicRemotes: false,
    remoteKeys: [],
    exposes: [],
};

/** A JSON file's object, or null when it is missing or not JSON. */
export function readJson(path: string): Record<string, unknown> | null {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** Whether a package.json lists `name` in its dependencies or devDependencies. */
export function dependsOn(pkg: Record<string, unknown>, name: string): boolean {
    return Boolean(
        (pkg.dependencies as Record<string, string> | undefined)?.[name] ??
            (pkg.devDependencies as Record<string, string> | undefined)?.[name]
    );
}

/** The first of `candidates` (paths relative to `dir`) that exists, or null. */
export function firstExisting(dir: string, candidates: string[]): string | null {
    return candidates.find((c) => existsSync(join(dir, c))) ?? null;
}

/** The Vite config file in `dir`, as a file name, or null. */
export function viteConfigFile(dir: string): string | null {
    return firstExisting(dir, VITE_CONFIGS);
}

/** The module script `index.html` points at, which is where a Vite app mounts React, relative to `dir`. */
export function viteEntry(dir: string): string | null {
    const html = existsSync(join(dir, "index.html"))
        ? readFileSync(join(dir, "index.html"), "utf8")
        : "";
    const src =
        /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i.exec(html)?.[1] ??
        /<script[^>]*src=["']([^"']+)["'][^>]*type=["']module["']/i.exec(html)?.[1];
    const fromHtml = src && !/^https?:/.test(src) ? src.replace(/^\//, "") : null;
    if (fromHtml && existsSync(join(dir, fromHtml))) return fromHtml;
    return firstExisting(dir, [
        "src/main.tsx",
        "src/main.jsx",
        "src/index.tsx",
        "src/index.jsx",
        "main.tsx",
        "main.jsx",
    ]);
}

/** Where a Next.js app has its root, relative to `dir`: the App Router's layout, else the Pages Router's _app. */
export interface NextRoot {
    file: string;
    router: "app" | "pages";
}

export function nextRoot(dir: string): NextRoot | null {
    const layout = firstExisting(dir, NEXT_LAYOUTS);
    if (layout) return { file: layout, router: "app" };
    const pagesApp = firstExisting(dir, NEXT_PAGES_APPS);
    return pagesApp ? { file: pagesApp, router: "pages" } : null;
}

/**
 * Where init writes the client component that renders the toolbar in a Next.js app, relative to the app: beside the
 * root layout, or in the components folder next to `pages`.
 */
export function nextComponentFile(root: NextRoot, extension: string): string {
    const name = `notato-dev${extension}`;
    if (root.router === "app") return join(dirname(root.file), name);
    return join(root.file.startsWith("src/") ? "src" : ".", "components", name);
}

/** Module Federation shows up in the Vite config; `analyzeFederation` reads what the app declares there. */
function federationOf(dir: string): FederationInfo {
    const config = viteConfigFile(dir);
    return config ? analyzeFederation(readFileSync(join(dir, config), "utf8")) : NO_FEDERATION;
}

/**
 * The first source file of the app whose text passes `test`, relative to `dir`, or null. Looks only where `init`
 * puts things and where an app's own components live, so it stays fast and does not wander through node_modules.
 */
function findInApp(dir: string, test: (text: string) => boolean): string | null {
    const spots = [
        "index.html",
        "src",
        "app",
        "pages",
        "components",
        "src/app",
        "src/pages",
        "src/components",
    ];
    const visit = (path: string, depth: number): string | null => {
        if (!existsSync(path)) return null;
        try {
            if (/\.(?:[cm]?[jt]sx?|html)$/.test(path))
                return test(readFileSync(path, "utf8")) ? path : null;
            if (depth === 0) return null;
            for (const e of readdirSync(path, { withFileTypes: true })) {
                if (e.name === "node_modules") continue;
                const found = visit(join(path, e.name), depth - 1);
                if (found) return found;
            }
            return null;
        } catch {
            return null;
        }
    };
    for (const spot of spots) {
        const found = visit(join(dir, spot), 2);
        if (found) return relative(dir, found).split("\\").join("/");
    }
    return null;
}

/** Whether the app's source uses @notato/react at all. */
export function appMentionsNotato(dir: string): boolean {
    return findInApp(dir, (text) => /@notato\/react/.test(text)) !== null;
}

/**
 * The file that renders the toolbar (`<Notato … />` from @notato/react), relative to the app, or null. The component
 * `init` writes for Next.js does not count: it only renders the toolbar where something renders it.
 */
export function notatoRenderedIn(dir: string): string | null {
    return findInApp(
        dir,
        (text) =>
            /@notato\/react/.test(text) &&
            /<Notato\b/.test(text) &&
            !isGeneratedNotatoComponent(text)
    );
}

/**
 * `dir` as a React app (Vite with an index.html, or Next.js), or null when it is something else. The role is what
 * the app's own config suggests; `refineRole` and `discoverApps` compare it with its neighbours.
 */
export function describeApp(dir: string, base = dir): AppInfo | null {
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg) return null;
    const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    const framework = deps.next
        ? "next"
        : deps.vite && existsSync(join(dir, "index.html"))
          ? "vite"
          : null;
    if (!framework || !deps.react) return null;
    const federation = framework === "vite" ? federationOf(dir) : NO_FEDERATION;
    return {
        dir,
        rel: relative(base, dir) || ".",
        name: typeof pkg.name === "string" ? pkg.name : basename(dir),
        framework,
        role: federationRole(federation),
        federation,
        hasNotato: appMentionsNotato(dir),
    };
}

/** Gives each app the role it has among the others, by comparing their federation links. */
function classify(apps: AppInfo[]): AppInfo[] {
    const roles = classifyFederation(
        apps.map((a) => ({ id: a.dir, dirName: basename(a.dir), info: a.federation }))
    );
    return apps.map((a) => ({ ...a, role: roles.get(a.dir) ?? a.role }));
}

/** React apps below `root`, found through workspace-style folders but not inside an app itself. */
export function discoverApps(root: string, maxDepth = 3): AppInfo[] {
    const found: AppInfo[] = [];
    const walk = (dir: string, depth: number) => {
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name))
                continue;
            const child = join(dir, entry.name);
            const app = describeApp(child, root);
            if (app) found.push(app);
            else if (depth + 1 < maxDepth) walk(child, depth + 1);
        }
    };
    walk(root, 0);
    return classify(found).sort((a, b) => a.rel.localeCompare(b.rel));
}

/** An app's role among the apps next to it, for when init runs inside one of them. */
export function refineRole(app: AppInfo): AppInfo {
    if (!app.federation.present) return app;
    // Neighbours in the same repository only: an app at the root of its own checkout has none.
    const repo = findGitRoot(app.dir);
    const peers = discoverApps(dirname(app.dir), 2).filter(
        (p) => p.dir !== app.dir && findGitRoot(p.dir) === repo
    );
    const roles = classify([{ ...app, rel: ".", role: app.role }, ...peers]);
    return { ...app, role: roles[0]?.role ?? app.role };
}

/** The nearest directory above `dir` that holds a `.git`, or null. */
export function findGitRoot(dir: string): string | null {
    for (let current = dir; ; current = dirname(current)) {
        if (existsSync(join(current, ".git"))) return current;
        if (dirname(current) === current) return null;
    }
}

/** Whether `dir` is `root` or inside it. */
const within = (dir: string, root: string) => {
    const rel = relative(root, dir);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * A federation host in a directory above `dir`: where a remote's toolbar should really live. Only in `dir`'s own
 * repository: a host in a checkout next door is another product, even when its config looks like a match.
 */
export function findHostAbove(dir: string, levels = 3): AppInfo | null {
    const repo = findGitRoot(dir);
    let parent = dirname(dir);
    for (let i = 0; i < levels && parent !== dirname(parent); i++, parent = dirname(parent)) {
        if (repo && !within(parent, repo)) break;
        const host = discoverApps(parent, 2).find(
            (a) => a.role === "host" && a.dir !== dir && findGitRoot(a.dir) === repo
        );
        if (host) return host;
    }
    return null;
}
