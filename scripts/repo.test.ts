// The conventions that keep the repository easy to extend and ready to publish. A new SDK under sdks/ that misses a
// step fails here, saying which (sdks/README.md lists them all).
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGES } from "../site/docs.ts";
import { libraries, REPO_URL, ROOT } from "./repo.ts";
import { currentVersion, readStamps, SDK_STAMPS } from "./version.ts";

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const dirs = (parent: string) =>
    readdirSync(join(ROOT, parent), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name);

const sdks = dirs("sdks");
/** SDKs that are npm packages (a package.json at the folder's root); the rest have their own toolchain. */
const npmSdks = sdks.filter((name) => existsSync(join(ROOT, "sdks", name, "package.json")));
const nativeSdks = sdks.filter((name) => !npmSdks.includes(name));

/** Every workspace folder, from the root package.json's list: folders, and globs like `dir/*`. */
function workspaces(): string[] {
    const globs = (JSON.parse(read("package.json")) as { workspaces: string[] }).workspaces;
    return globs.flatMap((glob) => {
        if (!glob.includes("*")) return [glob];
        const [parent, star, ...rest] = glob.split("/");
        if (star !== "*" || !parent)
            throw new Error(`a workspace glob this test cannot read: ${glob}`);
        return dirs(parent)
            .map((name) => [parent, name, ...rest].join("/"))
            .filter((dir) => existsSync(join(ROOT, dir, "package.json")));
    });
}

describe("every SDK", () => {
    it("has a README for app developers", () => {
        for (const name of sdks)
            expect(existsSync(join(ROOT, "sdks", name, "README.md")), name).toBe(true);
    });

    it("outside npm, says where its version is, has its own CI and a docs page", () => {
        const workflows = readdirSync(join(ROOT, ".github/workflows"));
        for (const name of nativeSdks) {
            expect(SDK_STAMPS[name], `${name} in SDK_STAMPS (scripts/version.ts)`).toBeDefined();
            const workflow = `sdk-${name}.yml`;
            expect(workflows, `.github/workflows/${workflow}`).toContain(workflow);
            const text = read(`.github/workflows/${workflow}`);
            expect(text, `${workflow} runs on changes to the SDK`).toContain(`sdks/${name}/**`);
            expect(text, `${workflow} runs on changes to the schema`).toContain("packages/schema/");
            expect(
                PAGES.some((p) => p.file === `sdks/${name}/README.md`),
                `a page for sdks/${name}/README.md in site/docs.ts`
            ).toBe(true);
        }
    });

    it("on npm, is a public package with a description, published by the release", () => {
        const published = libraries().map((l) => l.dir);
        for (const name of npmSdks) {
            const pkg = JSON.parse(read(`sdks/${name}/package.json`)) as {
                private?: boolean;
                description?: string;
            };
            if (pkg.private) continue;
            expect(pkg.description, `sdks/${name}/package.json description`).toBeTruthy();
            expect(published, `sdks/${name} among the libraries the release builds`).toContain(
                `sdks/${name}`
            );
        }
    });
});

describe("publishing", () => {
    it("has one version everywhere", () => {
        const want = currentVersion();
        for (const stamp of readStamps()) expect(stamp.version, stamp.file).toBe(want);
    });

    it("names the same repository in every registry's metadata, and no placeholder anywhere", () => {
        const path = new URL(REPO_URL).pathname.slice(1); // notatorg/notato
        expect(read("sdks/android/gradle.properties")).toContain(`POM_SCM_URL=${REPO_URL}`);
        expect(read("sdks/dotnet/Directory.Build.props")).toContain(
            `<RepositoryUrl>${REPO_URL}</RepositoryUrl>`
        );
        expect(read("Package.swift")).toContain(REPO_URL);
        expect(read("Dockerfile")).toContain(`ghcr.io/${path}`);
        for (const file of [
            "README.md",
            "Dockerfile",
            "site/src/index.html",
            "sdks/android/gradle.properties",
        ])
            expect(read(file), file).not.toContain("OWNER/");
    });

    it("gives every public library a description", () => {
        for (const lib of libraries()) expect(lib.pkg.description, lib.dir).toBeTruthy();
    });

    it("copies every workspace's package.json into the Docker build before installing", () => {
        const dockerfile = read("Dockerfile");
        for (const dir of workspaces())
            expect(dockerfile, `COPY ${dir}/package.json in the Dockerfile`).toContain(
                `COPY ${dir}/package.json ${dir}/`
            );
    });
});
