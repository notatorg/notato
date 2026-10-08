// One version for every Notato package, whatever registry it goes to: npm, SwiftPM (the git tag), Maven and NuGet.
// The root package.json holds it; every other manifest says the same, and a release tag is that version with a v.
//
//   bun scripts/version.ts                  check that every manifest says the root's version
//   bun scripts/version.ts 0.3.0            set it everywhere (then commit, and tag v0.3.0)
//   bun scripts/version.ts --tag v0.3.0     check, and that the tag is this version (the release workflow does this)
//
// A new SDK adds where its version is written to SDK_STAMPS (an npm package under sdks/ is found on its own).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./repo.ts";

/** A place a version is written: the file, and a pattern whose first group is the version. */
export interface Stamp {
    file: string;
    pattern: RegExp;
}

/**
 * Where each SDK outside npm keeps its version, by its folder under sdks/. The npm packages (packages/*, sdks/*) are
 * found from their package.json, and so are an SDK's own version constants listed here.
 */
export const SDK_STAMPS: Record<string, Stamp[]> = {
    // What notes name as the SDK that made them (`environment.sdk`).
    browser: [{ file: "sdks/browser/src/version.ts", pattern: /version: "([^"]+)"/ }],
    "react-native": [{ file: "sdks/react-native/src/version.ts", pattern: /version: "([^"]+)"/ }],
    // SwiftPM takes the version from the tag; this is what notes say.
    swift: [
        {
            file: "sdks/swift/Sources/Notato/Version.swift",
            pattern: /static let version = "([^"]+)"/,
        },
        // The README's Package.swift line, which people copy as it is.
        { file: "sdks/swift/README.md", pattern: /notatorg\/notato", from: "([^"]+)"/ },
    ],
    // The Maven coordinates and BuildConfig.NOTATO_VERSION.
    android: [
        { file: "sdks/android/gradle.properties", pattern: /^VERSION_NAME=(.+)$/m },
        // The README's install line, which Gradle users copy as it is.
        { file: "sdks/android/README.md", pattern: /dev\.notato:notato-compose:([^"]+)"/ },
    ],
    // The NuGet package and the assembly version notes report.
    dotnet: [{ file: "sdks/dotnet/Directory.Build.props", pattern: /<Version>([^<]+)<\/Version>/ }],
    // The pub.dev package, and what notes report.
    flutter: [
        { file: "sdks/flutter/pubspec.yaml", pattern: /^version: (.+)$/m },
        { file: "sdks/flutter/lib/src/version.dart", pattern: /notatoSdkVersion = '([^']+)'/ },
    ],
};

/** A release version: major.minor.patch, with an optional pre-release (`0.3.0-rc.1`). */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Every package.json in the workspaces that carries a version (examples need none). */
export function npmStamps(): Stamp[] {
    const dirs = ["packages", "sdks"].flatMap((parent) =>
        readdirSync(join(ROOT, parent), { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => join(parent, d.name))
    );
    return dirs
        .map((dir) => join(dir, "package.json"))
        .filter((file) => existsSync(join(ROOT, file)))
        .filter((file) => "version" in JSON.parse(readFileSync(join(ROOT, file), "utf8")))
        .map((file) => ({ file, pattern: /"version": "([^"]+)"/ }));
}

/** The version the repository is at: the root package.json's. */
export function currentVersion(): string {
    return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string })
        .version;
}

/** Every place the version is written: the root package.json, every npm package, and each SDK's own. */
export function allStamps(): Stamp[] {
    return [
        { file: "package.json", pattern: /"version": "([^"]+)"/ },
        ...npmStamps(),
        // The extension's build writes its package.json version into the manifest; the source copy keeps up too.
        { file: "packages/extension/manifest.json", pattern: /"version": "([^"]+)"/ },
        ...Object.values(SDK_STAMPS).flat(),
    ];
}

/** What each place says now, or null where the pattern is not found. */
export function readStamps(): Array<{ file: string; version: string | null }> {
    return allStamps().map(({ file, pattern }) => {
        const text = readFileSync(join(ROOT, file), "utf8");
        return { file, version: pattern.exec(text)?.[1]?.trim() ?? null };
    });
}

function setVersion(version: string) {
    for (const { file, pattern } of allStamps()) {
        const path = join(ROOT, file);
        const text = readFileSync(path, "utf8");
        const match = pattern.exec(text);
        if (!match?.[1]) throw new Error(`${file}: no version found to stamp`);
        const start = match.index + match[0].indexOf(match[1]);
        writeFileSync(path, text.slice(0, start) + version + text.slice(start + match[1].length));
    }
}

function check(): string[] {
    const want = currentVersion();
    return readStamps()
        .filter((s) => s.version !== want)
        .map((s) => `${s.file} says ${s.version ?? "nothing"}, not ${want}`);
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const tagAt = args.indexOf("--tag");
    const tag = tagAt >= 0 ? args[tagAt + 1] : undefined;
    const asked = args.find((a, i) => !a.startsWith("--") && (tagAt < 0 || i !== tagAt + 1));
    if (asked) {
        if (!SEMVER.test(asked)) throw new Error(`"${asked}" is not a version like 0.3.0`);
        setVersion(asked);
        console.log(`every Notato package is now ${asked}; commit, then tag v${asked}`);
    }
    const wrong = check();
    const version = currentVersion();
    if (tag !== undefined && tag !== `v${version}`)
        wrong.push(`the tag ${tag} is not v${version}, the version in the repository`);
    if (wrong.length) {
        for (const line of wrong) console.error(`✗ ${line}`);
        console.error("run `bun scripts/version.ts <version>` to set every one");
        process.exit(1);
    }
    if (!asked) {
        const stamps = readStamps();
        const others = stamps.map((s) => s.file).filter((f) => !f.endsWith("package.json"));
        console.log(
            `${version}: ${stamps.length} places agree (${others.join(", ")} and the package.json files)`
        );
    }
}
