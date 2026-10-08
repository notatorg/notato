import {
    copyFileSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    watch,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bundles the board UI into dist/, which a server run from source serves.
//
//   --embed          also list the output in `packages/server/src/web-assets.generated.ts`, so that
//                    `bun build --compile` embeds every file in the binary (the release build and the Dockerfile do
//                    this; `--stub` puts the committed stub back afterwards)
//   --outdir <dir>   build somewhere else and leave dist/ and the generated list alone: a server started with
//                    NOTATO_WEB_DIST=<dir> serves that board, so a change can be tried beside a running server
//   --watch          build again whenever something under src/ (or the page script) changes

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outdirAt = args.indexOf("--outdir");
const outdir = outdirAt >= 0 ? args[outdirAt + 1] : undefined;
if (outdirAt >= 0 && (!outdir || outdir.startsWith("--"))) {
    console.error("--outdir needs a folder");
    process.exit(1);
}
const dist = outdir ? resolve(outdir) : join(root, "dist");
const generated = join(root, "../server/src/web-assets.generated.ts");

const STUB = `// Overwritten by \`bun packages/board/scripts/build.ts --embed\`, which lists the built board UI here so
// \`bun build --compile\` embeds it in the binary. This stub is what the repository keeps: a binary built with it has
// no board at \`/\`, and a server run from source serves packages/board/dist, once \`bun run build:board\` has made it.
export const webAssets: Record<string, { path: string; type: string }> | null = null
`;

const embed = args.includes("--embed");

// `--stub`: put the stub back and keep the built board, as the release build does once the binaries embed it.
if (args.includes("--stub")) {
    writeFileSync(generated, STUB);
    process.exit(0);
}

if (args.includes("--reset")) {
    if (outdir) {
        console.error("--reset restores dist/ and the generated list; it takes no --outdir");
        process.exit(1);
    }
    writeFileSync(generated, STUB);
    rmSync(dist, { recursive: true, force: true });
    console.log("restored the empty web-assets stub");
    process.exit(0);
}

/** One build into `dist`. Returns false (having said why) when it failed. */
async function build(): Promise<boolean> {
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });

    const result = await Bun.build({
        entrypoints: [join(root, "index.html")],
        outdir: dist,
        minify: true,
        // Without this React ships its development build, which is several times larger.
        define: { "process.env.NODE_ENV": '"production"' },
        // The server serves these under /ui/, so the HTML must point there.
        publicPath: "/ui/",
        naming: {
            entry: "[name].[ext]",
            chunk: "[name]-[hash].[ext]",
            asset: "[name]-[hash].[ext]",
        },
        // Fonts would be inlined into the CSS as data: URLs, which the board's CSP refuses: they are copied below instead.
        external: ["*.woff2"],
    });
    if (!result.success) {
        for (const log of result.logs) console.error(log);
        return false;
    }

    // Every font src/fonts.css names, from the @fontsource-variable package it comes from, into dist/fonts.
    mkdirSync(join(dist, "fonts"), { recursive: true });
    const fontsCss = readFileSync(join(root, "src/fonts.css"), "utf8");
    for (const [, file] of fontsCss.matchAll(/url\("\.\/fonts\/([^"]+\.woff2)"\)/g)) {
        const family = /^(.+?)-(?:latin|latin-ext)-/.exec(file as string)?.[1];
        const pkg = dirname(Bun.resolveSync(`@fontsource-variable/${family}/package.json`, root));
        copyFileSync(join(pkg, "files", file as string), join(dist, "fonts", file as string));
    }

    // The script a bookmarklet, a script tag or the browser extension loads to put Notato on any page. It is served by
    // the same server at `/inject.js`, so it is built here and embedded with the board.
    const injected = await Bun.build({
        entrypoints: [join(root, "../../sdks/browser/src/inject.ts")],
        outdir: dist,
        naming: "inject.js",
        minify: true,
        target: "browser",
        define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!injected.success) {
        for (const log of injected.logs) console.error(log);
        return false;
    }

    const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
        ".json": "application/json; charset=utf-8",
        ".map": "application/json; charset=utf-8",
    };

    const files: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (!name.endsWith(".map")) files.push(path);
        }
    };
    walk(dist);
    const total = files.reduce((n, f) => n + statSync(f).size, 0);

    // Only a binary needs the list, and it embeds dist/ only: a board built elsewhere is for NOTATO_WEB_DIST.
    if (outdir || !embed) {
        console.log(`built ${files.length} files (${(total / 1024).toFixed(0)} kB) -> ${dist}`);
        return true;
    }

    const entries = files.map((file, i) => {
        const rel = relative(dist, file).split("\\").join("/");
        const ext = rel.slice(rel.lastIndexOf("."));
        return { rel, ident: `file${i}`, type: types[ext] ?? "application/octet-stream" };
    });

    const importPath = (rel: string) =>
        relative(dirname(generated), join(dist, rel)).split("\\").join("/");
    const source = `// @ts-nocheck: Bun types html and css imports as bundles, but with { type: "file" } they are paths.
// Generated by \`bun packages/board/scripts/build.ts --embed\` for \`bun build --compile\`. Do not edit or commit.
${entries.map((e) => `import ${e.ident} from "${importPath(e.rel)}" with { type: "file" }`).join("\n")}

export const webAssets: Record<string, { path: string; type: string }> | null = {
${entries.map((e) => `  ${JSON.stringify(e.rel)}: { path: ${e.ident}, type: ${JSON.stringify(e.type)} },`).join("\n")}
}
`;
    writeFileSync(generated, source);

    console.log(
        `built ${entries.length} files (${(total / 1024).toFixed(0)} kB) -> ${relative(process.cwd(), generated)}`
    );
    return true;
}

const ok = await build();
if (!args.includes("--watch")) process.exit(ok ? 0 : 1);

// Rebuild after a burst of saves settles; a build that starts while one runs waits for it.
let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<unknown> = Promise.resolve();
const again = (file: string | null) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
        running = running.then(async () => {
            console.log(`${file ?? "a file"} changed, building…`);
            await build();
        });
    }, 100);
};
for (const dir of [join(root, "src"), join(root, "../../sdks/browser/src")]) {
    watch(dir, { recursive: true }, (_event, file) => again(file));
}
watch(join(root, "index.html"), () => again("index.html"));
console.log("watching src/ for changes (Ctrl+C to stop)");
