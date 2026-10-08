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
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { entryPoints, type Library, libraries, NODE_LIBRARIES, REPO_URL, ROOT } from "./repo.ts";
import { currentVersion, SEMVER } from "./version.ts";

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

const HELP = `bun run scripts/build-release.ts [options]

  --version <x.y.z>   The version to build (default: the repository's, from package.json)
  --targets <list>    all (default), host, or a comma-separated list such as bun-linux-x64,bun-darwin-arm64
  --skip-web          Do not rebuild the board UI before compiling
  --skip-compile      Do not compile the binaries
  --skip-libs         Do not build the npm libraries
  --skip-extension    Do not build the browser extension
  --no-pack           Do not pack the packages into tarballs
  -h, --help          Show this help`;

const OUT = join(ROOT, "dist/release");

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

const platformName = (t: Target) => `@notato/cli-${t.os}-${t.cpu}`;
const binaryName = (t: Target) => (t.os === "win32" ? "notato.exe" : "notato");
/** The folder a package is written to: its name, with the scope's slash made safe for a path. */
const packageDir = (name: string) => join(OUT, "packages", name.replace("/", "__"));

const run = async (cmd: string[], cwd = ROOT) => {
    const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`);
};
const log = (message: string) => console.log(`\n▸ ${message}`);
const writeJson = (path: string, data: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
};
const megabytes = (path: string, digits = 0) =>
    `${(statSync(path).size / 1024 / 1024).toFixed(digits)} MB`;

const REPOSITORY = { type: "git", url: `git+${REPO_URL}.git` };

/** The package.json fields every published package shares. */
const commonFields = (version: string) => ({
    version,
    license: "MIT",
    repository: REPOSITORY,
    homepage: `${REPO_URL}#readme`,
    bugs: { url: `${REPO_URL}/issues` },
    publishConfig: { access: "public", provenance: true },
});

/** The board UI, then a binary for each target with it embedded. */
async function compileBinaries(targets: Target[], version: string, skipWeb: boolean) {
    if (!skipWeb) {
        log("building the board UI");
        await run(["bun", "run", "build:board"]);
    }
    for (const target of targets) {
        log(`compiling ${target.bun}`);
        const file = join(OUT, "bin", target.bun, binaryName(target));
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
        console.log(`  ${megabytes(file)}`);
    }
    // The binaries have the board in them; the repository keeps the empty list.
    if (!skipWeb) await run(["bun", "packages/board/scripts/build.ts", "--stub"]);
}

/** `@notato/cli-<os>-<cpu>`: one package per binary that was built. */
function writePlatformPackages(targets: Target[], version: string) {
    for (const target of targets) {
        const name = platformName(target);
        const source = join(OUT, "bin", target.bun, binaryName(target));
        if (!existsSync(source)) {
            console.log(`  (skipping ${name}: no binary at ${relative(ROOT, source)})`);
            continue;
        }
        const dir = packageDir(name);
        const binary = join(dir, "bin", binaryName(target));
        mkdirSync(dirname(binary), { recursive: true });
        cpSync(source, binary);
        chmodSync(binary, 0o755);
        writeJson(join(dir, "package.json"), {
            name,
            description: `The Notato command-line binary for ${target.os} ${target.cpu}. Install \`notato\` instead.`,
            ...commonFields(version),
            os: [target.os],
            cpu: [target.cpu],
            files: ["bin"],
            preferUnplugged: true,
        });
        writeFileSync(
            join(dir, "README.md"),
            `# ${name}\n\nThe ${target.os} ${target.cpu} binary for [notato](https://www.npmjs.com/package/notato). Do not install this directly.\n`
        );
    }
}

/**
 * The launcher's bin script: runs the native binary npm installed for this platform. It is plain Node, so the
 * package works wherever npx does.
 */
const launcherScript = (packages: Record<string, string>) => `#!/usr/bin/env node
"use strict"
// Runs the native notato binary that npm installed for this platform. The binary does the work; this only
// finds it and hands over stdin, stdout and stderr untouched, which \`notato dev\` needs for MCP over stdio.
const { spawn } = require("node:child_process")

const PACKAGES = ${JSON.stringify(packages, null, 2)}

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
`;

/** `notato`: the launcher, with every platform package as an optional dependency, and the repository's README. */
function writeLauncher(version: string) {
    const dir = packageDir("notato");
    const script = join(dir, "bin/notato.js");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(
        script,
        launcherScript(
            Object.fromEntries(TARGETS.map((t) => [`${t.os}-${t.cpu}`, platformName(t)]))
        )
    );
    chmodSync(script, 0o755);
    writeJson(join(dir, "package.json"), {
        name: "notato",
        description:
            "Pin feedback to a running app and hand it to your coding agent: the server, the board and MCP in one command.",
        ...commonFields(version),
        keywords: ["feedback", "annotations", "mcp", "coding-agent", "claude", "codex", "testing"],
        bin: { notato: "bin/notato.js" },
        files: ["bin"],
        engines: { node: ">=18" },
        optionalDependencies: Object.fromEntries(TARGETS.map((t) => [platformName(t), version])),
    });
    writeFileSync(join(dir, "README.md"), readFileSync(join(ROOT, "README.md"), "utf8"));
}

/** Whether any script under `dir` mentions process.env.NODE_ENV. */
const readsNodeEnv = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true }).some((e) =>
        e.isDirectory()
            ? readsNodeEnv(join(dir, e.name))
            : /\.[jt]s$/.test(e.name) &&
              readFileSync(join(dir, e.name), "utf8").includes("process.env.NODE_ENV")
    );

/** Relative specifiers keep their .ts extension in declarations; consumers resolve .js. */
function fixDeclarationSpecifiers(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) fixDeclarationSpecifiers(path);
        else if (entry.name.endsWith(".d.ts")) {
            const text = readFileSync(path, "utf8");
            writeFileSync(
                path,
                text.replace(/(from\s+["']|import\(["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g, "$1$2.js$3")
            );
        }
    }
}

/**
 * Every workspace package that is not private is a library on npm (packages/* and sdks/*, so a new SDK with a
 * package.json is published with the rest), built from its own package.json: its description, dependencies (the
 * workspace ones at this version), peers, and the files it lists besides src. Its README.md goes with it.
 */
async function buildLibraries(version: string) {
    if (!existsSync(join(ROOT, "packages/schema/schema.json")))
        await run(["bun", "run", "build:schema"]);
    const libs = libraries();
    for (const lib of libs) {
        log(`building ${lib.name}`);
        await buildLibrary(lib, libs, version);
    }
}

async function buildLibrary(lib: Library, libs: Library[], version: string) {
    if (!lib.pkg.description) throw new Error(`${lib.dir}/package.json needs a description`);
    const src = join(ROOT, lib.dir);
    const dist = join(src, "dist");
    rmSync(dist, { recursive: true, force: true });
    const deps = Object.fromEntries(
        Object.entries(lib.pkg.dependencies ?? {}).map(([name, range]) => [
            name,
            range.startsWith("workspace:") ? `^${version}` : range,
        ])
    );
    const peers = lib.pkg.peerDependencies ?? {};
    const external = [...Object.keys(deps), ...Object.keys(peers)].flatMap((n) => [n, `${n}/*`]);

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
        extends: own ? "./tsconfig.json" : relative(src, join(ROOT, "tsconfig.json")),
        compilerOptions: {
            noEmit: false,
            declaration: true,
            emitDeclarationOnly: true,
            outDir: "dist",
            rootDir: "src",
            ...(own ? {} : { types: ["bun"] }),
            paths: Object.fromEntries(
                libs
                    .filter((other) => other.name !== lib.name)
                    .map((other) => [
                        other.name,
                        [relative(src, join(ROOT, other.dir, "dist/index.d.ts"))],
                    ])
            ),
        },
        include: ["src"],
        exclude: ["src/**/*.test.ts"],
    });
    await run(["bunx", "tsc", "-p", tsconfig]);
    rmSync(tsconfig);
    fixDeclarationSpecifiers(dist);

    const extraFiles = (lib.pkg.files ?? []).filter((f) => f !== "src");
    const dir = packageDir(lib.name);
    mkdirSync(dir, { recursive: true });
    cpSync(dist, join(dir, "dist"), { recursive: true });
    for (const file of extraFiles) cpSync(join(src, file), join(dir, file));
    writeJson(join(dir, "package.json"), {
        name: lib.name,
        description: lib.pkg.description,
        ...commonFields(version),
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

/** The browser extension: loaded unpacked (chrome://extensions, Developer mode), so a folder and a zip of it. */
async function buildExtension(version: string) {
    log("building the browser extension");
    await run(["bun", "run", "packages/extension/scripts/build.ts"]);
    const extensionOut = join(OUT, "extension");
    rmSync(extensionOut, { recursive: true, force: true });
    cpSync(join(ROOT, "packages/extension/dist"), extensionOut, { recursive: true });
    const zip = join(OUT, `notato-extension-${version}.zip`);
    rmSync(zip, { force: true });
    try {
        await run(["zip", "-qr", zip, "."], extensionOut);
        console.log(`  ${relative(ROOT, zip)}  ${(statSync(zip).size / 1024).toFixed(0)} kB`);
    } catch {
        console.log(
            `  (could not zip it: no \`zip\` command here. The folder ${relative(ROOT, extensionOut)} loads as it is.)`
        );
    }
}

/** Every package folder as an npm tarball. */
async function pack() {
    log("packing");
    const tarballs = join(OUT, "tarballs");
    mkdirSync(tarballs, { recursive: true });
    for (const name of readdirSync(join(OUT, "packages"))) {
        await run([
            "npm",
            "pack",
            join(OUT, "packages", name),
            "--pack-destination",
            tarballs,
            "--silent",
        ]);
    }
    for (const file of readdirSync(tarballs))
        console.log(`  ${file}  ${megabytes(join(tarballs, file), 1)}`);
}

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
    console.log(HELP);
    process.exit(0);
}

// The repository's version (scripts/version.ts keeps every package at it), unless a release passes its tag's.
const version = values.version ?? currentVersion();
if (!SEMVER.test(version)) throw new Error(`"${version}" is not a semver version`);

const hostTarget = TARGETS.find((t) => t.os === process.platform && t.cpu === process.arch);
const targets =
    values.targets === "all"
        ? TARGETS
        : values.targets === "host"
          ? hostTarget
              ? [hostTarget]
              : []
          : TARGETS.filter((t) => values.targets.split(",").includes(t.bun));
if (targets.length === 0)
    throw new Error(
        `no matching targets for "${values.targets}" (host is ${process.platform}-${process.arch})`
    );

rmSync(join(OUT, "packages"), { recursive: true, force: true });
rmSync(join(OUT, "tarballs"), { recursive: true, force: true });
mkdirSync(join(OUT, "packages"), { recursive: true });

if (!values["skip-compile"]) await compileBinaries(targets, version, Boolean(values["skip-web"]));
writePlatformPackages(targets, version);
writeLauncher(version);
if (!values["skip-libs"]) await buildLibraries(version);
if (!values["skip-extension"]) await buildExtension(version);
if (!values["no-pack"]) await pack();
console.log(`\nDone. Version ${version}; packages in ${relative(ROOT, join(OUT, "packages"))}`);
