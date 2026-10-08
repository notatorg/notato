import { describe, expect, it } from "bun:test";
import { addToViteConfig, removeFromViteConfig } from "../src/init/transforms.ts";

/** The shape of a typical federated app: ESM, semicolons, 4 spaces, one entry per line. */
const REPO_CONFIG = `import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";
import { fileURLToPath } from "url";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    return {
        base: "/",
        plugins: [
            react(),
            federation({
                name: "publicPages",
                exposes: { "./routes": "./src/routes.tsx" },
                shared: ["react"],
            }),
        ],
        build: { minify: false },
    };
});
`;

describe("addToViteConfig", () => {
    it("adds the plugin as the first entry, on a line of its own, and the import after the others", () => {
        const edit = addToViteConfig(REPO_CONFIG);
        expect(edit.changed).toBe(true);
        expect(edit.source).toContain('import { notatoSource } from "@notato/vite";');
        expect(edit.source.indexOf("@notato/vite")).toBeGreaterThan(
            edit.source.indexOf('from "url"')
        );
        expect(edit.source).toContain(
            "        plugins: [\n            notatoSource(),\n            react(),"
        );
    });

    it("is undone exactly", () => {
        const edit = addToViteConfig(REPO_CONFIG);
        expect(removeFromViteConfig(edit.source).source).toBe(REPO_CONFIG);
    });

    it("is idempotent", () => {
        const once = addToViteConfig(REPO_CONFIG).source;
        expect(addToViteConfig(once)).toMatchObject({
            changed: false,
            reason: "already set up",
            source: once,
        });
    });

    const SHAPES: Record<string, string> = {
        "an object config with 2-space indent and no semicolons": `import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [
    react(),
  ],
})
`,
        "plugins on one line": `import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({ plugins: [react()] })
`,
        "several plugins on one line": `import { defineConfig } from "vite"
export default defineConfig({ plugins: [react(), tsconfigPaths()] })
`,
        "an empty array": `import { defineConfig } from "vite"
export default defineConfig({ plugins: [] })
`,
        "an empty multi-line array": `import { defineConfig } from "vite"
export default defineConfig({
  plugins: [
  ],
})
`,
        tabs: `import { defineConfig } from "vite"
export default defineConfig({
\tplugins: [
\t\treact(),
\t],
})
`,
        "CRLF line endings": `import { defineConfig } from "vite"\r\nexport default defineConfig({\r\n  plugins: [\r\n    react(),\r\n  ],\r\n})\r\n`,
    };
    for (const [name, source] of Object.entries(SHAPES)) {
        it(`gives back ${name} exactly after add and remove`, () => {
            const added = addToViteConfig(source);
            expect(added.changed).toBe(true);
            expect(added.source).toContain("notatoSource()");
            expect(removeFromViteConfig(added.source).source).toBe(source);
        });
    }

    it("keeps the plugin ahead of the others on one line, in a valid expression", () => {
        const edit = addToViteConfig(
            'import x from "y"\nexport default { plugins: [react(), b()] }\n'
        );
        expect(edit.source).toContain("plugins: [notatoSource(), react(), b()]");
    });

    it("uses the first plugins array and says so when there are several", () => {
        const edit = addToViteConfig(
            'import x from "y"\nexport default { plugins: [react()], worker: { plugins: [other()] } }\n'
        );
        expect(edit.source).toContain("plugins: [notatoSource(), react()]");
        expect(edit.source).toContain("worker: { plugins: [other()] }");
        expect(edit.note).toContain("first plugins array");
    });

    it("explains when it cannot edit safely, and changes nothing", () => {
        const noArray =
            'import x from "y"\nconst plugins = [react()]\nexport default { plugins }\n';
        expect(addToViteConfig(noArray)).toMatchObject({ changed: false, source: noArray });
        expect(addToViteConfig(noArray).reason).toContain("plugins: [");
        const cjs =
            'const react = require("@vitejs/plugin-react")\nmodule.exports = { plugins: [react()] }\n';
        expect(addToViteConfig(cjs)).toMatchObject({ changed: false, source: cjs });
        expect(addToViteConfig(cjs).reason).toContain("CommonJS");
    });
});

describe("removeFromViteConfig", () => {
    it("says there is nothing to remove from a config that never had it", () => {
        expect(removeFromViteConfig(REPO_CONFIG)).toMatchObject({
            changed: false,
            reason: "not set up",
        });
    });

    it("finds the entry wherever someone has moved it in the array", () => {
        const moved = addToViteConfig(REPO_CONFIG)
            .source.replace("            notatoSource(),\n", "")
            .replace(
                "            react(),\n",
                "            react(),\n            notatoSource(),\n"
            );
        expect(removeFromViteConfig(moved).source).toBe(REPO_CONFIG);
    });

    it("will not guess when notatoSource is used some other way", () => {
        const odd =
            'import { notatoSource } from "@notato/vite"\nconst p = notatoSource({ enabled: true })\nexport default { plugins: [p] }\n';
        const out = removeFromViteConfig(odd);
        expect(out.changed).toBe(false);
        expect(out.source).toBe(odd);
    });
});
