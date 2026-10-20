import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Builds the cloud's board: the open board's own build, started from this package's page, so that the open board's
// pages, fonts and scripts are the ones in `core/` and this package's screens are added to them. It never writes into
// `core/`: the output is always a folder of its own, which the server serves with NOTATO_WEB_DIST (`notato-server
// serve` run from source picks up services/board/dist by itself, and the image sets the variable to its copy).
//
//   bun run build                       into services/board/dist
//   bun run build -- --outdir <dir>     somewhere else
//   bun run build -- --watch            again whenever core's board or browser SDK sources, or index.html, change

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, "../../../packages/board/scripts/build.ts");
const page = join(here, "../index.html");
const args = process.argv.slice(2);

// The open build's --embed, --stub and --reset rewrite core's tracked `web-assets.generated.ts` (or, with an outdir,
// do nothing): the cloud serves its board from a folder instead.
const refused = args.find((arg) => ["--embed", "--stub", "--reset"].includes(arg));
if (refused) {
    console.error(
        `${refused} is not used by the cloud: build into a folder and serve it with NOTATO_WEB_DIST (see the Dockerfile)`
    );
    process.exit(1);
}
const outdir = args.includes("--outdir") ? [] : ["--outdir", join(here, "../dist")];
const proc = Bun.spawn(["bun", build, "--html", page, ...outdir, ...args], {
    stdout: "inherit",
    stderr: "inherit",
});
process.exit(await proc.exited);
