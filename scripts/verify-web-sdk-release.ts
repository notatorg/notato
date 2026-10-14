import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, WEB_SDK_NAMES } from "./repo.ts";
import { currentVersion } from "./version.ts";

export const releaseDirectory = join(ROOT, "dist/release");

/** Verify the packed files consumers install, including the MIT license. */
export function verifyWebSdkRelease() {
    const version = currentVersion();
    const packages = readdirSync(join(releaseDirectory, "packages")).sort();
    const expected = WEB_SDK_NAMES.map((name) => name.replace("/", "__")).sort();
    if (JSON.stringify(packages) !== JSON.stringify(expected))
        throw new Error("Web SDK release contains an unexpected package or is incomplete");
    const tarballs = readdirSync(join(releaseDirectory, "tarballs")).sort();
    if (tarballs.length !== WEB_SDK_NAMES.length)
        throw new Error("Expected exactly five packed web SDK packages");
    return WEB_SDK_NAMES.map((name) => {
        const filename = `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
        if (!tarballs.includes(filename)) throw new Error(`Missing ${filename}`);
        const path = join(releaseDirectory, "tarballs", filename);
        const tar = (args: string[]) => {
            const result = Bun.spawnSync(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
            if (result.exitCode !== 0) throw new Error(`Cannot inspect ${filename}`);
            return result.stdout.toString();
        };
        const entries = tar(["-tzf", path]).trim().split("\n");
        if (entries.some((entry) => !entry.startsWith("package/") || entry.includes("../")))
            throw new Error(`Unsafe archive path in ${filename}`);
        for (const file of ["LICENSE"])
            if (tar(["-xOf", path, `package/${file}`]) !== readFileSync(join(ROOT, file), "utf8"))
                throw new Error(`Missing or changed licensing notice in ${filename}`);
        const pkg = JSON.parse(tar(["-xOf", path, "package/package.json"]));
        if (pkg.name !== name || pkg.version !== version || pkg.license !== "MIT")
            throw new Error(`Wrong package metadata in ${filename}`);
        for (const [dependency, range] of Object.entries(pkg.dependencies ?? {})) {
            if (!dependency.startsWith("@notato/")) continue;
            if (!WEB_SDK_NAMES.some((allowed) => allowed === dependency) || range !== `^${version}`)
                throw new Error(`Unexpected internal dependency in ${filename}`);
        }
        for (const entry of entries.filter((entry) => entry.endsWith(".js"))) {
            const source = tar(["-xOf", path, entry]);
            if (
                /NOTATO_SUPABASE_STORAGE_KEY|class SupabaseAuth|NOTATO_TEST_PLANS|STRIPE_SECRET_KEY/.test(
                    source
                )
            )
                throw new Error(`Private service implementation found in ${filename}`);
        }
        return {
            name,
            version,
            path,
            integrity: `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`,
        };
    });
}

if (import.meta.main) {
    const verified = verifyWebSdkRelease();
    console.log(JSON.stringify({ version: currentVersion(), verified }, null, 2));
}
