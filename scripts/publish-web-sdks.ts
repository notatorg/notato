import { parseArgs } from "node:util";
import { verifyWebSdkRelease } from "./verify-web-sdk-release.ts";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } });
const dryRun = values["dry-run"] === true;
if (
    !dryRun &&
    (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "notatorg/notato")
)
    throw new Error("Publish web SDKs through the reviewed public repository's release workflow");
const packages = verifyWebSdkRelease();
const exists = new Set<string>();
// Check every version before publishing any of them; retry only identical partial releases.
for (const pkg of packages) {
    const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`
    );
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Cannot check registry state for ${pkg.name}`);
    const published = (await response.json()) as { dist?: { integrity?: string } };
    if (published.dist?.integrity !== pkg.integrity)
        throw new Error(`${pkg.name}@${pkg.version} already exists with different contents`);
    exists.add(pkg.name);
}
for (const pkg of packages) {
    if (exists.has(pkg.name)) {
        console.log(`${pkg.name}@${pkg.version}: identical package already published`);
        continue;
    }
    const process = Bun.spawn(
        [
            "npm",
            "publish",
            pkg.path,
            "--access",
            "public",
            "--tag",
            pkg.version.includes("-") ? "next" : "latest",
            ...(dryRun ? ["--dry-run"] : ["--provenance"]),
        ],
        { stdout: "inherit", stderr: "inherit" }
    );
    if ((await process.exited) !== 0) throw new Error(`npm publication failed for ${pkg.name}`);
}
