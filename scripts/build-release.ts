import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { entryPoints, libraries, NODE_LIBRARIES, REPO_URL } from "./repo.ts";

/**
 * Builds everything a release publishes, without publishing it:
 *
 *   dist/release/bin/<target>/notato[.exe]   Bun-compiled binaries, board UI embedded
 *   dist/release/packages/<name>/             one folder per npm package, ready for `npm publish`
 *   dist/release/extension/ and notato-extension-<version>.zip   the browser extension, to load unpacked
 *   dist/release/tarballs/*.tgz               the same, packed (what CI uploads, and what local tests install)
 *
 * Packages: `notato` (a small launcher), `@notato/cli-<os>-<cpu>` (one binary each, as optionalDependencies of
 * the launcher, the esbuild pattern), and every public workspace package as a library (`libraries()` below):
 * `@notato/schema`, `@notato/core`, `@notato/browser`, `@notato/react`, `@notato/vite`, and any SDK added under sdks/.
 */

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist/release");

interface Target {
    bun: string;
    os: "darwin" | "linux" | "win32";
    cpu: "arm64" | "x64";
}

const TARGETS: Target[] = [
    { bun: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
    { bun: "bun-darwin-x64", os: "darwin", cpu: "x64" },
    { bun: "bun-linux-x64", os: "linux", cpu: "x64" },
    { bun: "bun-linux-arm64", os: "linux", cpu: "arm64" },
    { bun: "bun-windows-x64", os: "win32", cpu: "x64" },
];

const { values } = parseArgs({
    options: {
        version: { type: "string" },
        targets: { type: "string", default: "all" },
        "skip-web": { type: "boolean" },
        "skip-compile": { type: "boolean" },
        "skip-libs": { type: "boolean" },
        "skip-extension": { type: "boolean" },
        "no-pack": { type: "boolean" },
        help: { type: "boolean", short: "h" },
    },
});

if (values.help) {
    console.log(`bun run scripts/build-release.ts [--version x.y.z] [--targets all|host|bun-linux-x64,...]
  [--skip-web] [--skip-compile] [--skip-libs] [--no-pack]`);
    process.exit(0);
}

// The repository's version (scripts/version.ts keeps every package at it), unless a release passes its tag's.
const version =
    values.version ??
    (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version))
    throw new Error(`"${version}" is not a semver version`);

const hostTarget = TARGETS.find((t) => t.os === process.platform && t.cpu === process.arch);
const chosen =
    values.targets === "all"
        ? TARGETS
        : values.targets === "host"
          ? hostTarget
              ? [hostTarget]
              : []
          : TARGETS.filter((t) => (values.targets as string).split(",").includes(t.bun));
if (chosen.length === 0)
    throw new Error(
        `no matching targets for "${values.targets}" (host is ${process.platform}-${process.arch})`
    );

const run = async (cmd: string[], cwd = root, env: Record<string, string> = {}) => {
    const proc = Bun.spawn(cmd, {
        cwd,
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, ...env },
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`);
};
const log = (message: string) => console.log(`\n▸ ${message}`);
const writeJson = (path: string, data: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
};

const REPOSITORY = { type: "git", url: `git+${REPO_URL}.git` };
const common = {
    version,
    license: "MIT",
    repository: REPOSITORY,
    homepage: `${REPO_URL}#readme`,
    bugs: { url: `${REPO_URL}/issues` },
    publishConfig: { access: "public", provenance: true },
};

rmSync(join(out, "packages"), { recursive: true, force: true });
rmSync(join(out, "tarballs"), { recursive: true, force: true });
mkdirSync(join(out, "packages"), { recursive: true });

// ---- the binaries ---------------------------------------------------------------------------------------
if (!values["skip-compile"]) {
    if (!values["skip-web"]) {
        log("building the board UI");
        await run(["bun", "run", "build:board"]);
    }
    for (const target of chosen) {
        log(`compiling ${target.bun}`);
        const file = join(out, "bin", target.bun, target.os === "win32" ? "notato.exe" : "notato");
        mkdirSync(dirname(file), { recursive: true });
        await run([
            "bun",
            "build",
            "--compile",
            "--minify",
            `--target=${target.bun}`,
            `--define=process.env.NOTATO_VERSION=${JSON.stringify(version)}`,
            "packages/cli/src/main.ts",
            "--outfile",
            file,
        ]);
        console.log(`  ${(statSync(file).size / 1024 / 1024).toFixed(0)} MB`);
    }
    // The binaries have the board in them; the repository keeps the empty list.
    if (!values["skip-web"]) await run(["bun", "packages/board/scripts/build.ts", "--stub"]);
}

// ---- platform packages and the launcher ---------------------------------------------------------------
const platformName = (t: Target) => `@notato/cli-${t.os}-${t.cpu}`;

for (const target of chosen) {
    const dir = join(out, "packages", platformName(target).replace("/", "__"));
    const binName = target.os === "win32" ? "notato.exe" : "notato";
    const source = join(out, "bin", target.bun, binName);
    if (!existsSync(source)) {
        console.log(`  (skipping ${platformName(target)}: no binary at ${relative(root, source)})`);
        continue;
    }
    mkdirSync(join(dir, "bin"), { recursive: true });
    cpSync(source, join(dir, "bin", binName));
    chmodSync(join(dir, "bin", binName), 0o755);
    writeJson(join(dir, "package.json"), {
        name: platformName(target),
        description: `The Notato command-line binary for ${target.os} ${target.cpu}. Install \`notato\` instead.`,
        ...common,
        os: [target.os],
        cpu: [target.cpu],
        files: ["bin"],
        preferUnplugged: true,
    });
    writeFileSync(
        join(dir, "README.md"),
        `# ${platformName(target)}\n\nThe ${target.os} ${target.cpu} binary for [notato](https://www.npmjs.com/package/notato). Do not install this directly.\n`
    );
}

const launcherDir = join(out, "packages", "notato");
mkdirSync(join(launcherDir, "bin"), { recursive: true });
const platformMap = Object.fromEntries(TARGETS.map((t) => [`${t.os}-${t.cpu}`, platformName(t)]));
writeFileSync(
    join(launcherDir, "bin/notato.js"),
    `#!/usr/bin/env node
"use strict"
// Runs the native notato binary that npm installed for this platform. The binary does the work; this only
// finds it and hands over stdin, stdout and stderr untouched, which \`notato dev\` needs for MCP over stdio.
const { spawn } = require("node:child_process")

const PACKAGES = ${JSON.stringify(platformMap, null, 2)}

function fail(message) {
  process.stderr.write("notato: " + message + "\\n")
  process.exit(1)
}

function binary() {
  if (process.env.NOTATO_BINARY) return process.env.NOTATO_BINARY
  const key = process.platform + "-" + process.arch
  const name = PACKAGES[key]
  if (!name) fail("there is no notato binary for " + key + ". Supported: " + Object.keys(PACKAGES).join(", ") + ".")
  try {
    return require.resolve(name + "/bin/notato" + (process.platform === "win32" ? ".exe" : ""))
  } catch {
    fail(name + " is not installed. It comes as an optional dependency of notato: reinstall without --omit=optional (or --no-optional), and make sure the lockfile was not created on another platform.")
  }
}

const child = spawn(binary(), process.argv.slice(2), { stdio: "inherit" })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal))
child.on("error", (error) => fail("could not start the binary: " + error.message))
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code === null ? 1 : code)
})
`
);
chmodSync(join(launcherDir, "bin/notato.js"), 0o755);
writeJson(join(launcherDir, "package.json"), {
    name: "notato",
    description:
        "Pin feedback to a running app and hand it to your coding agent: the server, the board and MCP in one command.",
    ...common,
    keywords: ["feedback", "annotations", "mcp", "coding-agent", "claude", "codex", "testing"],
    bin: { notato: "bin/notato.js" },
    files: ["bin"],
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(TARGETS.map((t) => [platformName(t), version])),
});
writeFileSync(join(launcherDir, "README.md"), readFileSync(join(root, "README.md"), "utf8"));

// ---- the libraries --------------------------------------------------------------------------------------
// Every workspace package that is not private is a library on npm (packages/* and sdks/*, so a new SDK with a
// package.json is published with the rest), built from its own package.json: its description, dependencies (the
// workspace ones at this version), peers, and the files it lists besides src. Its README.md goes with it.
if (!values["skip-libs"]) {
    if (!existsSync(join(root, "packages/schema/schema.json")))
        await run(["bun", "run", "build:schema"]);

    const libs = libraries();
    const names = new Set(libs.map((l) => l.name));
    for (const lib of libs) {
        log(`building ${lib.name}`);
        if (!lib.pkg.description) throw new Error(`${lib.dir}/package.json needs a description`);
        const src = join(root, lib.dir);
        const dist = join(src, "dist");
        rmSync(dist, { recursive: true, force: true });
        const deps = Object.fromEntries(
            Object.entries(lib.pkg.dependencies ?? {}).map(([name, range]) => [
                name,
                range.startsWith("workspace:") ? `^${version}` : range,
            ])
        );
        const peers = lib.pkg.peerDependencies ?? {};
        const external = [...Object.keys(deps), ...Object.keys(peers)].flatMap((n) => [
            n,
            `${n}/*`,
        ]);

        const built = await Bun.build({
            entrypoints: entryPoints(lib).map((e) => join(src, e.source)),
            outdir: dist,
            target: NODE_LIBRARIES.has(lib.name) ? "node" : "browser",
            format: "esm",
            splitting: true,
            external,
            // Bun would write "development" in place of process.env.NODE_ENV. A library must leave it for the app's own
            // bundler: <Notato /> reads it to stay out of production builds.
            define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
            // The production JSX runtime: react/jsx-dev-runtime has no jsxDEV in an app's release build.
            jsx: { development: false },
            naming: { entry: "[name].js", chunk: "[name]-[hash].js" },
        });
        if (!built.success) {
            for (const message of built.logs) console.error(message);
            throw new Error(`${lib.name} failed to build`);
        }
        const readsNodeEnv = (dir: string): boolean =>
            readdirSync(dir, { withFileTypes: true }).some((e) =>
                e.isDirectory()
                    ? readsNodeEnv(join(dir, e.name))
                    : /\.[jt]s$/.test(e.name) &&
                      readFileSync(join(dir, e.name), "utf8").includes("process.env.NODE_ENV")
            );
        if (readsNodeEnv(join(src, "src")) && !readsNodeEnv(dist))
            throw new Error(
                `${lib.name}: the build replaced process.env.NODE_ENV, which the app must decide`
            );
        // An import of it, not a mention (the web SDK's stack reading names it in a pattern).
        const devJsx = readdirSync(dist).some(
            (f) =>
                f.endsWith(".js") &&
                /["']react\/jsx-dev-runtime["']/.test(readFileSync(join(dist, f), "utf8"))
        );
        if (devJsx) throw new Error(`${lib.name}: built with React's development JSX runtime`);

        // Declarations: other Notato libraries resolve to the d.ts files built before this one, never to their sources.
        const tsconfig = join(src, "tsconfig.build.json");
        // A library with a program of its own (React Native's globals) keeps it; the rest share the repository's.
        const own = existsSync(join(src, "tsconfig.json"));
        writeJson(tsconfig, {
            extends: own ? "./tsconfig.json" : relative(src, join(root, "tsconfig.json")),
            compilerOptions: {
                noEmit: false,
                declaration: true,
                emitDeclarationOnly: true,
                outDir: "dist",
                rootDir: "src",
                ...(own ? {} : { types: ["bun"] }),
                paths: Object.fromEntries(
                    libs
                        .filter((other) => other.name !== lib.name && names.has(other.name))
                        .map((other) => [
                            other.name,
                            [relative(src, join(root, other.dir, "dist/index.d.ts"))],
                        ])
                ),
            },
            include: ["src"],
            exclude: ["src/**/*.test.ts"],
        });
        await run(["bunx", "tsc", "-p", tsconfig]);
        rmSync(tsconfig);
        // Relative specifiers keep their .ts extension in declarations; consumers resolve .js.
        const fixSpecifiers = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) fixSpecifiers(path);
                else if (entry.name.endsWith(".d.ts")) {
                    const text = readFileSync(path, "utf8");
                    writeFileSync(
                        path,
                        text.replace(
                            /(from\s+["']|import\(["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g,
                            "$1$2.js$3"
                        )
                    );
                }
            }
        };
        fixSpecifiers(dist);

        const extraFiles = (lib.pkg.files ?? []).filter((f) => f !== "src");
        const dir = join(out, "packages", lib.name.replace("/", "__"));
        mkdirSync(dir, { recursive: true });
        cpSync(dist, join(dir, "dist"), { recursive: true });
        for (const file of extraFiles) cpSync(join(src, file), join(dir, file));
        writeJson(join(dir, "package.json"), {
            name: lib.name,
            description: lib.pkg.description,
            ...common,
            repository: { ...REPOSITORY, directory: lib.dir },
            ...(lib.pkg.keywords ? { keywords: lib.pkg.keywords } : {}),
            type: "module",
            main: "./dist/index.js",
            types: "./dist/index.d.ts",
            exports: {
                ...Object.fromEntries(
                    entryPoints(lib).map((e) => [
                        e.key,
                        {
                            types: `./dist/${e.name}.d.ts`,
                            import: `./dist/${e.name}.js`,
                            default: `./dist/${e.name}.js`,
                        },
                    ])
                ),
                ...Object.fromEntries(extraFiles.map((f) => [`./${f}`, `./${f}`])),
            },
            sideEffects: false,
            files: ["dist", ...extraFiles],
            dependencies: deps,
            ...(Object.keys(peers).length ? { peerDependencies: peers } : {}),
            ...(lib.pkg.peerDependenciesMeta
                ? { peerDependenciesMeta: lib.pkg.peerDependenciesMeta }
                : {}),
        });
        const readme = join(src, "README.md");
        writeFileSync(
            join(dir, "README.md"),
            existsSync(readme)
                ? readFileSync(readme, "utf8")
                : `# ${lib.name}\n\n${lib.pkg.description}\n\nPart of [Notato](${REPO_URL}#readme).\n`
        );
        rmSync(dist, { recursive: true, force: true });
    }
}

// ---- the browser extension ----------------------------------------------------------------------------
// Loaded unpacked (chrome://extensions, Developer mode), so it is a folder and a zip of it, not an npm package.
if (!values["skip-extension"]) {
    log("building the browser extension");
    await run(["bun", "run", "packages/extension/scripts/build.ts"]);
    const extensionOut = join(out, "extension");
    rmSync(extensionOut, { recursive: true, force: true });
    cpSync(join(root, "packages/extension/dist"), extensionOut, { recursive: true });
    const zip = join(out, `notato-extension-${version}.zip`);
    rmSync(zip, { force: true });
    try {
        await run(["zip", "-qr", zip, "."], extensionOut);
        console.log(`  ${relative(root, zip)}  ${(statSync(zip).size / 1024).toFixed(0)} kB`);
    } catch {
        console.log(
            `  (could not zip it: no \`zip\` command here. The folder ${relative(root, extensionOut)} loads as it is.)`
        );
    }
}

// ---- pack -----------------------------------------------------------------------------------------------
if (!values["no-pack"]) {
    log("packing");
    mkdirSync(join(out, "tarballs"), { recursive: true });
    for (const name of readdirSync(join(out, "packages"))) {
        await run([
            "npm",
            "pack",
            join(out, "packages", name),
            "--pack-destination",
            join(out, "tarballs"),
            "--silent",
        ]);
    }
    for (const file of readdirSync(join(out, "tarballs"))) {
        console.log(
            `  ${file}  ${(statSync(join(out, "tarballs", file)).size / 1024 / 1024).toFixed(1)} MB`
        );
    }
}
console.log(`\nDone. Version ${version}; packages in ${relative(root, join(out, "packages"))}`);
