/**
 * Publishes the develop branch to preview.notato.dev. Cloudflare runs this for every non-production
 * branch, so any other branch is built (to catch errors) but left unpublished, and cannot replace the
 * shared preview.
 */
const branch = process.env.WORKERS_CI_BRANCH;

if (branch && branch !== "develop") {
    console.log(`Built ${branch}; only develop is published to preview.notato.dev.`);
    process.exit(0);
}

const wrangler = Bun.spawn(["bunx", "wrangler", "deploy", "--env", "preview"], {
    stdout: "inherit",
    stderr: "inherit",
});
process.exit(await wrangler.exited);
