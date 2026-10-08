import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Builds the browser extension into packages/extension/dist, ready to load unpacked (chrome://extensions, Developer
// mode, Load unpacked). Four scripts: the background worker, the relay content script, the page script that runs in
// the page's own world, and the popup.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const entries: Array<{ entry: string; name: string; format: "esm" | "iife" }> = [
    { entry: "entry-background.ts", name: "background.js", format: "esm" },
    // These are injected as plain scripts, so each is one self-contained file with nothing shared between them.
    { entry: "entry-relay.ts", name: "relay.js", format: "iife" },
    { entry: "entry-main.ts", name: "main.js", format: "iife" },
    { entry: "popup.ts", name: "popup.js", format: "iife" },
];

for (const { entry, name, format } of entries) {
    const result = await Bun.build({
        entrypoints: [join(root, "src", entry)],
        outdir: dist,
        naming: name,
        target: "browser",
        format,
        minify: true,
        define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!result.success) {
        for (const log of result.logs) console.error(log);
        process.exit(1);
    }
}

cpSync(join(root, "src/popup.html"), join(dist, "popup.html"));
for (const size of [16, 48, 128])
    cpSync(join(root, `icons/icon-${size}.png`), join(dist, `icon-${size}.png`));

// The version is the repository's, so a build always says which release it is from.
const version = (
    JSON.parse(readFileSync(join(root, "../cli/package.json"), "utf8")) as { version: string }
).version;
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Record<
    string,
    unknown
>;
manifest.version = version;
writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`built the extension ${version} -> ${dist}`);
